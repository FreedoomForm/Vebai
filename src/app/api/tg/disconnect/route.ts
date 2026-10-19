/**
 * T26: POST /api/tg/disconnect — removes the user's Telegram account row
 * (cascades to config + message log; the stored encrypted session dies with it).
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const account = await db.tgAccount.findFirst({ where: { userId: user.id } })
  if (!account) return NextResponse.json({ ok: true })
  await db.tgAccount.delete({ where: { id: account.id } })
  return NextResponse.json({ ok: true })
}
