import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { messageToDTO, taskToDTO } from '@/lib/agent/tools'

export const dynamic = 'force-dynamic'

// T53: bound the chat-open payload. The old shape pulled EVERY message and
// EVERY task with ALL columns — including AgentTask.imageData (binary PNG,
// served separately via /api/image) and payload/jobIds blobs the DTO never
// exposes — so opening a chat with generated images transferred megabytes
// from Postgres on every click. Now: slim columns only + last-N window.
const MESSAGES_TAKE = 400
const TASKS_TAKE = 200

/** GET /api/conversations/[id] — full chat state (messages + tasks) */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized

  const { id } = await params
  const conv = await db.conversation.findUnique({ where: { id } })
  // strict per-account isolation: a conversation is readable only by its owner
  // (in open/sandbox mode user is null and the gate stays pass-through)
  if (!conv || (user ? !conv.userId || conv.userId !== user.id : false))
    return NextResponse.json({ error: 'conversation not found' }, { status: 404 })

  const [messages, tasks] = await Promise.all([
    db.message
      .findMany({
        where: { conversationId: id },
        orderBy: { createdAt: 'desc' },
        take: MESSAGES_TAKE,
        select: {
          id: true,
          role: true,
          kind: true,
          content: true,
          meta: true,
          createdAt: true,
        },
      })
      .then((rows) => rows.reverse()),
    db.agentTask
      .findMany({
        where: { conversationId: id },
        orderBy: { createdAt: 'desc' },
        take: TASKS_TAKE,
        select: {
          id: true,
          conversationId: true,
          type: true,
          title: true,
          status: true,
          progress: true,
          result: true,
          error: true,
          createdAt: true,
        },
      })
      .then((rows) => rows.reverse()),
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
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized

  const { id } = await params
  await db.conversation.deleteMany({
    where: user ? { id, userId: user.id } : { id },
  })
  return NextResponse.json({ ok: true })
}
