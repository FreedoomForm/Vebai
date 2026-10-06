import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { resolveSession } from '@/lib/chatweb'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/token — attach the user's own chat.z.ai JWT (BYO mode).
 * Body: { token: string } — validated against chat.z.ai before saving.
 * DELETE — remove the stored token (back to ZAI_JWT / guest mode).
 */
export async function POST(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'auth disabled' }, { status: 400 })

  let token = ''
  try {
    const body = (await req.json()) as { token?: string }
    token = String(body.token || '').trim()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (token.length < 20)
    return NextResponse.json({ error: 'Токен выглядит некорректно' }, { status: 400 })

  // validate: exchange the JWT for a fresh session on chat.z.ai
  try {
    const session = await resolveSession(token)
    await db.user.update({ where: { id: user.id }, data: { zaiToken: token } })
    return NextResponse.json({
      ok: true,
      account: { email: session.email, role: session.role, name: session.name },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: `Z.ai отклонил токен: ${msg.slice(0, 200)}` }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'auth disabled' }, { status: 400 })

  await db.user.update({ where: { id: user.id }, data: { zaiToken: null } })
  return NextResponse.json({ ok: true })
}
