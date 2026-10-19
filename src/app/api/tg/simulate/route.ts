/**
 * T26: POST /api/tg/simulate — dry-run: given a sample incoming message the
 * AI generates 3 reply variants per the current rules; the owner then approves
 * one (/api/tg/variant) — nothing is sent to Telegram here.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { simulateVariants, parseExamples } from '@/lib/tguser'

export const runtime = 'nodejs'
export const maxDuration = 45

export async function POST(req: Request) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const text = String(body.text || '').trim()
  const fromName = String(body.fromName || '').trim().slice(0, 80)
  if (text.length < 1) return NextResponse.json({ error: 'введи пробное входящее сообщение' }, { status: 400 })
  if (text.length > 1000) return NextResponse.json({ error: 'сообщение слишком длинное (макс 1000)' }, { status: 400 })

  const account = await db.tgAccount.findFirst({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
    include: { config: true },
  })
  if (!account) return NextResponse.json({ error: 'сначала подключи Telegram-аккаунт' }, { status: 400 })

  try {
    const variants = await simulateVariants(
      account.config?.systemPrompt || '',
      parseExamples(account.config?.examples),
      fromName, text,
    )
    return NextResponse.json({ ok: true, variants })
  } catch (e) {
    return NextResponse.json({ error: `тест не удался: ${e instanceof Error ? e.message.slice(0, 200) : 'ошибка'}` }, { status: 502 })
  }
}
