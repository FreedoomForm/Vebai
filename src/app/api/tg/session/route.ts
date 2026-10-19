/**
 * T33: POST /api/tg/session — "Telegram app on the agent's computer"
 * (.github/tg.js) bootstrap endpoint. The resident GitHub Actions executor
 * job IS the agent's computer; on first use of its `tg` app it needs the
 * owner's connected MTProto session. Auth: GH_TERM_SECRET (same worker
 * boundary as /api/tg/work — the secret already buys full session access
 * there). Returns the FIRST connected+active account (or the requested
 * accountId) with the DECRYPTED session + apiId/apiHash + public "me" info.
 * No message content ever flows through here; failures are honest JSON.
 */
import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/tguser'

export const runtime = 'nodejs'
export const maxDuration = 30

function secretOk(s: unknown): boolean {
  const expected = process.env.GH_TERM_SECRET || ''
  const given = String(s || '')
  if (!expected || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  if (!secretOk(body.secret)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const accountId = typeof body.accountId === 'string' ? body.accountId : ''
  const acc = accountId
    ? await db.tgAccount.findFirst({ where: { id: accountId, status: 'connected', active: true } })
    : await db.tgAccount.findFirst({
        where: { status: 'connected', active: true },
        orderBy: { updatedAt: 'desc' },
      })
  if (!acc) {
    return NextResponse.json({
      ok: false,
      error: 'нет подключённого Telegram-аккаунта — владелец должен подключить его на /tgagent',
    })
  }
  let session: string
  let apiHash: string
  try {
    session = decryptSecret(acc.sessionEnc)
    apiHash = decryptSecret(acc.apiHashEnc)
  } catch {
    await db.tgAccount
      .update({
        where: { id: acc.id },
        data: {
          status: 'error',
          statusText: 'не удалось расшифровать сессию — переподключи аккаунт',
          active: false,
        },
      })
      .catch(() => {})
    return NextResponse.json({
      ok: false,
      error: 'не удалось расшифровать сессию аккаунта — аккаунт помечен ошибочным, нужно переподключить на /tgagent',
    })
  }
  let me: Record<string, unknown> = {}
  try { me = JSON.parse(acc.meInfo || '{}') } catch { /* ignore */ }
  return NextResponse.json({
    ok: true,
    account: { id: acc.id, session, apiId: acc.apiId, apiHash, me },
  })
}
