import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * POST /api/terminal/gh/claim — the GitHub Actions executor picks work.
 * Auth: session.secret of a TerminalSession with kind='gh' (never a cookie —
 * the runner is headless). Claiming is atomic (pending -> running) so two
 * concurrent workflow runs can never execute the same command twice.
 * Also reclaims 'running' commands stuck for >25 min (crashed runner).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    secret?: string
    session?: string
    cmd?: string
  }
  const secret = String(body.secret || '')
  const sessionId = String(body.session || '')
  if (!secret || !sessionId)
    return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 })

  const session = await db.terminalSession.findUnique({ where: { id: sessionId } })
  if (!session || session.kind !== 'gh' || session.secret !== secret)
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })

  const stale = new Date(Date.now() - 25 * 60_000)

  const tryClaim = async (id: string, staleOnly = false) => {
    const r = await db.terminalCommand.updateMany({
      where: staleOnly
        ? { id, status: 'running', updatedAt: { lt: stale } }
        : { id, status: 'pending' },
      data: { status: 'running' },
    })
    if (r.count !== 1) return null
    return db.terminalCommand.findUnique({ where: { id } })
  }

  type CmdRow = Awaited<ReturnType<typeof tryClaim>>
  let cmd: CmdRow = null
  const want = String(body.cmd || '')
  if (want) cmd = await tryClaim(want)
  if (!cmd) {
    const oldest = await db.terminalCommand.findFirst({
      where: { sessionId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    })
    if (oldest) cmd = await tryClaim(oldest.id)
  }
  if (!cmd) {
    // self-heal: a previous runner crashed mid-command
    const stuck = await db.terminalCommand.findFirst({
      where: { sessionId, status: 'running', updatedAt: { lt: stale } },
      orderBy: { updatedAt: 'asc' },
    })
    if (stuck) cmd = await tryClaim(stuck.id, true)
  }

  if (!cmd) return NextResponse.json({ ok: false, reason: 'empty' })

  await db.terminalSession.update({
    where: { id: sessionId },
    data: { lastSeenAt: new Date() },
  })
  return NextResponse.json({
    ok: true,
    cmd: { id: cmd.id, command: cmd.command, conversationId: cmd.conversationId },
  })
}
