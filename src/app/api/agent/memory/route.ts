import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { appendMemText, readMemText, writeMemText } from '@/lib/agent/memory'
import crypto from 'node:crypto'

export const dynamic = 'force-dynamic'

/**
 * T52 (owner request 2026-10-23): the SHARED agent memory — one plain-text
 * store that the agent itself fills through <memory>…</memory> and <end>
 * recap tags, the owner can READ and EDIT on the site's memory page, and
 * every future agent context includes automatically (runner task header,
 * incoming-DM tasks, site chat requests).
 *
 * Storage: StudioState key 'agentMemory' (see lib/agent/memory.ts).
 *
 * Auth, two modes:
 * - session (site page): GET -> { text }; PUT { text } -> overwrite;
 * - runner secret (GitHub Actions, SECRET env = GH_TERM_SECRET):
 *   POST { secret }                        -> { text } (runner reads the
 *   memory for its task header);
 *   POST { secret, text, source }          -> APPEND a note (<memory> notes
 *   and <end> recaps), capped to the last ~24k chars.
 */

function secretOk(s: unknown): boolean {
  const expected = process.env.GH_TERM_SECRET || ''
  const given = String(s || '')
  if (!expected || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export async function GET(req: NextRequest) {
  const { unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  return NextResponse.json({ text: await readMemText() })
}

export async function PUT(req: NextRequest) {
  const { unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  const body = (await req.json().catch(() => ({}))) as { text?: string }
  const text = String(body.text || '').slice(0, 60_000)
  await writeMemText(text)
  return NextResponse.json({ ok: true, text })
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    secret?: string
    text?: string
    source?: string
  }
  if (!secretOk(body.secret)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const text = String(body.text || '').trim()
  if (!text) return NextResponse.json({ ok: true, text: await readMemText() })
  const merged = await appendMemText(text, body.source)
  return NextResponse.json({ ok: true, text: merged })
}
