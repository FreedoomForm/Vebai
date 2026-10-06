import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  AUTH_REQUIRED,
  createSessionToken,
  hashPassword,
  sessionCookieHeader,
  verifyPassword,
} from '@/lib/auth'
import { zaiSignIn, resolveSession, ChatWebError } from '@/lib/chatweb'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/login — verify local credentials, then attach the user's
 * REAL chat.z.ai account session.
 *
 * Flow:
 *  1. local scrypt hash check (fast, no captcha);
 *  2. stored Z.ai JWT still alive? refresh it and issue our cookie — done;
 *  3. otherwise Z.ai's own captcha is REQUIRED for signin: without
 *     `zaiCaptchaParam` we answer 401 {code:'zai_captcha_required'} and the
 *     UI reveals the same Aliyun widget chat.z.ai shows on its login page;
 *  4. with the param we call /auths/signin (same email/password the user
 *     registered with — their Z.ai account is theirs), persist the fresh
 *     JWT and issue the cookie.
 *
 * If the local hash is unknown but Z.ai accepts the credentials (an account
 * created on chat.z.ai directly), we adopt it: hash the provided password
 * locally and continue — one account everywhere.
 */
export async function POST(req: NextRequest) {
  if (!AUTH_REQUIRED)
    return NextResponse.json({ error: 'auth disabled (AUTH_REQUIRED=false)' }, { status: 400 })

  let email = ''
  let password = ''
  let zaiCaptchaParam = ''
  try {
    const body = (await req.json()) as {
      email?: string
      password?: string
      zaiCaptchaParam?: string
    }
    email = String(body.email || '').trim().toLowerCase()
    password = String(body.password || '')
    zaiCaptchaParam = String(body.zaiCaptchaParam || '').slice(0, 4096)
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!email || !password)
    return NextResponse.json({ error: 'Укажи email и пароль' }, { status: 400 })

  const user = await db.user.findUnique({ where: { email } })
  const localOk = !!user && verifyPassword(password, user.passwordHash)
  if (!user) {
    // not registered here — do not leak existence details
    return NextResponse.json({ error: 'Неверный email или пароль' }, { status: 401 })
  }

  const issue = () => {
    const res = NextResponse.json({ user: { id: user!.id, email: user!.email, name: user!.name } })
    res.headers.append('Set-Cookie', sessionCookieHeader(createSessionToken(user!.id)))
    return res
  }

  // (2) stored Z.ai session still alive → just refresh and go
  if (user.zaiToken) {
    try {
      const session = await resolveSession(user.zaiToken)
      await db.user.update({
        where: { id: user.id },
        data: { zaiToken: session.token, zaiUserId: session.userId, zaiSessionAt: new Date() },
      })
      return issue()
    } catch {
      /* dead JWT → fall through to the captcha path */
    }
  }

  // (3) Z.ai requires its own captcha for signin — ask the UI to relay it
  if (!zaiCaptchaParam) {
    if (!localOk)
      return NextResponse.json({ error: 'Неверный email или пароль' }, { status: 401 })
    return NextResponse.json(
      {
        error: 'Z.ai требует подтверждение входа — реши капчу Z.ai и повтори',
        code: 'zai_captcha_required',
      },
      { status: 401 },
    )
  }

  // (4) sign in to the user's OWN chat.z.ai account
  try {
    const session = await zaiSignIn(email, password, zaiCaptchaParam)
    await db.user.update({
      where: { id: user.id },
      data: {
        zaiToken: session.token,
        zaiUserId: session.userId,
        zaiSessionAt: new Date(),
        // keep local auth in sync with the working Z.ai credentials
        ...(localOk ? {} : { passwordHash: hashPassword(password) }),
      },
    })
    return issue()
  } catch (e) {
    if (e instanceof ChatWebError) {
      if (e.code === 'bad_credentials')
        return NextResponse.json(
          { error: 'Z.ai не принял этот email/пароль. Если ты менял пароль на Z.ai — используй новый.' },
          { status: 401 },
        )
      if (e.code === 'captcha_failed')
        return NextResponse.json(
          { error: 'Капча Z.ai не прошла — реши заново и повтори вход', code: e.code },
          { status: 401 },
        )
      return NextResponse.json({ error: e.message, code: e.code }, { status: 502 })
    }
    return NextResponse.json({ error: 'Z.ai недоступен, попробуй чуть позже' }, { status: 502 })
  }
}
