import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

async function loadSession(id: string, userId: string | null) {
  const s = await db.terminalSession.findUnique({ where: { id } })
  if (!s || s.kind !== 'browser') return null
  if (userId && s.userId && s.userId !== userId) return null
  return s
}

/** GET /api/terminal/sessions/[id]/commands — page polls its work queue */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  const { id } = await params
  const s = await loadSession(id, user?.id ?? null)
  if (!s) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const url = new URL(req.url)
  const status = url.searchParams.get('status') || 'pending'
  const limit = Math.min(Number(url.searchParams.get('limit') || 5), 20)
  const commands = await db.terminalCommand.findMany({
    where: { sessionId: id, status: status === 'all' ? undefined : status },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
  return NextResponse.json({
    commands: commands.map((c) => ({
      id: c.id, command: c.command, status: c.status, source: c.source,
      output: c.output, exitCode: c.exitCode, conversationId: null,
      createdAt: c.createdAt.toISOString(),
    })),
  })
}

/** POST /api/terminal/sessions/[id]/commands — enqueue a command for the VM */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  const { id } = await params
  const s = await loadSession(id, user?.id ?? null)
  if (!s) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as {
    command?: string; source?: string; conversationId?: string; timeoutS?: number
  }
  const command = String(body.command || '').trim()
  if (!command) return NextResponse.json({ error: 'empty command' }, { status: 400 })
  if (command.length > 4000) return NextResponse.json({ error: 'command too long' }, { status: 400 })

  const cmd = await db.terminalCommand.create({
    data: {
      sessionId: id,
      command,
      source: body.source === 'user' ? 'user' : 'agent',
    },
  })
  return NextResponse.json({ command: { id: cmd.id, status: cmd.status } })
}
