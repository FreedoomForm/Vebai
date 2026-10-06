import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, createSessionToken, hashPassword, sessionCookieHeader } from '@/lib/auth'
import { zaiSignUpStart, ChatWebError } from '@/lib/chatweb'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/register — create the site account INSTANTLY (v5).
 *
 * The local account is created first and the user is let in immediately —
 * registration can no longer be blocked by anything Z.ai-side.
 *
 * If the browser also relayed a solved Z.ai auth-scene captcha param, we
 * START the creation of the user's REAL chat.z.ai account (byte-verified
 * flow, prod-fe-1.1.98): POST /auths/signup {name,email,password,captcha}
 * → Z.ai emails a 6-digit verification code → the user enters it (in-app
 * or right on the auth screen) → verify_email + finish_signup complete the
 * account and hand us the JWT. The code step never blocks logging in —
 * skipping it just leaves the account unlinked (connect later in-app).
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

  const existing = await db.user.findUnique({ where: { email } })
  if (existing)
    return NextResponse.json({ error: 'Такой email уже зарегистрирован здесь' }, { status: 409 })

  // 1) the local account — instant, unconditional
  const user = await db.user.create({
    data: {
      email,
      passwordHash: hashPassword(password),
      name,
    },
    select: { id: true, email: true, name: true },
  })

  // 2) best-effort: START the user's REAL chat.z.ai account behind the
  //    relayed captcha param. Success = verification email sent by Z.ai;
  //    the in-code step finishes the link. Never blocks registration.
  let zai: { linked: boolean; needsCode?: boolean; code?: string; detail?: string } = {
    linked: false,
  }
  if (zaiCaptchaParam) {
    try {
      await zaiSignUpStart(name || email.split('@')[0], email, password, zaiCaptchaParam)
      zai = { linked: false, needsCode: true }
    } catch (e) {
      const detail = e instanceof ChatWebError ? e.message : 'Z.ai недоступен'
      const code = e instanceof ChatWebError ? e.code : 'zai_unavailable'
      console.error(`[register] z.ai signup start failed for ${email}: ${code} :: ${detail.slice(0, 200)}`)
      zai = { linked: false, code, detail: detail.slice(0, 220) }
    }
  }

  const res = NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name },
    zai,
  })
  res.headers.append('Set-Cookie', sessionCookieHeader(createSessionToken(user.id)))
  return res
}
