import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { zai, type ChatMessage } from '@/lib/zai'
import { systemPrompt } from '@/lib/agent/prompt'
import { parseAiAnswer } from '@/lib/agent/answer'
import {
  mtprotoSendCode,
  mtprotoVerifyCode,
  NeedPasswordError,
  humanTgError,
  normalizePhone,
  encryptSecret,
  migrateRulesDraft,
} from '@/lib/tguser'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/telegram — two-way Telegram bot (multi-user since 2026-10-18).
 *
 * EVERY Telegram user can chat with the bot: the first /start ever binds the
 * OWNER (full powers: raw shell "!cmd", channel archive, third-party sends).
 * All other users are auto-registered (User with telegramChatId) and get
 * their own conversation, so their task/file history is visible on the site
 * (Telegram Mini App -> /api/auth/telegram -> session cookie -> account).
 *
 * Modes: plain text = agent task (GitHub Actions, #!agent), "?text" = fast
 * model chat, "!cmd" = raw shell (owner only), /status = pipeline state.
 * Guests are rate-limited (concurrent + daily caps) because one resident
 * runner serves everyone sequentially.
 *
 * T27: the menu carries «📱 Подключить Telegram аккаунт» — a per-chat FSM
 * (phone -> code -> optional 2FA password) that connects the user's OWN
 * Telegram account (MTProto, same TgAccount row as the site /tgagent). While
 * not connected the button shows; once connected it disappears in the bot AND
 * on the site, and the personal agent can answer incoming DMs on the user's
 * behalf (resident worker, .github/tg_userbot.js). Messages containing the
 * phone/code/password are deleted from the chat right after processing.
 *
 * Setup (one-time): setWebhook with url + secret_token=TELEGRAM_WEBHOOK_SECRET.
 */

const CACHE_KEY = 'telegramBot'
const USERS_KEY = 'tgUsers'
const LINK_TOKENS_KEY = 'tgLinkTokens'
const CONNECT_KEY = 'tgBotConnect' // T27: per-chat connect FSM (phone/code/password)
const MINI_APP_URL = process.env.VEBAI_MINI_APP_URL || 'https://vebai-six.vercel.app/tg'
const SITE_BASE = MINI_APP_URL.replace(/\/tg$/, '') // for deep links to site pages

/** guests: no more than this many running/queued tasks at once ... */
const GUEST_MAX_ACTIVE = 1
/** ... and no more than this many tasks per UTC day */
const GUEST_DAILY_LIMIT = 20

interface BotCache {
  ownerChatId?: string
  convId?: string
  lastUpdateId?: number
}

interface TgUserEntry {
  userId: string
  convId: string
  username?: string
  name?: string
  /** message_id of the last /start in this chat — everything below it gets
   * wiped from the window when the user taps "Создать чат" / "Список чатов" */
  lastStartMsgId?: number
  /** T21: true once the user explicitly created a chat (🆕) or picked an
   * existing one (📂 -> conv:<id>). Until then the bot refuses to hand any
   * message to the AI agent — owner request 2026-10-18: «не позволяй без
   * создания нового чата или выбора существующего чата общаться с ИИ» */
  chatPicked?: boolean
}

type TgUsersMap = Record<string, TgUserEntry>

async function readCache(): Promise<BotCache> {
  try {
    const row = await db.studioState.findUnique({ where: { key: CACHE_KEY } })
    if (row) return JSON.parse(row.data) as BotCache
  } catch { /* fall through */ }
  return {}
}

async function writeCache(patch: Partial<BotCache>): Promise<void> {
  const c = { ...(await readCache()), ...patch }
  await db.studioState.upsert({
    where: { key: CACHE_KEY },
    create: { key: CACHE_KEY, data: JSON.stringify(c) },
    update: { data: JSON.stringify(c) },
  })
}

async function readUsersMap(): Promise<TgUsersMap> {
  try {
    const row = await db.studioState.findUnique({ where: { key: USERS_KEY } })
    if (row) return JSON.parse(row.data) as TgUsersMap
  } catch { /* fall through */ }
  return {}
}

async function writeUsersMap(map: TgUsersMap): Promise<void> {
  await db.studioState.upsert({
    where: { key: USERS_KEY },
    create: { key: USERS_KEY, data: JSON.stringify(map) },
    update: { data: JSON.stringify(map) },
  })
}

/* -------------------------------------------------- T27: connect-own-account */

/** per-chat FSM for connecting the user's OWN Telegram account:
 *  phone -> code -> optional 2FA password (the same TgAccount row the site
 *  /tgagent creates, so connected state is visible in BOTH places) */
interface ConnectFsm {
  step: 'phone' | 'code' | 'password'
  accountId?: string
  phone?: string
  exp: number
}

type ConnectMap = Record<string, ConnectFsm>

async function readConnectMap(): Promise<ConnectMap> {
  try {
    const row = await db.studioState.findUnique({ where: { key: CONNECT_KEY } })
    if (row) return JSON.parse(row.data) as ConnectMap
  } catch { /* fall through */ }
  return {}
}

async function writeConnectMap(map: ConnectMap): Promise<void> {
  await db.studioState.upsert({
    where: { key: CONNECT_KEY },
    create: { key: CONNECT_KEY, data: JSON.stringify(map) },
    update: { data: JSON.stringify(map) },
  })
}

async function setConnect(chatId: string, fsm: ConnectFsm): Promise<void> {
  const map = await readConnectMap()
  map[chatId] = fsm
  await writeConnectMap(map)
}

async function clearConnect(chatId: string): Promise<void> {
  const map = await readConnectMap()
  if (!map[chatId]) return
  delete map[chatId]
  await writeConnectMap(map)
}

/** the user's connected MTProto account (same row the site /tgagent uses) */
function connectedAccount(userId: string) {
  return db.tgAccount.findFirst({ where: { userId, status: 'connected' }, orderBy: { updatedAt: 'desc' } })
}

async function tgSend(
  chatId: number | string,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!token) return
  try {
    const body: Record<string, unknown> = { chat_id: chatId, text: text.slice(0, 3800) }
    if (replyMarkup) body.reply_markup = replyMarkup
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
  } catch { /* best-effort */ }
}

const appButtonRow = (): { text: string; web_app: { url: string } }[] => [
  { text: '🌐 Открыть Vebai (аккаунт)', web_app: { url: MINI_APP_URL } },
]

/** menu keyboard (T27): the «📱 Подключить Telegram аккаунт» button exists
 *  ONLY while the user's account is not connected — once connected it
 *  disappears here AND on the site (one shared TgAccount row), and the agent
 *  toggle + rules link take its place. */
async function menuKb(userId: string): Promise<Record<string, unknown>> {
  const rows: Record<string, unknown>[][] = [
    [
      { text: '🆕 Создать чат', callback_data: 'newchat' },
      { text: '📂 Чаты', callback_data: 'chatlist' },
    ],
    appButtonRow(),
  ]
  const acc = await connectedAccount(userId)
  if (!acc) {
    rows.push([{ text: '📱 Подключить Telegram аккаунт', callback_data: 'tgconnect' }])
  } else {
    rows.push([
      { text: acc.active ? '🤖 Агент: ВКЛ — выключить' : '🤖 Агент: ВЫКЛ — включить', callback_data: 'tgagent' },
      { text: '💬 Научить агента (чат)', url: `${SITE_BASE}/?agent=1` },
    ])
  }
  return { inline_keyboard: rows }
}

async function patchUserEntry(chatId: string, patch: Partial<TgUserEntry>): Promise<void> {
  const map = await readUsersMap()
  const cur = map[chatId]
  if (!cur) return
  await writeUsersMap({ ...map, [chatId]: { ...cur, ...patch } })
}

/** delete the messages currently visible in the user's chat with the bot
 * (everything after the last /start — Telegram lets bots delete private-chat
 * messages up to 48h; older ones just fail and are skipped) */
async function clearBotWindow(chatId: string, currentMsgId: number, anchorMsgId?: number): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!token || !anchorMsgId || currentMsgId <= anchorMsgId) return
  const stop = Math.max(currentMsgId - 40, anchorMsgId + 1)
  for (let id = currentMsgId - 1; id >= stop; id--) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: id }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch { /* best-effort */ }
  }
}

/** delete the user's message (T27 privacy: phone/code/password must not
 * linger in the chat history). Bots may delete private-chat messages. */
async function deleteMsg(chatId: string, messageId: number): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!token || !messageId) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch { /* best-effort */ }
}

async function answerCallback(queryId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!token) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: queryId, text: text.slice(0, 190) }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch { /* best-effort */ }
}

/** inline keyboard with the user's conversations (chat list in the bot) */
async function chatListKeyboard(userId: string): Promise<Record<string, unknown>> {
  const convs = await db.conversation.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  })
  const rows = convs.map((c) => [{
    text: `💬 ${(c.title || 'Без названия').slice(0, 32)}`,
    callback_data: `conv:${c.id}`,
  }])
  rows.push([{ text: '🆕 Создать чат', callback_data: 'newchat' }])
  rows.push([{ text: '⬅️ Назад', callback_data: 'back' }])
  return { inline_keyboard: rows }
}

/** header text of the morphing control panel (menu state) */
const menuPanelText = (connected: boolean) =>
  connected
    ? '🤖 Vebai — панель управления:\n\n' +
      '• «🆕 Создать чат» — новый чат для задач\n' +
      '• «📂 Чаты» — список чатов (история откроется одним сообщением)\n' +
      '✅ твой Telegram подключён: агент отвечает на входящие личные сообщения от твоего имени (тумблер ниже, контекст — кнопка «💬 Научить агента»: чат на сайте, где ты учишь агента)\n\n' +
      'Обычный текст = задача агенту, «?текст» = быстрый вопрос. Кнопки: /menu'
    : '🤖 Vebai — панель управления:\n\n' +
      '• «🆕 Создать чат» — новый чат для задач\n' +
      '• «📂 Чаты» — список чатов (история откроется одним сообщением)\n' +
      '• «📱 Подключить Telegram аккаунт» — номер + код из Telegram, и агент сможет отвечать на входящие от твоего имени\n\n' +
      'Обычный текст = задача агенту, «?текст» = быстрый вопрос. Кнопки: /menu'

/** chat history condensed into ONE message (Telegram cap ~4096 chars) */
async function chatDigest(convId: string, title?: string): Promise<string> {
  const msgs = await db.message.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: 'desc' },
    take: 14,
  })
  const tail = '\n\n(вернуться к кнопкам: /menu)'
  if (!msgs.length)
    return `🆕 «${(title || 'Чат').slice(0, 40)}» пуст — напиши задачу обычным сообщением, агент приступит.${tail}`
  const lines = msgs
    .reverse()
    .map((m) => `${m.role === 'user' ? '👤' : '🤖'} ${(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`)
    .join('\n\n')
  let out = `📜 «${(title || 'Чат').slice(0, 40)}» — история одним сообщением:\n\n${lines}`
  if (out.length > 3800) out = out.slice(0, 3760) + '…\n\n(показаны последние сообщения)'
  return out + tail
}

/** morph the panel message: edit text + swap/remove the inline keyboard.
 * kb === undefined -> buttons are REMOVED after the press (owner request:
 * вошёл в чат — кнопки исчезли, история видна одним сообщением, пиши агенту). */
async function editPanel(chatId: string, messageId: number, text: string, kb?: Record<string, unknown>): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!token || !messageId) {
    await tgSend(chatId, text, kb)
    return
  }
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 3800),
    link_preview_options: { is_disabled: true },
  }
  if (kb) body.reply_markup = kb
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const j = (await r.json().catch(() => null)) as { ok?: boolean } | null
    if (j?.ok) {
      if (!kb) {
        // strip whatever inline keyboard the message still carries
        await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
          signal: AbortSignal.timeout(15_000),
        }).catch(() => undefined)
      }
      return
    }
  } catch { /* fall through: send a fresh panel message */ }
  await tgSend(chatId, text, kb)
}

async function statusText(): Promise<string> {
  const lines: string[] = []
  try {
    const jobs = await db.job.groupBy({ by: ['status'], _count: { _all: true } })
    const s = jobs.map((j) => `${j.status}: ${j._count._all}`).join(', ') || 'нет задач'
    lines.push(`Задачи: ${s}`)
    const st = await db.studioState.findUnique({ where: { key: 'studio' } })
    if (st) {
      const d = JSON.parse(st.data) as { kernelStatus?: string; kernelStatusAt?: string }
      lines.push(`Kaggle-воркер (видео): ${d.kernelStatus || '?'}`)
    }
    const cmds = await db.terminalCommand.count({ where: { session: { kind: 'gh' }, status: { in: ['pending', 'running'] } } })
    lines.push(`Терминал (GitHub Actions): ${cmds === 0 ? 'свободен' : `${cmds} в работе`}`)
    const users = Object.keys(await readUsersMap()).length
    lines.push(`Пользователей бота: ${users + 1}+`)
  } catch {
    lines.push('(статус недоступен)')
  }
  return `📡 Vebai status\n${lines.join('\n')}`
}

/** «🆕 Создать чат»: wipe the window down to the last /start, then open a
 * fresh conversation (the old one stays in the site account) */
async function createChat(chatId: string, entry: TgUserEntry, currentMsgId: number): Promise<void> {
  await clearBotWindow(chatId, currentMsgId, entry.lastStartMsgId)
  const stamp = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  const conv = await db.conversation.create({
    data: { userId: entry.userId, title: `Чат ${stamp}` },
  })
  await patchUserEntry(chatId, { convId: conv.id, chatPicked: true })
  await tgSend(
    chatId,
    '🆕 Новый чат создан — пиши задачу. Прежняя история и файлы остались в аккаунте на сайте.',
    await menuKb(entry.userId),
  )
}

/** "/start connect_<token>" from the site button "Подключить Telegram":
 * bind this telegram chat to the site account and pull the whole bot
 * history into that account's conversation list */
async function connectAccount(
  chatId: string,
  token: string,
  from: { first_name?: string; username?: string },
  msgId?: number,
): Promise<string> {
  const store = await db.studioState.findUnique({ where: { key: LINK_TOKENS_KEY } })
  const tokens = (store ? (JSON.parse(store.data) as Record<string, { userId?: string; exp?: number }>) : {})
  const rec = tokens[token]
  if (!rec?.userId || !rec.exp || rec.exp < Date.now())
    return '⚠️ Ссылка подключения устарела (живёт сутки). Открой настройки сайта и нажми «Подключить Telegram» ещё раз.'
  delete tokens[token]
  await db.studioState.upsert({
    where: { key: LINK_TOKENS_KEY },
    create: { key: LINK_TOKENS_KEY, data: JSON.stringify(tokens) },
    update: { data: JSON.stringify(tokens) },
  })

  const siteUser = await db.user.findUnique({ where: { id: rec.userId } })
  if (!siteUser) return '⚠️ Аккаунт сайта не найден — создай новую ссылку в настройках.'
  if (siteUser.telegramChatId && siteUser.telegramChatId !== chatId)
    return `⚠️ К этому аккаунту уже привязан другой Telegram. Сначала перепривяжи его на сайте.`

  // if this telegram chat currently powers another (e.g. auto-registered
  // guest) account - detach it, the chatId moves to the site account
  const holder = await db.user.findUnique({ where: { telegramChatId: chatId } })
  if (holder && holder.id !== siteUser.id)
    await db.user.update({ where: { id: holder.id }, data: { telegramChatId: null } })
  await db.user.update({
    where: { id: siteUser.id },
    data: { telegramChatId: chatId, telegramUsername: from.username || siteUser.telegramUsername },
  })

  // merge: the bot conversation(s) join the account's conversation list
  const map = await readUsersMap()
  const entry = map[chatId]
  if (entry?.convId) {
    await db.conversation.updateMany({ where: { id: entry.convId }, data: { userId: siteUser.id } })
    map[chatId] = {
      ...entry,
      userId: siteUser.id,
      name: from.first_name || entry.name,
      username: from.username || entry.username,
      lastStartMsgId: msgId || entry.lastStartMsgId,
    }
    await writeUsersMap(map)
  }
  const botRow = await db.studioState.findUnique({ where: { key: 'telegramBot' } })
  if (botRow) {
    const bot = JSON.parse(botRow.data) as { ownerChatId?: string; convId?: string }
    if (bot.ownerChatId === chatId && bot.convId)
      await db.conversation.updateMany({ where: { id: bot.convId, userId: null }, data: { userId: siteUser.id } })
  }
  return `✅ Telegram подключён к аккаунту ${siteUser.email}. История чатов с ботом объединена с аккаунтом — видно на сайте и в мини-аппе.`
}

/** T27: one step of the connect-your-own-account FSM. The user's message
 *  (phone / code / 2FA password) is DELETED right after processing so
 *  credentials never linger in the chat. */
async function handleConnectStep(
  chatId: string,
  entry: TgUserEntry,
  fsm: ConnectFsm,
  text: string,
  msgId: number,
): Promise<void> {
  try {
    if (fsm.step === 'phone') {
      const norm = normalizePhone(text)
      if ('error' in norm) {
        await tgSend(chatId, `⚠️ ${norm.error}.\nОтправь номер ещё раз (или /start — отмена).`)
        return
      }
      try {
        const res = await mtprotoSendCode(norm.phone)
        const data = {
          phone: norm.phone,
          apiId: res.apiId,
          apiHashEnc: res.apiHashEnc,
          phoneCodeHash: res.phoneCodeHash,
          loginSessionEnc: encryptSecret(res.loginSession),
          status: 'pending',
          statusText: res.viaApp ? 'код отправлен в Telegram-приложение' : 'код отправлен SMS',
          meInfo: null,
          sessionEnc: null,
          active: false,
          updatedAt: new Date(),
        }
        const existing = await db.tgAccount.findFirst({ where: { userId: entry.userId } })
        const account = existing
          ? await db.tgAccount.update({ where: { id: existing.id }, data })
          : await db.tgAccount.create({ data: { userId: entry.userId, ...data } })
        await setConnect(chatId, { step: 'code', accountId: account.id, phone: norm.phone, exp: Date.now() + 15 * 60_000 })
        await tgSend(
          chatId,
          `2️⃣ Код отправлен ${res.viaApp ? 'в твоё Telegram-приложение' : 'SMS-кой'} на ${norm.phone}.\n\n` +
            'Введи код следующим сообщением — я сразу удалю его из чата.',
        )
      } catch (e) {
        await tgSend(chatId, `⚠️ Не вышло отправить код: ${humanTgError(e)}\n\nПроверь номер и отправь снова (или /start — отмена).`)
      }
      return
    }

    // ---- code / password steps
    const acc = fsm.accountId ? await db.tgAccount.findUnique({ where: { id: fsm.accountId } }) : null
    if (!acc || acc.userId !== entry.userId || !acc.phoneCodeHash || !acc.loginSessionEnc) {
      await clearConnect(chatId)
      await tgSend(chatId, '⚠️ Сессия подключения истекла. Нажми «📱 Подключить Telegram аккаунт» ещё раз.')
      return
    }
    const code = fsm.step === 'code' ? text.replace(/\D/g, '') : ''
    const password = fsm.step === 'password' ? text : ''
    if (fsm.step === 'code' && code.length < 4) {
      await tgSend(chatId, 'Код подтверждения — это цифры, которые Telegram прислал в приложение. Отправь их одним сообщением.')
      return
    }
    try {
      const res = await mtprotoVerifyCode({
        apiId: acc.apiId,
        apiHashEnc: acc.apiHashEnc,
        loginSessionEnc: acc.loginSessionEnc,
        phone: acc.phone,
        phoneCodeHash: acc.phoneCodeHash,
        status: acc.status,
        code,
        password,
      })
      const meInfo = JSON.stringify(res.me)
      await db.tgAccount.update({
        where: { id: acc.id },
        data: {
          sessionEnc: encryptSecret(res.session),
          status: 'connected',
          statusText: 'подключено',
          meInfo,
          phoneCodeHash: null,
          loginSessionEnc: null,
          active: true, // the point of the flow: the agent may answer DMs now
        },
      })
      await migrateRulesDraft(entry.userId, acc.id)
      await clearConnect(chatId)
      const who = [res.me.firstName, res.me.username ? `(@${res.me.username})` : ''].filter(Boolean).join(' ')
      await tgSend(
        chatId,
        `✅ Telegram аккаунт подключён: ${who || 'аккаунт'} (${acc.phone}).\n\n` +
          'Кнопка «📱 Подключить Telegram аккаунт» исчезла — здесь и на сайте.\n' +
          '🤖 Агент ВКЛЮЧЁН: отвечает на новые входящие ЛИЧНЫЕ сообщения от твоего имени (никогда не пишет первым). ' +
          'Выключить — кнопкой «🤖 Агент»; научить его — кнопкой «💬 Научить агента (чат)»: расскажешь ему в чате на сайте, он запомнит и будет отвечать людям по этому контексту.',
        await menuKb(entry.userId),
      )
    } catch (e) {
      if (e instanceof NeedPasswordError) {
        await db.tgAccount.update({
          where: { id: acc.id },
          data: { status: '2fa', statusText: 'включена двухфакторная защита — отправь облачный пароль' },
        }).catch(() => {})
        await setConnect(chatId, { ...fsm, step: 'password', exp: Date.now() + 15 * 60_000 })
        await tgSend(chatId, '🔒 На аккаунте включена двухфакторная защита. Отправь облачный пароль Telegram следующим сообщением — удалю его сразу после проверки.')
        return
      }
      await db.tgAccount.update({ where: { id: acc.id }, data: { statusText: humanTgError(e) } }).catch(() => {})
      const msg = humanTgError(e)
      const hint = /Неверный код/i.test(msg)
        ? ' Проверь код и отправь ещё раз.'
        : /истёк/i.test(msg)
          ? ' Нажми «📱 Подключить Telegram аккаунт» заново — пришлю свежий код.'
          : ' Попробуй ещё раз или /start — отмена.'
      await tgSend(chatId, `⚠️ ${msg}.${hint}`)
    }
  } finally {
    // privacy: phone/code/password messages must not linger in the chat
    await deleteMsg(chatId, msgId)
  }
}

/** inline button presses: open a chat from the list / create a chat */
async function handleCallback(cb: { id?: string; data?: string; from?: { id?: number; username?: string; first_name?: string }; message?: { message_id?: number } }): Promise<void> {
  if (!cb.id || !cb.data || !cb.from?.id) return
  const chatId = String(cb.from.id)
  const entry = await ensureUserConv(chatId, { first_name: cb.from.first_name, username: cb.from.username })
  const data = cb.data
  // the message carrying the pressed buttons IS the live panel: every press
  // morphs it (menu -> list -> history) or strips its buttons entirely
  const carrierMsgId = cb.message?.message_id || 0
  if (data === 'back') {
    await answerCallback(cb.id, 'Меню')
    await editPanel(chatId, carrierMsgId, menuPanelText(!!(await connectedAccount(entry.userId))), await menuKb(entry.userId))
    return
  }
  // ---- T27: connect your own Telegram account (MTProto phone+code in-chat)
  if (data === 'tgconnect') {
    const already = await connectedAccount(entry.userId)
    if (already) {
      await answerCallback(cb.id, 'Уже подключено ✅')
      await editPanel(chatId, carrierMsgId, menuPanelText(true), await menuKb(entry.userId))
      return
    }
    await setConnect(chatId, { step: 'phone', exp: Date.now() + 15 * 60_000 })
    await answerCallback(cb.id, 'Отправь номер телефона')
    await editPanel(
      chatId,
      carrierMsgId,
      '📱 Подключение твоего Telegram-аккаунта\n\n' +
        '1️⃣ Отправь сюда свой номер: например +998901234567 (можно просто 9 цифр — добавлю +998).\n\n' +
        '2️⃣ Telegram пришлёт код в твоё приложение — введи код следующим сообщением.\n\n' +
        '🔐 Сообщение с номером/кодом/паролем я удаляю из чата сразу после проверки. /start — отмена.',
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'tgcancel' }]] },
    )
    return
  }
  if (data === 'tgcancel') {
    await clearConnect(chatId)
    await answerCallback(cb.id, 'Отменено')
    await editPanel(chatId, carrierMsgId, menuPanelText(!!(await connectedAccount(entry.userId))), await menuKb(entry.userId))
    return
  }
  if (data === 'tgagent') {
    const acc = await connectedAccount(entry.userId)
    if (!acc) {
      await answerCallback(cb.id, 'Сначала подключи аккаунт кнопкой «📱 Подключить Telegram аккаунт»')
      return
    }
    await db.tgAccount.update({ where: { id: acc.id }, data: { active: !acc.active } })
    await answerCallback(cb.id, !acc.active ? '🤖 Агент ВКЛЮЧЁН — отвечает на входящие от твоего имени' : '🤖 Агент выключен — входящие остаются без ответа')
    await editPanel(chatId, carrierMsgId, menuPanelText(true), await menuKb(entry.userId))
    return
  }
  if (data === 'newchat') {
    await answerCallback(cb.id, 'Создаю новый чат…')
    const stamp = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    const conv = await db.conversation.create({ data: { userId: entry.userId, title: `Чат ${stamp}` } })
    await patchUserEntry(chatId, { convId: conv.id, chatPicked: true })
    await editPanel(chatId, carrierMsgId, `🆕 «${conv.title}» создан — пиши задачу прямо сюда, результат придёт в этот чат.\n(кнопки: /menu)`)
    return
  }
  if (data === 'chatlist') {
    await answerCallback(cb.id, 'Открываю чаты…')
    const kb = await chatListKeyboard(entry.userId)
    const count = await db.conversation.count({ where: { userId: entry.userId } })
    await editPanel(
      chatId,
      carrierMsgId,
      count
        ? '📂 Твои чаты (они же на сайте в аккаунте). Нажми — открою историю одним сообщением:'
        : 'Пока нет чатов — создай первый кнопкой ниже:',
      kb,
    )
    return
  }
  if (data.startsWith('conv:')) {
    const convId = data.slice(5)
    const conv = await db.conversation.findUnique({ where: { id: convId } })
    if (!conv || (conv.userId && conv.userId !== entry.userId)) {
      await answerCallback(cb.id, 'Этот чат принадлежит другому аккаунту')
      return
    }
    if (!conv.userId) await db.conversation.update({ where: { id: convId }, data: { userId: entry.userId } })
    await patchUserEntry(chatId, { convId, chatPicked: true })
    await answerCallback(cb.id, `Открыт: ${(conv.title || 'чат').slice(0, 60)}`)
    // buttons disappear; the history shows as ONE message; typing continues
    // in THIS conversation
    await editPanel(chatId, carrierMsgId, await chatDigest(conv.id, conv.title || undefined))
    return
  }
}

/**
 * per-user registration: find-or-create the User (keyed by telegramChatId)
 * and that user's personal bot conversation. Returns both ids.
 */
async function ensureUserConv(
  chatId: string,
  from: { first_name?: string; username?: string },
): Promise<TgUserEntry> {
  const map = await readUsersMap()
  const known = map[chatId]
  if (known) {
    const conv = await db.conversation.findUnique({ where: { id: known.convId } })
    if (conv) return known
  }
  const name = (from.first_name || from.username || 'Пользователь').slice(0, 60)
  // user keyed by telegramChatId; telegram accounts have no password
  const user = await db.user.upsert({
    where: { telegramChatId: chatId },
    create: {
      email: `tg_${chatId}@telegram.vebai.app`,
      passwordHash: `s2$disabled$${chatId}-${Date.now()}`, // login only via telegram signature
      name,
      telegramChatId: chatId,
      telegramUsername: from.username || null,
    },
    update: { name, telegramUsername: from.username || null },
  })
  let conv = known
    ? await db.conversation.findUnique({ where: { id: known.convId } })
    : null
  if (!conv) {
    conv = await db.conversation.findFirst({
      where: { userId: user.id, title: { startsWith: 'Telegram' } },
      orderBy: { updatedAt: 'desc' },
    })
  }
  if (!conv) {
    conv = await db.conversation.create({
      data: { userId: user.id, title: `Telegram · ${name}` },
    })
  }
  const entry: TgUserEntry = {
    userId: user.id,
    convId: conv.id,
    username: from.username,
    name,
    // keep the /start anchor if we already stored one; keep the T21
    // chatPicked flag ONLY if the stored conversation still exists (a fresh
    // auto-created conv resets it — the user must pick/create a chat again)
    lastStartMsgId: known?.lastStartMsgId,
    chatPicked: known && known.convId === conv.id ? known.chatPicked : undefined,
  }
  await writeUsersMap({ ...map, [chatId]: entry })
  return entry
}

/** fast conversational answer via the site LLM (the "?вопрос" escape) */
async function chatAnswer(convId: string, q: string): Promise<string> {
  await db.message.create({
    data: { conversationId: convId, role: 'user', kind: 'text', content: q.slice(0, 4000) },
  })
  const history = await db.message.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        systemPrompt() +
        '\nПользователь пишет из Telegram в быстрый режим: отвечай сжато, без markdown-таблиц, без блоков run-terminal. Если для ответа нужно что-то выполнить на сервере — скажи отправить задачу без «?» и агент сделает.' +
        '\nВ ЭТОМ режиме у тебя НЕТ доступа к файлам и инструментам: НИКОГДА не утверждай, что создал, подготовил, прикрепил или отправил файл — это ложь. Если просят файл — скажи отправить задачу без «?».',
    },
  ]
  for (const m of history.reverse()) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const c = (m.content || '').trim()
    if (c) messages.push({ role: m.role, content: c.slice(0, 6000) })
  }
  try {
    const cc = await zai.chat.completions({
      messages,
      thinking: { type: 'disabled' }, // fast mode: Telegram waits
    })
    // T16: the user sees only what the model wants to show — <answer>…</answer>
    // content; everything else (thinking, plans) is stripped. Same parser as
    // the site stream and the GH agent results.
    const raw = cc.choices?.[0]?.message?.content || '(пустой ответ модели)'
    const parsed = parseAiAnswer(raw)
    const answer = (parsed.text || raw).slice(0, 20_000)
    await db.message.create({
      data: { conversationId: convId, role: 'assistant', kind: 'text', content: answer },
    })
    return answer.slice(0, 3800)
  } catch (e) {
    return '⚠️ Модель недоступна: ' + (e instanceof Error ? e.message.slice(0, 140) : 'ошибка')
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, bot: 'vebai', mode: 'webhook-multiuser' })
}

export async function POST(req: NextRequest) {
  const secretEnv = process.env.TELEGRAM_WEBHOOK_SECRET
  if (secretEnv) {
    const got = req.headers.get('x-telegram-bot-api-secret-token') || ''
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    // fallback: the bot token itself (same trust level as the webhook secret;
    // lets server-side smoke tests drive the webhook without the Vercel secret)
    if (got !== secretEnv && bearer !== (process.env.TELEGRAM_BOT_TOKEN || ''))
      return new NextResponse('bad secret', { status: 401 })
  }

  const update = (await req.json().catch(() => null)) as {
    update_id?: number
    message?: {
      message_id?: number
      text?: string
      chat?: { id?: number; type?: string }
      from?: { id?: number; first_name?: string; last_name?: string; username?: string }
    }
    callback_query?: {
      id?: string
      data?: string
      from?: { id?: number; username?: string; first_name?: string }
      message?: { message_id?: number }
    }
  } | null
  if (!update?.update_id) return NextResponse.json({ ok: true })

  const cache = await readCache()
  if (cache.lastUpdateId && update.update_id <= cache.lastUpdateId)
    return NextResponse.json({ ok: true, dup: true })
  await writeCache({ lastUpdateId: update.update_id })

  const fromCb = update.callback_query
  if (fromCb?.id && fromCb.data && fromCb.from?.id) {
    await handleCallback(fromCb)
    return NextResponse.json({ ok: true })
  }

  const msg = update.message
  if (!msg?.text || msg.chat?.type !== 'private' || !msg.from?.id)
    return NextResponse.json({ ok: true })
  const chatId = String(msg.from.id)
  const isOwner = cache.ownerChatId === chatId
  const text = String(msg.text).trim()
  if (!text) return NextResponse.json({ ok: true })

  // ---- first /start ever: bind the owner (full powers)
  if (!cache.ownerChatId) {
    if (/^\/start/i.test(text)) {
      await writeCache({ ownerChatId: chatId })
      await tgSend(
        chatId,
        '✅ Привязано. Ты ВЛАДЕЛЕЦ этого бота — пиши задачи прямо сюда.\n\n' +
          '🤖 обычный текст — задача АГЕНТУ на GitHub Actions (Ubuntu): он сам спланирует работу, доведёт дело до конца и пришлёт файлы (PDF, отчёты, код…), даже если сайт и Telegram закрыты. Ты увидишь только готовый результат и нужные файлы — без промежуточных шагов\n' +
          '❓ «?текст» — быстрый вопрос модели без запуска задач\n' +
          '❗ «!команда» — одна прямая shell-команда на сервере (только владелец)\n' +
          '• /app — открыть мини-апп: аккаунт на сайте с историей задач и файлов\n' +
          '• /status — состояние конвейера\n\n' +
          'В конце работы приходит только готовый результат и файлы — то, что агент сам решит показать.',
      )
    } else {
      await tgSend(chatId, 'Бот привязывается по /start. Напиши /start.')
    }
    return NextResponse.json({ ok: true })
  }

  // ---- every user (owner included) has a user record + personal conversation
  // (owner powers still come from cache.ownerChatId; the conversation now lives
  // in the owner's ACCOUNT, so chat list / new chat buttons work for him too)
  const from = { first_name: msg.from.first_name, username: msg.from.username }
  const entry = await ensureUserConv(chatId, from)
  let convId = entry.convId

  // ---- T27: connect-own-account FSM (phone -> code -> 2FA). Runs BEFORE
  // everything else so credential messages never reach the agent/history;
  // any '/'-command cancels the FSM and falls through to normal handling.
  const connectMap = await readConnectMap()
  const fsm = connectMap[chatId]
  if (fsm && fsm.exp < Date.now()) {
    await clearConnect(chatId)
  }
  if (fsm && fsm.exp >= Date.now() && !text.startsWith('/')) {
    await handleConnectStep(chatId, entry, fsm, text, msg.message_id || 0)
    return NextResponse.json({ ok: true })
  }
  if (fsm && fsm.exp >= Date.now() && text.startsWith('/')) {
    await clearConnect(chatId) // the command doubles as a cancel
  }

  // ---- /commands (all users)
  if (/^\/menu/i.test(text)) {
    await tgSend(chatId, menuPanelText(!!(await connectedAccount(entry.userId))), await menuKb(entry.userId))
    return NextResponse.json({ ok: true })
  }
  if (/^\/status/i.test(text)) {
    await tgSend(chatId, await statusText())
    return NextResponse.json({ ok: true })
  }
  if (/^\/start/i.test(text)) {
    // anchor for the window cleaner: everything below the last /start is wiped
    // when the user taps "Создать чат" / "Список чатов"
    if (msg.message_id) await patchUserEntry(chatId, { lastStartMsgId: msg.message_id })
    // deep link from the site button "Подключить Telegram": /start connect_<token>
    const param = text.replace(/^\/start\s*/i, '').trim()
    if (param.startsWith('connect_')) {
      await tgSend(chatId, await connectAccount(chatId, param.slice(8), from, msg.message_id))
      return NextResponse.json({ ok: true })
    }
    if (isOwner) {
      await tgSend(chatId, 'Уже привязано 👌 Просто пиши задачу. Кнопки — под этим сообщением.', await menuKb(entry.userId))
    } else {
      await tgSend(
        chatId,
        `Привет! Я агент Vebai — сделаю документ, график, отчёт, найду инфу в интернете и пришлю файлы сюда.\n\n` +
          '🤖 обычный текст — задача агенту (создаёт файлы, доводит до конца; ты увидишь только готовый результат)\n' +
          '❓ «?текст» — быстрый вопрос без запуска задач\n' +
          '📱 «Подключить Telegram аккаунт» — кнопка ниже: подключи СВОЙ аккаунт (номер + код), и агент будет отвечать на входящие личные сообщения от твоего имени\n' +
          '• /app — аккаунт на сайте: вся история задач и файлов',
        await menuKb(entry.userId),
      )
    }
    return NextResponse.json({ ok: true })
  }
  if (/^\/app/i.test(text)) {
    await tgSend(chatId, 'Открывай аккаунт — история задач и файлов синхронизирована с сайтом:', await menuKb(entry.userId))
    return NextResponse.json({ ok: true })
  }

  // ---- typed text equivalents of the inline menu buttons: create a chat /
  // open the chat list
  // (both first wipe the bot window down to the last /start — owner request
  // 2026-10-18: "все тексты из истории бота удаляются кроме команды /start")
  if (/^\s*(?:🆕\s*)?создать чат\s*$/i.test(text)) {
    await createChat(chatId, entry, msg.message_id || 0)
    return NextResponse.json({ ok: true })
  }
  if (/^\s*(?:открыть\s*)?(?:📂\s*)?список чатов\s*$/i.test(text)) {
    await clearBotWindow(chatId, msg.message_id || 0, entry.lastStartMsgId)
    const kb = await chatListKeyboard(entry.userId)
    const count = (await db.conversation.count({ where: { userId: entry.userId } }))
    await tgSend(
      chatId,
      count
        ? '📂 Твои чаты (они же на сайте в аккаунте). Нажми — выберу его для переписки:'
        : 'Пока нет чатов — нажми «🆕 Создать чат».',
      kb,
    )
    return NextResponse.json({ ok: true })
  }

  // ---- T21 (owner request 2026-10-18): no talking to the AI agent until a
  // chat is explicitly created (🆕) or picked (📂). Covers BOTH the default
  // agent path below and the fast "?" chat — both write history into a
  // conversation, and history needs a chosen chat. /-commands, "!cmd" and
  // the two typed menu commands above stay available — they ARE the picker.
  if (!entry.chatPicked) {
    await tgSend(
      chatId,
      '🚫 Сначала открой чат: нажми «🆕 Создать чат» или «📂 Чаты» и выбери существующий.\nБез выбранного чата агент не примет задачу — истории некуда сохраняться.',
      await menuKb(entry.userId),
    )
    return NextResponse.json({ ok: true })
  }

  // ---- fast conversational escape: "?вопрос" -> site LLM answers right away
  if (text.startsWith('?')) {
    const q = text.slice(1).trim()
    if (!q) {
      await tgSend(chatId, 'Напиши вопрос после знака «?». А обычные задачи (без «?») уходят агенту на GitHub Actions.')
      return NextResponse.json({ ok: true })
    }
    await tgSend(chatId, await chatAnswer(convId, q))
    return NextResponse.json({ ok: true })
  }

  // ---- shell escape: "!команда" -> raw shell (OWNER ONLY: guests would be
  // able to touch the runner env / other users' workspace)
  if (text.startsWith('!')) {
    if (!isOwner) {
      await tgSend(
        chatId,
        '❗ Прямые shell-команды доступны только владельцу.\nПросто опиши задачу обычным сообщением — агент сам выполнит всё, что нужно.',
      )
      return NextResponse.json({ ok: true })
    }
    const command = text.slice(1).trim()
    if (!command) {
      await tgSend(chatId, 'Напиши команду после «!», например: !uptime')
      return NextResponse.json({ ok: true })
    }
    await db.message.create({
      data: { conversationId: convId, role: 'user', kind: 'text', content: `! ${command.slice(0, 4000)}` },
    })
    await db.agentTask.create({
      data: {
        conversationId: convId,
        type: 'terminal',
        title: `$ ${command.replace(/\s+/g, ' ').slice(0, 90)}`,
        status: 'queued',
        progress: 'Команда в очереди GitHub Actions…',
        payload: JSON.stringify({ command: command.slice(0, 20_000), terminalId: convId, timeoutS: 240 }),
      },
    })
    await tgSend(chatId, '⌨️ Команда ушла на GitHub Actions (Ubuntu) — пришлю вывод и файлы.')
    return NextResponse.json({ ok: true })
  }

  // ---- default: hand the whole message to the resident agent on GitHub
  // Actions. Guests are rate-limited: one resident runner serves everyone.
  if (!isOwner) {
    const active = await db.agentTask.count({
      where: { conversationId: convId, type: 'terminal', status: { in: ['queued', 'running'] } },
    })
    if (active >= GUEST_MAX_ACTIVE) {
      await tgSend(chatId, '⏳ Агент ещё занят твоей прошлой задачей. Дождись результата и присылай следующую.')
      return NextResponse.json({ ok: true })
    }
    const dayStart = new Date()
    dayStart.setUTCHours(0, 0, 0, 0)
    const today = await db.agentTask.count({
      where: { conversationId: convId, type: 'terminal', createdAt: { gte: dayStart } },
    })
    if (today >= GUEST_DAILY_LIMIT) {
      await tgSend(chatId, `📅 Дневной лимит задач исчерпан (${GUEST_DAILY_LIMIT}/день). Лимит обновится в 00:00 UTC.`)
      return NextResponse.json({ ok: true })
    }
  }
  await db.message.create({
    data: { conversationId: convId, role: 'user', kind: 'text', content: text.slice(0, 4000) },
  })
  await db.agentTask.create({
    data: {
      conversationId: convId,
      type: 'terminal',
      title: `🤖 ${text.replace(/\s+/g, ' ').slice(0, 90)}`,
      status: 'queued',
      progress: 'Агент на GitHub Actions возьмёт задачу в течение минуты…',
      payload: JSON.stringify({
        command: `#!agent\n${text.slice(0, 8000)}`,
        terminalId: convId,
        timeoutS: 3600,
      }),
    },
  })
  await tgSend(
    chatId,
    '🤖 Задачу принял агент на GitHub Actions (Ubuntu). Работаю молча: в конце пришлю только готовый результат и нужные файлы.',
  )
  return NextResponse.json({ ok: true })
}
