import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { db } from '@/lib/db'
import {
  AUTH_REQUIRED,
  createSessionToken,
  getSessionUser,
  hashPassword,
  sessionCookieHeader,
} from '@/lib/auth'
import { extractZaiTokenFromPaste, resolveSession, ChatWebError } from '@/lib/chatweb'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/google/claim — the Google-bridge completion (v5).
 *
 * Z.ai's own Google login can only hand its session token back to their own
 * whitelisted domains (byte-verified: redirect_uri is fixed to
 * chat.z.ai/oauth/google/callback, the OAuth state is single-use and
 * server-side, and their client-side sso_redirect whitelist accepts only
 * zread.ai / test.cgx.dev / z.ai / www.chatglm.site). So the token can NOT
 * be auto-forwarded to us — but it IS visible in the user's address bar
 * (chat.z.ai/auth#token=…) after they log in with Google on chat.z.ai.
 *
 * The user pastes that address (or just the token) here. We:
 *   1. extract the JWT,
 *   2. validate it LIVE against Z.ai (GET /auths/ → fresh session, real
 *      account email/role; guests are rejected),
 *   3. mode 'login'  (default, from the auth screen): sign the matching
 *      local user in — creating the local account on the fly when the
 *      email is new (Google-style signup: no password needed),
 *      and store the fresh JWT → their own Z.ai quota,
 *      mode 'link' (from the in-app card): attach it to the CURRENT user.
 */
export async function POST(req: NextRequest) {
  if (!AUTH_REQUIRED)
    return NextResponse.json({ error: 'auth disabled (AUTH_REQUIRED=false)' }, { status: 400 })

  let raw = ''
  let mode = 'login'
  try {
    const body = (await req.json()) as { raw?: string; mode?: string }
    raw = String(body.raw || '').slice(0, 8192)
    mode = String(body.mode || 'login') === 'link' ? 'link' : 'login'
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const token = extractZaiTokenFromPaste(raw)
  if (!token)
    return NextResponse.json(
      {
        error:
          'Не нашёл токен во вставленном тексте. Скопируй АДРЕС из строки браузера после входа через Google (он начинается с chat.z.ai/auth#token=…) и вставь целиком.',
      },
      { status: 400 },
    )

  // live validation on Z.ai — proves the JWT works and who owns it
  let session
  try {
    session = await resolveSession(token)
  } catch (e) {
    if (e instanceof ChatWebError) {
      // a dead real token comes back from Z.ai as a silent guest downgrade
      const msg =
        e.code === 'zai_session_expired' || e.code === 'invalid_token'
          ? 'Этот токен уже недействителен (сессия истекла). Войди через Google на chat.z.ai заново и вставь свежий адрес.'
          : e.message
      return NextResponse.json({ error: msg, code: e.code }, { status: 400 })
    }
    return NextResponse.json({ error: 'Z.ai недоступен, попробуй чуть позже' }, { status: 502 })
  }

  if (!session.email || /guest/i.test(session.email) || session.role === 'guest') {
    return NextResponse.json(
      { error: 'Это гостевой токен chat.z.ai — войди через Google, а не гостем.' },
      { status: 400 },
    )
  }

  const zaiEmail = session.email.toLowerCase()

  if (mode === 'link') {
    const { user } = { user: await getSessionUser(req) }
    if (!user) return NextResponse.json({ error: 'нет сессии' }, { status: 401 })
    await db.user.update({
      where: { id: user.id },
      data: {
        zaiToken: session.token,
        zaiUserId: session.userId,
        zaiSessionAt: new Date(),
      },
    })
    return NextResponse.json({ ok: true, mode, zaiEmail, linked: true })
  }

  // login mode: the claimed Z.ai identity IS the local identity
  let local = await db.user.findUnique({ where: { email: zaiEmail } })
  let created = false
  if (!local) {
    local = await db.user.create({
      data: {
        email: zaiEmail,
        // random password: the user logs in via the Google bridge; a local
        // password can be set later from the profile/link card
        passwordHash: hashPassword(crypto.randomUUID()),
        name: session.name || zaiEmail.split('@')[0],
      },
    })
    created = true
  } else if (local.name === '' && session.name) {
    await db.user.update({ where: { id: local.id }, data: { name: session.name } })
  }

  await db.user.update({
    where: { id: local.id },
    data: {
      zaiToken: session.token,
      zaiUserId: session.userId,
      zaiSessionAt: new Date(),
    },
  })

  const res = NextResponse.json({
    ok: true,
    mode,
    zaiEmail,
    created,
    user: { id: local.id, email: local.email, name: session.name || local.name },
  })
  res.headers.append('Set-Cookie', sessionCookieHeader(createSessionToken(local.id)))
  return res
}
