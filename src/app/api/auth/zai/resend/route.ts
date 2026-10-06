import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, requireAuth } from '@/lib/auth'
import { zaiResendCode, ChatWebError } from '@/lib/chatweb'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/zai/resend — re-send the Z.ai signup verification email
 * (Z.ai contract: POST /auths/resend_email {name,email,sso_redirect} —
 * no captcha; works while the signup is in "pending" state).
 */
export async function POST(req: NextRequest) {
  if (!AUTH_REQUIRED)
    return NextResponse.json({ error: 'auth disabled (AUTH_REQUIRED=false)' }, { status: 400 })

  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'нет сессии' }, { status: 401 })

  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { email: true, name: true },
  })
  if (!row) return NextResponse.json({ error: 'пользователь не найден' }, { status: 404 })

  try {
    await zaiResendCode(row.name || row.email.split('@')[0], row.email)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof ChatWebError) {
      console.error(`[zai/resend] failed for ${row.email}: ${e.code} :: ${e.message.slice(0, 200)}`)
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.code === 'captcha_failed' ? 400 : 502 },
      )
    }
    return NextResponse.json({ error: 'Z.ai недоступен, попробуй чуть позже' }, { status: 502 })
  }
}
