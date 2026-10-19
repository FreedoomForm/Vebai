/**
 * T26: personal Telegram agents (userbot layer).
 *
 * A user connects HIS OWN Telegram account (MTProto user API: phone + login
 * code, optional 2FA password — the my.telegram.org-style flow). The site AI
 * maintains the agent's rules (system prompt), tests them by generating reply
 * variants, and — after the owner switches the agent on — the resident
 * worker (.github/tg_userbot.js on the GitHub Actions shift) answers incoming
 * private messages on the user's behalf through /api/tg/work|incoming|sent.
 *
 * Secrets at rest: the GramJS StringSession and api_hash are encrypted with
 * AES-256-GCM. The key is derived from GH_TERM_SECRET (server-side only,
 * already required by the gh executor). No plaintext fallback: if the secret
 * is missing the layer fails loudly instead of storing credentials in clear.
 */

import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { zai } from '@/lib/zai'

/* ------------------------------------------------------------ encryption */

function encKey(): Buffer {
  const base = process.env.GH_TERM_SECRET || ''
  if (!base) throw new Error('GH_TERM_SECRET не задан — шифрование сессий недоступно')
  return Buffer.from(crypto.createHash('sha256').update(base + '|tguser-v1').digest('hex'), 'hex')
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('base64')}`
}

export function decryptSecret(blob: string | null | undefined): string {
  if (!blob) return ''
  const parts = blob.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('неизвестный формат шифра')
  const [, ivHex, tagHex, dataB64] = parts
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encKey(),
    Buffer.from(ivHex, 'hex'),
  )
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}

/* ---------------------------------------------------------- mtproto creds */

/** Service-level MTProto app creds (owner adds them once via Vercel env).
 *  When absent, the user supplies his own api_id/api_hash from my.telegram.org. */
export function envApiCreds(): { apiId: number; apiHash: string } | null {
  const id = Number(process.env.TELEGRAM_API_ID || 0)
  const hash = (process.env.TELEGRAM_API_HASH || '').trim()
  if (id > 0 && hash.length >= 16) return { apiId: id, apiHash: hash }
  return null
}

export function parseApiCreds(input: { apiId?: unknown; apiHash?: unknown }):
  { apiId: number; apiHash: string } | { error: string } {
  const env = envApiCreds()
  if (env) return env
  const apiId = Number(input.apiId)
  const apiHash = String(input.apiHash || '').trim()
  if (!Number.isInteger(apiId) || apiId <= 0) return { error: 'нужен api_id (число) — см. my.telegram.org → API development tools' }
  if (!/^[a-f0-9]{32}$/i.test(apiHash)) return { error: 'нужен api_hash (32 hex-символа) — см. my.telegram.org → API development tools' }
  return { apiId, apiHash }
}

export function normalizePhone(input: unknown): { phone: string } | { error: string } {
  const raw = String(input || '').replace(/[^\d+]/g, '')
  const digits = raw.startsWith('+') ? raw.slice(1) : raw
  if (!/^\d{8,15}$/.test(digits)) return { error: 'номер в международном формате, например +998901234567' }
  return { phone: `+${digits}` }
}

/* ------------------------------------------------------------- gramjs glue */

/** Dynamic import so routes that never touch MTProto don't pay for it.
 *  Everything comes from the SINGLE root entry: subpath imports
 *  ('telegram/sessions', 'telegram/Password') get split into separate bundled
 *  module copies by Next.js and then `instanceof` checks inside GramJS fail
 *  ("Only StringSession and StoreSessions are supported"). */
export async function gramjs() {
  const t = await import('telegram')
  return {
    TelegramClient: t.TelegramClient,
    StringSession: t.sessions.StringSession,
    computeCheck: t.password.computeCheck,
    Api: t.Api,
  }
}

export function clientOpts() {
  return {
    connectionRetries: 1,
    requestRetries: 1,
    useWSS: true,
    autoReconnect: false,
    floodSleepThreshold: 0,
    deviceModel: 'Vebai Agent',
    systemVersion: 'vebai-six.vercel.app',
  }
}

/** Human-readable Russian error from a GramJS/MTProto failure (honest errors
 *  are the T21 rule: never swallow, never fake success). */
export function tgErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const map: [RegExp, string][] = [
    [/PHONE_NUMBER_INVALID/i, 'Telegram отклонил номер: PHONE_NUMBER_INVALID'],
    [/PHONE_NUMBER_UNEXISTED/i, 'Telegram: номер не зарегистрирован (PHONE_NUMBER_UNEXISTED)'],
    [/PHONE_CODE_INVALID/i, 'Неверный код подтверждения'],
    [/PHONE_CODE_EXPIRED/i, 'Код истёк — запроси новый'],
    [/SESSION_PASSWORD_NEEDED/i, 'Включена двухфакторная защита — нужен облачный пароль'],
    [/PASSWORD_HASH_INVALID/i, 'Неверный облачный пароль (2FA)'],
    [/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/i, 'api_id отклонён Telegram (API_ID_INVALID/PUBLISHED_FLOOD) — проверь api_id/api_hash с my.telegram.org'],
    [/FLOOD_WAIT_(\d+)/i, 'Telegram: слишком много попыток, подожди немного (FLOOD_WAIT)'],
    [/AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED/i, 'сессия недействительна — переподключи аккаунт'],
  ]
  for (const [re, msg] of map) if (re.test(raw)) return msg
  return raw.slice(0, 240)
}

/* --------------------------------------------------------- agent prompting */

export const DEFAULT_AGENT_PROMPT = `Ты — личный Telegram-ассистент владельца аккаунта. Отвечаешь на входящие личные сообщения ОТ ЕГО ИМЕНИ, когда он занят.

Базовые правила:
- Тон: дружелюбный, вежливый, лаконичный (1-3 предложения).
- Пиши на языке входящего сообщения.
- Не придумывай факты о делах владельца: если вопрос требует его решения (деньги, договорённости, документы) — вежливо скажи, что передашь вопрос владельцу, и ответит чуть позже.
- Не раскрывай лишнего о себе; если прямо спросят «ты бот?» — честно признай, что ты ассистент владельца.
- Никогда не отправляй пароли, коды, личные данные.
- Если собеседник просит создать файл или выполнить действие — подтверди, что передал запрос владельцу (запрос попадёт в журнал).`

export interface TgExample {
  from?: string
  incoming: string
  reply: string
  at?: string
}

export function parseExamples(raw: string | null | undefined): TgExample[] {
  try {
    const arr = JSON.parse(raw || '[]')
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e.incoming === 'string' && typeof e.reply === 'string') : []
  } catch {
    return []
  }
}

/** Compile the worker-side system prompt: identity + rules + few-shot examples. */
export function compileAgentPrompt(me: { firstName?: string; username?: string }, systemPrompt: string, examples: TgExample[]): string {
  const who = [me.firstName, me.username ? `(@${me.username})` : ''].filter(Boolean).join(' ')
  let s = `Ты — личный Telegram-агент пользователя ${who || '(владелец аккаунта)'}. Тебе приходит входящее личное сообщение; верни ТОЛЬКО текст ответа от имени владельца, без пояснений, без кавычек, без подписи.\n\nПРАВИЛА, заданные владельцем:\n${(systemPrompt || DEFAULT_AGENT_PROMPT).trim()}\n`
  if (examples.length) {
    s += `\nПРИМЕРЫ одобренных ответов (стиль подстраивай под правила, не копируй дословно):\n`
    for (const e of examples.slice(-8)) {
      s += `- ${e.from ? `От ${e.from}: ` : ''}${e.incoming.replace(/\s+/g, ' ').slice(0, 300)}\n  Ответ: ${e.reply.replace(/\s+/g, ' ').slice(0, 500)}\n`
    }
  }
  s += `\nЖёсткие ограничения: никаких паролей/кодов/личных данных; никаких обещаний реальных действий (платежи, документы) — только «передам владельцу»; ответ всегда на языке входящего.`
  return s
}

/* --------------------------------------------------------------- zai calls */

async function zaiText(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], temperature = 0.4, maxTokens = 700): Promise<string> {
  const res = await zai.chat.completions({ messages, temperature, max_tokens: maxTokens })
  const text = res.choices?.[0]?.message?.content || ''
  if (!text.trim()) throw new Error('модель вернула пустой ответ')
  return text.trim()
}

function extractJson<T>(raw: string): T | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.search(/[[{]/)
  if (start < 0) return null
  const open = candidate[start]
  const close = open === '[' ? ']' : '}'
  const end = candidate.lastIndexOf(close)
  if (end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

/** /api/tg/coach: the owner explains rules in words; AI updates the prompt. */
export async function coachPrompt(currentPrompt: string, message: string): Promise<{ reply: string; prompt: string }> {
  const sys =
    'Ты помогаешь владельцу Telegram-аккаунта настраивать правила его личного агента, ' +
    'который отвечает на входящие сообщения от его имени. Ты ведёшь ТЕКСТ ПРАВИЛ ' +
    '(системный промпт агента). Пользователь сообщает правила обычными словами ' +
    '(тон, что делать с конкретными людьми, какие файлы создавать, что передавать владельцу). ' +
    'Обнови полный текст правил, сохранив всё важное из прежней версии и добавив новое. ' +
    'Правила — только про поведение агента в Telegram: тон, запреты, приоритеты, имя/отношение к контактам. ' +
    'Ответь СТРОГО JSON: {"reply": "короткий ответ пользователю по-русски (1-3 предложения, что изменил)", "prompt": "полный обновлённый текст правил"}'
  const raw = await zaiText(
    [
      { role: 'system', content: sys },
      { role: 'user', content: `ТЕКУЩИЕ ПРАВИЛА:\n"""\n${(currentPrompt || DEFAULT_AGENT_PROMPT).slice(0, 4000)}\n"""\n\nСООБЩЕНИЕ ВЛАДЕЛЬЦА:\n${message.slice(0, 2000)}` },
    ],
    0.3,
    1600,
  )
  const parsed = extractJson<{ reply?: string; prompt?: string }>(raw)
  if (!parsed || typeof parsed.prompt !== 'string' || parsed.prompt.trim().length < 20) {
    throw new Error('модель не вернула обновлённые правила — переформулируй и попробуй ещё раз')
  }
  return { reply: (parsed.reply || 'Правила обновлены.').trim(), prompt: parsed.prompt.trim() }
}

/** /api/tg/simulate: dry-run the agent against a sample incoming message. */
export async function simulateVariants(systemPrompt: string, examples: TgExample[], fromName: string, incoming: string): Promise<{ style: string; text: string }[]> {
  const base = compileAgentPrompt({ firstName: 'Владелец' }, systemPrompt, examples)
  const sys =
    base +
    '\n\nСЕЙЧАС РЕЖИМ ТЕСТИРОВАНИЯ: сгенерируй ТРИ варианта ответа на пробное входящее сообщение ' +
    '(короткий, официальный/деловой, тёплый/неформальный). ' +
    'Ответь СТРОГО JSON: {"variants":[{"style":"короткий","text":"..."},{"style":"официальный","text":"..."},{"style":"тёплый","text":"..."}]} — каждый text это готовое сообщение от лица владельца.'
  const raw = await zaiText(
    [
      { role: 'system', content: sys },
      { role: 'user', content: `ВХОДЯЩЕЕ ОТ ${fromName || 'контакта'}: ${incoming.slice(0, 1000)}` },
    ],
    0.6,
    900,
  )
  const parsed = extractJson<{ variants?: { style?: string; text?: string }[] }>(raw)
  const variants = (parsed?.variants || [])
    .filter((v) => v && typeof v.text === 'string' && v.text.trim())
    .map((v) => ({ style: (v.style || 'вариант').slice(0, 40), text: v.text!.trim() }))
  if (variants.length < 2) throw new Error('модель не вернула варианты ответа — попробуй ещё раз')
  return variants.slice(0, 3)
}

/** /api/tg/incoming: the real reply for an incoming private message. */
export async function agentReply(me: { firstName?: string; username?: string }, systemPrompt: string, examples: TgExample[], fromName: string, incoming: string): Promise<string> {
  const sys = compileAgentPrompt(me, systemPrompt, examples)
  const raw = await zaiText(
    [
      { role: 'system', content: sys },
      { role: 'user', content: `${fromName ? `Сообщение от ${fromName}: ` : ''}${incoming.slice(0, 1500)}` },
    ],
    0.5,
    600,
  )
  // the model must return the bare message text; strip wrapping quotes/backticks
  return raw.replace(/^["'`«]+|["'`»]+$/g, '').trim().slice(0, 1200)
}

/* ---------------------------------------------------------------- helpers */

export async function getOwnedAccount(userId: string, accountId: string) {
  return db.tgAccount.findFirst({ where: { id: accountId, userId }, include: { config: true } })
}

/** Trimmed account projection for the UI (never returns sessions/hashes). */
export function accountView(a: {
  id: string
  phone: string
  status: string
  statusText: string | null
  meInfo: string | null
  active: boolean
  apiId: number
  lastCheckAt: Date | null
  updatedAt: Date
  config?: { systemPrompt: string; examples: string; updatedAt: Date } | null
}) {
  let me: { id?: string; firstName?: string; username?: string } | null = null
  try { me = a.meInfo ? JSON.parse(a.meInfo) : null } catch { /* ignore */ }
  return {
    id: a.id,
    phone: a.phone,
    status: a.status,
    statusText: a.statusText,
    me,
    active: a.active,
    apiId: a.apiId,
    lastCheckAt: a.lastCheckAt?.toISOString() || null,
    systemPrompt: a.config?.systemPrompt ?? '',
    examples: parseExamples(a.config?.examples),
  }
}
