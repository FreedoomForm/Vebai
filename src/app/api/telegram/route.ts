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
          '• «создай PDF …» / команды — выполнятся на GitHub Actions (Ubuntu), даже если сайт и Telegram закрыты\n' +
          '• видео — уйдёт на Kaggle (кнопка «Сделать видео» на сайте запускает то же самое)\n' +
          '• /status — состояние конвейера\n\nРезультаты и файлы приходят в этот чат.',
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

  // ---- chat turn (persistent "Telegram" conversation)
  let convId = cache.convId || ''
  if (convId) {
    const exists = await db.conversation.findUnique({ where: { id: convId } })
    if (!exists) convId = ''
  }
  if (!convId) {
    const conv = await db.conversation.create({ data: { title: 'Telegram' } })
    convId = conv.id
    await writeCache({ convId })
  }
  await db.message.create({
    data: { conversationId: convId, role: 'user', kind: 'text', content: text.slice(0, 4000) },
  })

  const history = await db.message.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() + '\nПользователь пишет из Telegram: отвечай сжато, без markdown-таблиц; команды для исполнения — в блоках ```run-terminal```.' },
  ]
  for (const m of history.reverse()) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const c = (m.content || '').trim()
    if (c) messages.push({ role: m.role, content: c.slice(0, 6000) })
  }
  if (messages[messages.length - 1]?.role !== 'user') {
    await tgSend(chatId, '⚠️ Не смог обработать сообщение.')
    return NextResponse.json({ ok: true })
  }

  let answer = ''
  try {
    const cc = await zai.chat.completions({
      messages,
      thinking: { type: 'disabled' }, // fast mode: Telegram waits
    })
    answer = cc.choices?.[0]?.message?.content || ''
  } catch (e) {
    await tgSend(chatId, '⚠️ Модель недоступна: ' + (e instanceof Error ? e.message.slice(0, 140) : 'ошибка'))
    return NextResponse.json({ ok: true })
  }
  if (!answer) answer = '(пустой ответ модели)'

  // ---- queue real execution: run-terminal blocks -> GitHub Actions
  let queued = 0
  const re = /```run-terminal\s*\n([\s\S]*?)```/g
  for (let m = re.exec(answer); m && queued < 3; m = re.exec(answer)) {
    const command = m[1].trim().slice(0, 3400)
    if (!command) continue
    await db.agentTask.create({
      data: {
        conversationId: convId,
        type: 'terminal',
        title: `$ ${command.replace(/\s+/g, ' ').slice(0, 90)}`,
        status: 'queued',
        progress: 'Команда в очереди GitHub Actions…',
        payload: JSON.stringify({ command, terminalId: convId, timeoutS: 240 }),
      },
    })
    queued++
  }
  await db.message.create({
    data: { conversationId: convId, role: 'assistant', kind: 'text', content: answer },
  })

  // ---- reply (strip execution blocks; they are not for humans)
  const plain =
    answer
      .replace(/```\s*run-(terminal|vterm)\s*\n[\s\S]*?```/g, '')
      .trim() || ''
  let reply = plain || answer.slice(0, 3800)
  if (queued > 0)
    reply += `\n\n⌨️ ${queued} команда(ы) ушли на GitHub Actions (Ubuntu) — вывод и файлы пришлю сюда через 1-5 минут.`
  await tgSend(chatId, reply)
  return NextResponse.json({ ok: true })
}
