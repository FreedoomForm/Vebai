/**
 * T26: POST /api/tg/sent — the worker confirms a reply was ACTUALLY delivered
 * via the user's account; only then the outgoing message enters the log.
 */
import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

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
  if (!accountId || !chatId || !text.trim()) return NextResponse.json({ ok: false })
  await db.tgAgentMessage.create({
    data: { accountId, chatId, chatName, msgId: msgId || `out-${Date.now()}`, direction: 'out', text },
  }).catch(() => {})
  return NextResponse.json({ ok: true })
}
