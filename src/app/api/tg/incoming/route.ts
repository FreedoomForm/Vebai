/**
 * T26: POST /api/tg/incoming — the worker reports a fresh incoming private
 * message on a user's account; the site dedupes, logs it and DECIDES what to
 * do about it. The actual sending happens in the worker (or by the agent's
 * own Telegram app), and /api/tg/sent logs the outgoing message (T21 rule:
 * the log reflects reality, not intentions).
 *
 * T38..T39 (2026-10-20): the message went to a one-shot agentDecide() model
 * that picked reply/ignore/owner/approve in a single LLM call.
 *
 * T52 (owner request 2026-10-23): NO more "just an AI" answering people.
 * Every incoming DM now goes to the FULL agent — the one with the computer
 * (shell, python, files), the Telegram app, web search and the shared
 * memory. The route composes a DM task (sender + message + last 50 messages
 * of THIS chat + shared agent memory + the owner's teaching), queues it as a
 * #!agent task and kicks the worker. The agent replies to the person from
 * the owner's account via its own Telegram app (node "$TG" send <chat_id>),
 * escalates delicate questions to the owner via <answer>, and closes with
 * an <end> recap that lands in the shared memory. Nothing is sent
 * synchronously here — the HTTP response only acknowledges the queueing.
 */
import crypto from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { loadAgentContext, parseExamples, rememberInteraction, type TgExample } from '@/lib/tguser'
import { readMemText } from '@/lib/agent/memory'
import { agentTick } from '@/lib/agent/worker'

export const runtime = 'nodejs'
export const maxDuration = 60

const RATE_PER_HOUR = 30
const HISTORY_TURNS = 50

function secretOk(s: unknown): boolean {
  const expected = process.env.GH_TERM_SECRET || ''
  const given = String(s || '')
  if (!expected || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** one-line digest of the queueing for the shared memory */
function outcomeLine(taskId: string, from: string, text: string): string {
  return `входящее от ${from || 'неизвестного'}: «${text.slice(0, 120)}» → передано полному агенту (задача ${taskId.slice(-6)} в очереди)`
}

/** the DM site conversation (owner-visible log of this chat's agent runs) */
async function dmConversation(userId: string, chatId: string, chatName: string | null) {
  const title = `TG-входящие · ${chatName || chatId} (${chatId})`
  const existing = await db.conversation.findFirst({
    where: { userId, title },
    orderBy: { updatedAt: 'desc' },
  })
  if (existing) return existing
  return db.conversation.create({ data: { userId, title } })
}

/** the #!agent task body the GitHub runner executes with ALL tools */
function dmTaskPrompt(opts: {
  chatId: string
  chatName: string
  text: string
  history: string[]
  memory: string
  teaching: string
  configPrompt: string
  examples: TgExample[]
}): string {
  const parts: string[] = []
  parts.push(
    `ВХОДЯЩЕЕ ЛИЧНОЕ СООБЩЕНИЕ в Telegram-аккаунт владельца. Ты отвечаешь на него ОТ ИМЕНИ владельца — со всеми своими инструментами (компьютер, Telegram, поиск, память).`,
    ``,
    `От: ${opts.chatName || 'Неизвестный'} (chat id: ${opts.chatId})`,
    `Сообщение: «${opts.text}»`,
  )
  if (opts.history.length > 0) {
    parts.push(
      ``,
      `История этого чата (последние ${opts.history.length}, старые → свежие):`,
      ...opts.history.map((h) => `- ${h}`),
    )
  }
  if (opts.memory) parts.push(``, `# Общая память агента\n${opts.memory}`)
  if (opts.configPrompt) parts.push(``, `# Настройка владельца (стиль и правила общения)\n${opts.configPrompt}`)
  if (opts.teaching) parts.push(``, `# Чему владельец учил агента в чате «TG-агент»\n${opts.teaching}`)
  if (opts.examples.length > 0) {
    parts.push(``, `ПРИМЕРЫ одобренных владельцем ответов (стиль и краткость подстраивай, не копируй дословно; язык примеров НЕ копируй — твой ответ всегда по-русски):`)
    for (const e of opts.examples.slice(-8))
      parts.push(`- ${e.from ? `От ${e.from}: ` : ''}${e.incoming.replace(/\s+/g, ' ').slice(0, 300)}\n  Ответ: ${e.reply.replace(/\s+/g, ' ').slice(0, 500)}`)
  }
  parts.push(
    ``,
    `## Правила обработки входящего (v12)`,
    `1. Ответ человеку — ТОЛЬКО через приложение Telegram: node "$TG" send ${opts.chatId} "текст". НЕ используй <answer> для ответа этому человеку — <answer> уходит только владельцу в его бот-чат.`,
    `   ПОЧЕРК (владелец проверяет): пиши как ЖИВОЙ ЧЕЛОВЕК от первого лица владельца. ЯЗЫК ОТВЕТА — ВСЕГДА РУССКИЙ, даже если собеседник пишет по-узбекски или на другом языке; не смешивай языки и не вставляй в сообщение иноязычных фраз (ломаный узбекский «Йакшимисан?» — главный грех почерка). Стиль, обращения и краткость бери из истории ЭТОГО чата выше (как владелец сам пишет — так же коротко и живо, но по-русски). Коротко, 1-3 естественных предложения, по сути последнего сообщения; один вопрос — один раз. Запрещены роботизмы («Я помогу вам…», «Предварительно изучив контекст…»), канцелярит, повторы одной мысли. Грамотно по-русски, как носитель. Перед отправкой перечитай и упрости: звучит как бот/переводчик — перепиши.`,
    `2. Спам или не требует ответа — ничего не отправляй, заверши сразу <end>пересказ</end>.`,
    `3. Деликатные темы (деньги, обещания, встречи, важные решения) или сомневаешься — человеку НЕ отвечай; сообщи владельцу через <answer> (цитируй вопрос, предложи свой вариант ответа).`,
    `4. Для ответа нужно что-то сделать (файл, расчёт, поиск, прочитать историю) — сделай инструментами компьютера, проверь результат и только потом отправляй.`,
    `5. Важные факты (договорённости, имена, предпочтения) — <memory>…</memory>.`,
    `6. Заверши <end>краткий пересказ: от кого, что сделал, что отправил</end>.`,
  )
  return parts.join('\n')
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  if (!secretOk(body.secret)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const accountId = String(body.accountId || '')
  const chatId = String(body.chatId || '')
  const msgId = String(body.msgId || '')
  const chatName = String(body.chatName || '').slice(0, 120) || null
  const text = String(body.text || '').slice(0, 2000)
  if (!accountId || !chatId || !msgId || !text.trim())
    return NextResponse.json({ skip: 'bad-request' })

  const account = await db.tgAccount.findUnique({ where: { id: accountId }, include: { config: true } })
  if (!account || account.status !== 'connected' || !account.active)
    return NextResponse.json({ skip: 'inactive' })

  // dedupe (worker restarts / Telegram replays must not double-reply)
  const dup = await db.tgAgentMessage.findUnique({
    where: { accountId_chatId_msgId_direction: { accountId, chatId, msgId, direction: 'in' } },
  }).catch(() => null)
  if (dup) return NextResponse.json({ skip: 'dup' })
  await db.tgAgentMessage.create({
    data: { accountId, chatId, chatName, msgId, direction: 'in', text },
  }).catch(() => {})

  // server-side hourly cap (belt & suspenders on top of the worker limiter)
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const sentCount = await db.tgAgentMessage.count({
    where: { accountId, direction: 'out', createdAt: { gt: hourAgo } },
  })
  if (sentCount >= RATE_PER_HOUR) return NextResponse.json({ skip: 'rate' })

  // the agent's context, gathered in parallel: the per-chat transcript
  // (T52: last 50 messages), the shared agent memory and the owner's teaching
  const [memory, teaching, chatRows] = await Promise.all([
    readMemText().catch(() => ''),
    loadAgentContext(account.userId).catch(() => ''),
    db.tgAgentMessage.findMany({
      where: { accountId, chatId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_TURNS,
    }).catch(() => []),
  ])
  chatRows.reverse() // oldest -> newest
  const history = chatRows.map((m) => {
    const who = m.direction === 'in' ? (m.chatName || chatName || 'Собеседник') : 'Ты (агент)'
    return `${who}: ${(m.text || '').replace(/\s+/g, ' ').slice(0, 300)}`
  })

  try {
    const conv = await dmConversation(account.userId, chatId, chatName)
    const prompt = dmTaskPrompt({
      chatId,
      chatName: chatName || '',
      text,
      history,
      memory,
      teaching,
      configPrompt: account.config?.systemPrompt || '',
      examples: parseExamples(account.config?.examples),
    })
    const task = await db.agentTask.create({
      data: {
        conversationId: conv.id,
        type: 'terminal',
        title: `📩 ${chatName || chatId}: ${text.replace(/\s+/g, ' ').slice(0, 60)}`,
        status: 'queued',
        progress: 'Полный агент (GitHub Actions) возьмёт сообщение в течение минуты: сам решит, ответить человеку, действовать инструментами или позвать владельца',
        payload: JSON.stringify({ command: `#!agent\n${prompt}`.slice(0, 20_000), terminalId: conv.id, timeoutS: 3600 }),
      },
    })
    // kick the worker immediately (cron would pick it up anyway) — the DM
    // gets answered in seconds-to-minutes, not at the next 5-min cron beat
    after(() => agentTick().catch(() => {}))

    // silent memory write at the END of the request (never delays the reply):
    // the interaction digest lands in the shared memory like <memory>/<end>
    after(() =>
      rememberInteraction(
        account.userId,
        chatName || '',
        text,
        outcomeLine(task.id, chatName || '', text),
      ).catch(() => {}),
    )

    return NextResponse.json({ skip: 'agent-queued', taskId: task.id })
  } catch (e) {
    return NextResponse.json({ skip: 'queue-error', error: e instanceof Error ? e.message.slice(0, 200) : 'ошибка очереди' })
  }
}
