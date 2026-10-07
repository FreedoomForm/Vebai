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
 * Captcha (settled by live probes 2026-10): anonymous guest sessions must
 * pass Z.ai's server captcha — Aliyun Captcha 2.0 — on EVERY chat
 * completions. The server answers with {code: FRONTEND_CAPTCHA_REQUIRED,
 * captcha_error_type: 'missing_param'} until the request carries a one-time
 * `captcha_verify_param`. CRITICAL (v11): Aliyun binds each solve to the
 * domains registered in chat.z.ai's scene config — a param solved on any
 * foreign domain is ALWAYS rejected ("The captcha verification failed"),
 * even when the widget showed green and the same browser re-sent the
 * request with a byte-identical payload. Because of that there is NO
 * captcha relay anywhere in vebai anymore: guest mode is removed, and Z.ai
 * accounts are created/logged-in on chat.z.ai itself and connected via the
 * token bridge (see auth-screen.tsx / zai-link-card.tsx). This module keeps
 * only the server-side session helpers (resolveSession / paste parsing)
 * used by /api/auth/google/claim and /api/auth/zai/attach.
 *
 * Agent mode (default): chats are created with type 'general_agent' on an
 * agent-capable model (GLM-5.x / x-preview). That mode IS the full Z.ai
 * agent — its own toolbelt covers web search, IMAGE GENERATION, file/QA
 * tools and code interpreter through the account's Z.ai quota (no extra
 * API keys). The upstream stream also emits type:'status' events (agent
 * activity) which we relay to the UI as ephemeral activity cards.
 */

import crypto from 'node:crypto'

const BASE = process.env.ZAI_CHATWEB_BASE_URL || 'https://chat.z.ai'
/** X-FE-Version candidates, newest first. Z.ai's Aliyun WAF now blocks
 * requests whose X-FE-Version is not the CURRENT frontend build (verified
 * live 2026-10: prod-fe-1.0.272 => 405 WAF challenge page, prod-fe-1.1.98
 * => 200). When Z.ai ships a new build, we detect the 405 and retry with
 * the other candidates — ZAI_FE_VERSION env var overrides for hotfixes. */
const FE_VERSIONS = [
  process.env.ZAI_FE_VERSION,
  'prod-fe-1.1.98', // current chat.z.ai build (index-BEIsjDOv.js)
  'prod-fe-1.0.272', // previous build some older sessions were pinned to
].filter((v): v is string => Boolean(v))
const SIGNING_SECRET = 'key-@@@@)))()((9))-xxxx&&&%%%%%'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

export const DEFAULT_CHATWEB_MODEL = process.env.ZAI_CHATWEB_MODEL || 'x-preview-l'

/** Agent-capable models (capabilities.agent_mode on chat.z.ai:
 * x-preview-l / glm-5.3 / glm-5.2 / GLM-5-Turbo …). For these we create
 * 'general_agent' chats; anything else falls back to plain chat mode. */
const AGENT_MODEL_RE = /x-preview|glm-5|GLM-5/i
export function isAgentModel(model: string): boolean {
  return AGENT_MODEL_RE.test(model)
}

/** Shape of the ephemeral agent-activity events relayed to the UI. */
export interface ZaiActivity {
  id: string
  /** human-readable RU label, doubles as the ToolCard name fallback */
  name: string
  done: boolean
  summary?: string
}

/** Transport extras threaded from /api/chat down to the completions call. */
export interface ChatWebTransport {
  /** per-user anonymous chat.z.ai session token (guest JWT) */
  sessionToken?: string | null
  /** one-time Aliyun captcha_verify_param relayed from the user's widget */
  captchaVerifyParam?: string
  /** upstream model id (whitelisted in /api/chat) */
  model?: string
  /** the 🌐 web-search toggle from the composer (agent mode: tools stay on) */
  webSearch?: boolean
  /** reasoning effort from the Deep-Think selector: 'high' | 'max' */
  effort?: 'high' | 'max'
}

export class ChatWebError extends Error {
  code: string
  constructor(message: string, code = 'chatweb_error') {
    super(message)
    this.code = code
  }
}

/** Map a signup/signin {detail} error into a typed ChatWebError.
 * The upstream detail is preserved verbatim — the UI shows the EXACT
 * reason Z.ai rejected the request (no more guessing why a solved
 * captcha was refused). */
function mapAuthError(status: number, txt: string): ChatWebError {
  let detail = txt
  try {
    const j = JSON.parse(txt) as { detail?: unknown }
    if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
  } catch { /* raw text */ }
  const short = detail.slice(0, 180)
  if (/verification token/i.test(detail))
    return new ChatWebError(
      `Z.ai не принял код из письма (invalid verification token) — проверь код или запроси новый`,
      'bad_code',
    )
  if (/not pending/i.test(detail))
    return new ChatWebError(
      `Z.ai: активной регистрации с этим email нет — сначала запусти создание аккаунта (капча + «Создать»)`,
      'signup_not_pending',
    )
  if (/captcha/i.test(detail))
    return new ChatWebError(`Z.ai не принял проверку капчи: ${short}`, 'captcha_failed')
  if (status === 400 && /already|exists|занят/i.test(detail))
    return new ChatWebError(`Этот email уже зарегистрирован на Z.ai (${short})`, 'email_taken')
  if (status === 401 || /invalid|wrong|incorrect|credential/i.test(detail))
    return new ChatWebError(`Z.ai не принял email/пароль (${short})`, 'bad_credentials')
  return new ChatWebError(`chat.z.ai auth ${status}: ${short}`, 'auth_failed')
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

/** Decode a chat.z.ai JWT payload WITHOUT verification (we only need the
 * identity fields to detect silent downgrades — Z.ai signs with ES256 and
 * the server validates tokens itself; we never trust these fields for
 * authorization, only to notice when a token stopped being what it was). */
export function peekZaiJwtEmail(token: string): string {
  try {
    const pl = token.split('.')[1] || ''
    const json = JSON.parse(Buffer.from(pl, 'base64url').toString('utf8')) as { email?: string }
    return String(json.email || '')
  } catch {
    return ''
  }
}

const GUEST_EMAIL_RE = /^guest-\d+@guest\.com$/i

/** True when a stored zaiToken is a REAL account session (not the per-user
 * anonymous guest session every user gets by default). This is what
 * "linked" means for the UI badge and session reporting. */
export function isRealZaiToken(token?: string | null): boolean {
  if (!token) return false
  const email = peekZaiJwtEmail(token)
  return Boolean(email) && !GUEST_EMAIL_RE.test(email)
}

/** Exchange a (possibly stale) JWT for a fresh session, or mint a guest one.
 *
 * Z.ai quirk (verified live): a STALE/revoked Bearer token does NOT produce
 * 401 — GET /auths/ silently mints a fresh GUEST session instead. We detect
 * that downgrade by comparing identities and THROW `zai_session_expired`,
 * so callers never mistake a guest session for a refreshed real account
 * (and never persist a guest token over a real one). */
export async function resolveSession(userToken?: string | null): Promise<ChatWebSession> {
  const originalEmail = userToken ? peekZaiJwtEmail(userToken) : ''
  const originalIsGuest = !userToken || !originalEmail || GUEST_EMAIL_RE.test(originalEmail)
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
  // the silent-downgrade guard (see docblock): a real token must never
  // come back as a guest session
  if (!originalIsGuest && GUEST_EMAIL_RE.test(String(data.email || ''))) {
    throw new ChatWebError(
      'Сессия chat.z.ai истекла — аккаунт подключён, но токен устарел. Перелогинись (кнопка «Аккаунт Z.ai»).',
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
 * STEP 1 of Z.ai email registration (byte-verified against their frontend
 * prod-fe-1.1.98, 2026-10): POST /auths/signup is captcha-gated and on
 * success returns {success:...} with NO token — Z.ai emails a verification
 * code instead and the account sits in "signup pending" state.
 * (The old contract "token in the signup response" is gone on their side —
 * expecting one here was the exact root cause of the "green captcha, but
 * verification failed" bug our users reported.)
 */
export async function zaiSignUpStart(
  name: string,
  email: string,
  password: string,
  captchaVerifyParam: string,
): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/auths/signup`, {
    method: 'POST',
    headers: { ...commonHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name || email.split('@')[0],
      email,
      password,
      profile_image_url: '/static/favicon.png',
      sso_redirect: '',
      captcha_verify_param: captchaVerifyParam,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const txt = await res.text().catch(() => '')
  if (!res.ok) throw mapAuthError(res.status, txt)
  // accepted shapes: {success:true} | {token:...} (if Z.ai ever reverts)
  let data: { success?: boolean; token?: string; detail?: string } = {}
  try {
    data = JSON.parse(txt)
  } catch { /* empty body counts as success */ }
  if (data?.detail) throw new ChatWebError(String(data.detail), 'auth_failed')
}

/** STEP 2 (NO captcha on Z.ai side): confirm the emailed code. */
export async function zaiVerifyEmailCode(
  email: string,
  username: string,
  code: string,
): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/auths/verify_email`, {
    method: 'POST',
    headers: { ...commonHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username || email.split('@')[0], email, token: code }),
    signal: AbortSignal.timeout(30_000),
  })
  const txt = await res.text().catch(() => '')
  if (!res.ok) throw mapAuthError(res.status, txt)
}

/** STEP 3 (NO captcha): finalize the account; response carries the JWT. */
export async function zaiFinishSignup(
  email: string,
  username: string,
  code: string,
  password: string,
): Promise<ChatWebSession> {
  const res = await fetch(`${BASE}/api/v1/auths/finish_signup`, {
    method: 'POST',
    headers: { ...commonHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: username || email.split('@')[0],
      email,
      token: code,
      password,
      profile_image_url: '/static/favicon.png',
      sso_redirect: '',
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const txt = await res.text().catch(() => '')
  if (!res.ok) throw mapAuthError(res.status, txt)
  const data = JSON.parse(txt) as {
    token?: string
    user?: { token?: string; id?: string; name?: string; email?: string; role?: string }
    id?: string
    name?: string
    email?: string
    role?: string
  }
  const token = data?.user?.token || data?.token
  if (!token) throw new ChatWebError('Z.ai не вернул токен аккаунта', 'auth_failed')
  const u = data.user || data
  return {
    token,
    userId: u.id || '',
    name: u.name || username || 'User',
    email: u.email || email,
    role: u.role || 'user',
  }
}

/** Re-send the signup verification email (works while signup is pending). */
export async function zaiResendCode(name: string, email: string): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/auths/resend_email`, {
    method: 'POST',
    headers: { ...commonHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || email.split('@')[0], email, sso_redirect: '' }),
    signal: AbortSignal.timeout(30_000),
  })
  const txt = await res.text().catch(() => '')
  if (!res.ok) throw mapAuthError(res.status, txt)
}

/** Pull a chat.z.ai JWT out of what the user pasted after Google/GitHub login:
 * the full page URL (`https://chat.z.ai/auth#token=…&is_new_user=…`), a bare
 * JWT, or JSON. Returns '' when nothing JWT-shaped is found. */
export function extractZaiTokenFromPaste(raw: string): string {
  const s = (raw || '').trim()
  if (!s) return ''
  const m = s.match(/[#&?]token=([^&\s]+)/) || s.match(/token=([^&\s]+)/)
  if (m) return decodeURIComponent(m[1])
  // bare JWT (three base64url segments)
  const jwt = s.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/)
  if (jwt) return jwt[0]
  return ''
}

/** Sign in to an EXISTING chat.z.ai account (also captcha-gated by Z.ai). */
export async function zaiSignIn(
  email: string,
  password: string,
  captchaVerifyParam: string,
): Promise<ChatWebSession> {
  const res = await fetch(`${BASE}/api/v1/auths/signin`, {
    method: 'POST',
    headers: { ...commonHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, captcha_verify_param: captchaVerifyParam }),
    signal: AbortSignal.timeout(30_000),
  })
  const txt = await res.text().catch(() => '')
  if (!res.ok) throw mapAuthError(res.status, txt)
  const data = JSON.parse(txt) as { token?: string; id?: string; name?: string; email?: string; role?: string }
  if (!data?.token) throw new ChatWebError('Z.ai не вернул токен аккаунта', 'auth_failed')
  return {
    token: data.token,
    userId: data.id || '',
    name: data.name || 'User',
    email: data.email || email,
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
      // mirror chat.z.ai's own agent-mode chat record: hidden tool_selector
      // feature flag (the agent decides its tools itself)
      features: agent ? [{ server: 'tool_selector_h', status: 'hidden', type: 'tool_selector' }] : [],
      mcp_servers: [],
      enable_thinking: agent,
      ...(agent ? { reasoning_effort: 'max' } : {}),
      auto_web_search: !agent,
      message_version: 1,
      extra: {},
      timestamp: Date.now(),
      // 'general_agent' = THE agent mode of chat.z.ai (web search, image
      // generation, file tools — all inside Z.ai, no extra APIs)
      type: agent ? 'general_agent' : 'default',
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
  if (code.includes('FRONTEND_CAPTCHA_REQUIRED'))
    return new ChatWebError(
      'Z.ai требует подтверждение капчи для этой сессии.',
      'captcha_required',
    )
  if (code.includes('CAPTCHA') || /captcha/i.test(detail))
    return new ChatWebError(
      'Капча Z.ai не прошла проверку. Реши капчу ещё раз и повтори сообщение.',
      'captcha_failed',
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

/** POST the signed completions request. Tries each X-FE-Version candidate;
 * a 405 whose body is an Aliyun WAF HTML page means "stale client version"
 * (Z.ai's WAF rejects old builds) — retry the next candidate. */
async function openCompletionsStream(
  session: ChatWebSession,
  url: string,
  body: string,
  signature: string,
): Promise<Response> {
  let lastWafRes: Response | null = null
  for (const feVersion of FE_VERSIONS) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...commonHeaders(),
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-Signature': signature,
        'X-FE-Version': feVersion,
        'X-Device-Id': crypto.randomUUID(),
        'X-Region': 'overseas',
      },
      body,
      signal: AbortSignal.timeout(600_000),
    })
    if (res.status === 405) {
      // Aliyun WAF challenge page = this X-FE-Version is no longer accepted
      const head = await res.text().catch(() => '')
      if (/aliyun|errors\.aliyun|<!doctype/i.test(head.slice(0, 400))) {
        lastWafRes = res
        continue // try the next candidate version
      }
      return res // genuine 405 from the API itself — surface it
    }
    return res
  }
  return lastWafRes!
}

/** Low-level: open the signed v2 SSE stream and yield raw upstream events.
 * Two kinds are yielded: {data} for chat:completion (phased content) and
 * {status} for the agent's activity updates (type:'status'). */
async function* upstreamEvents(
  session: ChatWebSession,
  prompt: string,
  model: string,
  captchaVerifyParam?: string,
  transport?: ChatWebTransport,
): AsyncGenerator<{ data?: UpstreamEventData; status?: Record<string, unknown> }> {
  const timestampMs = String(Date.now())
  const requestId = crypto.randomUUID()
  const signature = signPrompt(requestId, timestampMs, session.userId, prompt)
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
          // Z.ai agent mode: its own toolbelt (web search, IMAGE GENERATION,
          // file QA, code interpreter) runs server-side on the account's
          // quota — no extra API keys. reasoning_effort mirrors the chat.z.ai
          // composer's Deep-Think selector (High/Max); the 🌐 toggle turns
          // web_search on explicitly.
          image_generation: true,
          web_search: Boolean(transport?.webSearch),
          auto_web_search: false,
          preview_mode: false,
          flags: [],
          enable_thinking: true,
          reasoning_effort: transport?.effort === 'high' ? 'high' : 'max',
        }
      : {
          image_generation: false,
          web_search: Boolean(transport?.webSearch),
          auto_web_search: !transport?.webSearch, // plain chat: let Z.ai decide
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
    session_id: session.userId,
    current_user_message_id: crypto.randomUUID(),
    current_user_message_parent_id: null,
    background_tasks: { title_generation: false, tags_generation: false },
    // one-time Aliyun captcha param relayed from the user's widget.
    // IMPORTANT: mirror chat.z.ai's own frontend — attach the field ONLY
    // when a param exists; sending an empty string can trip the captcha
    // gate even for real (logged-in) accounts, which don't need it at all.
    ...(captchaVerifyParam ? { captcha_verify_param: captchaVerifyParam } : {}),
    stream_options: { include_usage: true },
  }

  const url = `${BASE}/api/v2/chat/completions?${fingerprintQuery(session, requestId, timestampMs)}&signature_timestamp=${timestampMs}`
  const res = await openCompletionsStream(session, url, JSON.stringify(body), signature)
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '')
    let parsed: { detail?: unknown; code?: unknown } | null = null
    try { parsed = JSON.parse(txt) } catch { /* raw text */ }
    if (parsed && (parsed.code || parsed.detail)) throw mapUpstreamError(parsed as never)
    if (/aliyun|errors\.aliyun|<!doctype/i.test(txt.slice(0, 400)))
      throw new ChatWebError(
        'Z.ai обновила защиту своего сайта (WAF) и временно отклоняет запросы нашего сервера. Мы уже адаптируемся — попробуй ещё раз через несколько минут.',
        'waf_blocked',
      )
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
          const event = JSON.parse(payload) as {
            type?: string
            data?: UpstreamEventData & Record<string, unknown>
          }
          if (event.type === 'chat:completion') yield { data: event.data || {} }
          else if (event.type === 'status')
            yield { status: (event.data || {}) as Record<string, unknown> }
          // chat:title / chat:tags / notification / conn:heartbeat — ignored
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

/** Map an upstream type:'status' payload into a human activity label. */
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

/** Try to extract a tool name/content from a tool_call / tool_response phase. */
function describeToolPhase(phase: string, data: UpstreamEventData): { name: string; args?: Record<string, unknown> } | null {
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
              name: /search/i.test(fn)
                ? 'web_search'
                : /image/i.test(fn)
                  ? 'generate_image'
                  : fn,
              args: typeof call.function?.arguments === 'object' && call.function?.arguments
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

/** Streaming chat via chat.z.ai -> OpenAI-compatible SSE chunks.
 * Session: explicit transport token (per-user session) → site-wide
 * ZAI_JWT (owner, optional) → fresh anonymous guest. The captcha param is
 * relayed as-is; without it Z.ai demands the captcha (the UI catches the
 * typed error and pops Z.ai's own widget).
 *
 * Agent mode: besides content, the stream carries agent activity
 * (type:'status' events, tool phases, thinking). Those are relayed as
 * `{"zai_activity": …}` SSE lines — the loop converts them into ephemeral
 * ToolCards so the user sees the agent working (search/images/files). */
export async function chatWebStream(
  messages: PlainMessage[],
  opts?: { model?: string; transport?: ChatWebTransport },
): Promise<ReadableStream<Uint8Array>> {
  const model = opts?.model || opts?.transport?.model || DEFAULT_CHATWEB_MODEL
  const session = await resolveSession(
    opts?.transport?.sessionToken ?? process.env.ZAI_JWT ?? null,
  )
  const captchaVerifyParam = opts?.transport?.captchaVerifyParam || ''
  const prompt = renderPrompt(messages)
  if (!prompt) throw new ChatWebError('Пустой промпт', 'empty_prompt')
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => {
        try { controller.enqueue(enc.encode(s)) } catch { /* closed */ }
      }
      // ---- ephemeral agent-activity relay (running card per label) ----
      let openActivity: { id: string; name: string; args: Record<string, unknown> } | null = null
      const closeActivity = (summary?: string) => {
        if (!openActivity) return
        push(
          `data: ${JSON.stringify({
            zai_activity: { id: openActivity.id, done: true, ...(summary ? { summary } : {}) },
          })}\n\n`,
        )
        openActivity = null
      }
      const startActivity = (name: string, args: Record<string, unknown> = {}) => {
        if (openActivity && openActivity.name === name) return // same step continues
        closeActivity()
        const id = 'z' + crypto.randomUUID().replace(/-/g, '').slice(0, 10)
        openActivity = { id, name, args }
        push(`data: ${JSON.stringify({ zai_activity: { id, name, args, done: false } })}\n\n`)
      }
      // ---- content assembly with edit_content dedupe guard ----
      // Some upstreams stream answer as pure delta_content; others resend
      // the whole answer-so-far in edit_content. If a cleaned edit_content
      // starts with everything already emitted, emit only the suffix.
      let emittedAnswer = ''
      const emitAnswer = (text: string) => {
        if (!text) return
        if (text.startsWith(emittedAnswer) && text.length > emittedAnswer.length) {
          push(openaiChunk({ content: text.slice(emittedAnswer.length) }))
          emittedAnswer = text
          return
        }
        if (emittedAnswer.startsWith(text)) return // stale resend — nothing new
        push(openaiChunk({ content: text }))
        emittedAnswer += text
      }
      try {
        for await (const ev of upstreamEvents(session, prompt, model, captchaVerifyParam, opts?.transport)) {
          if (ev.status !== undefined) {
            const described = describeStatus(ev.status)
            if (described) startActivity(described.name, described.args || {})
            continue
          }
          const data = ev.data as UpstreamEventData
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
          // answer (or unknown phase carrying content)
          closeActivity()
          const raw = data.edit_content ?? data.delta_content ?? ''
          const text = cleanAnswerDelta(raw)
          if (text) emitAnswer(text)
          if (data.done) break
        }
        closeActivity()
        push(openaiChunk({}, 'stop'))
        push('data: [DONE]\n\n')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const code = e instanceof ChatWebError ? e.code : 'chatweb_error'
        push(
          `data: ${JSON.stringify({
            error: { message: msg, code },
          })}\n\n`,
        )
        if (code !== 'captcha_required') {
          // captcha is not an assistant-visible failure — the UI will relay
          // Z.ai's own widget and retry; everything else surfaces inline
          push(openaiChunk({ content: `\n\n[Ошибка Z.ai-прокси: ${msg.slice(0, 300)}]` }, 'stop'))
        }
        push('data: [DONE]\n\n')
      } finally {
        try { controller.close() } catch { /* already closed */ }
      }
    },
  })
}

/** Non-streaming chat via chat.z.ai (collects the stream).
 * Transport errors (captcha_required, captcha_failed, upstream…) are THROWN
 * as ChatWebError with the machine code — never swallowed into the content. */
export async function chatWebComplete(
  messages: PlainMessage[],
  opts?: { model?: string; transport?: ChatWebTransport },
): Promise<{ choices: { message: { content: string } }[] }> {
  const stream = await chatWebStream(messages, opts)
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let out = ''
  let firstError: ChatWebError | null = null
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
          const chunk = JSON.parse(payload) as {
            error?: { message?: string; code?: string }
            choices?: { delta?: { content?: string } }[]
          }
          if (chunk.error && !firstError) {
            firstError = new ChatWebError(
              String(chunk.error.message || 'Z.ai error').slice(0, 300),
              String(chunk.error.code || 'chatweb_error'),
            )
            continue
          }
          out += chunk?.choices?.[0]?.delta?.content || ''
        } catch { /* ignore */ }
      }
    }
  }
  if (firstError) throw firstError
  return { choices: [{ message: { content: out } }] }
}
