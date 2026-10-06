import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { messageToDTO, taskToDTO } from '@/lib/agent/tools'
import { agentTick } from '@/lib/agent/worker'

export const dynamic = 'force-dynamic'

/** GET /api/agent/state?conversationId=... — compact state for the UI poller.
 * Also opportunistically drives the background worker: with no always-on
 * process on Vercel, every open client doubles as a heartbeat. */
export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get('conversationId') || ''

  const [activeTasks, queued, running] = await Promise.all([
    db.agentTask.count({ where: { status: { in: ['queued', 'running'] } } }),
    db.agentTask.count({ where: { status: 'queued' } }),
    db.agentTask.count({ where: { status: 'running' } }),
  ])
  const worker = { activeTasks, queued, running }

  // fire-and-forget tick when there is work (serverless waitUntil keeps it
  // alive after the response; the local mode debounces it to a no-op)
  if (activeTasks > 0) {
    const { waitUntil } = await import('@vercel/functions').catch(() => ({
      waitUntil: (p: Promise<unknown>) => { void p },
    }))
    waitUntil(agentTick().catch(() => {}))
  }

  if (!conversationId) return NextResponse.json({ worker })

  const [conv, messages, tasks] = await Promise.all([
    db.conversation.findUnique({ where: { id: conversationId } }),
    db.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }),
    db.agentTask.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }),
  ])
  if (!conv) return NextResponse.json({ worker, missing: true })

  return NextResponse.json({
    worker,
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
