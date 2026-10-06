import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, createSessionToken, hashPassword, sessionCookieHeader } from '@/lib/auth'
import { zaiSignUp, resolveSession, ChatWebError } from '@/lib/chatweb'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/register — create the site account AND the user's OWN
 * REAL chat.z.ai account in one step.
 *
 * The gate is Z.ai itself: the browser solves the auth-scene Aliyun captcha
 * (the very widget chat.z.ai embeds on its signup page); we forward the
 * one-time captcha_verify_param together with the user's chosen
 * email/password to chat.z.ai /auths/signup. If Z.ai accepts, a real
 * account exists with its own JWT and its own quota — no owner token, no
 * shared pool, no per-message captcha for this user.
 */
export async function POST(req: NextRequest) {
  if (!AUTH_REQUIRED)
    return NextResponse.json({ error: 'auth disabled (AUTH_REQUIRED=false)' }, { status: 400 })

  let email = ''
  let password = ''
  let name = ''
  let zaiCaptchaParam = ''
  try {
    const body = (await req.json()) as {
      email?: string
      password?: string
      name?: string
      zaiCaptchaParam?: string
    }
    email = String(body.email || '').trim().toLowerCase()
    password = String(body.password || '')
    name = String(body.name || '').trim().slice(0, 60)
    zaiCaptchaParam = String(body.zaiCaptchaParam || '').slice(0, 4096)
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return NextResponse.json({ error: 'Укажи корректный email' }, { status: 400 })
  if (password.length < 6)
    return NextResponse.json({ error: 'Пароль — минимум 6 символов' }, { status: 400 })
  if (!zaiCaptchaParam)
    return NextResponse.json(
      { error: 'Пройди проверку Z.ai (капча под формой) и попробуй снова' },
      { status: 400 },
    )

  const existing = await db.user.findUnique({ where: { email } })
  if (existing)
    return NextResponse.json({ error: 'Такой email уже зарегистрирован здесь' }, { status: 409 })

  // Create the REAL chat.z.ai account — Z.ai verifies the captcha param.
  let session
  try {
    session = await zaiSignUp(name, email, password, zaiCaptchaParam)
    // canonicalize the session (fresh token + stable user id)
    session = await resolveSession(session.token)
  } catch (e) {
    if (e instanceof ChatWebError) {
      if (e.code === 'captcha_failed')
        return NextResponse.json(
          { error: 'Проверка Z.ai не прошла — реши капчу заново и отправь форму ещё раз', code: e.code },
          { status: 400 },
        )
      if (e.code === 'email_taken')
        return NextResponse.json(
          {
            error: 'Такой email уже занят на Z.ai — если это твой аккаунт, просто войди',
            code: e.code,
          },
          { status: 409 },
        )
      return NextResponse.json({ error: e.message, code: e.code }, { status: 502 })
    }
    return NextResponse.json(
      { error: 'Z.ai недоступен для регистрации, попробуй чуть позже' },
      { status: 502 },
    )
  }

  const user = await db.user.create({
    data: {
      email,
      passwordHash: hashPassword(password),
      name: name || session.name || '',
      zaiToken: session.token,
      zaiUserId: session.userId,
      zaiSessionAt: new Date(),
    },
    select: { id: true, email: true, name: true },
  })

  const res = NextResponse.json({ user: { id: user.id, email: user.email, name: user.name } })
  res.headers.append('Set-Cookie', sessionCookieHeader(createSessionToken(user.id)))
  return res
}
