import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { runAgentTurn } from '@/lib/agent/loop'
import { requireAuth } from '@/lib/auth'
import type { AgentEvent } from '@/lib/agent/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 800

/** POST /api/chat — runs one agent turn and streams AgentEvents as SSE */
export async function POST(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized

  let conversationId = ''
  let content = ''
  try {
    const body = (await req.json()) as { conversationId?: string; content?: string }
    conversationId = String(body.conversationId || '')
    content = String(body.content || '').trim()
    if (!content)
      return new Response(JSON.stringify({ error: 'content is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    if (conversationId) {
      const exists = await db.conversation.findUnique({ where: { id: conversationId } })
      // scope: a conversation belongs to its creator
      if (!exists || (user && exists.userId && exists.userId !== user.id)) conversationId = ''
      else if (user && !exists.userId) {
        // adopt legacy/anonymous conversations created before auth
        await db.conversation.update({ where: { id: exists.id }, data: { userId: user.id } })
      }
    }
    if (!conversationId) {
      const conv = await db.conversation.create({ data: { userId: user?.id ?? null } })
      conversationId = conv.id
    }
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const cid = conversationId
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const safeEnqueue = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          closed = true
        }
      }
      const emit = (evt: AgentEvent) => {
        safeEnqueue(`data: ${JSON.stringify(evt)}\n\n`)
      }

      // heartbeat so proxies never idle out mid-turn
      const hb = setInterval(() => safeEnqueue(': hb\n\n'), 15_000)

      try {
        await runAgentTurn(cid, content, emit)
      } catch (e) {
        emit({
          type: 'error',
          message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
        })
        emit({ type: 'done' })
      } finally {
        clearInterval(hb)
        closed = true
        try { controller.close() } catch { /* already closed */ }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Conversation-Id': cid,
    },
  })
}
