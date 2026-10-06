import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, createSessionToken, hashPassword, sessionCookieHeader } from '@/lib/auth'
import { zaiSignUp, resolveSession, ChatWebError } from '@/lib/chatweb'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/register — create the site account INSTANTLY (v4).
 *
 * The local account is created first and the user is let in immediately —
 * registration can no longer be blocked by anything Z.ai-side (the old
 * hard captcha gate produced "green but rejected" dead ends).
 *
 * If the browser also relayed a solved Z.ai auth-scene captcha param, we
 * TRY to create the user's REAL chat.z.ai account in the same breath:
 *  - success → their own JWT is stored; their traffic consumes their own
 *    Z.ai quota (no per-message captcha);
 *  - failure → the account still exists and works (guest-relay chat), and
 *    the exact upstream reason is returned so the user can retry linking
 *    later from the in-app card.
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

  // 2) best-effort: create the user's OWN chat.z.ai account behind the
  //    relayed captcha param. Never blocks registration.
  let zai: { linked: boolean; code?: string; detail?: string } = { linked: false }
  if (zaiCaptchaParam) {
    try {
      const session = await zaiSignUp(name || email.split('@')[0], email, password, zaiCaptchaParam)
      const canonical = await resolveSession(session.token)
      await db.user.update({
        where: { id: user.id },
        data: {
          zaiToken: canonical.token,
          zaiUserId: canonical.userId,
          zaiSessionAt: new Date(),
        },
      })
      zai = { linked: true }
    } catch (e) {
      const detail = e instanceof ChatWebError ? e.message : 'Z.ai недоступен'
      const code = e instanceof ChatWebError ? e.code : 'zai_unavailable'
      console.error(`[register] z.ai link failed for ${email}: ${code} :: ${detail.slice(0, 200)}`)
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
