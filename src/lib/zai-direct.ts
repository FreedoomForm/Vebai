/**
 * BROWSER-DIRECT chat.z.ai client (v11).
 *
 * Byte-level live checks (2026-10) proved chat.z.ai's API answers with
 * PERMISSIVE CORS: `access-control-allow-origin: <any origin>` +
 * `access-control-allow-credentials: true` and a preflight whitelist that
 * includes `authorization, x-signature, x-fe-version`. That means the
 * USER'S BROWSER can talk to chat.z.ai directly — exactly like chat.z.ai's
 * own frontend does:
 *
 *   - no Vercel datacenter IP in the AI path at all: no WAF blocks, no
 *     shared rate limits, no 300s function cap on long agent turns;
 *   - every user's session/quota is naturally their own (their browser,
 *     their JWT, their limits).
 *
 * CAPTCHA (v12, live-probed): when Z.ai's risk engine demands a captcha on
 * chat completions it answers {code: FRONTEND_CAPTCHA_REQUIRED}. Their own
 * frontend then pops the Aliyun Captcha 2.0 widget IN-PAGE and retries with
 * the one-time captcha_verify_param. The scene is HOSTNAME-CONDITIONAL in
 * their bundle:
 *     SceneId = hostname === 'chat.z.ai' ? 'didk33e0' : 'xswyjefn'
 * i.e. Z.ai officially ships a foreign-domain scene (xswyjefn, region sgp,
 * prefix no8xfe, popup mode). Live probe on our domain: the widget loads,
 * issues a certifyId and returns verdicts — the scene accepts foreign
 * hostnames (an F015 verdict is a headless-client risk block, NOT a domain
 * rejection). So solveChatCaptcha() below replicates their BN() flow
 * byte-for-byte: hidden trigger -> popup -> solve -> param -> retry.
 *
 * Signing: chat.z.ai signs completions with a double HMAC-SHA256 whose
 * secret ships in their public bundle (`key-@@@@...)`). Here it runs via
 * WebCrypto — same bytes as the server implementation in chatweb.ts.
 *
 * Silent-downgrade guard (ported from chatweb.ts): a stale/revoked Bearer
 * does NOT 401 on GET /auths/ — it silently mints a GUEST session. We
 * detect that by comparing JWT identities and throw `zai_session_expired`
 * so a dead session can never masquerade as a linked account.
 */

export const ZAI_BASE = 'https://chat.z.ai'

/** chat.z.ai's current frontend build — the WAF rejects older versions. */
const FE_VERSIONS = ['prod-fe-1.1.98', 'prod-fe-1.0.272']

const SIGNING_SECRET = 'key-@@@@)))()((9))-xxxx&&&%%%%%'

const GUEST_EMAIL_RE = /^guest-\d+@guest\.com$/i

/** Agent-capable models (capabilities.agent_mode on chat.z.ai). */
const AGENT_MODEL_RE = /x-preview|glm-5|GLM-5/i
export function isAgentModel(model: string): boolean {
  return AGENT_MODEL_RE.test(model)
}

/* ------------------------------------------------------------- jwt utils */

export function peekJwtEmail(token: string): string {
  try {
    const pl = token.split('.')[1] || ''
    const json = JSON.parse(atob(pl.replace(/-/g, '+').replace(/_/g, '/')))
    return String(json.email || '')
  } catch {
    return ''
  }
}

export function isGuestToken(token: string | null | undefined): boolean {
  if (!token) return true
  const email = peekJwtEmail(token)
  return !email || GUEST_EMAIL_RE.test(email)
}

/* --------------------------------------------------------------- storage */

const LS_JWT = 'vebai_zai_jwt'
const LS_DEVICE = 'vebai_zai_device_id'

export function getStoredJwt(): string | null {
  try {
    return localStorage.getItem(LS_JWT)
  } catch {
    return null
  }
}

export function setStoredJwt(token: string): void {
  try {
    localStorage.setItem(LS_JWT, token)
  } catch { /* private mode */ }
}

export function clearStoredJwt(): void {
  try {
    localStorage.removeItem(LS_JWT)
  } catch { /* noop */ }
}

/** Stable per-browser device id (chat.z.ai sends X-Device-Id per request). */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(LS_DEVICE)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(LS_DEVICE, id)
    }
    return id
  } catch {
    return crypto.randomUUID()
  }
}

/* ---------------------------------------------------------------- errors */

export class ZaiDirectError extends Error {
  code: string
  constructor(message: string, code = 'zai_error') {
    super(message)
    this.code = code
  }
}

/* ---------------------------------------------------------------- session */

export interface ZaiSession {
  token: string
  userId: string
  name: string
  email: string
  role: string
}

function commonHeaders(): Record<string, string> {
  return {
    'Accept-Language': navigator.language || 'en-US',
    Origin: ZAI_BASE,
    Referer: `${ZAI_BASE}/`,
  }
}

/**
 * Refresh a session JWT (sliding expiry).
 * Guard (silent-downgrade): a REAL token must never come back as a guest
 * session — that means the account JWT died. A PERSONAL (guest-class)
 * session refreshing into a guest session is the normal sliding path.
 */
export async function refreshSession(userToken: string): Promise<ZaiSession> {
  const wasGuest = isGuestToken(userToken)
  const res = await fetch(`${ZAI_BASE}/api/v1/auths/`, {
    headers: { ...commonHeaders(), Authorization: `Bearer ${userToken}` },
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    if (res.status === 401)
      throw new ZaiDirectError(
        wasGuest
          ? 'Личная сессия Z.ai истекла — обновляю…'
          : 'Сессия chat.z.ai недействительна (401). Подключи аккаунт заново (кнопка «Z.ai»).',
        wasGuest ? 'personal_session_expired' : 'zai_session_expired',
      )
    throw new ZaiDirectError(`chat.z.ai auth ${res.status}: ${txt.slice(0, 160)}`, 'auth_failed')
  }
  const data = (await res.json()) as {
    token: string
    id: string
    name?: string
    email?: string
    role?: string
  }
  if (!wasGuest && GUEST_EMAIL_RE.test(String(data.email || ''))) {
    throw new ZaiDirectError(
      'Сессия chat.z.ai истекла — аккаунт подключён, но токен устарел. Подключи аккаунт заново (кнопка «Z.ai»).',
      'zai_session_expired',
    )
  }
  return {
    token: data.token,
    userId: data.id,
    name: data.name || 'User',
    email: data.email || '',
    role: data.role || 'user',
  }
}

/**
 * Resolve the session for chatting: the stored token (personal or real) →
 * refresh → persist the sliding value. A dead PERSONAL token is re-minted
 * transparently (fresh personal quota bucket); a dead REAL token throws
 * zai_session_expired.
 */
async function resolveChatSession(): Promise<ZaiSession> {
  const stored = getStoredJwt()
  if (!stored) {
    // v12: the browser may not have received the personal token yet
    // (e.g. this turn is the first after an old login) — the caller
    // (agent-app) passes it from /api/chat/start; without any token we
    // cannot chat
    throw new ZaiDirectError(
      'Личная сессия Z.ai ещё не подключена — отправь сообщение ещё раз, она подключится автоматически.',
      'zai_not_linked',
    )
  }
  try {
    const session = await refreshSession(stored)
    setStoredJwt(session.token) // sliding refresh
    return session
  } catch (e) {
    if (e instanceof ZaiDirectError && e.code === 'personal_session_expired') {
      // re-mint a fresh personal session (guest mint: no auth header)
      const res = await fetch(`${ZAI_BASE}/api/v1/auths/`, { headers: commonHeaders() })
      if (!res.ok) throw new ZaiDirectError(`chat.z.ai auth ${res.status}`, 'auth_failed')
      const data = (await res.json()) as {
        token: string
        id: string
        name?: string
        email?: string
        role?: string
      }
      const fresh: ZaiSession = {
        token: data.token,
        userId: data.id,
        name: data.name || 'User',
        email: data.email || '',
        role: data.role || 'user',
      }
      setStoredJwt(fresh.token)
      return fresh
    }
    throw e
  }
}

/* ---------------------------------------------------------------- signing */

async function hmacRaw(key: string | Uint8Array, msg: string): Promise<string> {
  const kc = typeof key === 'string' ? new TextEncoder().encode(key) : key
  const k = await crypto.subtle.importKey(
    'raw',
    kc as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** base64 (utf-8 safe, chunked — spread on huge prompts overflows the stack) */
function b64encodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** Double-HMAC prompt signature — byte-identical to chat.z.ai's frontend. */
async function signPrompt(
  requestId: string,
  timestampMs: string,
  userId: string,
  prompt: string,
): Promise<string> {
  const payload = { requestId, timestamp: timestampMs, user_id: userId }
  const sortedPayload = Object.keys(payload)
    .sort()
    .map((k) => `${k},${payload[k as keyof typeof payload]}`)
    .join(',')
  const promptB64 = b64encodeUtf8(prompt)
  const bucket = String(Math.floor(Number(timestampMs) / (5 * 60 * 1000)))
  const key1 = await hmacRaw(SIGNING_SECRET, bucket)
  return hmacRaw(key1, `${sortedPayload}|${promptB64}|${timestampMs}`)
}

/** Real browser fingerprint (chat.z.ai collects the same fields). */
function fingerprintQuery(session: ZaiSession, requestId: string, timestampMs: string): string {
  const now = new Date()
  const q: Record<string, string> = {
    requestId,
    timestamp: timestampMs,
    user_id: session.userId,
    version: '0.0.1',
    platform: 'web',
    token: session.token,
    user_agent: navigator.userAgent,
    language: navigator.language || 'en-US',
    languages: (navigator.languages || ['en-US']).join(','),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    cookie_enabled: String(navigator.cookieEnabled),
    screen_width: String(screen.width),
    screen_height: String(screen.height),
    screen_resolution: `${screen.width}x${screen.height}`,
    viewport_height: String(window.innerHeight),
    viewport_width: String(window.innerWidth),
    viewport_size: `${window.innerWidth}x${window.innerHeight}`,
    color_depth: String(screen.colorDepth),
    pixel_ratio: String(window.devicePixelRatio || 1),
    current_url: location.href,
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    host: location.host,
    hostname: location.hostname,
    protocol: location.protocol,
    referrer: document.referrer || `${ZAI_BASE}/`,
    title: document.title,
    timezone_offset: String(-new Date().getTimezoneOffset()),
    local_time: now.toUTCString(),
    utc_time: now.toUTCString(),
    is_mobile: String(/Mobi|Android/i.test(navigator.userAgent)),
    is_touch: String('ontouchstart' in window || navigator.maxTouchPoints > 0),
    max_touch_points: String(navigator.maxTouchPoints || 0),
    browser_name: /Firefox/i.test(navigator.userAgent)
      ? 'Firefox'
      : /Edg/i.test(navigator.userAgent)
        ? 'Edge'
        : 'Chrome',
    os_name: /Windows/i.test(navigator.userAgent)
      ? 'Windows'
      : /Mac/i.test(navigator.userAgent)
        ? 'macOS'
        : /Android/i.test(navigator.userAgent)
          ? 'Android'
          : /iPhone|iPad/i.test(navigator.userAgent)
            ? 'iOS'
            : 'Linux',
  }
  return new URLSearchParams(q).toString()
}

/* ----------------------------------------------------------------- prompt */

export interface PlainMessage {
  role: 'user' | 'assistant'
  content: string
}

/** GLM chat-template rendering (same as server: orbitoo/zai2api scheme). */
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

/* ------------------------------------------------------------ chat record */

async function createChatRecord(session: ZaiSession, model: string, prompt: string): Promise<string> {
  const userMessageId = crypto.randomUUID()
  const agent = isAgentModel(model)
  const body = {
    chat: {
      id: '',
      title: 'New Chat',
      models: [model],
      params: {},
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
      features: agent ? [{ server: 'tool_selector_h', status: 'hidden', type: 'tool_selector' }] : [],
      mcp_servers: [],
      enable_thinking: agent,
      ...(agent ? { reasoning_effort: 'max' } : {}),
      auto_web_search: !agent,
      message_version: 1,
      extra: {},
      timestamp: Date.now(),
      type: agent ? 'general_agent' : 'default',
    },
  }
  const res = await fetch(`${ZAI_BASE}/api/v1/chats/new`, {
    method: 'POST',
    headers: {
      ...commonHeaders(),
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new ZaiDirectError(`chat.z.ai chats/new ${res.status}: ${txt.slice(0, 160)}`, 'chat_new_failed')
  }
  const data = (await res.json()) as { id?: string }
  return data.id || userMessageId
}

/* ------------------------------------------------------------- completions */

interface UpstreamEventData {
  phase?: string
  delta_content?: string
  edit_content?: string
  done?: boolean
  error?: { detail?: unknown; code?: unknown; error_code?: unknown }
}

export interface StreamHandlers {
  onDelta: (text: string) => void
  onActivity: (a: { id: string; name: string; args?: Record<string, unknown>; done: boolean; summary?: string }) => void
}

function mapUpstreamError(err: { detail?: unknown; code?: unknown; error_code?: unknown }): ZaiDirectError {
  const code = String(err.code ?? err.error_code ?? '')
  const detail = typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail ?? err)
  if (code.includes('FRONTEND_CAPTCHA_REQUIRED'))
    return new ZaiDirectError(
      'Z.ai просит короткую проверку — реши её во всплывающем окне (та же капча, что и на chat.z.ai), и сообщение уйдёт автоматически.',
      'captcha_required',
    )
  if (code.includes('CAPTCHA') || /captcha/i.test(detail))
    return new ZaiDirectError(
      'Z.ai отклонил проверку капчи. Попробуй отправить сообщение ещё раз — при повторном требовании капчи реши её аккуратно во всплывающем окне.',
      'captcha_failed',
    )
  if (/user level/i.test(detail) || code === '403')
    return new ZaiDirectError(
      `Модель недоступна для текущего уровня аккаунта Z.ai (${detail.slice(0, 120)}). Выбери другую модель в селекторе.`,
      'model_level',
    )
  return new ZaiDirectError(`chat.z.ai: ${detail.slice(0, 200)}`, 'upstream_error')
}

function cleanAnswerDelta(text: string): string {
  let out = text.replace(/<glm_block[\s\S]*?<\/glm_block>/g, '')
  const detailsIdx = out.lastIndexOf('</details>')
  if (detailsIdx >= 0) out = out.slice(detailsIdx + '</details>'.length)
  out = out.replace(/<\/?details[^>]*>/g, '').replace(/<summary[^>]*>[\s\S]*?<\/summary>/g, '')
  return out
}

function describeStatus(status: Record<string, unknown>): { name: string; args?: Record<string, unknown> } | null {
  const action = String(status.action || status.type || '').toLowerCase()
  const detail = String(status.query || status.keyword || status.title || status.description || '').slice(0, 80)
  if (/image|picture|photo|изображ/.test(action))
    return { name: 'generate_image', args: detail ? { title: detail } : {} }
  if (/search|web/.test(action)) return { name: 'web_search', args: detail ? { query: detail } : {} }
  if (/knowledge/.test(action)) return { name: 'knowledge_search', args: detail ? { query: detail } : {} }
  if (/code|python|exec/.test(action)) return { name: 'code_interpreter', args: detail ? { title: detail } : {} }
  if (/file|document|doc|read/.test(action)) return { name: 'file_qa', args: detail ? { title: detail } : {} }
  if (/ppt|slide|presentation/.test(action)) return { name: 'ppt_maker', args: detail ? { title: detail } : {} }
  if (action) return { name: 'Агент: ' + action }
  return null
}

function describeToolPhase(
  phase: string,
  data: UpstreamEventData,
): { name: string; args?: Record<string, unknown> } | null {
  const blocks = (data as { content_blocks?: unknown }).content_blocks
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      const block = b as { type?: string; content?: unknown }
      if (block?.type === 'tool_calls' && Array.isArray(block.content)) {
        for (const c of block.content) {
          const call = c as { function?: { name?: unknown; arguments?: unknown } }
          const fn = call?.function?.name
          if (typeof fn === 'string' && fn)
            return {
              name: /search/i.test(fn) ? 'web_search' : /image/i.test(fn) ? 'generate_image' : fn,
              args:
                typeof call.function?.arguments === 'object' && call.function?.arguments
                  ? (call.function.arguments as Record<string, unknown>)
                  : {},
            }
        }
      }
    }
  }
  const raw = (data.delta_content || '').trim()
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as { name?: unknown; function?: { name?: unknown } }
      const fn = j.name || j.function?.name
      if (typeof fn === 'string' && fn) return { name: fn, args: {} }
    } catch { /* not json */ }
  }
  return phase === 'tool_call' ? { name: 'Агент вызывает инструмент' } : null
}

export interface ChatOptions {
  messages: PlainMessage[]
  model?: string
  webSearch?: boolean
  effort?: 'high' | 'max'
  /** one-time captcha param (relay of the user's own solve) */
  captchaVerifyParam?: string
  handlers: StreamHandlers
  /** signal to abort the upstream stream (component unmount / new turn) */
  signal?: AbortSignal
}

/**
 * Run ONE chat turn against chat.z.ai from the browser. Emits deltas and
 * agent-activity through handlers; resolves with the full answer text.
 * Throws ZaiDirectError with typed codes:
 *   zai_not_linked | zai_session_expired | captcha_required | captcha_failed | …
 */
export async function chatTurn(opts: ChatOptions): Promise<string> {
  const model = opts.model || 'x-preview-l'
  const session = await resolveChatSession()
  const prompt = renderPrompt(opts.messages)
  if (!prompt) throw new ZaiDirectError('Пустой промпт', 'empty_prompt')

  const timestampMs = String(Date.now())
  const requestId = crypto.randomUUID()
  const signature = await signPrompt(requestId, timestampMs, session.userId, prompt)
  const recordId = await createChatRecord(session, model, prompt)

  const agent = isAgentModel(model)
  const body = {
    stream: true,
    model,
    messages: [{ role: 'user', content: prompt }],
    signature_prompt: prompt,
    params: {},
    extra: {},
    features: agent
      ? {
          image_generation: true,
          web_search: Boolean(opts.webSearch),
          auto_web_search: false,
          preview_mode: false,
          flags: [],
          enable_thinking: true,
          reasoning_effort: opts.effort === 'high' ? 'high' : 'max',
        }
      : {
          image_generation: false,
          web_search: Boolean(opts.webSearch),
          auto_web_search: !opts.webSearch,
          preview_mode: false,
          flags: [],
          enable_thinking: false,
        },
    variables: {
      '{{USER_NAME}}': session.name,
      '{{USER_LOCATION}}': 'Unknown',
      '{{CURRENT_DATETIME}}': new Date().toISOString().slice(0, 19).replace('T', ' '),
      '{{CURRENT_DATE}}': new Date().toISOString().slice(0, 10),
      '{{USER_LANGUAGE}}': navigator.language || 'ru-RU',
    },
    chat_id: recordId,
    id: crypto.randomUUID(),
    session_id: session.userId,
    current_user_message_id: crypto.randomUUID(),
    current_user_message_parent_id: null,
    background_tasks: { title_generation: false, tags_generation: false },
    ...(opts.captchaVerifyParam ? { captcha_verify_param: opts.captchaVerifyParam } : {}),
    stream_options: { include_usage: true },
  }

  const url = `${ZAI_BASE}/api/v2/chat/completions?${fingerprintQuery(session, requestId, timestampMs)}&signature_timestamp=${timestampMs}`

  let res: Response | null = null
  let lastWaf = false
  for (const feVersion of FE_VERSIONS) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        ...commonHeaders(),
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-Signature': signature,
        'X-FE-Version': feVersion,
        'X-Device-Id': deviceId(),
        'X-Region': 'overseas',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
    if (r.status === 405) {
      const head = await r.text().catch(() => '')
      if (/aliyun|errors\.aliyun|<!doctype/i.test(head.slice(0, 400))) {
        lastWaf = true
        continue // stale FE version — try the next candidate
      }
      res = r
      break
    }
    res = r
    break
  }
  if (!res)
    throw new ZaiDirectError(
      'Z.ai обновила защиту своего сайта (WAF) и отклоняет текущую версию клиента. Попробуй ещё раз через несколько минут.',
      'waf_blocked',
    )
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '')
    let parsed: { detail?: unknown; code?: unknown } | null = null
    try {
      parsed = JSON.parse(txt)
    } catch { /* raw text */ }
    if (parsed && (parsed.code || parsed.detail)) throw mapUpstreamError(parsed as never)
    if (/aliyun|errors\.aliyun|<!doctype/i.test(txt.slice(0, 400)))
      throw new ZaiDirectError(
        'Z.ai обновила защиту своего сайта (WAF) и временно отклоняет запросы. Попробуй ещё раз через несколько минут.',
        'waf_blocked',
      )
    throw new ZaiDirectError(`chat.z.ai completions ${res.status}: ${txt.slice(0, 200)}`, 'http_error')
  }

  // ---- SSE parse with edit_content dedupe (same as server impl) ----
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let buf = ''
  let emittedAnswer = ''
  let openActivity: { id: string; name: string } | null = null
  const closeActivity = (summary?: string) => {
    if (!openActivity) return
    opts.handlers.onActivity({ id: openActivity.id, name: openActivity.name, done: true, summary })
    openActivity = null
  }
  const startActivity = (name: string, args: Record<string, unknown> = {}) => {
    if (openActivity && openActivity.name === name) return
    closeActivity()
    const id = 'z' + crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    openActivity = { id, name }
    opts.handlers.onActivity({ id, name, args, done: false })
  }
  const emitAnswer = (text: string) => {
    if (!text) return
    if (text.startsWith(emittedAnswer) && text.length > emittedAnswer.length) {
      opts.handlers.onDelta(text.slice(emittedAnswer.length))
      emittedAnswer = text
      return
    }
    if (emittedAnswer.startsWith(text)) return // stale resend
    opts.handlers.onDelta(text)
    emittedAnswer += text
  }

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
          const event = JSON.parse(payload) as {
            type?: string
            data?: UpstreamEventData & Record<string, unknown>
          }
          if (event.type === 'status') {
            const described = describeStatus((event.data || {}) as Record<string, unknown>)
            if (described) startActivity(described.name, described.args || {})
            continue
          }
          if (event.type !== 'chat:completion') continue
          const data = (event.data || {}) as UpstreamEventData
          if (data.error) throw mapUpstreamError(data.error)
          const phase = data.phase || 'answer'
          if (phase === 'thinking') {
            startActivity('Агент думает')
            continue
          }
          if (phase === 'tool_call' || phase === 'tool_response') {
            const described = describeToolPhase(phase, data)
            if (described) startActivity(described.name, described.args || {})
            continue
          }
          if (phase === 'other') continue
          closeActivity()
          const raw = data.edit_content ?? data.delta_content ?? ''
          const text = cleanAnswerDelta(raw)
          if (text) emitAnswer(text)
          if (data.done) break
        } catch (e) {
          if (e instanceof ZaiDirectError) throw e
          /* partial JSON line — skip */
        }
      }
    }
    closeActivity()
    return emittedAnswer
  } finally {
    try {
      reader.releaseLock()
    } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ captcha */

// v12 debug/automation hook (also lets support drive the flow manually)
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__solveChatCaptcha = () => solveChatCaptcha()
}

/**
 * In-page Z.ai chat captcha (v12) — a byte-level replica of chat.z.ai's own
 * BN()/ohe()/she() flow from their public bundle (prod-fe-1.1.98):
 *   - window.AliyunCaptchaConfig = { region: 'sgp', prefix: 'no8xfe' }
 *   - load https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
 *   - hidden element `#chat-captcha-element` + trigger `#chat-captcha-trigger`
 *   - initAliyunCaptcha({ SceneId: hostname==='chat.z.ai' ? 'didk33e0'
 *     : 'xswyjefn', mode: 'popup', ... }) and click the trigger
 *   - the success event (the whole object, exactly like their code) is the
 *     captcha_verify_param that gets attached to the retried completions.
 * The popup is solved by the REAL user in OUR page — no navigation.
 */
export function solveChatCaptcha(): Promise<unknown> {
  const w = window as unknown as {
    AliyunCaptchaConfig?: { region: string; prefix: string }
    initAliyunCaptcha?: (cfg: Record<string, unknown>) => void
  }
  return new Promise((resolve, reject) => {
    const ensureDom = () => {
      if (!document.getElementById('chat-captcha-element')) {
        const el = document.createElement('div')
        el.id = 'chat-captcha-element'
        el.style.cssText =
          'position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none;'
        document.body.appendChild(el)
      }
      if (!document.getElementById('chat-captcha-trigger')) {
        const b = document.createElement('button')
        b.id = 'chat-captcha-trigger'
        b.style.display = 'none'
        document.body.appendChild(b)
      }
    }
    const CAPTCHA_SDK_ERR = () =>
      new ZaiDirectError('Не удалось загрузить капчу Z.ai — отправь сообщение ещё раз', 'captcha_sdk_failed')
    const loadSdk = () =>
      new Promise<void>((res, rej) => {
        // AliyunCaptcha.js defines window.initAliyunCaptcha ASYNCHRONOUSLY
        // after the script's load event (it pulls sub-resources first) —
        // poll until it appears; a plain post-load check races and hangs.
        const poll = () => {
          const t0 = Date.now()
          const tick = () => {
            if (w.initAliyunCaptcha) return res()
            if (Date.now() - t0 > 12_000) return rej(CAPTCHA_SDK_ERR())
            setTimeout(tick, 100)
          }
          tick()
        }
        if (w.initAliyunCaptcha) return res()
        w.AliyunCaptchaConfig = { region: 'sgp', prefix: 'no8xfe' }
        const SRC = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
        const existing = document.querySelector(`script[src="${SRC}"]`)
        if (existing) {
          poll() // tag already there (maybe mid-load) — poll for the global
          return
        }
        const s = document.createElement('script')
        s.src = SRC
        s.addEventListener('load', poll)
        s.addEventListener('error', () => rej(CAPTCHA_SDK_ERR()))
        document.head.appendChild(s)
      })

    void (async () => {
      try {
        ensureDom()
        await loadSdk()
        if (!w.initAliyunCaptcha) throw new ZaiDirectError('initAliyunCaptcha missing', 'captcha_sdk_failed')
        const lang = (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'cn' : 'en'
        let settled = false
        const callbacks = {
          success: (e: unknown) => {
            settled = true
            resolve(e)
          },
          fail: () => {
            // risk verdict failed (e.g. suspicious client) — keep the popup
            // usable: refresh + re-show, exactly like their fail handler
            try {
              document.getElementById('chat-captcha-trigger')?.click()
            } catch { /* noop */ }
          },
          onError: () => {
            if (!settled) reject(new ZaiDirectError('Сервис капчи Z.ai недоступен', 'captcha_error'))
          },
          onClose: () => {
            if (!settled)
              reject(new ZaiDirectError('Проверка отменена — отправь сообщение ещё раз', 'captcha_cancelled'))
          },
        }
        const cfg = {
          SceneId: location.hostname === 'chat.z.ai' ? 'didk33e0' : 'xswyjefn',
          mode: 'popup',
          element: '#chat-captcha-element',
          button: '#chat-captcha-trigger',
          captchaLogoImg: 'https://z-cdn.chatglm.cn/z-ai/static/logo.svg',
          ...(lang === 'cn'
            ? {
                upLang: {
                  cn: {
                    START_VERIFY: '点击开始验证',
                    POPUP_TITLE: '请完成安全验证',
                    SLIDE_TIP: '请按住滑块，拖动到最右边',
                  },
                },
              }
            : {}),
          language: lang,
          timeout: 10000,
          delayBeforeSuccess: false,
          ...callbacks,
        }
        // The SDK defines window.initAliyunCaptcha slightly BEFORE its
        // internal assets are ready — an early init() call is silently
        // swallowed. Retry init+trigger until the widget actually renders.
        let attempt = 0
        const tryInit = () => {
          if (settled) return
          attempt += 1
          console.info('[captcha] init attempt', attempt, { sdk: typeof w.initAliyunCaptcha })
          try {
            w.initAliyunCaptcha?.({ ...cfg })
            document.getElementById('chat-captcha-trigger')?.click()
          } catch (e) { console.warn('[captcha] init threw', e) }
          setTimeout(() => {
            if (settled) return
            const rendered = document.querySelector('[id^="aliyunCaptcha"]')
            if (!rendered && attempt < 5) tryInit()
            else if (!rendered)
              reject(new ZaiDirectError('Капча Z.ai не открылась — отправь сообщение ещё раз', 'captcha_error'))
          }, 3000)
        }
        tryInit()
      } catch (e) {
        reject(e instanceof ZaiDirectError ? e : new ZaiDirectError(String(e), 'captcha_error'))
      }
    })()
  })
}

/**
 * Attach a freshly obtained REAL session to the site account: persist the
 * JWT in the browser AND register it server-side (server validates it live
 * and stores it on the user row — the linked-status source of truth).
 */
export async function attachSession(session: ZaiSession): Promise<void> {
  setStoredJwt(session.token)
  const res = await fetch('/api/auth/zai/attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: session.token }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ZaiDirectError(data.error || `attach ${res.status}`, 'attach_failed')
  }
}
