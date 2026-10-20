import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * POST /api/terminal/gh/progress — heartbeat from the agent-mode runner
 * (prefix '#!agent' commands). Auth identical to /claim and /result.
 *
 * T16 (owner request 2026-10-18): the user must NOT see intermediate work.
 * This route is now a SILENT keepalive only:
 *  1. touch the TerminalCommand row so the 30-minute running-timeout in
 *     syncTerminalTask never kills a legitimately long agent job;
 *  2. touch the session (resident keepalive, stale-heartbeat redispatch);
 *  3. keep the last note in the command row for server-side diagnostics.
 * No Telegram mirrors, no chat messages — the user sees only the final
 * <answer> delivered by /result.
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
  }
  return NextResponse.json({ ok: true })
}
