import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, hashPassword, requireAuth } from '@/lib/auth'
import { zaiSignUp, zaiSignIn, resolveSession, ChatWebError } from '@/lib/chatweb'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/link — attach (or re-attach) the user's OWN chat.z.ai
 * account to their site profile. Runs entirely inside the app — no reason
 * for it to ever block logging in or registering.
 *
 * Body: { email?, password, zaiCaptchaParam, mode: 'signup' | 'signin' }
 *  - mode 'signup'  → create a REAL chat.z.ai account with these creds;
 *  - mode 'signin'  → sign in to an EXISTING chat.z.ai account.
 * The Aliyun captcha param is single-use, so the UI shows two explicit
 * buttons (Создать / Войти) — a wrong guess never burns the param twice.
 *
 * On success the fresh JWT is stored on the User row: from now on the
 * user's AI traffic runs on THEIR OWN Z.ai quota (no per-message captcha).
 * If the Z.ai password differs from the local one, the local hash is
 * adopted to keep one password everywhere.
 */
export async function POST(req: NextRequest) {
  if (!AUTH_REQUIRED)
    return NextResponse.json({ error: 'auth disabled (AUTH_REQUIRED=false)' }, { status: 400 })

  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized

  let email = ''
  let password = ''
  let mode = ''
  let zaiCaptchaParam = ''
  try {
    const body = (await req.json()) as {
      email?: string
      password?: string
      mode?: string
      zaiCaptchaParam?: string
    }
    email = String(body.email || '').trim().toLowerCase()
    password = String(body.password || '')
    mode = String(body.mode || '')
    zaiCaptchaParam = String(body.zaiCaptchaParam || '').slice(0, 4096)
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  if (!user) return NextResponse.json({ error: 'нет сессии' }, { status: 401 })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return NextResponse.json({ error: 'Укажи корректный email' }, { status: 400 })
  if (password.length < 6)
    return NextResponse.json({ error: 'Пароль — минимум 6 символов' }, { status: 400 })
  if (!zaiCaptchaParam)
    return NextResponse.json(
      { error: 'Сначала пройди проверку Z.ai (капча в карточке)' },
      { status: 400 },
    )
  if (mode !== 'signup' && mode !== 'signin')
    return NextResponse.json({ error: 'mode должен быть signup или signin' }, { status: 400 })

  try {
    const session =
      mode === 'signup'
        ? await zaiSignUp(email.split('@')[0], email, password, zaiCaptchaParam)
        : await zaiSignIn(email, password, zaiCaptchaParam)
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
        `[link] z.ai ${mode} failed for ${user.email} (${email}): ${e.code} :: ${e.message.slice(0, 200)}`,
      )
      return NextResponse.json(
        { error: e.message, code: e.code, detail: e.message.slice(0, 220) },
        { status: e.code === 'captcha_failed' ? 400 : 502 },
      )
    }
    return NextResponse.json({ error: 'Z.ai недоступен, попробуй чуть позже' }, { status: 502 })
  }
}
