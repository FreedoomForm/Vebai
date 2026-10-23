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
import { appendMemText, readMemText } from '@/lib/agent/memory'

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
  let raw = String(input || '').replace(/[^\d+]/g, '')
  if (!raw.startsWith('+')) {
    // bare national numbers: guess the country instead of failing with a
    // cryptic PHONE_NUMBER_INVALID (the audience is Uzbekistan first)
    if (/^8\d{10}$/.test(raw)) raw = `+7${raw.slice(1)}` // 8XXXXXXXXXX (legacy) -> +7
    else if (/^998\d{9}$/.test(raw)) raw = `+${raw}` // 998XXXXXXXXX without +
    else if (/^\d{9}$/.test(raw)) raw = `+998${raw}` // 9 digits -> Uzbekistan
    else raw = `+${raw}`
  }
  const digits = raw.slice(1)
  if (!/^\d{8,15}$/.test(digits))
    return { error: 'номер в международном формате, например +998901234567 (можно просто 9 цифр — добавлю +998)' }
  return { phone: raw }
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
    connectionRetries: 2,
    // T29: MUST stay >= 2. GramJS _call() handles PHONE_MIGRATE_X /
    // NETWORK_MIGRATE_X (the number's home DC differs from the connect DC —
    // e.g. Uzbek accounts live on DC5 while a fresh lambda client connects to
    // its nearest DC) and ServerError/RPC_CALL_FAIL by switching DC / sleeping
    // and RE-SENDING the request on the NEXT loop iteration. With
    // requestRetries=1 there is no next iteration, so login failed with the
    // useless "Request was unsuccessful 1 time(s)" even though Telegram was
    // answering normally (reproduced on prod with a +998 number, fixed here).
    requestRetries: 5,
    useWSS: true,
    autoReconnect: false,
    floodSleepThreshold: 0,
    deviceModel: 'Vebai Agent',
    systemVersion: 'vebai-six.vercel.app',
  }
}

/** Full MTProto failure into the server logs (Vercel runtime logs): the final
 *  humanized text loses the underlying RPC details, so keep them here. */
export function logTgFailure(stage: string, e: unknown): void {
  const err = e as { constructor?: { name?: string }; message?: string; errorMessage?: string; newDc?: number; code?: number }
  console.error(
    `[tguser] ${stage} failed: ${err?.constructor?.name || 'Error'}: ${err?.message || String(e)}` +
      (err?.errorMessage ? ` | errorMessage=${err.errorMessage}` : '') +
      (err?.newDc ? ` | newDc=${err.newDc}` : ''),
  )
}

/** Human-readable Russian error from a GramJS/MTProto failure (honest errors
 *  are the T21 rule: never swallow, never fake success). */
export function tgErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const flood = raw.match(/FLOOD_WAIT_(\d+)/i)
  if (flood)
    return `Telegram: слишком много попыток входа — подожди ${flood[1]} сек и попробуй снова (FLOOD_WAIT)`
  const retries = raw.match(/Request was unsuccessful (\d+)/i)
  if (retries)
    return `Telegram не ответил после ${retries[1]} попыток (временный сбой сети/сервера) — попробуй ещё раз через минуту`
  const map: [RegExp, string][] = [
    [/PHONE_NUMBER_INVALID/i, 'Telegram отклонил номер: PHONE_NUMBER_INVALID'],
    [/PHONE_NUMBER_UNEXISTED/i, 'Telegram: номер не зарегистрирован (PHONE_NUMBER_UNEXISTED)'],
    // T42b: Telegram's anti-phishing revokes a login code that was SENT as a
    // chat message and blocks the login («код введён верно, но вход
    // заблокирован — вы сообщили код со своего аккаунта»). Both the site and
    // the bot surface these texts, so they must teach the safe path: enter the
    // code on /tgagent, never in a chat.
    [/PHONE_CODE_INVALID/i, 'Telegram отклонил код. Причины: опечатка, код из СТАРОГО запроса — или код отправили в чат (Telegram отзывает коды, отправленные сообщением). Запроси новый код и введи его на странице /tgagent, не в чате'],
    [/PHONE_CODE_EXPIRED/i, 'Код истёк или отозван (истекает сам, убивается новым запросом кода или отправкой кода в чат) — запроси новый и введи его на странице /tgagent, не в чате'],
    [/SESSION_PASSWORD_NEEDED/i, 'Включена двухфакторная защита — нужен облачный пароль'],
    [/PASSWORD_HASH_INVALID/i, 'Неверный облачный пароль (2FA)'],
    [/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/i, 'api_id отклонён Telegram (API_ID_INVALID/PUBLISHED_FLOOD) — проверь api_id/api_hash с my.telegram.org'],
    [/AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED/i, 'сессия недействительна — переподключи аккаунт'],
  ]
  for (const [re, msg] of map) if (re.test(raw)) return msg
  return raw.slice(0, 240)
}

/* ------------------------------------------------ shared MTProto login flow */

/** Mark of an MTProto-level failure (already humanized) — callers prefix it
 *  with «Telegram недоступен» while passing validation errors as-is. */
export class TgMtprotoError extends Error {}

/** thrown by mtprotoVerifyCode when Telegram demands the 2FA cloud password */
export class NeedPasswordError extends Error {}

export interface SendCodeResult {
  phoneCodeHash: string
  loginSession: string // StringSession created during sendCode (MUST match at signIn)
  viaApp: boolean
  usingEnvCreds: boolean
  apiId: number
  apiHashEnc: string
}

/** Ask Telegram to send the login code for `phone`. A fresh MTProto connection
 *  is made each time (Vercel lambdas are stateless) — Telegram validates the
 *  code against phoneCodeHash, not against the socket. Throws TgMtprotoError
 *  (humanized) on MTProto failures, plain Error on validation problems. */
export async function mtprotoSendCode(
  phone: string,
  ownCreds?: { apiId?: unknown; apiHash?: unknown },
): Promise<SendCodeResult> {
  const creds = parseApiCreds(ownCreds || {})
  if ('error' in creds) throw new Error(creds.error)
  // T30: encrypt the api_hash BEFORE touching MTProto — a missing/invalid
  // encryption key is a server CONFIG error. If it threw inside the MTProto
  // catch below, it would be reported as «Telegram недоступен» even though
  // Telegram had already delivered the login code (exactly the owner-reported
  // «GH_TERM_SECRET не задан» confusion).
  const apiHashEnc = encryptSecret(creds.apiHash)
  const { TelegramClient, StringSession } = await gramjs()
  let client: InstanceType<typeof TelegramClient> | null = null
  try {
    client = new TelegramClient(new StringSession(''), creds.apiId, creds.apiHash, clientOpts())
    await client.connect()
    const sent = await client.sendCode({ apiId: creds.apiId, apiHash: creds.apiHash }, phone)
    return {
      phoneCodeHash: sent.phoneCodeHash,
      loginSession: (client.session.save() as unknown as string) || '',
      viaApp: !!sent.isCodeViaApp,
      usingEnvCreds: !!envApiCreds(),
      apiId: creds.apiId,
      apiHashEnc,
    }
  } catch (e) {
    logTgFailure('sendCode', e)
    throw new TgMtprotoError(tgErrorText(e))
  } finally {
    try { if (client) await client.disconnect() } catch { /* already gone */ }
  }
}

export interface VerifyCodeArgs {
  apiId: number
  apiHashEnc: string
  loginSessionEnc: string
  phone: string
  phoneCodeHash: string
  status: string // 'pending' | '2fa'
  code: string
  password: string
}

export interface VerifiedLogin {
  session: string // long-lived StringSession (encrypt before storing!)
  me: { id: string; firstName: string; username: string; phone: string }
}

/** Verify the login code (auth.signIn) on the SAME login session created by
 *  mtprotoSendCode; handles the 2FA path (account.GetPassword + SRP check).
 *  Throws NeedPasswordError when the cloud password is required. */
export async function mtprotoVerifyCode(args: VerifyCodeArgs): Promise<VerifiedLogin> {
  const { TelegramClient, StringSession, computeCheck, Api } = await gramjs()
  // T30: decrypt inputs BEFORE the MTProto try — decryption failures are
  // server config problems (missing key / corrupted row), not Telegram errors.
  const apiHash = decryptSecret(args.apiHashEnc)
  const loginSession = decryptSecret(args.loginSessionEnc)
  let client: InstanceType<typeof TelegramClient> | null = null
  try {
    client = new TelegramClient(new StringSession(loginSession), args.apiId, apiHash, clientOpts())
    await client.connect()
    if (args.status === '2fa' || (!args.code && args.password)) {
      const pwdInfo = await client.invoke(new Api.account.GetPassword())
      const check = await computeCheck(pwdInfo, args.password)
      await client.invoke(new Api.auth.CheckPassword({ password: check }))
    } else {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: args.phone,
          phoneCodeHash: args.phoneCodeHash,
          phoneCode: args.code,
        }),
      )
    }
    const me = await client.getMe()
    return {
      session: (client.session.save() as unknown as string) || '',
      me: { id: String(me.id), firstName: me.firstName || '', username: me.username || '', phone: args.phone },
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    if (/SESSION_PASSWORD_NEEDED/i.test(raw)) throw new NeedPasswordError()
    logTgFailure('verifyCode', e)
    throw new TgMtprotoError(tgErrorText(e))
  } finally {
    try { if (client) await client.disconnect() } catch { /* already gone */ }
  }
}

/** human error for UI/chat: MTProto failures get the «Telegram недоступен» tag */
export function humanTgError(e: unknown): string {
  if (e instanceof TgMtprotoError) return `Telegram недоступен: ${e.message}`
  return e instanceof Error ? e.message : String(e)
}

/* -------------------- login-code freshness + resend (T42) ------------------
 * A NEWER auth.SendCode for the same phone KILLS every previous login code —
 * the owner then enters a code whose hash is already dead and gets
 * PHONE_CODE_EXPIRED «even though a minute has not passed» (reproduced 2026-10-20:
 * same auth key + own hash -> EXPIRED once a newer request had superseded it).
 * Within the freshness window a second sendCode must NOT fire; the user is
 * told to enter the code or explicitly ask for a resend (auth.ResendCode). */

export const CODE_FRESH_MS = 3 * 60_000

const codeReqKey = (userId: string) => `tg-code-req:${userId}`

/** remember the moment a login code was REQUESTED (shared by the site
 *  /api/tg/connect and the bot FSM — one marker per user, last write wins) */
export async function markCodeRequested(userId: string, phone: string): Promise<void> {
  await db.studioState.upsert({
    where: { key: codeReqKey(userId) },
    create: { key: codeReqKey(userId), data: JSON.stringify({ phone, at: Date.now() }) },
    update: { data: JSON.stringify({ phone, at: Date.now() }) },
  })
}

/** seconds since a code was requested for THIS phone (null when nothing is
 *  fresh) — callers must not fire a second sendCode while it is not null */
export async function freshCodeRequest(userId: string, phone: string): Promise<number | null> {
  try {
    const row = await db.studioState.findUnique({ where: { key: codeReqKey(userId) } })
    if (!row) return null
    const rec = JSON.parse(row.data) as { phone?: string; at?: number }
    if (!rec?.at || rec.phone !== phone) return null
    const age = Date.now() - rec.at
    return age >= 0 && age < CODE_FRESH_MS ? Math.round(age / 1000) : null
  } catch {
    return null
  }
}

export interface ResendCodeArgs {
  apiId: number
  apiHashEnc: string
  loginSessionEnc: string
  phone: string
  phoneCodeHash: string
}

/** Re-deliver the login code for the SAME request (auth.ResendCode on the SAME
 *  session + phoneCodeHash) — unlike a fresh sendCode it does not invalidate
 *  the pending request. Throws TgMtprotoError when the old hash is dead
 *  (PHONE_CODE_EXPIRED) — the caller must fall back to a full phone step. */
export async function mtprotoResendCode(args: ResendCodeArgs): Promise<{ phoneCodeHash: string; viaApp: boolean }> {
  const apiHash = decryptSecret(args.apiHashEnc)
  const loginSession = decryptSecret(args.loginSessionEnc)
  const { TelegramClient, StringSession, Api } = await gramjs()
  let client: InstanceType<typeof TelegramClient> | null = null
  try {
    client = new TelegramClient(new StringSession(loginSession), args.apiId, apiHash, clientOpts())
    await client.connect()
    const res = await client.invoke(
      new Api.auth.ResendCode({ phoneNumber: args.phone, phoneCodeHash: args.phoneCodeHash }),
    )
    if (res instanceof Api.auth.SentCodeSuccess) throw new TgMtprotoError('запрос уже завершился — отправь номер заново')
    return {
      phoneCodeHash: String(res.phoneCodeHash),
      viaApp: res.type instanceof Api.auth.SentCodeTypeApp,
    }
  } catch (e) {
    if (e instanceof TgMtprotoError) throw e
    logTgFailure('resendCode', e)
    throw new TgMtprotoError(tgErrorText(e))
  } finally {
    try { if (client) await client.disconnect() } catch { /* already gone */ }
  }
}

/** Move the pre-connection rules draft into the agent config (after a
 *  successful login). Used by BOTH the site /verify and the bot connect FSM. */
export async function migrateRulesDraft(userId: string, accountId: string): Promise<void> {
  const draft = await readRulesDraft(userId)
  await db.tgAgentConfig.upsert({
    where: { accountId },
    update: {},
    create: {
      accountId,
      systemPrompt: draft.systemPrompt || DEFAULT_AGENT_PROMPT,
      examples: JSON.stringify(draft.examples || []),
    },
  })
  await clearRulesDraft(userId)
}

/* ------------------------------------------------------- agent chat (T28) */

/** T28: the user's agent conversation on the site (one per user). Its
 *  transcript IS the agent's memory: everything the owner tells the agent
 *  here is what the agent uses when it answers people DM-ing the account.
 *  Pointer lives in StudioState; the Conversation row is a normal chat row
 *  (title badge only) so the usual chat history/UI/permissions apply. */
const agentChatKey = (userId: string) => `tguser-chat:${userId}`
export const AGENT_CONV_TITLE = '🤖 Telegram-агент'

/** read-only: the registered agent conversation id (or null). Ownership is
 *  re-verified against the Conversation row. */
export async function readAgentConversationId(userId: string): Promise<string | null> {
  try {
    const row = await db.studioState.findUnique({ where: { key: agentChatKey(userId) } })
    const id = row ? String((JSON.parse(row.data) as { conversationId?: string }).conversationId || '') : ''
    if (!id) return null
    const conv = await db.conversation.findUnique({ where: { id } })
    return conv && (!conv.userId || conv.userId === userId) ? id : null
  } catch {
    return null
  }
}

/** get-or-create the agent conversation (used by POST /api/tg/chat). */
export async function getAgentConversation(userId: string): Promise<string> {
  const existing = await readAgentConversationId(userId)
  if (existing) return existing
  const conv = await db.conversation.create({
    data: { userId, title: AGENT_CONV_TITLE },
  })
  const data = JSON.stringify({ conversationId: conv.id })
  await db.studioState.upsert({
    where: { key: agentChatKey(userId) },
    update: { data, updatedAt: new Date() },
    create: { key: agentChatKey(userId), data },
  })
  return conv.id
}

/** The owner ↔ agent transcript (last turns), condensed for the reply prompt. */
export async function loadAgentContext(userId: string, opts?: { maxTurns?: number; maxChars?: number }): Promise<string> {
  const convId = await readAgentConversationId(userId)
  if (!convId) return ''
  const maxTurns = opts?.maxTurns ?? 40
  const maxChars = opts?.maxChars ?? 6000
  const msgs = await db.message.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: 'desc' },
    take: maxTurns,
  })
  const lines: string[] = []
  let budget = maxChars
  for (const m of [...msgs].reverse()) {
    const c = (m.content || '').trim()
    if (!c) continue
    const line = `${m.role === 'user' ? 'Владелец' : 'Агент'}: ${c.replace(/\s+/g, ' ').slice(0, 400)}`
    budget -= line.length
    if (budget < 0) break
    lines.push(line)
  }
  return lines.join('\n')
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

/* ---------------------------------------------------- agent memory (T38/T52) */

/** T38 (owner request): the agent's DURABLE memory. T52: the storage is now
 *  the SHARED agent memory (StudioState 'agentMemory' via lib/agent/memory)
 *  — one store the runner (<memory>/<end>), the DM tasks and the site chat
 *  all read, and the owner can edit on the memory page. The per-user
 *  'tg-agent-memory:{userId}' keys are legacy (kept untouched in the DB). */

export async function readAgentMemory(_userId: string): Promise<string> {
  try {
    return await readMemText()
  } catch { return '' }
}

/** Append one entry; when over budget drop the OLDEST whole entries first
 *  (the newest tail is what steers current behaviour). Best-effort.
 *  T52: writes now land in the SHARED agent memory. */
export async function appendAgentMemory(userId: string, title: string, body: string): Promise<void> {
  const line = [(title || '').trim(), (body || '').trim()].filter(Boolean).join(' — ')
  if (!line) return
  await appendMemText(line, 'dm')
}

/** T38: the silent step at the END of every agent request — condense the
 *  interaction into 1-2 sentences and append to memory.md. Strictly
 *  best-effort: never throws, never delays or breaks the reply itself. */
export async function rememberInteraction(
  userId: string,
  chatName: string,
  incoming: string,
  outcome: string,
): Promise<void> {
  try {
    const memory = await readAgentMemory(userId)
    const res = await zai.chat.completions({
      messages: [
        {
          role: 'system',
          content:
            'Ты ведёшь память личного Telegram-агента (memory.md). После каждого обращения к агенту в память дописывается краткая выжимка. Верни ТОЛЬКО 1-2 коротких предложения САМОГО важного на будущее: кто писал, что просил/сообщил, факты, договорённости, обещания, тон общения. Телеграфный стиль, в третьем лице, по-русски. Без вступлений, без кавычек, без markdown-заголовков.',
        },
        {
          role: 'user',
          content: [
            `ПАМЯТЬ (уже записано):\n${memory.trim() || '(пусто)'}`,
            `Человек: ${chatName || '(имя неизвестно)'}`,
            `Входящее сообщение: ${incoming.replace(/\s+/g, ' ').slice(0, 800)}`,
            `Итог обращения: ${outcome.replace(/\s+/g, ' ').slice(0, 800)}`,
          ].join('\n\n'),
        },
      ],
      temperature: 0.2,
      max_tokens: 160,
    })
    const text = String(res.choices?.[0]?.message?.content || '').replace(/^["'«]+|["'»]+$/g, '').trim()
    if (!text) return
    await appendAgentMemory(userId, chatName || 'входящее', text)
  } catch { /* memory is strictly best-effort */ }
}

/* ------------------------------------------- DM decision (T52) */

/** T38/T39 used a one-shot agentDecide() model ("просто ИИ"). T52 (owner
 *  request 2026-10-23): incoming DMs are handled by the FULL agent (a
 *  #!agent task with the computer, the Telegram app and the shared memory)
 *  — see /api/tg/incoming; the deciding prompt and its mechanical
 *  <action>/<text> protocol were removed together with the format retries. */

/* ------------------------------------------ owner-approval drafts (T39) */

/** T39 (owner request): the agent may decide a reply needs the owner's
 *  blessing — it then ships a DRAFT to the owner's bot chat with
 *  ✅ Отправить / ✏️ Изменить / ❌ Отменить buttons; the person receives
 *  the text only after «✅». Drafts live in StudioState per account
 *  (survives reconnects, like memory.md), TTL 24h, newest kept. */
export interface TgDraft {
  id: string
  chatId: string // the person's numeric peer id the draft is destined for
  chatName: string
  incoming: string // the message the draft answers (context for the owner)
  text: string // the draft itself — what the person would receive
  ownerChatId: string // bot chat that carries the approval buttons
  botMsgId?: number // message carrying the buttons (edited after the decision)
  status: 'pending' | 'sent' | 'cancelled'
  createdAt: string
}

const draftsKey = (accountId: string) => `tg-drafts:${accountId}`
const DRAFTS_MAX = 30
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000

function pruneDrafts(list: TgDraft[]): TgDraft[] {
  const now = Date.now()
  const fresh = list.filter((d) => now - new Date(d.createdAt).getTime() < DRAFT_TTL_MS)
  return fresh.slice(-DRAFTS_MAX)
}

export async function readDrafts(accountId: string): Promise<TgDraft[]> {
  try {
    const row = await db.studioState.findUnique({ where: { key: draftsKey(accountId) } })
    const list = row ? ((JSON.parse(row.data) as { drafts?: TgDraft[] }).drafts || []) : []
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

async function writeDrafts(accountId: string, drafts: TgDraft[]): Promise<void> {
  const data = JSON.stringify({ drafts })
  await db.studioState.upsert({
    where: { key: draftsKey(accountId) },
    update: { data, updatedAt: new Date() },
    create: { key: draftsKey(accountId), data },
  })
}

export async function createDraft(accountId: string, draft: TgDraft): Promise<void> {
  const list = pruneDrafts(await readDrafts(accountId))
  list.push(draft)
  await writeDrafts(accountId, list)
}

/** find a draft across all accounts' stores — the approval callback carries
 *  only the draft id (Telegram caps callback_data at 64 bytes) */
export async function findDraft(id: string): Promise<{ accountId: string; draft: TgDraft } | null> {
  try {
    const rows = await db.studioState.findMany({ where: { key: { startsWith: 'tg-drafts:' } }, take: 50 })
    for (const row of rows) {
      const accountId = row.key.slice('tg-drafts:'.length)
      const list = ((JSON.parse(row.data) as { drafts?: TgDraft[] }).drafts || []) as TgDraft[]
      const draft = list.find((d) => d.id === id)
      if (draft) return { accountId, draft }
    }
  } catch { /* fall through */ }
  return null
}

/** status transition + optional text/botMsgId patch (edit flow) */
export async function setDraftStatus(
  accountId: string,
  id: string,
  status: TgDraft['status'],
  patch: Partial<Pick<TgDraft, 'text' | 'botMsgId'>> = {},
): Promise<TgDraft | null> {
  const list = await readDrafts(accountId)
  const draft = list.find((d) => d.id === id)
  if (!draft) return null
  draft.status = status
  if (patch.text !== undefined) draft.text = patch.text
  if (patch.botMsgId !== undefined) draft.botMsgId = patch.botMsgId
  await writeDrafts(accountId, list)
  return draft
}

/** one canonical rendering of the draft card shown to the owner — used by
 *  the incoming route when creating AND by the webhook when editing */
export function renderDraftMessage(draft: TgDraft): string {
  return (
    `📨 Черновик ответа для ${draft.chatName || `id ${draft.chatId}`}\n\n` +
    `Входящее: «${draft.incoming.replace(/\s+/g, ' ').slice(0, 600)}»\n\n` +
    `Черновик:\n${draft.text.slice(0, 1500)}\n\n` +
    `✅ — отправить от твоего имени; ✏️ — пришлёшь свой текст вместо черновика; ❌ — ничего не уйдёт.`
  )
}

export function draftKeyboard(id: string): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: '✅ Отправить', callback_data: `drok:${id}` },
        { text: '✏️ Изменить', callback_data: `dredit:${id}` },
      ],
      [{ text: '❌ Отменить', callback_data: `drno:${id}` }],
    ],
  }
}

/** T28: the persona used in the SITE CHAT when the owner talks to his agent
 *  (the «TG-агент» connector). The owner teaches the agent here; the
 *  transcript feeds every incoming-message decision (T38), alongside the
 *  durable memory.md. */
export function compileAgentChatPrompt(me: { firstName?: string; username?: string }, systemPrompt: string): string {
  const who = [me.firstName, me.username ? `(@${me.username})` : ''].filter(Boolean).join(' ')
  return [
    `Ты — личный Telegram-агент пользователя ${who || '(владелец аккаунта)'} на сайте Vebai.`,
    'Это ЛИЧНЫЙ чат владельца с тобой: он объясняет здесь, как тебе вести себя в его Telegram — тон, что отвечать конкретным людям, какие вопросы передавать ему лично.',
    'ЗАПОМИНАЙ всё, что он говорит, — вся эта переписка становится твоим контекстом: по ней ты будешь отвечать на входящие личные сообщения В ЕГО TELEGRAM от его имени.',
    'Веди себя как умный ассистент: уточняй детали, предлагай формулировки, показывай, как бы ты ответил на типичное входящее — владелец сразу видит результат.',
    'Сейчас ты разговариваешь с ВЛАДЕЛЬЦЕМ (не с чужими людьми) — отвечай ему свободно и подробно, когда он просит разъяснений.',
    'Это обычный чат-планирование: НЕ используй инструменты run-agent/run-terminal/run-vterm/run-tg/run-tg-read и не создавай видео/файлы — только обсуждение правил и поведения. Для реальных приказов (написать/прочитать/отправить) владелец пишет в ОБЫЧНЫЙ чат сайта — там исполняй блоками.',
    'ФОРМАТ ОТВЕТА (проверяется механически): весь текст для владельца — только внутри <answer> и </answer>; пустой ответ или текст без <answer> система автоматически повторит заново.',
    `Базовые правила твоего поведения в чужом Telegram: ${(systemPrompt || DEFAULT_AGENT_PROMPT).trim()}`,
    '- Текущая дата и время (UTC): ' + new Date().toISOString().slice(0, 19).replace('T', ' '),
  ].join('\n')
}

/* ---------------------------------------------------------------- helpers */

export interface TgRulesDraft { systemPrompt?: string; examples?: TgExample[] }

/** Rules BEFORE the account is connected live as a per-user draft
 *  (StudioState); /verify migrates the draft into TgAgentConfig. The rules
 *  conversation is the entry point of the service - it must not require a
 *  connected Telegram account. */
const draftKey = (userId: string) => `tguser-rules:${userId}`

export async function readRulesDraft(userId: string): Promise<TgRulesDraft> {
  try {
    const row = await db.studioState.findUnique({ where: { key: draftKey(userId) } })
    return row ? (JSON.parse(row.data) as TgRulesDraft) : {}
  } catch { return {} }
}

export async function writeRulesDraft(userId: string, patch: Partial<TgRulesDraft>): Promise<TgRulesDraft> {
  const cur = await readRulesDraft(userId)
  const next: TgRulesDraft = { ...cur, ...patch }
  const data = JSON.stringify(next)
  await db.studioState.upsert({
    where: { key: draftKey(userId) },
    update: { data, updatedAt: new Date() },
    create: { key: draftKey(userId), data },
  })
  return next
}

export async function clearRulesDraft(userId: string): Promise<void> {
  await db.studioState.delete({ where: { key: draftKey(userId) } }).catch(() => {})
}

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

/* --------------------------------- site<->bot identity bridge (T41) --------
 * The bot maps a chat to a User row by User.telegramChatId, while a personal
 * MTProto account is always owned by the SAME User row (TgAccount.userId).
 * When the account is connected on the SITE the chat binding used to be left
 * untouched, so the bot kept looking at a guest user and showed «не подключён».
 * These helpers make one Telegram identity = one user row in both directions. */

/** the telegram user id hidden in a stored meInfo JSON ({id,...}) — null when
 *  the blob is missing/corrupt or not a plain numeric TG id */
export function meInfoTgId(meInfo: string | null | undefined): string | null {
  if (!meInfo) return null
  try {
    const me = JSON.parse(meInfo) as { id?: unknown }
    const id = typeof me.id === 'number' ? String(me.id) : typeof me.id === 'string' ? me.id : ''
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

/** Bind a telegram chat (the bot's per-chat user) to a site User row:
 *  detaches the current holder (auto-registered guest), sets
 *  User.telegramChatId and re-points the bot's tgUsers map entry at the site
 *  user so the bot instantly sees the site-side state (connected personal
 *  account, agent toggle, chats). The bot conversation history moves with the
 *  binding — the same merge /start connect_<token> performs. */
export async function bindChatToUser(
  chatId: string,
  siteUserId: string,
  tgUsername?: string | null,
): Promise<void> {
  const holder = await db.user.findUnique({ where: { telegramChatId: chatId } })
  if (holder && holder.id !== siteUserId)
    await db.user.update({ where: { id: holder.id }, data: { telegramChatId: null } })
  await db.user.update({
    where: { id: siteUserId },
    data: { telegramChatId: chatId, ...(tgUsername ? { telegramUsername: tgUsername } : {}) },
  })
  // re-point the bot's per-chat entry (keep convId/flags) and hand the bot
  // conversation history to the site account; best-effort — ensureUserConv
  // reconciles the map against User.telegramChatId on the next message anyway
  try {
    const row = await db.studioState.findUnique({ where: { key: 'tgUsers' } })
    const map = row ? (JSON.parse(row.data) as Record<string, { convId?: string } & Record<string, unknown>>) : {}
    const entry = map[chatId]
    if (entry) {
      map[chatId] = { ...entry, userId: siteUserId, ...(tgUsername ? { username: tgUsername } : {}) }
      await db.studioState.upsert({
        where: { key: 'tgUsers' },
        create: { key: 'tgUsers', data: JSON.stringify(map) },
        update: { data: JSON.stringify(map) },
      })
      if (entry.convId)
        await db.conversation.updateMany({ where: { id: entry.convId }, data: { userId: siteUserId } })
    }
  } catch { /* the reconciliation in ensureUserConv covers this */ }
}

/** T41 auto-heal: this chat's person may have connected their OWN account on
 *  the SITE while the bot chat still maps to a guest user row (the binding
 *  was never made). Find the connected TgAccount whose meInfo.id == chatId
 *  and bind its owner to this chat. Conservative by design:
 *  - never touches an account whose owner is bound to a DIFFERENT chat;
 *  - never rips the chat away from a real (email-registered) site user.
 *  Returns the adopted account or null. */
export async function adoptConnectedAccountByChatId(chatId: string): Promise<{ id: string; active: boolean } | null> {
  if (!/^\d+$/.test(chatId)) return null
  const rows = await db.tgAccount.findMany({
    where: { status: 'connected' },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: { id: true, userId: true, meInfo: true, active: true },
  })
  const acc = rows.find((r) => meInfoTgId(r.meInfo) === chatId)
  if (!acc) return null
  const owner = await db.user.findUnique({ where: { id: acc.userId } })
  if (!owner) return null
  // the account owner is already bound to another chat — leave everything as is
  if (owner.telegramChatId && owner.telegramChatId !== chatId) return null
  const holder = await db.user.findUnique({ where: { telegramChatId: chatId } })
  if (holder && holder.id !== owner.id && !holder.email.endsWith('@telegram.vebai.app'))
    return null // a real site user owns this chat — do not steal it
  if (!holder || holder.id !== owner.id)
    await bindChatToUser(chatId, owner.id, owner.telegramUsername || null)
  return { id: acc.id, active: acc.active }
}
