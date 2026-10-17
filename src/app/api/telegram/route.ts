import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { zai, type ChatMessage } from '@/lib/zai'
import { systemPrompt } from '@/lib/agent/prompt'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/telegram — two-way Telegram bot (owner's remote control).
 *
 * Owner writes to the bot in a private chat -> the message becomes a user
 * turn in a dedicated "Telegram" conversation, the model answers (fast
 * mode), and ```run-terminal``` blocks are queued as background terminal
 * tasks (GitHub Actions executor). Results arrive back here via the normal
 * mirrors (chat message + Telegram uploads).
 *
 * Setup (one-time): setWebhook with url + secret_token=TELEGRAM_WEBHOOK_SECRET.
 * The FIRST user to send /start becomes the owner (locked in StudioState).
 */

const CACHE_KEY = 'telegramBot'

interface BotCache {
  ownerChatId?: string
  convId?: string
  lastUpdateId?: number
}

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

async function tgSend(chatId: number | string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!token) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3800) }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch { /* best-effort */ }
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
  } catch {
    lines.push('(статус недоступен)')
  }
  return `📡 Vebai status\n${lines.join('\n')}`
}

/** conversation id of the Telegram chat (create if missing) */
async function ensureConv(cache: BotCache): Promise<string> {
  const existing = cache.convId || ''
  if (existing) {
    const row = await db.conversation.findUnique({ where: { id: existing } })
    if (row) return existing
  }
  const conv = await db.conversation.create({ data: { title: 'Telegram' } })
  await writeCache({ convId: conv.id })
  return conv.id
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
  return NextResponse.json({ ok: true, bot: 'vebai', mode: 'webhook' })
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
      from?: { id?: number; first_name?: string }
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
  const chatId = msg.from.id
  const text = String(msg.text).trim()
  if (!text) return NextResponse.json({ ok: true })

  // ---- owner lock: first /start wins
  if (!cache.ownerChatId) {
    if (/^\/start/i.test(text)) {
      await writeCache({ ownerChatId: String(chatId) })
      await tgSend(
        chatId,
        '✅ Привязано. Это пульт Vebai — пиши задачи прямо сюда.\n\n' +
          '🤖 обычный текст — задача АГЕНТУ на GitHub Actions (Ubuntu): он сам спланирует команды, доведёт дело до конца и пришлёт файлы (PDF, отчёты, код…), даже если сайт и Telegram закрыты\n' +
          '❓ «?текст» — быстрый вопрос модели без запуска задач\n' +
          '❗ «!команда» — одна прямая shell-команда на сервере\n' +
          '• видео — уйдёт на Kaggle (кнопка «Сделать видео» на сайте запускает то же самое)\n' +
          '• /status — состояние конвейера\n\n' +
          'Результаты, шаги работы и файлы приходят в этот чат.',
      )
    } else {
      await tgSend(chatId, 'Бот персональный. Отправь /start для привязки.')
    }
    return NextResponse.json({ ok: true })
  }
  if (String(chatId) !== cache.ownerChatId) {
    await tgSend(chatId, 'Это персональный бот владельца Vebai.')
    return NextResponse.json({ ok: true })
  }

  // ---- /commands
  if (/^\/status/i.test(text)) {
    await tgSend(chatId, await statusText())
    return NextResponse.json({ ok: true })
  }
  if (/^\/start$/i.test(text)) {
    await tgSend(chatId, 'Уже привязано 👌 Просто пиши задачу.')
    return NextResponse.json({ ok: true })
  }

  // ---- fast conversational escape: "?вопрос" -> site LLM answers right away
  if (text.startsWith('?')) {
    const q = text.slice(1).trim()
    if (!q) {
      await tgSend(chatId, 'Напиши вопрос после знака «?». А обычные задачи (без «?») уходят агенту на GitHub Actions.')
      return NextResponse.json({ ok: true })
    }
    await tgSend(chatId, await chatAnswer(await ensureConv(cache), q))
    return NextResponse.json({ ok: true })
  }

  // ---- shell escape: "!команда" -> one plain command (old direct mode)
  if (text.startsWith('!')) {
    const command = text.slice(1).trim()
    if (!command) {
      await tgSend(chatId, 'Напиши команду после «!», например: !uptime')
      return NextResponse.json({ ok: true })
    }
    const convId = await ensureConv(cache)
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
  // Actions (owner request 2026-10-18): instead of one big shell command the
  // runner works as a real agent - plans, runs many commands, delivers files.
  const convId = await ensureConv(cache)
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
