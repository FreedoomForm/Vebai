/**
 * Unified Z.ai access layer for Vebai — OFFICIAL API mode.
 *
 * All AI traffic goes through the official OpenAI-compatible endpoint
 * (ZAI_BASE_URL, default: https://open.bigmodel.cn/api/paas/v4) with the
 * site owner's key (ZAI_API_KEY). No logins with Z.ai, no sessions,
 * no captchas — the key stays server-side and every user shares the
 * owner's free-model quota.
 *
 * Models (free on this platform, T52c chain — strongest first):
 *   - glm-4.7-flash  — default (ZAI_MODEL), a thinking model (owner request)
 *   - glm-4.6-flash  — middle rung when 4.7-flash is overloaded (T52c: 4.5
 *                      alone wrote toddler-grade messages, owner report)
 *   - glm-4.5-flash  — last resort
 * Image generation: cogview-3-flash (free) via ZAI_IMAGE_MODEL.
 *
 * Web tools (web_search / page_reader) remain key-free (Bing RSS + DDG +
 * direct page fetch) so search works even without an API key.
 */

import { DEFAULT_BASE_URL, DEFAULT_CHAT_MODEL, MIDDLE_CHAT_MODEL, FALLBACK_CHAT_MODEL, DEFAULT_IMAGE_MODEL } from './zai-config'

export interface ZaiConfig {
  baseUrl: string
  apiKey: string
}

function config(): ZaiConfig {
  const baseUrl = (process.env.ZAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
  const apiKey = process.env.ZAI_API_KEY || ''
  if (!apiKey)
    throw new Error(
      'Z.ai API не настроен: задай ZAI_API_KEY в переменных окружения (официальный ключ с z.ai / bigmodel.cn).',
    )
  return { baseUrl, apiKey }
}

/** Chat models tried in order when the upstream errors/overloads (deduped,
 * strongest first — T52c: the weak tail only fires after the newer model). */
function chatModels(primaryOverride?: string): string[] {
  const primary = (primaryOverride || DEFAULT_CHAT_MODEL).trim()
  const models = [primary]
  if (primary !== MIDDLE_CHAT_MODEL) models.push(MIDDLE_CHAT_MODEL)
  if (primary !== FALLBACK_CHAT_MODEL) models.push(FALLBACK_CHAT_MODEL)
  return models
}

function buildHeaders(cfg: ZaiConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  }
}

async function post(cfg: ZaiConfig, urlPath: string, body: unknown, timeoutMs = 120_000): Promise<Response> {
  const res = await fetch(`${cfg.baseUrl}${urlPath}`, {
    method: 'POST',
    headers: buildHeaders(cfg),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return res
}

/* ------------------------------------------------------- upstream retries *
 * Z.ai free models regularly answer 429 / «负载已饱和» / «模型调用过高» when the
 * shared quota is busy. Instead of failing the user's turn, we retry the SAME
 * model with exponential backoff + jitter (honoring Retry-After when sent),
 * and only then fall through to the next model of the chain. */

/** backoff schedule BEFORE each retry of the same model (ms); overridable via
 * ZAI_RETRY_DELAYS_MS="900,2600,6500" for ops tuning and offline tests */
const RETRY_DELAYS_MS: readonly number[] = (
  process.env.ZAI_RETRY_DELAYS_MS || '900,2600,6500'
)
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function jitter(base: number): number {
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

/** wait time before the next attempt, honoring a sane Retry-After header */
function backoffMs(attempt: number, res?: Response): number {
  const ra = Number(res?.headers?.get?.('retry-after'))
  if (Number.isFinite(ra) && ra > 0) return Math.min(jitter(ra * 1000), 15_000)
  return jitter(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)])
}

/** Is this upstream answer worth retrying on the same model? */
export function isRetryableError(status: number, payload: string): boolean {
  if (status === 429 || status === 502 || status === 503 || status === 504) return true
  if (status === 500 && /operation failed|internal/i.test(payload)) return true
  // Zhipu numeric codes: 1302/1303 — rate & concurrency limit, 1305 — «модель
  // перегружена/высокая нагрузка», 1113 — «нет баланса» (бесполезно ждать, но
  // фолбэк-модель бесплатна — пробуем её тоже)
  if (/"code"\s*:\s*"?(1302|1303|1305|1113)"?/.test(payload)) return true
  // free-quota wording in the human-readable message (any of the known phrasings)
  if (
    /rate.?limit|too many requests|concurrency|высокая нагрузк|перегружен|调用过高|负载已饱和|算力不足|并发/.test(
      payload,
    )
  )
    return true
  return false
}

/** network-level failures (timeouts, reset sockets) are also worth a retry */
function isRetryableException(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  return /timeout|abort|network|ECONNRESET|ETIMEDOUT|socket|fetch failed/i.test(msg)
}

export interface RetryStats {
  attempts: number
  retries: number
  modelUsed?: string
}

/** Run `fn` for one model with the retry/backoff policy. `fn` returns either
 * `{ok:true,value}` or `{ok:false,status,payload,res}`; network exceptions are
 * retried too. Throws the last error once the schedule is exhausted. */
async function withModelRetries<T>(
  fn: (attempt: number, lastRes?: Response) => Promise<{ ok: true; value: T } | { ok: false; status: number; payload: string; res?: Response }>,
  onRetry?: (info: { attempt: number; delayMs: number; status: number | 'network'; payload: string }) => void,
): Promise<T> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const r = await fn(attempt)
      if (r.ok) return r.value
      const retryable = isRetryableError(r.status, r.payload)
      lastErr = new Error(`${r.status}: ${r.payload.slice(0, 300)}`)
      if (!retryable || attempt === RETRY_DELAYS_MS.length) throw lastErr
      const delay = backoffMs(attempt, r.res)
      onRetry?.({ attempt, delayMs: delay, status: r.status, payload: r.payload.slice(0, 160) })
      await sleep(delay)
    } catch (e) {
      // a thrown non-Error from fn means it already decided to give up
      if (e instanceof Error && lastErr === e) throw e
      if (!isRetryableException(e) || attempt === RETRY_DELAYS_MS.length) throw e
      const delay = backoffMs(attempt)
      onRetry?.({ attempt, delayMs: delay, status: 'network', payload: (e as Error).message.slice(0, 160) })
      await sleep(delay)
    }
  }
  throw lastErr || new Error('upstream retries exhausted')
}

/* ------------------------------------------------------------------ types */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatBody {
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  thinking?: { type: 'disabled' | 'enabled' }
  /** optional primary model override (UI selector, whitelisted upstream) */
  model?: string
}

export interface ChatCompletion {
  choices: { message: { content: string; reasoning_content?: string }; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

/* ------------------------------------------------------- chat (non-stream) */

async function officialComplete(cfg: ZaiConfig, body: ChatBody): Promise<ChatCompletion> {
  let lastError = ''
  for (const model of chatModels(body.model)) {
    try {
      return await withModelRetries(async () => {
        const res = await post(cfg, '/chat/completions', {
          model,
          messages: body.messages,
          stream: false,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          thinking: body.thinking || { type: 'disabled' },
        })
        const text = await res.text()
        if (res.ok) {
          try {
            return { ok: true as const, value: JSON.parse(text) as ChatCompletion }
          } catch {
            // undecodable 200 answer — pointless on the same model
            throw new Error(`bad JSON from ${model}: ${text.slice(0, 160)}`)
          }
        }
        return { ok: false as const, status: res.status, payload: text, res }
      })
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      // keep walking the chain only for overload/limit-style failures
      // (status codes, known wording, or network timeouts)
      const chainWorthy =
        isRetryableError(Number(lastError.match(/^(\d{3}):/)?.[1] || 0), lastError) ||
        /rate|нагрузк|перегруж|调用过高|算力|timeout|abort|fetch failed/i.test(lastError) ||
        /bad JSON/.test(lastError)
      if (!chainWorthy) break
      // overloaded / rate-limited after all retries — try the next model
    }
  }
  throw new Error(`Z.ai chat/completions не удалось: ${lastError}`)
}

/* --------------------------------------------------------- chat (stream) */

export interface StreamChunk {
  content: string
  reasoning: string
}

/**
 * Streaming chat completion. Returns a ReadableStream of OpenAI-style
 * `data: {...}` SSE lines WITH the `model` field set to the model actually
 * used (the chain may fall back). Callers parse delta.content /
 * delta.reasoning_content.
 */
export async function officialStream(
  body: ChatBody,
): Promise<ReadableStream<Uint8Array>> {
  const cfg = config()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const tryModelOnce = async (model: string) => {
    const res = await post(cfg, '/chat/completions', {
      model,
      messages: body.messages,
      stream: true,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      thinking: body.thinking || { type: 'disabled' },
    })
    if (res.ok) return res
    const text = await res.text().catch(() => '')
    return { status: res.status, payload: text, res } as const
  }

  // resolve the first working model (with per-model retry/backoff), then stream
  let upstream: Response | null = null
  let lastError: Error | null = null
  for (const model of chatModels(body.model)) {
    try {
      upstream = await withModelRetries(async () => {
        const r = await tryModelOnce(model)
        if (r instanceof Response) return { ok: true as const, value: r }
        return { ok: false as const, status: r.status, payload: r.payload, res: r.res }
      })
      // stash the model name for the first SSE payload
      const src = upstream.body as ReadableStream<Uint8Array>
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          // announce which model is answering (useful for debugging/fallback)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model_used: model })}\n\n`))
          const reader = src.getReader()
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              controller.enqueue(value)
            }
          } finally {
            reader.releaseLock()
            controller.close()
          }
        },
        cancel() {
          void upstream?.body?.cancel().catch(() => {})
        },
      })
    } catch (e) {
      lastError = e as Error
      const retryable = (e as { retryable?: boolean }).retryable
      if (!retryable) break
    }
  }
  throw new Error(
    `Z.ai chat/completions (stream) не удалось: ${lastError?.message?.slice(0, 300) || 'нет доступных моделей'}`,
  )
}

/* --------------------------------------------------------- free web tools */

interface SearchItem {
  url: string
  name: string
  snippet: string
  host_name: string
  date?: string
}

const stripHtml = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

/** Bing RSS: bot-lenient, clean XML, no key required. */
async function bingSearch(query: string, num: number): Promise<SearchItem[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${Math.max(num, 10)}&setlang=${encodeURIComponent(String(process.env.SEARCH_LANG || 'en'))}&cc=US`
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`bing rss ${res.status}`)
  const xml = await res.text()
  const items: SearchItem[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) && items.length < num) {
    const block = m[1]
    const tag = (t: string) => {
      const mm = block.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))
      return mm ? stripHtml(mm[1]) : ''
    }
    const name = tag('title')
    const link = tag('link')
    if (!name || !/^https?:\/\//.test(link)) continue
    let host = ''
    try { host = new URL(link).hostname } catch { continue }
    items.push({ url: link, name, snippet: tag('description').slice(0, 400), host_name: host })
  }
  if (items.length === 0) throw new Error('bing rss: пустой результат')
  return items
}

/** DuckDuckGo HTML fallback (may be bot-gated from some datacenter IPs). */
async function ddgSearch(query: string, num: number): Promise<SearchItem[]> {
  const endpoints = [
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  ]
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) continue
      const html = await res.text()
      const items: SearchItem[] = []
      let m: RegExpExecArray | null
      const seen = new Set<string>()
      const activeRe = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      while ((m = activeRe.exec(html)) && items.length < num) {
        let url = m[1]
        const name = stripHtml(m[2])
        if (!name || name.length < 3) continue
        if (url.startsWith('//')) url = `https:${url}`
        try {
          const u = new URL(url)
          if (/duckduckgo\.com$/.test(u.hostname)) continue
          if (u.hostname === 'localhost') continue
          if (seen.has(u.href)) continue
          seen.add(u.href)
          items.push({ url: u.href, name, snippet: '', host_name: u.hostname })
        } catch { /* bad url */ }
      }
      const snipRe = /(?:class="result-snippet"[^>]*>|class="result__snippet"[^>]*>)([\s\S]*?)<\/(?:td|a)>/gi
      let si = 0
      let s: RegExpExecArray | null
      while ((s = snipRe.exec(html)) && si < items.length) {
        items[si].snippet = stripHtml(s[1]).slice(0, 400)
        si++
      }
      if (items.length > 0) return items
    } catch {
      continue
    }
  }
  throw new Error('DuckDuckGo недоступен')
}

/** search: Bing RSS primary, DuckDuckGo fallback */
async function freeWebSearch(query: string, num: number): Promise<SearchItem[]> {
  try {
    return await bingSearch(query, num)
  } catch {
    return await ddgSearch(query, num)
  }
}

async function readPage(url: string): Promise<{ data: { html: string; title: string } }> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`read_page ${res.status}`)
  const raw = (await res.text()).slice(0, 300_000)
  const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim()
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { data: { html: text.slice(0, 60_000), title } }
}

/* ---------------------------------------------------------------- public */

export const zai = {
  chat: {
    /** non-streaming chat completion (streaming lives in streamChat) */
    async completions(body: ChatBody): Promise<ChatCompletion> {
      const cfg = config()
      return officialComplete(cfg, body)
    },
  },

  /** streaming chat: returns an SSE ReadableStream of OpenAI-style chunks
   * (first event carries { model_used } — the fallback chain result). */
  async streamChat(body: ChatBody): Promise<ReadableStream<Uint8Array>> {
    return officialStream(body)
  },

  images: {
    generations: {
      /** official api (CogView-3-Flash is free). Returns base64 PNG. */
      async create(body: { prompt: string; size?: string }): Promise<{ data: { base64: string; format: string }[] }> {
        const cfg = config()
        const model = DEFAULT_IMAGE_MODEL
        const res = await post(
          cfg,
          '/images/generations',
          { model, prompt: body.prompt, size: body.size || '1024x1024' },
          180_000,
        )
        const text = await res.text()
        if (!res.ok) throw new Error(`Z.ai images/generations ${res.status}: ${text.slice(0, 300)}`)
        const result = JSON.parse(text) as {
          data: ({ base64?: string; url?: string; format?: string })[]
        }
        const data = await Promise.all(
          (result.data || []).map(async (item) => {
            if (item.base64) return { base64: item.base64, format: item.format || 'png' }
            if (item.url) {
              const img = await fetch(item.url)
              const buf = Buffer.from(await img.arrayBuffer())
              return { base64: buf.toString('base64'), format: 'png' }
            }
            throw new Error('generator returned neither base64 nor url')
          }),
        )
        return { data }
      },
    },
  },

  functions: {
    /** key-free web tools (web_search / page_reader) */
    async invoke(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ data?: unknown } & Record<string, unknown>> {
      if (name === 'web_search') {
        const query = String(args.query || '').trim()
        const num = Math.min(Math.max(Number(args.num) || 5, 1), 10)
        if (!query) throw new Error('web_search: пустой query')
        return (await freeWebSearch(query, num)) as unknown as { data?: unknown }
      }
      if (name === 'page_reader') {
        const url = String(args.url || '').trim()
        if (!/^https?:\/\//.test(url)) throw new Error('read_page: нужен http(s) URL')
        return await readPage(url)
      }
      throw new Error(`unknown function: ${name}`)
    },
  },
}

export default zai
