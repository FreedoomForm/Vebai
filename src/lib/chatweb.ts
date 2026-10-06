/**
 * Chat.z.ai web-protocol client (v2, reverse-engineered).
 *
 * Protocol (verified live, refs: orbitoo/zai2api, gpt4free GLM provider):
 *   1. GET  /api/v1/auths/          -> session {token, id, name, email, role}
 *      - with `Authorization: Bearer <ZAI_JWT>` refreshes a real account;
 *      - without auth mints an anonymous guest session.
 *   2. POST /api/v1/chats/new       -> chat record id (server-side history stub)
 *   3. POST /api/v2/chat/completions?{fingerprint}&signature_timestamp={ms}
 *      headers: Authorization, X-Signature (HMAC-SHA256), X-FE-Version
 *      SSE: data: {"type":"chat:completion","data":{phase, delta_content, ...}}
 *
 * The public API of this module emits OpenAI-compatible SSE chunks
 * (`choices[0].delta.content`), so the agent loop stays unchanged.
 *
 * Captcha note: anonymous guest sessions are rate-limited by an Aliyun
 * captcha on chat.z.ai (FRONTEND_CAPTCHA_REQUIRED). Real accounts used via
 * ZAI_JWT (or a user's own token) are not affected. When the captcha is
 * required we surface a clear, actionable error message.
 */

import crypto from 'node:crypto'

const BASE = process.env.ZAI_CHATWEB_BASE_URL || 'https://chat.z.ai'
const FE_VERSION = 'prod-fe-1.0.272'
const SIGNING_SECRET = 'key-@@@@)))()((9))-xxxx&&&%%%%%'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

export const DEFAULT_CHATWEB_MODEL = process.env.ZAI_CHATWEB_MODEL || 'glm-4.7'

export class ChatWebError extends Error {
  code: string
  constructor(message: string, code = 'chatweb_error') {
    super(message)
    this.code = code
  }
}

/* ------------------------------------------------------------- session */

export interface ChatWebSession {
  token: string
  userId: string
  name: string
  email: string
  role: string
}

const commonHeaders = (): Record<string, string> => ({
  'User-Agent': UA,
  'Accept-Language': 'en-US',
  Origin: BASE,
  Referer: `${BASE}/`,
})

/** Exchange a (possibly stale) JWT for a fresh session, or mint a guest one. */
export async function resolveSession(userToken?: string | null): Promise<ChatWebSession> {
  const res = await fetch(`${BASE}/api/v1/auths/`, {
    headers: {
      ...commonHeaders(),
      ...(userToken ? { Authorization: `Bearer ${userToken}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    if (res.status === 401 && userToken)
      throw new ChatWebError(
        'Токен chat.z.ai недействителен (401). Обнови его: войди на chat.z.ai и скопируй свежий token из Local Storage, либо удали свой токен в настройках.',
        'invalid_token',
      )
    throw new ChatWebError(`chat.z.ai auth ${res.status}: ${txt.slice(0, 200)}`, 'auth_failed')
  }
  const data = (await res.json()) as {
    token: string
    id: string
    name?: string
    email?: string
    role?: string
  }
  return {
    token: data.token,
    userId: data.id,
    name: data.name || 'User',
    email: data.email || '',
    role: data.role || 'user',
  }
}

/* ------------------------------------------------------------- signing */

function signPrompt(requestId: string, timestampMs: string, userId: string, prompt: string): string {
  const payload = { requestId, timestamp: timestampMs, user_id: userId }
  const sortedPayload = Object.keys(payload)
    .sort()
    .map((k) => `${k},${payload[k as keyof typeof payload]}`)
    .join(',')
  const promptB64 = Buffer.from(prompt, 'utf8').toString('base64')
  const bucket = String(Math.floor(Number(timestampMs) / (5 * 60 * 1000)))
  const key1 = crypto.createHmac('sha256', SIGNING_SECRET).update(bucket).digest('hex')
  return crypto.createHmac('sha256', key1).update(`${sortedPayload}|${promptB64}|${timestampMs}`).digest('hex')
}

function fingerprintQuery(session: ChatWebSession, requestId: string, timestampMs: string): string {
  const now = new Date()
  const q: Record<string, string> = {
    requestId,
    timestamp: timestampMs,
    user_id: session.userId,
    version: '0.0.1',
    platform: 'web',
    token: session.token,
    user_agent: UA,
    language: 'en-US',
    languages: 'en-US,en',
    timezone: 'Asia/Taipei',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    screen_resolution: '1920x1080',
    viewport_height: '1080',
    viewport_width: '1920',
    viewport_size: '1920x1080',
    color_depth: '24',
    pixel_ratio: '1',
    current_url: `${BASE}/`,
    pathname: '/',
    search: '',
    hash: '',
    host: 'chat.z.ai',
    hostname: 'chat.z.ai',
    protocol: 'https:',
    referrer: `${BASE}/`,
    title: 'Z.ai - Free AI Chatbot & Agent powered by GLM',
    timezone_offset: '-480',
    local_time: now.toUTCString().replace('GMT', 'GMT'),
    utc_time: now.toUTCString(),
    is_mobile: 'false',
    is_touch: 'false',
    max_touch_points: '0',
    browser_name: 'Chrome',
    os_name: 'Linux',
  }
  return new URLSearchParams(q).toString()
}

/* ------------------------------------------------------------- prompt */

export interface PlainMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Render the multi-turn transcript into GLM's chat-template prompt
 * (orbitoo/zai2api prompt_assembly: first non-assistant bare, subsequent
 * non-assistant as <|User|>, assistant as <|Assistant|>…<|end▁of▁sentence|>). */
export function renderPrompt(messages: PlainMessage[]): string {
  const parts: string[] = []
  let firstNonAssistant = true
  for (const m of messages) {
    const content = (m.content || '').trim()
    if (!content) continue
    if (m.role === 'assistant') {
      parts.push(`<｜Assistant｜>${content}<｜end▁of▁sentence｜>`)
      continue
    }
    if (firstNonAssistant) {
      parts.push(content)
      firstNonAssistant = false
    } else {
      parts.push(`<｜User｜>${content}`)
    }
  }
  return parts.join('\n\n').trim()
}

/* ------------------------------------------------------------- chat record */

async function createChatRecord(session: ChatWebSession, model: string, prompt: string): Promise<string> {
  const userMessageId = crypto.randomUUID()
  const body = {
    chat: {
      id: '',
      title: 'New Chat',
      models: [model],
      history: {
        currentId: userMessageId,
        messages: {
          [userMessageId]: {
            id: userMessageId,
            parentId: null,
            childrenIds: [],
            role: 'user',
            content: prompt,
            timestamp: Math.floor(Date.now() / 1000),
            models: [model],
          },
        },
      },
      tags: [],
      flags: [],
      features: [],
      mcp_servers: [],
      enable_thinking: false,
      auto_web_search: false,
      message_version: 1,
      timestamp: Date.now(),
    },
  }
  const res = await fetch(`${BASE}/api/v1/chats/new`, {
    method: 'POST',
    headers: { ...commonHeaders(), Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new ChatWebError(`chat.z.ai chats/new ${res.status}: ${txt.slice(0, 200)}`, 'chat_new_failed')
  }
  const data = (await res.json()) as { id?: string }
  return data.id || userMessageId
}

/* ------------------------------------------------------------- completions */

function mapUpstreamError(err: { detail?: unknown; code?: unknown; error_code?: unknown }): ChatWebError {
  const code = String(err.code ?? err.error_code ?? '')
  const detail = typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail ?? err)
  if (code.includes('CAPTCHA') || /captcha/i.test(detail))
    return new ChatWebError(
      'Z.ai требует капчу для анонимных сессий. Решение: задай ZAI_JWT (токен реального аккаунта chat.z.ai) в переменных окружения Vercel — см. README, раздел «Прокси chat.z.ai».',
      'captcha_required',
    )
  if (/user level/i.test(detail) || code === '403')
    return new ChatWebError(
      `Модель недоступна для текущего уровня аккаунта Z.ai (${detail.slice(0, 120)}). Выбери модель попроще через ZAI_CHATWEB_MODEL (например glm-4.7) или используй аккаунт с подпиской.`,
      'model_level',
    )
  return new ChatWebError(`chat.z.ai: ${detail.slice(0, 200)}`, 'upstream_error')
}

function cleanAnswerDelta(text: string): string {
  // strips model-side wrappers that leak into answer deltas
  let out = text.replace(/<glm_block[\s\S]*?<\/glm_block>/g, '')
  const detailsIdx = out.lastIndexOf('</details>')
  if (detailsIdx >= 0) out = out.slice(detailsIdx + '</details>'.length)
  out = out.replace(/<\/?details[^>]*>/g, '').replace(/<summary[^>]*>[\s\S]*?<\/summary>/g, '')
  return out
}

interface UpstreamEventData {
  phase?: string
  delta_content?: string
  edit_content?: string
  done?: boolean
  usage?: unknown
  error?: { detail?: unknown; code?: unknown; error_code?: unknown }
}

/** Low-level: open the signed v2 SSE stream and yield raw upstream events. */
async function* upstreamEvents(
  session: ChatWebSession,
  prompt: string,
  model: string,
): AsyncGenerator<{ data: UpstreamEventData }> {
  const timestampMs = String(Date.now())
  const requestId = crypto.randomUUID()
  const signature = signPrompt(requestId, timestampMs, session.userId, prompt)
  const recordId = await createChatRecord(session, model, prompt)

  const body = {
    stream: true,
    model,
    messages: [{ role: 'user', content: prompt }],
    signature_prompt: prompt.slice(0, 500),
    params: {},
    extra: {},
    features: {
      image_generation: false,
      web_search: false,
      auto_web_search: false,
      preview_mode: false,
      flags: [],
      enable_thinking: false,
    },
    variables: {
      '{{USER_NAME}}': session.name,
      '{{USER_LOCATION}}': 'Unknown',
      '{{CURRENT_DATETIME}}': new Date().toISOString().slice(0, 19).replace('T', ' '),
      '{{CURRENT_DATE}}': new Date().toISOString().slice(0, 10),
      '{{USER_LANGUAGE}}': 'ru-RU',
    },
    chat_id: recordId,
    id: crypto.randomUUID(),
    current_user_message_id: crypto.randomUUID(),
    current_user_message_parent_id: null,
    background_tasks: { title_generation: false, tags_generation: false },
    captcha_verify_param: '',
    stream_options: { include_usage: true },
  }

  const url = `${BASE}/api/v2/chat/completions?${fingerprintQuery(session, requestId, timestampMs)}&signature_timestamp=${timestampMs}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...commonHeaders(),
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Signature': signature,
      'X-FE-Version': FE_VERSION,
      'X-Device-Id': crypto.randomUUID(),
      'X-Region': 'overseas',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  })
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '')
    let parsed: { detail?: unknown; code?: unknown } | null = null
    try { parsed = JSON.parse(txt) } catch { /* raw text */ }
    if (parsed && (parsed.code || parsed.detail)) throw mapUpstreamError(parsed as never)
    throw new ChatWebError(`chat.z.ai completions ${res.status}: ${txt.slice(0, 200)}`, 'http_error')
  }

  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const event = JSON.parse(payload) as { type?: string; data?: UpstreamEventData }
          if (event.type && event.type !== 'chat:completion') continue
          yield { data: event.data || {} }
        } catch { /* partial line */ }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* noop */ }
  }
}

function openaiChunk(delta: { content?: string }, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 29)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'chat.z.ai',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

/** Streaming chat via chat.z.ai -> OpenAI-compatible SSE chunks.
 * `userToken` = the caller's own chat.z.ai JWT; falls back to ZAI_JWT env,
 * then to an anonymous guest session. */
export async function chatWebStream(
  messages: PlainMessage[],
  opts?: { userToken?: string | null; model?: string },
): Promise<ReadableStream<Uint8Array>> {
  const model = opts?.model || DEFAULT_CHATWEB_MODEL
  const session = await resolveSession(opts?.userToken || process.env.ZAI_JWT || null)
  const prompt = renderPrompt(messages)
  if (!prompt) throw new ChatWebError('Пустой промпт', 'empty_prompt')
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => {
        try { controller.enqueue(enc.encode(s)) } catch { /* closed */ }
      }
      try {
        for await (const { data } of upstreamEvents(session, prompt, model)) {
          if (data.error) throw mapUpstreamError(data.error)
          const phase = data.phase || 'answer'
          if (phase === 'other') continue
          if (phase === 'thinking') continue // agent runs with thinking disabled
          const raw = data.edit_content ?? data.delta_content ?? ''
          const text = cleanAnswerDelta(raw)
          if (text) push(openaiChunk({ content: text }))
          if (data.done) break
        }
        push(openaiChunk({}, 'stop'))
        push('data: [DONE]\n\n')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        push(
          `data: ${JSON.stringify({
            error: { message: msg },
          })}\n\n`,
        )
        push(openaiChunk({ content: `\n\n[Ошибка Z.ai-прокси: ${msg.slice(0, 300)}]` }, 'stop'))
        push('data: [DONE]\n\n')
      } finally {
        try { controller.close() } catch { /* already closed */ }
      }
    },
  })
}

/** Non-streaming chat via chat.z.ai (collects the stream). */
export async function chatWebComplete(
  messages: PlainMessage[],
  opts?: { userToken?: string | null; model?: string },
): Promise<{ choices: { message: { content: string } }[] }> {
  const stream = await chatWebStream(messages, opts)
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of block.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }
          out += chunk?.choices?.[0]?.delta?.content || ''
        } catch { /* ignore */ }
      }
    }
  }
  return { choices: [{ message: { content: out } }] }
}
