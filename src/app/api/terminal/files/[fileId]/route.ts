import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/terminal/files/[fileId] — download a terminal file.
 * Auth: owner cookie OR ?secret=<session secret> (guest restore).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params
  const secret = new URL(req.url).searchParams.get('secret') || req.headers.get('x-term-secret') || ''

  const file = await db.terminalFile.findUnique({ where: { id: fileId } })
  if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const session = await db.terminalSession.findUnique({ where: { id: file.sessionId } })
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let authorized = secret && secret === session.secret
  if (!authorized) {
    const { user, unauthorized } = await requireAuth(req)
    if (unauthorized) return unauthorized
    authorized = !user || !session.userId || session.userId === user.id
  }
  if (!authorized) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  if (!file.data) {
    // large file: inline copy was skipped — it lives only in the channel
    return NextResponse.json(
      { error: 'file too large for inline storage', hint: 'скачайте из Telegram-канала', size: file.size },
      { status: 409 },
    )
  }

  return new NextResponse(Buffer.from(file.data), {
    headers: {
      'Content-Type': file.mime || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${file.path.split('/').pop() || 'file.bin'}"`,
      'Cache-Control': 'private, max-age=60',
    },
  })
}
