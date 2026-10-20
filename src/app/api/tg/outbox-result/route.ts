/**
 * T31: POST /api/tg/outbox-result — the resident Telegram worker
 * (.github/tg_userbot.js) reports the outcome of an outbox job (message/file
 * sent FROM the owner's own account to a contact). Auth: GH_TERM_SECRET.
 * ok=true  -> AgentTask completed + task_result message in the chat
 *             (+ TgAgentMessage log entry for the outgoing side).
 * ok=false -> AgentTask failed + honest reason in the chat (site-side retries
 *             already bounded in syncOutboxTasks).
 * T32: kind='read' carries the fetched message transcript — it lands in the
 * chat verbatim and the agent AUTO-CONTINUES the original order via
 * continueAfterRead (after() — never blocks the worker's HTTP call).
 */
import crypto from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { continueAfterRead } from '@/lib/agent/continue'

export const runtime = 'nodejs'
export const maxDuration = 300 // continuation LLM runs inside after()

function secretOk(s: unknown): boolean {
  const expected = process.env.GH_TERM_SECRET || ''
  const given = String(s || '')
  if (!expected || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  if (!secretOk(body.secret)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const id = String(body.id || '')
  if (!id) return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 })

  const task = await db.agentTask.findUnique({ where: { id } })
  if (!task || (task.type !== 'tg_outbox' && task.type !== 'tg_read'))
    return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })
  if (task.status === 'completed' || task.status === 'failed')
    return NextResponse.json({ ok: true, alreadyFinal: true }) // duplicate report

  let payload: {
    peer?: string
    message?: string
    file?: string | null
    fileId?: string | null
    kind?: string
    chat?: string
    search?: string | null
    accountId?: string
  } = {}
  try { payload = JSON.parse(task.payload || '{}') } catch { /* ignore */ }
  const isRead = payload.kind === 'read'

  const info = (body.info || {}) as {
    peerId?: string
    peerName?: string
    msgId?: string
    fileName?: string | null
    count?: number
  }
  const peerName = String(info.peerName || payload.peer || 'контакт').slice(0, 120)
  const fileName = String(info.fileName || payload.file || '').slice(0, 200)
  const isFile = Boolean(payload.file || info.fileName)

  if (body.ok === true && isRead) {
    // ---- T32: read result — format the transcript into the chat
    const rawMsgs = Array.isArray(body.messages) ? body.messages.slice(0, 500) : []
    const MAX_TRANSCRIPT = 50_000
    const lines: string[] = []
    let total = 0
    for (const rm of rawMsgs) {
      const date = String((rm as { date?: string }).date || '')
      // ISO -> DD.MM HH:mm (RU-friendly); fallback: raw prefix
      const d = /^\d{4}-\d{2}-\d{2}T/.test(date)
        ? `${date.slice(8, 10)}.${date.slice(5, 7)} ${date.slice(11, 16)}`
        : date.slice(0, 16)
      const from = String((rm as { from?: string }).from || '?').slice(0, 80)
      const text = String((rm as { text?: string }).text || '')
        .trim()
        .slice(0, 1200)
        .replace(/\s+/g, ' ')
      const line = `[${d}] ${from}: ${text || '(без текста)'}`
      if (total + line.length > MAX_TRANSCRIPT) {
        lines.push(`…(обрезано: показано ${lines.length} из ${rawMsgs.length} сообщений — попроси продолжить с большим limit или в несколько блоков)`)
        break
      }
      lines.push(line)
      total += line.length
    }
    const count = Number(info.count) || rawMsgs.length
    const header = `📖 Прочитал ${count} сообщений из чата «${peerName}»${payload.search ? ` (поиск: «${String(payload.search).slice(0, 80)}»)`: ''}:`
    const transcript = lines.length ? `${header}\n${lines.join('\n')}` : `${header} сообщений нет (пустой чат или search ничего не нашёл)`
    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: 'completed',
        progress: null,
        result: JSON.stringify({ summary: header, count }),
      },
    })
    await db.message.create({
      data: {
        conversationId: task.conversationId,
        role: 'assistant',
        kind: 'task_result',
        content: transcript.slice(0, MAX_TRANSCRIPT + 1000),
        meta: JSON.stringify({ taskId: task.id }),
      },
    })
    await db.conversation
      .update({ where: { id: task.conversationId }, data: { updatedAt: new Date() } })
      .catch(() => {})
    // T32: the agent continues the original order on its own (no user turn)
    after(() => continueAfterRead(task.conversationId, task.id, transcript))
    return NextResponse.json({ ok: true })
  }

  if (body.ok === true) {
    const fileLink = payload.fileId
      ? `📎 [${fileName || 'файл'}](/api/terminal/files/${payload.fileId})`
      : ''
    const summary = isFile
      ? `Отправлено через твой Telegram: файл «${fileName || 'файл'}» → ${peerName}`
      : `Отправлено через твой Telegram: сообщение → ${peerName}`
    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: 'completed',
        progress: null,
        result: JSON.stringify({ summary }),
      },
    })
    const content = `📤 ${summary}.${info.msgId ? ` (msg id ${String(info.msgId).slice(0, 20)})` : ''}${fileLink ? `\n${fileLink}` : ''}`
    await db.message.create({
      data: {
        conversationId: task.conversationId,
        role: 'assistant',
        kind: 'task_result',
        content,
        meta: JSON.stringify({ taskId: task.id }),
      },
    })
    await db.conversation
      .update({ where: { id: task.conversationId }, data: { updatedAt: new Date() } })
      .catch(() => {})
    // outgoing-side log (same ledger the auto-replyer uses)
    try {
      const p2 = JSON.parse(task.payload || '{}') as { accountId?: string }
      if (p2.accountId && info.peerId) {
        await db.tgAgentMessage.create({
          data: {
            accountId: p2.accountId,
            chatId: String(info.peerId),
            chatName: peerName,
            msgId: String(info.msgId || `out-${Date.now()}`),
            direction: 'out',
            text: isFile ? `(файл) ${fileName || 'файл'}` : String(payload.message || '').slice(0, 2000),
          },
        }).catch(() => {})
      }
    } catch { /* log is best-effort */ }
    return NextResponse.json({ ok: true })
  }

  // failure report
  const error = String(body.error || (isRead ? 'воркер не смог прочитать сообщения' : 'воркер не смог отправить сообщение')).slice(0, 300)
  await db.agentTask.update({
    where: { id: task.id },
    data: { status: 'failed', progress: null, error },
  })
  const content = isRead
    ? `📖 Чтение Telegram не удалось: ${error.slice(0, 250)}`
    : `📤 Отправка через Telegram не удалась: ${error.slice(0, 250)}`
  await db.message.create({
    data: {
      conversationId: task.conversationId,
      role: 'assistant',
      kind: 'task_result',
      content,
      meta: JSON.stringify({ taskId: task.id }),
    },
  })
  await db.conversation
    .update({ where: { id: task.conversationId }, data: { updatedAt: new Date() } })
    .catch(() => {})
  return NextResponse.json({ ok: true })
}
