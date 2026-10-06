import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, createSessionToken, hashPassword, sessionCookieHeader } from '@/lib/auth'
import { chatWebComplete } from '@/lib/chatweb'
import { getUserZaiSession } from '@/lib/zai-session'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/register — create a site account, gated by Z.ai's OWN server
 * captcha (Aliyun slider relayed to the user — the same widget chat.z.ai uses).
 *
 * How the gate works: the browser solves the widget and hands us the one-time
 * captcha_verify_param; we prove it against chat.z.ai itself by minting an
 * anonymous guest session and running a tiny "PONG" completion with the param.
 * If chat.z.ai accepts the param, the human is verified — by Z.ai, not by us.
 * The (now warm) guest session is stored on the user and reused for their AI
 * traffic; its quota is consumed by Z.ai. No tokens are collected from users
 * and the site owner's JWT is not involved.
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
      { error: 'Пройди проверку Z.ai (кнопка «Я не робот») и попробуй снова' },
      { status: 400 },
    )

  const existing = await db.user.findUnique({ where: { email } })
  if (existing)
    return NextResponse.json({ error: 'Такой email уже зарегистрирован' }, { status: 409 })

  // Validate the relayed captcha the honest way: feed it to chat.z.ai.
  // The probe also warms up the guest session we then attach to the user.
  let session
  try {
    session = await getUserZaiSession(null) // throwaway guest, persisted below
    await chatWebComplete(
      [{ role: 'user', content: 'Ответь одним словом: OK' }],
      { transport: { sessionToken: session.token, captchaVerifyParam: zaiCaptchaParam } },
    )
  } catch (e) {
    const code = (e as { code?: string }).code || ''
    if (code === 'captcha_required' || code === 'captcha_failed')
      return NextResponse.json(
        { error: 'Проверка Z.ai не прошла — реши капчу заново и отправь форму ещё раз' },
        { status: 400 },
      )
    return NextResponse.json(
      { error: 'Z.ai недоступен для проверки капчи, попробуй чуть позже' },
      { status: 502 },
    )
  }

  const user = await db.user.create({
    data: {
      email,
      passwordHash: hashPassword(password),
      name,
      zaiToken: session.token,
      zaiUserId: session.zaiUserId,
      zaiSessionAt: new Date(),
    },
    select: { id: true, email: true, name: true },
  })

  const res = NextResponse.json({ user: { id: user.id, email: user.email, name: user.name } })
  res.headers.append('Set-Cookie', sessionCookieHeader(createSessionToken(user.id)))
  return res
}
