import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** GET /api/terminal/sessions — list the user's browser terminal sessions */
export async function GET(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized

  const sessions = await db.terminalSession.findMany({
    where: { kind: 'browser', status: 'active', userId: user ? user.id : undefined },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    include: {
      _count: { select: { commands: true, files: true } },
    },
  })

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      commands: s._count.commands,
      files: s._count.files,
    })),
  })
}

/** POST /api/terminal/sessions — create a new browser terminal session */
export async function POST(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized

  let title = ''
  try {
    const body = (await req.json()) as { title?: string }
    title = String(body.title || '').slice(0, 80)
  } catch { /* empty body ok */ }

  const session = await db.terminalSession.create({
    data: {
      userId: user?.id ?? null,
      kind: 'browser',
      title: title || `Терминал ${new Date().toLocaleDateString('ru-RU')}`,
      secret: randomBytes(16).toString('hex'),
    },
  })

  return NextResponse.json({
    session: {
      id: session.id,
      title: session.title,
      secret: session.secret,
      createdAt: session.createdAt.toISOString(),
    },
  })
}
