/**
 * T26: POST /api/tg/work — worker endpoint (resident GitHub Actions shift,
 * .github/tg_userbot.js). Auth: GH_TERM_SECRET (never a cookie).
 * Returns the active connected accounts with their decrypted MTProto sessions
 * so the worker can listen for incoming private messages; touches lastCheckAt
 * (liveness shown on the page) and records the worker heartbeat in StudioState.
 */
import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { decryptSecret, parseExamples } from '@/lib/tguser'

export const runtime = 'nodejs'
export const maxDuration = 60

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

  const accounts = await db.tgAccount.findMany({
    where: { status: 'connected', active: true },
    include: { config: true },
  })
  const out: Record<string, unknown>[] = []
  for (const a of accounts) {
    try {
      const session = decryptSecret(a.sessionEnc)
      const apiHash = decryptSecret(a.apiHashEnc)
      let me: { firstName?: string; username?: string } = {}
      try { me = JSON.parse(a.meInfo || '{}') } catch { /* ignore */ }
      out.push({
        id: a.id,
        session,
        apiId: a.apiId,
        apiHash,
        me,
        systemPrompt: a.config?.systemPrompt || '',
        examples: parseExamples(a.config?.examples),
      })
      await db.tgAccount.update({ where: { id: a.id }, data: { lastCheckAt: new Date() } })
    } catch {
      // decryption failed (rotated secret?) — surface honestly, skip the account
      await db.tgAccount.update({
        where: { id: a.id },
        data: { status: 'error', statusText: 'не удалось расшифровать сессию — переподключи аккаунт', active: false },
      }).catch(() => {})
    }
  }
  const heartbeat = JSON.stringify({ lastWorkerAt: new Date().toISOString() })
  await db.studioState.upsert({
    where: { key: 'tguser' },
    update: { data: heartbeat, updatedAt: new Date() },
    create: { key: 'tguser', data: heartbeat },
  }).catch(() => {})
  return NextResponse.json({ accounts: out, now: new Date().toISOString() })
}
