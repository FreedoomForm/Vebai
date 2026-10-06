import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { messageToDTO, taskToDTO } from '@/lib/agent/tools'

export const dynamic = 'force-dynamic'

/** GET /api/conversations/[id] — full chat state (messages + tasks) */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const conv = await db.conversation.findUnique({ where: { id } })
  if (!conv)
    return NextResponse.json({ error: 'conversation not found' }, { status: 404 })

  const [messages, tasks] = await Promise.all([
    db.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' } }),
    db.agentTask.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' } }),
  ])

  return NextResponse.json({
    conversation: {
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
    },
    messages: messages.map(messageToDTO),
    tasks: tasks.map(taskToDTO),
  })
}

/** DELETE /api/conversations/[id] */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  await db.conversation.deleteMany({ where: { id } })
  return NextResponse.json({ ok: true })
}
