import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, createSessionToken, hashPassword, sessionCookieHeader } from '@/lib/auth'
import { verifyCaptcha } from '@/lib/captcha'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/register — create a local site account (captcha-gated).
 *
 * Transparency note (also shown on the landing page): registration happens
 * HERE behind a captcha; no chat.z.ai tokens are ever collected from users.
 * AI traffic is proxied through chat.z.ai with the site's ZAI_JWT (owner) or
 * a guest session — see src/lib/chatweb.ts.
 */
export async function POST(req: NextRequest) {
  if (!AUTH_REQUIRED)
    return NextResponse.json({ error: 'auth disabled (AUTH_REQUIRED=false)' }, { status: 400 })

  let email = ''
  let password = ''
  let name = ''
  let captchaId = ''
  let captchaText = ''
  try {
    const body = (await req.json()) as {
      email?: string
      password?: string
      name?: string
      captchaId?: string
      captchaText?: string
    }
    email = String(body.email || '').trim().toLowerCase()
    password = String(body.password || '')
    name = String(body.name || '').trim().slice(0, 60)
    captchaId = String(body.captchaId || '').trim()
    captchaText = String(body.captchaText || '').trim()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return NextResponse.json({ error: 'Укажи корректный email' }, { status: 400 })
  if (password.length < 6)
    return NextResponse.json({ error: 'Пароль — минимум 6 символов' }, { status: 400 })

  if (!(await verifyCaptcha(captchaId, captchaText)))
    return NextResponse.json({ error: 'Капча введена неверно — обнови картинку и попробуй снова' }, { status: 400 })

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
