import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  AUTH_REQUIRED,
  createSessionToken,
  sessionCookieHeader,
  verifyPassword,
} from '@/lib/auth'
import { isRealZaiToken } from '@/lib/chatweb'
import { ensureUserZaiSession } from '@/lib/zai-session'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/login — local credential check, then resolve the user's
 * Z.ai session (v12: never blocks login).
 *
 * Flow:
 *  1. local scrypt hash check → issue our cookie — the user is in;
 *  2. resolve the Z.ai session: REAL account → sliding refresh (dead real
 *     JWT surfaces 'expired', the in-app card re-links it); otherwise the
 *     PERSONAL session is refreshed/minted automatically (own quota).
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

  // v12: resolve the Z.ai session for this user.
  // A REAL account JWT refreshes silently; anything else gets/refreshes the
  // PERSONAL dedicated session (minted server-side, own quota).
  let zaiSession: 'linked' | 'personal' | 'expired' | 'none' = 'none'
  if (isRealZaiToken(user.zaiToken)) {
    try {
      const s = await ensureUserZaiSession(user.id)
      zaiSession = s.kind === 'real' ? 'linked' : 'personal'
    } catch {
      zaiSession = 'expired' // dead real JWT — the in-app card re-links it
    }
  } else {
    try {
      await ensureUserZaiSession(user.id) // refresh/mint the personal session
      zaiSession = 'personal'
    } catch {
      // Z.ai unreachable — lazily retried on the first message
      zaiSession = 'none'
    }
  }

  const res = NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name },
    zaiSession,
  })
  res.headers.append('Set-Cookie', sessionCookieHeader(createSessionToken(user.id)))
  return res
}
