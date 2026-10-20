import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  AUTH_REQUIRED,
  createSessionToken,
  sessionCookieHeader,
  verifyPassword,
} from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/login — plain local credential check.
 * No Z.ai sessions, no captchas: AI runs server-side on the owner's key.
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

  const res = NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name },
  })
  res.headers.append('Set-Cookie', sessionCookieHeader(createSessionToken(user.id)))
  return res
}
