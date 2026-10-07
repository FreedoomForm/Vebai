import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, createSessionToken, hashPassword, sessionCookieHeader } from '@/lib/auth'
import { ensureUserZaiSession } from '@/lib/zai-session'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/register — create the site account INSTANTLY and connect
 * the user's PERSONAL Z.ai session automatically (v12).
 *
 * The local account is created first; then the server mints a DEDICATED
 * chat.z.ai session for THIS user (GET /api/v1/auths/ without auth) and
 * stores it on the user row — from this moment the user owns a personal
 * free-AI quota on Z.ai and never has to leave our site. Minting is
 * best-effort: if Z.ai is momentarily unreachable the user still gets in
 * and the session is minted lazily on the first message (chat/start).
 */
export async function POST(req: NextRequest) {
  if (!AUTH_REQUIRED)
    return NextResponse.json({ error: 'auth disabled (AUTH_REQUIRED=false)' }, { status: 400 })

  let email = ''
  let password = ''
  let name = ''
  try {
    const body = (await req.json()) as { email?: string; password?: string; name?: string }
    email = String(body.email || '').trim().toLowerCase()
    password = String(body.password || '')
    name = String(body.name || '').trim().slice(0, 60)
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return NextResponse.json({ error: 'Укажи корректный email' }, { status: 400 })
  if (password.length < 6)
    return NextResponse.json({ error: 'Пароль — минимум 6 символов' }, { status: 400 })

  const existing = await db.user.findUnique({ where: { email } })
  if (existing)
    return NextResponse.json({ error: 'Такой email уже зарегистрирован здесь' }, { status: 409 })

  const user = await db.user.create({
    data: {
      email,
      passwordHash: hashPassword(password),
      name,
    },
    select: { id: true, email: true, name: true },
  })

  // ---- v12: connect the personal Z.ai session immediately (best-effort —
  // chat/start re-runs ensureUserZaiSession lazily if this failed)
  let zai: { linked: boolean; kind: 'personal' | 'real' | 'none'; email?: string } = {
    linked: false,
    kind: 'none',
  }
  try {
    const s = await ensureUserZaiSession(user.id)
    zai = { linked: true, kind: s.kind, email: s.email }
  } catch {
    // Z.ai unreachable — the user still gets in; retried on first message
  }

  const res = NextResponse.json({ user, zai })
  res.headers.append('Set-Cookie', sessionCookieHeader(createSessionToken(user.id)))
  return res
}
