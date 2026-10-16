import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** owner helper — in open mode (AUTH_REQUIRED=false) any known id passes */
async function loadSession(id: string, userId: string | null) {
  const s = await db.terminalSession.findUnique({ where: { id } })
  if (!s || s.kind !== 'browser') return null
  if (userId && s.userId && s.userId !== userId) return null
  return s
}

/** GET /api/terminal/sessions/[id] — session details for the owner page */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  const { id } = await params
  const s = await loadSession(id, user?.id ?? null)
  if (!s) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({
    session: {
      id: s.id, title: s.title, secret: s.secret, status: s.status,
      lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    },
  })
}

/** PATCH /api/terminal/sessions/[id] — rename or archive */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  const { id } = await params
  const s = await loadSession(id, user?.id ?? null)
  if (!s) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { title?: string; status?: string }
  const data: { title?: string; status?: string } = {}
  if (body.title) data.title = String(body.title).slice(0, 80)
  if (body.status === 'active' || body.status === 'archived') data.status = body.status
  const updated = await db.terminalSession.update({ where: { id }, data })
  return NextResponse.json({ ok: true, status: updated.status, title: updated.title })
}
