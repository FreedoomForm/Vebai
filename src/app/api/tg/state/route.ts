/**
 * T26: GET /api/tg/state — everything the /tg page needs for one user:
 * account (sanitized), agent config, recent message log, worker liveness and
 * whether service-level api creds exist (to hide the api_id/api_hash fields).
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { accountView, envApiCreds, parseExamples } from '@/lib/tguser'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const account = await db.tgAccount.findFirst({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
    include: { config: true },
  })
  const messages = account
    ? await db.tgAgentMessage.findMany({
        where: { accountId: account.id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      })
    : []
  let worker = { lastWorkerAt: null as string | null }
  try {
    const row = await db.studioState.findUnique({ where: { key: 'tguser' } })
    if (row) worker = JSON.parse(row.data)
  } catch { /* ignore */ }

  return NextResponse.json({
    account: account ? accountView(account) : null,
    messages: messages.map((m) => ({
      id: m.id,
      chatId: m.chatId,
      chatName: m.chatName,
      direction: m.direction,
      text: m.text,
      at: m.createdAt.toISOString(),
    })),
    worker,
    needApiCreds: !envApiCreds(),
    examplesCount: account ? parseExamples(account.config?.examples).length : 0,
  })
}
