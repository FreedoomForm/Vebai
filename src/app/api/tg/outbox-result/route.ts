/**
 * T31: POST /api/tg/outbox-result — the resident Telegram worker
 * (.github/tg_userbot.js) reports the outcome of an outbox job (message/file
 * sent FROM the owner's own account to a contact). Auth: GH_TERM_SECRET.
 * ok=true  -> AgentTask completed + task_result message in the chat
 *             (+ TgAgentMessage log entry for the outgoing side).
 * ok=false -> AgentTask failed + honest reason in the chat (site-side retries
 *             already bounded in syncOutboxTasks).
 */
import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const maxDuration = 60

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
  if (!task || task.type !== 'tg_outbox')
    return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })
  if (task.status === 'completed' || task.status === 'failed')
    return NextResponse.json({ ok: true, alreadyFinal: true }) // duplicate report

  let payload: { peer?: string; message?: string; file?: string | null; fileId?: string | null } = {}
  try { payload = JSON.parse(task.payload || '{}') } catch { /* ignore */ }

  const info = (body.info || {}) as {
    peerId?: string
    peerName?: string
    msgId?: string
    fileName?: string | null
  }
  const peerName = String(info.peerName || payload.peer || 'контакт').slice(0, 120)
  const fileName = String(info.fileName || payload.file || '').slice(0, 200)
  const isFile = Boolean(payload.file || info.fileName)

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
  const error = String(body.error || 'воркер не смог отправить сообщение').slice(0, 300)
  await db.agentTask.update({
    where: { id: task.id },
    data: { status: 'failed', progress: null, error },
  })
  const content = `📤 Отправка через Telegram не удалась: ${error.slice(0, 250)}`
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
