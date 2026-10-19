/**
 * T26: POST /api/tg/connect — step 1 of the my.telegram.org-style login.
 * Body: { phone, apiId?, apiHash? } (api creds optional when the service has
 * TELEGRAM_API_ID/TELEGRAM_API_HASH in env). Sends the Telegram login code to
 * the phone via MTProto and stores the transient login state encrypted.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import {
  gramjs, clientOpts, tgErrorText,
  encryptSecret, parseApiCreds, normalizePhone, envApiCreds,
} from '@/lib/tguser'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(req: Request) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const phoneRes = normalizePhone(body.phone)
  if ('error' in phoneRes) return NextResponse.json({ error: phoneRes.error }, { status: 400 })
  const phone = phoneRes.phone
  const creds = parseApiCreds(body)
  if ('error' in creds) return NextResponse.json({ error: creds.error }, { status: 400 })

  const { TelegramClient, StringSession } = await gramjs()
  const client = new TelegramClient(new StringSession(''), creds.apiId, creds.apiHash, clientOpts())
  try {
    await client.connect()
    const sent = await client.sendCode({ apiId: creds.apiId, apiHash: creds.apiHash }, phone)
    const loginSession = (client.session.save() as unknown as string) || ''
    const existing = await db.tgAccount.findFirst({ where: { userId: user.id, phone } })
    const data = {
      apiId: creds.apiId,
      apiHashEnc: encryptSecret(creds.apiHash),
      phoneCodeHash: sent.phoneCodeHash,
      loginSessionEnc: encryptSecret(loginSession),
      status: 'pending',
      statusText: sent.isCodeViaApp
        ? 'код отправлен в Telegram-приложение на этот номер'
        : 'код отправлен SMS на этот номер',
      meInfo: null,
      sessionEnc: null,
      updatedAt: new Date(),
    }
    const account = existing
      ? await db.tgAccount.update({ where: { id: existing.id }, data })
      : await db.tgAccount.create({ data: { userId: user.id, phone, ...data } })
    return NextResponse.json({
      ok: true,
      accountId: account.id,
      viaApp: !!sent.isCodeViaApp,
      usingEnvCreds: !!envApiCreds(),
    })
  } catch (e) {
    return NextResponse.json({ error: tgErrorText(e) }, { status: 400 })
  } finally {
    try { await client.disconnect() } catch { /* already gone */ }
  }
}
