import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { zai, type ChatMessage } from '@/lib/zai'
import { systemPrompt } from '@/lib/agent/prompt'

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

/** conversation id of the owner's Telegram chat (legacy single-conv flow) */
async function ensureOwnerConv(cache: BotCache): Promise<string> {
  const existing = cache.convId || ''
  if (existing) {
    const row = await db.conversation.findUnique({ where: { id: existing } })
    if (row) return existing
  }
  const conv = await db.conversation.create({ data: { title: 'Telegram' } })
  await writeCache({ convId: conv.id })
  return conv.id
}

/**
 * per-user registration: find-or-create the User (keyed by telegramChatId)
 * and that user's personal bot conversation. Returns both ids.
 */
async function ensureUserConv(
  chatId: string,
  from: { first_name?: string; username?: string },
): Promise<{ userId: string; convId: string }> {
  const map = await readUsersMap()
  const known = map[chatId]
  if (known) {
    const conv = await db.conversation.findUnique({ where: { id: known.convId } })
    if (conv) return { userId: known.userId, convId: known.convId }
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
  const next = { ...map, [chatId]: { userId: user.id, convId: conv.id, username: from.username, name } }
  await writeUsersMap(next)
  return { userId: user.id, convId: conv.id }
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
    const answer = cc.choices?.[0]?.message?.content || '(пустой ответ модели)'
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
    if (got !== secretEnv) return new NextResponse('bad secret', { status: 401 })
  }

  const update = (await req.json().catch(() => null)) as {
    update_id?: number
    message?: {
      text?: string
      chat?: { id?: number; type?: string }
      from?: { id?: number; first_name?: string; last_name?: string; username?: string }
    }
  } | null
  if (!update?.update_id) return NextResponse.json({ ok: true })

  const cache = await readCache()
  if (cache.lastUpdateId && update.update_id <= cache.lastUpdateId)
    return NextResponse.json({ ok: true, dup: true })
  await writeCache({ lastUpdateId: update.update_id })

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
          '🤖 обычный текст — задача АГЕНТУ на GitHub Actions (Ubuntu): он сам спланирует команды, доведёт дело до конца и пришлёт файлы (PDF, отчёты, код…), даже если сайт и Telegram закрыты\n' +
          '❓ «?текст» — быстрый вопрос модели без запуска задач\n' +
          '❗ «!команда» — одна прямая shell-команда на сервере (только владелец)\n' +
          '• /app — открыть мини-апп: аккаунт на сайте с историей задач и файлов\n' +
          '• /status — состояние конвейера\n\n' +
          'Результаты, шаги работы и файлы приходят в этот чат.',
      )
    } else {
      await tgSend(chatId, 'Бот привязывается по /start. Напиши /start.')
    }
    return NextResponse.json({ ok: true })
  }

  // ---- every user has (or now gets) a user record + personal conversation
  const from = { first_name: msg.from.first_name, username: msg.from.username }
  let convId: string
  if (isOwner) {
    convId = await ensureOwnerConv(cache)
  } else {
    convId = (await ensureUserConv(chatId, from)).convId
  }

  // ---- /commands (all users)
  if (/^\/status/i.test(text)) {
    await tgSend(chatId, await statusText())
    return NextResponse.json({ ok: true })
  }
  if (/^\/start$/i.test(text)) {
    if (isOwner) {
      await tgSend(chatId, 'Уже привязано 👌 Просто пиши задачу.')
    } else {
      await tgSend(
        chatId,
        `Привет! Я агент Vebai — сделаю документ, график, отчёт, найду инфу в интернете и пришлю файлы сюда.\n\n` +
          '🤖 обычный текст — задача агенту (создаёт файлы, доводит до конца)\n' +
          '❓ «?текст» — быстрый вопрос без запуска задач\n' +
          '• /app — аккаунт на сайте: вся история задач и файлов',
        appButton(),
      )
    }
    return NextResponse.json({ ok: true })
  }
  if (/^\/app/i.test(text)) {
    await tgSend(chatId, 'Открывай аккаунт — история задач и файлов синхронизирована с сайтом:', appButton())
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
    '🤖 Задачу принял агент на GitHub Actions (Ubuntu). Он сам разобьёт её на команды и доведёт до конца. ' +
      'По ходу пришлю шаги, в конце — результат и файлы.',
  )
  return NextResponse.json({ ok: true })
}
