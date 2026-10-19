/**
 * T26: POST /api/tg/variant — the owner approved one of the simulated reply
 * variants; it becomes a few-shot example in the agent config (max 12 kept).
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { parseExamples } from '@/lib/tguser'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const incoming = String(body.incoming || '').trim().slice(0, 1000)
  const reply = String(body.chosen || '').trim().slice(0, 1200)
  const from = String(body.fromName || '').trim().slice(0, 80)
  if (!incoming || !reply)
    return NextResponse.json({ error: 'нужны и входящее сообщение, и выбранный вариант' }, { status: 400 })

  const account = await db.tgAccount.findFirst({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
    include: { config: true },
  })
  if (!account) return NextResponse.json({ error: 'сначала подключи Telegram-аккаунт' }, { status: 400 })

  const examples = parseExamples(account.config?.examples)
  examples.push({ from, incoming, reply, at: new Date().toISOString() })
  const trimmed = examples.slice(-12)
  const config = await db.tgAgentConfig.upsert({
    where: { accountId: account.id },
    update: { examples: JSON.stringify(trimmed) },
    create: { accountId: account.id, systemPrompt: '', examples: JSON.stringify(trimmed) },
  })
  return NextResponse.json({ ok: true, examples: parseExamples(config.examples) })
}
