import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, createSessionToken, hashPassword, sessionCookieHeader } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/register — create the site account INSTANTLY (v10).
 *
 * The local account is created first and the user is let in immediately —
 * registration can no longer be blocked by anything Z.ai-side.
 *
 * The REAL chat.z.ai account is created by the BROWSER (v10 browser-direct):
 * the Aliyun captcha widget runs in the user's browser and the signup request
 * carries the param from the SAME browser/IP — byte-for-byte the same flow as
 * chat.z.ai's own signup page. After the emailed code step the browser hands
 * the JWT to /api/auth/zai/attach, which validates and stores it here.
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

  const res = NextResponse.json({
    user,
    zai: { linked: false, browserLink: true },
  })
  res.headers.append('Set-Cookie', sessionCookieHeader(createSessionToken(user.id)))
  return res
}
