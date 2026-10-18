import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { zai, type ChatMessage } from '@/lib/zai'
import { systemPrompt } from '@/lib/agent/prompt'
import { parseAiAnswer } from '@/lib/agent/answer'

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
 * Setup (one-time): setWebhook with url + secret_token=TELEGRAM_WEBHOOK_SECRET.
 */

const CACHE_KEY = 'telegramBot'
const USERS_KEY = 'tgUsers'
const LINK_TOKENS_KEY = 'tgLinkTokens'
const MINI_APP_URL = process.env.VEBAI_MINI_APP_URL || 'https://vebai-six.vercel.app/tg'

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

const appButton = () => ({
  inline_keyboard: [[{ text: '🌐 Открыть Vebai (аккаунт)', web_app: { url: MINI_APP_URL } }]],
})

/** persistent bottom keyboard: «Создать чат» и «Список чатов» (owner request
 * 2026-10-18) */
const replyKeyboard = () => ({
  keyboard: [
    [{ text: '🆕 Создать чат' }],
    [{ text: '📂 Список чатов' }],
  ],
  resize_keyboard: true,
  input_field_placeholder: 'Опиши задачу для агента…',
})

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
  return { inline_keyboard: rows }
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
  await patchUserEntry(chatId, { convId: conv.id })
  await tgSend(
    chatId,
    '🆕 Новый чат создан — пиши задачу. Прежняя история и файлы остались в аккаунте на сайте.',
    replyKeyboard(),
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

/** inline button presses: open a chat from the list / create a chat */
async function handleCallback(cb: { id?: string; data?: string; from?: { id?: number; username?: string; first_name?: string } }): Promise<void> {
  if (!cb.id || !cb.data || !cb.from?.id) return
  const chatId = String(cb.from.id)
  const entry = await ensureUserConv(chatId, { first_name: cb.from.first_name, username: cb.from.username })
  const data = cb.data
  if (data === 'newchat') {
    await answerCallback(cb.id, 'Создаю новый чат…')
    await createChat(chatId, entry, 0)
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
    await patchUserEntry(chatId, { convId })
    await answerCallback(cb.id, `Открыт: ${(conv.title || 'чат').slice(0, 60)}`)
    await tgSend(
      chatId,
      `📂 Чат «${(conv.title || 'чат').slice(0, 40)}» открыт — переписка идёт в нём, история синхронна с сайтом.`,
      replyKeyboard(),
    )
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
    // keep the /start anchor if we already stored one
    lastStartMsgId: known?.lastStartMsgId,
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
        '\nПользователь пишет из Telegram в быстрый режим: отвечай сжато, без markdown-таблиц, без блоков run-terminal. Если для ответа нужно что-то выполнить на сервере — скажи отправить задачу без «?» и агент сделает.',
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

  // ---- /commands (all users)
  if (/^\/status/i.test(text)) {
    await tgSend(chatId, await statusText(), replyKeyboard())
    return NextResponse.json({ ok: true })
  }
  if (/^\/start/i.test(text)) {
    // anchor for the window cleaner: everything below the last /start is wiped
    // when the user taps "Создать чат" / "Список чатов"
    if (msg.message_id) await patchUserEntry(chatId, { lastStartMsgId: msg.message_id })
    // deep link from the site button "Подключить Telegram": /start connect_<token>
    const param = text.replace(/^\/start\s*/i, '').trim()
    if (param.startsWith('connect_')) {
      await tgSend(chatId, await connectAccount(chatId, param.slice(8), from, msg.message_id), replyKeyboard())
      return NextResponse.json({ ok: true })
    }
    if (isOwner) {
      await tgSend(chatId, 'Уже привязано 👌 Просто пиши задачу. Кнопки внизу — чаты.', replyKeyboard())
    } else {
      await tgSend(
        chatId,
        `Привет! Я агент Vebai — сделаю документ, график, отчёт, найду инфу в интернете и пришлю файлы сюда.\n\n` +
          '🤖 обычный текст — задача агенту (создаёт файлы, доводит до конца; ты увидишь только готовый результат)\n' +
          '❓ «?текст» — быстрый вопрос без запуска задач\n' +
          '• /app — аккаунт на сайте: вся история задач и файлов',
        { ...appButton(), ...replyKeyboard() },
      )
    }
    return NextResponse.json({ ok: true })
  }
  if (/^\/app/i.test(text)) {
    await tgSend(chatId, 'Открывай аккаунт — история задач и файлов синхронизирована с сайтом:', { ...appButton(), ...replyKeyboard() })
    return NextResponse.json({ ok: true })
  }

  // ---- bottom-keyboard buttons: create a chat / open the chat list
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
