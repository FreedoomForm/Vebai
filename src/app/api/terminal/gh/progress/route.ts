import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sendTelegramText, taskChat } from '@/lib/telegram'

export const dynamic = 'force-dynamic'

/**
 * POST /api/terminal/gh/progress — short progress lines from the agent-mode
 * runner (prefix '#!agent' commands). Auth identical to /claim and /result.
 *
 * Two jobs:
 *  1. touch the TerminalCommand row so the 30-minute running-timeout in
 *     syncTerminalTask never kills a legitimately long agent job;
 *  2. mirror the progress note to the owner's private Telegram chat when the
 *     command belongs to the Telegram conversation (same rule as /result).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    secret?: string
    session?: string
    text?: string
  }
  const secret = String(body.secret || '')
  const sessionId = String(body.session || '')
  const text = String(body.text || '').slice(0, 400)
  if (!secret || !sessionId || !text)
    return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 })

  const session = await db.terminalSession.findUnique({ where: { id: sessionId } })
  if (!session || session.kind !== 'gh' || session.secret !== secret)
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })

  // a progress update also re-authorizes the resident session's presence
  await db.terminalSession
    .update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } })
    .catch(() => null)

  // touch the oldest running command of this session (the agent owns the
  // runner while it works, so there is exactly one) - keeps updatedAt fresh
  const cmd = await db.terminalCommand.findFirst({
    where: { sessionId, status: 'running' },
    orderBy: { updatedAt: 'desc' },
  })
  if (cmd) {
    await db.terminalCommand
      .update({
        where: { id: cmd.id },
        data: { output: `[агент] ${text}`.slice(0, 500) },
      })
      .catch(() => null)

    // mirror to the task sender's Telegram chat (multi-user: not only the
    // owner's DM anymore)
    try {
      if (cmd.conversationId) {
        const origin = await taskChat(cmd.conversationId)
        if (origin?.chatId) await sendTelegramText(`🤖 ${text}`, origin.chatId)
      }
    } catch {
      /* best-effort */
    }
  }
  return NextResponse.json({ ok: true })
}
