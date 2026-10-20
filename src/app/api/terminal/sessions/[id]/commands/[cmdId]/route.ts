import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { sendTelegramText } from '@/lib/telegram'

export const dynamic = 'force-dynamic'

async function loadSession(id: string, userId: string | null) {
  const s = await db.terminalSession.findUnique({ where: { id } })
  if (!s || s.kind !== 'browser') return null
  if (userId && s.userId && s.userId !== userId) return null
  return s
}

/** GET /api/terminal/sessions/[id]/commands/[cmdId] — poll one command */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; cmdId: string }> }) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  const { id, cmdId } = await params
  const s = await loadSession(id, user?.id ?? null)
  if (!s) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const c = await db.terminalCommand.findUnique({ where: { id: cmdId } })
  if (!c || c.sessionId !== id) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({
    command: {
      id: c.id, command: c.command, status: c.status, output: c.output,
      exitCode: c.exitCode, createdAt: c.createdAt.toISOString(),
    },
  })
}

/** POST /api/terminal/sessions/[id]/commands/[cmdId] — page reports the result */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; cmdId: string }> }) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  const { id, cmdId } = await params
  const s = await loadSession(id, user?.id ?? null)
  if (!s) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as {
    status?: string; output?: string; exitCode?: number
  }
  const status = ['running', 'done', 'failed'].includes(String(body.status)) ? String(body.status) : null
  if (!status) return NextResponse.json({ error: 'bad status' }, { status: 400 })

  const cmd = await db.terminalCommand.update({
    where: { id: cmdId },
    data: {
      status,
      output: body.output != null ? String(body.output).slice(0, 20_000) : undefined,
      exitCode: typeof body.exitCode === 'number' ? Math.trunc(body.exitCode) : undefined,
    },
  }).catch(() => null)
  if (!cmd) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // completed agent command -> mirror to the chat and Telegram, like the
  // background Kaggle terminal does
  if ((status === 'done' || status === 'failed') && cmd.conversationId) {
    const exit = cmd.exitCode ?? 0
    const output = (cmd.output || '(пустой вывод)').slice(0, 6000)
    const content = status === 'done'
      ? `Терминал (браузер): $ ${cmd.command.slice(0, 300)}\n\`\`\`\n${output}\n\`\`\`\nexit code: ${exit}`
      : `Терминал (браузер): команда «${cmd.command.slice(0, 120)}» не выполнена: ${output.slice(0, 300)}`
    await db.message.create({
      data: { conversationId: cmd.conversationId, role: 'assistant', kind: 'task_result', content, meta: JSON.stringify({ terminalCommandId: cmd.id }) },
    })
    await db.conversation.update({ where: { id: cmd.conversationId }, data: { updatedAt: new Date() } })
    void sendTelegramText(`🖥 терминал(браузер) ${id.slice(0, 8)}\n$ ${cmd.command.slice(0, 200)}\nexit ${exit}\n\n${output.slice(0, 2500)}`).catch(() => {})
  }

  return NextResponse.json({ ok: true, status: cmd.status })
}
