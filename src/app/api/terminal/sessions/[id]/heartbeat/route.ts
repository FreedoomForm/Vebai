import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** POST /api/terminal/sessions/[id]/heartbeat — page proves the VM is alive */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  const { id } = await params
  const s = await db.terminalSession.findUnique({ where: { id } })
  if (!s || s.kind !== 'browser') return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (user && s.userId && s.userId !== user.id) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  await db.terminalSession.update({ where: { id }, data: { lastSeenAt: new Date() } })
  const pending = await db.terminalCommand.count({ where: { sessionId: id, status: 'pending' } })
  return NextResponse.json({ ok: true, pending })
}
