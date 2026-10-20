/**
 * T42b: POST /api/tg/resend — re-deliver the login code for a PENDING
 * account. Since the in-chat connect flow is retired (Telegram revokes login
 * codes sent as chat messages), the site page is the only place the code is
 * entered — so the «новый код» re-delivery that used to live in the bot FSM
 * moves here. Uses auth.ResendCode on the SAME login session + phoneCodeHash
 * (it does NOT burn a new sendCode and does not kill the previous request).
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { mtprotoResendCode, humanTgError, getOwnedAccount, markCodeRequested } from '@/lib/tguser'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(req: Request) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const account = await getOwnedAccount(user.id, String(body.accountId || ''))
  if (!account) return NextResponse.json({ error: 'аккаунт не найден' }, { status: 404 })
  if (!account.phoneCodeHash || !account.loginSessionEnc)
    return NextResponse.json({ error: 'нет активного запроса кода — отправь номер заново' }, { status: 400 })

  try {
    const res = await mtprotoResendCode({
      apiId: account.apiId,
      apiHashEnc: account.apiHashEnc,
      loginSessionEnc: account.loginSessionEnc,
      phone: account.phone,
      phoneCodeHash: account.phoneCodeHash,
    })
    await db.tgAccount.update({
      where: { id: account.id },
      data: {
        phoneCodeHash: res.phoneCodeHash,
        statusText: res.viaApp ? 'код отправлен повторно в Telegram-приложение' : 'код отправлен повторно SMS',
      },
    })
    await markCodeRequested(user.id, account.phone)
    return NextResponse.json({ ok: true, viaApp: res.viaApp })
  } catch (e) {
    return NextResponse.json({ error: humanTgError(e) }, { status: 400 })
  }
}
