/**
 * T26: POST /api/tg/incoming — the worker reports a fresh incoming private
 * message on a user's account; the site dedupes, logs it and returns the AI
 * reply text (or an honest skip reason). The actual sending happens in the
 * worker, and only then /api/tg/sent logs the outgoing message (T21 rule:
 * the log reflects reality, not intentions).
 */
import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agentReply, parseExamples } from '@/lib/tguser'

export const runtime = 'nodejs'
export const maxDuration = 45

const RATE_PER_HOUR = 30

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

  const accountId = String(body.accountId || '')
  const chatId = String(body.chatId || '')
  const msgId = String(body.msgId || '')
  const chatName = String(body.chatName || '').slice(0, 120) || null
  const text = String(body.text || '').slice(0, 2000)
  if (!accountId || !chatId || !msgId || !text.trim())
    return NextResponse.json({ skip: 'bad-request' })

  const account = await db.tgAccount.findUnique({ where: { id: accountId }, include: { config: true } })
  if (!account || account.status !== 'connected' || !account.active)
    return NextResponse.json({ skip: 'inactive' })

  // dedupe (worker restarts / Telegram replays must not double-reply)
  const dup = await db.tgAgentMessage.findUnique({
    where: { accountId_chatId_msgId_direction: { accountId, chatId, msgId, direction: 'in' } },
  }).catch(() => null)
  if (dup) return NextResponse.json({ skip: 'dup' })
  await db.tgAgentMessage.create({
    data: { accountId, chatId, chatName, msgId, direction: 'in', text },
  }).catch(() => {})

  // server-side hourly cap (belt & suspenders on top of the worker limiter)
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const sentCount = await db.tgAgentMessage.count({
    where: { accountId, direction: 'out', createdAt: { gt: hourAgo } },
  })
  if (sentCount >= RATE_PER_HOUR) return NextResponse.json({ skip: 'rate' })

  let me: { firstName?: string; username?: string } = {}
  try { me = JSON.parse(account.meInfo || '{}') } catch { /* ignore */ }
  try {
    const reply = await agentReply(
      me,
      account.config?.systemPrompt || '',
      parseExamples(account.config?.examples),
      chatName || '',
      text,
    )
    if (!reply) return NextResponse.json({ skip: 'empty-reply' })
    return NextResponse.json({ reply })
  } catch (e) {
    return NextResponse.json({ skip: 'ai-error', error: e instanceof Error ? e.message.slice(0, 200) : 'ошибка ИИ' })
  }
}
