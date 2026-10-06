import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  AUTH_REQUIRED,
  createSessionToken,
  sessionCookieHeader,
  verifyPassword,
} from '@/lib/auth'
import { resolveSession } from '@/lib/chatweb'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/login — local credential check, then attach the stored
 * Z.ai session if it is still alive (v4: login is NEVER blocked by Z.ai).
 *
 * Flow:
 *  1. local scrypt hash check → issue our cookie — the user is in;
 *  2. stored Z.ai JWT still alive? refresh it silently (best-effort);
 *  3. dead JWT → respond with zaiSession:'expired' — the user still enters
 *     the app and sees the reconnect card (their messages continue on a
 *     guest session until they reconnect their own Z.ai account).
 *
 * Re-linking a dead Z.ai session (email+password behind Z.ai's captcha)
 * lives in POST /api/auth/link — one concern, one route.
 */
export async function POST(req: NextRequest) {
  if (!AUTH_REQUIRED)
    return NextResponse.json({ error: 'auth disabled (AUTH_REQUIRED=false)' }, { status: 400 })

  let email = ''
  let password = ''
  try {
    const body = (await req.json()) as { email?: string; password?: string }
    email = String(body.email || '').trim().toLowerCase()
    password = String(body.password || '')
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!email || !password)
    return NextResponse.json({ error: 'Укажи email и пароль' }, { status: 400 })

  const user = await db.user.findUnique({ where: { email } })
  if (!user || !verifyPassword(password, user.passwordHash)) {
    // unknown email or wrong password — do not leak which one
    return NextResponse.json({ error: 'Неверный email или пароль' }, { status: 401 })
  }

  // silently refresh the stored Z.ai session when possible
  let zaiSession: 'linked' | 'expired' | 'none' = user.zaiToken ? 'expired' : 'none'
  if (user.zaiToken) {
    try {
      const session = await resolveSession(user.zaiToken)
      await db.user.update({
        where: { id: user.id },
        data: { zaiToken: session.token, zaiUserId: session.userId, zaiSessionAt: new Date() },
      })
      zaiSession = 'linked'
    } catch {
      /* dead JWT — the in-app card will re-link it */
    }
  }

  const res = NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name },
    zaiSession,
  })
  res.headers.append('Set-Cookie', sessionCookieHeader(createSessionToken(user.id)))
  return res
}
