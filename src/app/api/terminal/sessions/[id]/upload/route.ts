import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { uploadToTelegram } from '@/lib/telegram'
import { parseTarGz } from '@/lib/terminal/tar'

export const dynamic = 'force-dynamic'

/** keep small files in Postgres so restore works without Telegram */
const INLINE_LIMIT = 3_500_000

/**
 * POST /api/terminal/sessions/[id]/upload
 * Guest daemon posts a tar.gz of changed workspace files (raw body).
 * Auth: X-Term-Secret header must match the session secret.
 * Every file is mirrored to the owner's Telegram channel (caption carries
 * the terminal id), files <=3.5MB are also kept inline for quick restore.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const secret = req.headers.get('x-term-secret') || new URL(req.url).searchParams.get('secret') || ''
  const session = await db.terminalSession.findUnique({ where: { id } })
  if (!session || !secret || secret !== session.secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = Buffer.from(await req.arrayBuffer())
  if (body.length === 0) return NextResponse.json({ error: 'empty body' }, { status: 400 })
  if (body.length > 48 * 1024 * 1024) return NextResponse.json({ error: 'too large' }, { status: 413 })

  let entries
  try {
    entries = parseTarGz(body)
  } catch {
    return NextResponse.json({ error: 'bad tar' }, { status: 400 })
  }
  if (entries.length === 0) return NextResponse.json({ saved: 0 })

  let saved = 0
  const tgFiles: { name: string; data: Buffer; mime?: string }[] = []
  for (const e of entries.slice(0, 40)) {
    if (e.size === 0 || e.size > 40 * 1024 * 1024) continue
    if (!/^[\w./-]+$/.test(e.path)) continue // path safety
    await db.terminalFile.upsert({
      where: { sessionId_path: { sessionId: id, path: e.path } },
      create: {
        sessionId: id,
        path: e.path,
        size: e.size,
        mime: e.path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        data: e.size <= INLINE_LIMIT ? new Uint8Array(e.data) : null,
        tgOk: true,
      },
      update: {
        size: e.size,
        data: e.size <= INLINE_LIMIT ? new Uint8Array(e.data) : null,
        tgOk: true,
        updatedAt: new Date(),
      },
    })
    tgFiles.push({ name: e.path.split('/').pop() || 'file.bin', data: e.data })
    saved++
  }

  if (tgFiles.length > 0) {
    void uploadToTelegram(
      tgFiles,
      `🗂 терминал ${id.slice(0, 8)} (browser VM) • ${new Date().toISOString().slice(11, 19)} UTC`,
    ).catch(() => 0)
  }

  return NextResponse.json({ saved, files: entries.map((e) => e.path).slice(0, 40) })
}
