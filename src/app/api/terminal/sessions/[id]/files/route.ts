import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/terminal/sessions/[id]/files — file manifest of the session.
 * Guest calls with ?secret=...&format=tsv (id<TAB>path lines for busybox sh).
 * Owner UI calls with the cookie and gets rich JSON.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret') || req.headers.get('x-term-secret') || ''

  const session = await db.terminalSession.findUnique({ where: { id } })
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let authorized = secret && secret === session.secret
  if (!authorized) {
    const { user, unauthorized } = await requireAuth(req)
    if (unauthorized) return unauthorized
    authorized = !user || !session.userId || session.userId === user.id
  }
  if (!authorized) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const files = await db.terminalFile.findMany({
    where: { sessionId: id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  if (url.searchParams.get('format') === 'tsv') {
    const tsv = files.map((f) => `${f.id}\t${f.path}`).join('\n') + '\n'
    return new NextResponse(tsv, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  return NextResponse.json({
    files: files.map((f) => ({
      id: f.id, path: f.path, size: f.size, tgOk: f.tgOk,
      createdAt: f.createdAt.toISOString(),
      url: `/api/terminal/files/${f.id}`,
    })),
  })
}
