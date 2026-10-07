import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { db } from '@/lib/db'
import { isGuestToken } from '@/lib/zai-direct'
import { resolveSession, ChatWebError, peekZaiJwtEmail } from '@/lib/chatweb'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/zai/attach — register a REAL chat.z.ai session on the site
 * user row (v10 browser-direct flow).
 *
 * The browser obtained the JWT itself (email signup + code, signin, or the
 * Google/GitHub bridge) — same-client captcha flow, exactly like
 * chat.z.ai's own frontend. The server NEVER relays the captcha anymore;
 * its only job here is to validate the token live (resolveSession — a
 * sliding refresh) and persist it as the linked-account source of truth.
 * Guest tokens are rejected: guest mode is removed.
 */
export async function POST(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'нет сессии' }, { status: 401 })

  let token = ''
  try {
    const body = (await req.json()) as { token?: string }
    token = String(body.token || '').slice(0, 8192)
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!token || isGuestToken(token))
    return NextResponse.json(
      { error: 'Гостевые сессии не подключаются — нужен настоящий аккаунт Z.ai', code: 'guest_token' },
      { status: 400 },
    )

  try {
    // live validation + sliding refresh (throws zai_session_expired on dead JWT)
    const canonical = await resolveSession(token)
    if (/^guest-\d+@guest\.com$/i.test(peekZaiJwtEmail(canonical.token) || ''))
      return NextResponse.json(
        { error: 'Сессия откатилась в гостевую — войди в настоящий аккаунт', code: 'guest_token' },
        { status: 400 },
      )
    await db.user.update({
      where: { id: user.id },
      data: {
        zaiToken: canonical.token,
        zaiUserId: canonical.userId,
        zaiSessionAt: new Date(),
      },
    })
    return NextResponse.json({
      zai: { linked: true, email: canonical.email, name: canonical.name },
    })
  } catch (e) {
    const code = e instanceof ChatWebError ? e.code : 'attach_failed'
    const msg = e instanceof Error ? e.message.slice(0, 240) : 'Z.ai не подтвердил сессию'
    return NextResponse.json({ error: msg, code }, { status: 400 })
  }
}

/** DELETE /api/auth/zai/attach — unlink (logout of the Z.ai account). */
export async function DELETE(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'нет сессии' }, { status: 401 })
  await db.user.update({
    where: { id: user.id },
    data: { zaiToken: null, zaiUserId: null, zaiSessionAt: null },
  })
  return NextResponse.json({ zai: { linked: false } })
}
