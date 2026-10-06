import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, hashPassword, requireAuth } from '@/lib/auth'
import {
  zaiVerifyEmailCode,
  zaiFinishSignup,
  resolveSession,
  ChatWebError,
} from '@/lib/chatweb'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/zai/verify — STEP 2+3 of the REAL Z.ai email registration
 * (byte-verified against chat.z.ai prod-fe-1.1.98).
 *
 * After /auths/signup accepted the captcha and Z.ai emailed a verification
 * code, the user enters that code here. We then run, server-side:
 *   1. POST /auths/verify_email {username,email,token}  (no captcha on Z.ai)
 *   2. POST /auths/finish_signup {username,email,token,password,...}
 *      → the response carries the account JWT (user.token)
 * The JWT is canonicalised via GET /auths/ and stored on the User row —
 * from that moment the user's AI traffic runs on their OWN Z.ai quota.
 *
 * Body: { code, password } — password is the SAME one chosen at signup
 * (Z.ai's finish_signup sets the account password; we keep them in sync).
 */
export async function POST(req: NextRequest) {
  if (!AUTH_REQUIRED)
    return NextResponse.json({ error: 'auth disabled (AUTH_REQUIRED=false)' }, { status: 400 })

  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'нет сессии' }, { status: 401 })

  let code = ''
  let password = ''
  try {
    const body = (await req.json()) as { code?: string; password?: string }
    code = String(body.code || '').trim().slice(0, 32)
    password = String(body.password || '')
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  if (!code) return NextResponse.json({ error: 'Введи код из письма Z.ai' }, { status: 400 })
  if (password.length < 6)
    return NextResponse.json({ error: 'Пароль — минимум 6 символов' }, { status: 400 })

  // the email Z.ai knows is the one the user registered here with
  const row = await db.user.findUnique({ where: { id: user.id }, select: { email: true, name: true } })
  if (!row) return NextResponse.json({ error: 'пользователь не найден' }, { status: 404 })
  const email = row.email

  try {
    // 1) confirm the emailed code
    await zaiVerifyEmailCode(email, row.name || email.split('@')[0], code)
    // 2) finalize the account — JWT comes back in the response
    const session = await zaiFinishSignup(email, row.name || email.split('@')[0], code, password)
    const canonical = await resolveSession(session.token)
    await db.user.update({
      where: { id: user.id },
      data: {
        zaiToken: canonical.token,
        zaiUserId: canonical.userId,
        zaiSessionAt: new Date(),
        // keep local auth in sync with the working Z.ai credentials
        passwordHash: hashPassword(password),
      },
    })
    return NextResponse.json({ zai: { linked: true, email } })
  } catch (e) {
    if (e instanceof ChatWebError) {
      console.error(
        `[zai/verify] failed for ${user.id} (${email}): ${e.code} :: ${e.message.slice(0, 200)}`,
      )
      const status = e.code === 'captcha_failed' ? 400 : 502
      return NextResponse.json(
        { error: e.message, code: e.code, detail: e.message.slice(0, 220) },
        { status },
      )
    }
    return NextResponse.json({ error: 'Z.ai недоступен, попробуй чуть позже' }, { status: 502 })
  }
}
