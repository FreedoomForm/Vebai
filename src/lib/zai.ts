/**
 * Unified Z.ai access layer for Vebai.
 *
 * Two backends for chat:
 *   1. chatweb (default) — the chat.z.ai web protocol (src/lib/chatweb.ts).
 *      Credentials: ZAI_JWT env (site-wide) -> anonymous guest session.
 *   2. official — the paid OpenAI-compatible api.z.ai (ZAI_BASE_URL+ZAI_API_KEY),
 *      enabled with ZAI_MODE=official. Image generation always needs it.
 *
 * Web tools (web_search / page_reader) are implemented key-free here so the
 * agent works on Vercel without the sandbox-only SDK.
 */

import {
  chatWebStream,
  chatWebComplete,
  ChatWebError,
  DEFAULT_CHATWEB_MODEL,
  type ChatWebTransport,
  type PlainMessage,
} from './chatweb'

export type { ChatWebTransport } from './chatweb'

export interface ZaiConfig {
  baseUrl: string
  apiKey: string
  token?: string
  chatId?: string
  userId?: string
}

const OFFICIAL_MODE = process.env.ZAI_MODE === 'official'

function fromEnv(): ZaiConfig | null {
  const baseUrl = process.env.ZAI_BASE_URL
  const apiKey = process.env.ZAI_API_KEY
  if (!baseUrl || !apiKey) return null
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    token: process.env.ZAI_TOKEN || undefined,
    chatId: process.env.ZAI_CHAT_ID || undefined,
    userId: process.env.ZAI_USER_ID || undefined,
  }
}

async function loadOfficialConfig(): Promise<ZaiConfig> {
  const cfg = fromEnv()
  if (!cfg)
    throw new Error(
      'Официальный Z.ai API не настроен: задай ZAI_BASE_URL + ZAI_API_KEY (и ZAI_MODE=official) — или используй режим chat.z.ai (ZAI_JWT).',
    )
  return cfg
}

function buildHeaders(cfg: ZaiConfig): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
    'X-Z-AI-From': 'Z',
  }
  if (cfg.chatId) h['X-Chat-Id'] = cfg.chatId
  if (cfg.userId) h['X-User-Id'] = cfg.userId
  if (cfg.token) h['X-Token'] = cfg.token
  return h
}

async function post(cfg: ZaiConfig, urlPath: string, body: unknown): Promise<Response> {
  const res = await fetch(`${cfg.baseUrl}${urlPath}`, {
    method: 'POST',
    headers: buildHeaders(cfg),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Z.ai ${urlPath} ${res.status}: ${txt.slice(0, 300)}`)
  }
  return res
}

/* ------------------------------------------------------------------ types */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatBody {
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  thinking?: { type: 'disabled' | 'enabled' }
  [k: string]: unknown
}

/* ------------------------------------------------------- chat routing */

function chatBackend(): 'chatweb' | 'official' {
  // chatweb by default: it needs no paid key (ZAI_JWT / BYO / guest).
  // Official paid API is opt-in via ZAI_MODE=official.
  return OFFICIAL_MODE ? 'official' : 'chatweb'
}

async function officialStream(cfg: ZaiConfig, body: ChatBody): Promise<ReadableStream<Uint8Array>> {
  const res = await post(cfg, '/chat/completions', {
    ...body,
    stream: true,
    thinking: body.thinking || { type: 'disabled' },
  })
  return res.body as ReadableStream<Uint8Array>
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) continue
      const html = await res.text()
      const items: SearchItem[] = []
      let m: RegExpExecArray | null
      const seen = new Set<string>()
      // external result links (lite + html layouts both emit plain <a href>)
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
      // snippets: <td class="result-snippet">...</td> (lite) or <a class="result__snippet">
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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
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
    async completions(
      body: ChatBody,
    ): Promise<{ choices: { message: { content: string } }[] }> {
      if (chatBackend() === 'official') {
        const cfg = await loadOfficialConfig()
        const res = await post(cfg, '/chat/completions', {
          ...body,
          stream: false,
          thinking: body.thinking || { type: 'disabled' },
        })
        return (await res.json()) as { choices: { message: { content: string } }[] }
      }
      return chatWebComplete(body.messages as PlainMessage[], {
        model: DEFAULT_CHATWEB_MODEL,
        transport: body.transport as ChatWebTransport | undefined,
      })
    },
  },

  /** streaming chat: returns an SSE ReadableStream of OpenAI-style chunks.
   * transport carries the per-user session token + one-time captcha param. */
  async streamChat(
    body: ChatBody,
    transport?: ChatWebTransport,
  ): Promise<ReadableStream<Uint8Array>> {
    if (chatBackend() === 'official') {
      const cfg = await loadOfficialConfig()
      return officialStream(cfg, body)
    }
    return chatWebStream(body.messages as PlainMessage[], {
      model: DEFAULT_CHATWEB_MODEL,
      transport: (transport || (body.transport as ChatWebTransport | undefined)),
    })
  },

  images: {
    generations: {
      /** official api.z.ai only (CogView). Returns base64 PNG like the stock SDK. */
      async create(body: { prompt: string; size?: string }): Promise<{ data: { base64: string; format: string }[] }> {
        const cfg = await loadOfficialConfig()
        const res = await post(cfg, '/images/generations', body)
        const result = (await res.json()) as {
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
    /** key-free web tools (web_search / page_reader); anything else needs the official key */
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
      const cfg = await loadOfficialConfig()
      const res = await post(cfg, '/functions/invoke', { name, args })
      return (await res.json()) as { data?: unknown } & Record<string, unknown>
    },
  },
}

export { ChatWebError }
export default zai
