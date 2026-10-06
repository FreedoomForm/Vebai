import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, createSessionToken, hashPassword, sessionCookieHeader } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/register — create a local site account.
 *
 * Transparency note (also shown on the landing page): registration happens
 * HERE, but AI requests are proxied through chat.z.ai. We do not create
 * chat.z.ai accounts programmatically (their signup is captcha-protected);
 * users can attach their own chat.z.ai token via /api/auth/token or the
 * site-wide ZAI_JWT env is used.
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
    return NextResponse.json({ error: 'Такой email уже зарегистрирован' }, { status: 409 })

  const user = await db.user.create({
    data: { email, passwordHash: hashPassword(password), name },
    select: { id: true, email: true, name: true },
  })

  const res = NextResponse.json({ user: { id: user.id, email: user.email, name: user.name } })
  res.headers.append('Set-Cookie', sessionCookieHeader(createSessionToken(user.id)))
  return res
}
