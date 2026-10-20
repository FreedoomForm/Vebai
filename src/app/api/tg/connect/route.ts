/**
 * T26/T27: POST /api/tg/connect — step 1 of the my.telegram.org-style login.
 * Body: { phone, apiId?, apiHash? } (api creds optional when the service has
 * TELEGRAM_API_ID/TELEGRAM_API_HASH in env). Sends the Telegram login code to
 * the phone via MTProto and stores the transient login state encrypted.
 * Bare 9-digit numbers get +998 prepended (Uzbekistan default).
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { mtprotoSendCode, normalizePhone, encryptSecret, humanTgError, markCodeRequested, freshCodeRequest } from '@/lib/tguser'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(req: Request) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { phone?: unknown; apiId?: unknown; apiHash?: unknown }
  const phoneRes = normalizePhone(body.phone)
  if ('error' in phoneRes) return NextResponse.json({ error: phoneRes.error }, { status: 400 })
  const phone = phoneRes.phone

  try {
    // T42: a newer sendCode KILLS every previous login code for the phone —
    // while the previous request is fresh, do not fire a second one (the bot
    // FSM shares the same marker, so site and bot never invalidate each other)
    const fresh = await freshCodeRequest(user.id, phone)
    if (fresh !== null)
      return NextResponse.json(
        {
          error: `код уже отправлен ${fresh} сек назад и ещё действует — введи его. Каждый новый запрос убивает предыдущий код; не пришёл — повтори запрос через пару минут`,
          fresh: true,
        },
        { status: 400 },
      )
    const res = await mtprotoSendCode(phone, body)
    const existing = await db.tgAccount.findFirst({ where: { userId: user.id, phone } })
    const data = {
      apiId: res.apiId,
      apiHashEnc: res.apiHashEnc,
      phoneCodeHash: res.phoneCodeHash,
      loginSessionEnc: encryptSecret(res.loginSession),
      status: 'pending',
      statusText: res.viaApp
        ? 'код отправлен в Telegram-приложение на этот номер'
        : 'код отправлен SMS на этот номер',
      meInfo: null,
      sessionEnc: null,
      active: false, // a re-login of an old account must not leave it active
      updatedAt: new Date(),
    }
    const account = existing
      ? await db.tgAccount.update({ where: { id: existing.id }, data })
      : await db.tgAccount.create({ data: { userId: user.id, phone, ...data } })
    await markCodeRequested(user.id, phone)
    return NextResponse.json({
      ok: true,
      accountId: account.id,
      viaApp: res.viaApp,
      usingEnvCreds: res.usingEnvCreds,
    })
  } catch (e) {
    return NextResponse.json({ error: humanTgError(e) }, { status: 400 })
  }
}
