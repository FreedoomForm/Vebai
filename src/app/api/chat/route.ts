import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { runAgentTurn } from '@/lib/agent/loop'
import { requireAuth } from '@/lib/auth'
import { getUserZaiSession } from '@/lib/zai-session'
import type { AgentEvent } from '@/lib/agent/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // hobby-plan cap; SSE heartbeat keeps proxies from idling

/** POST /api/chat — runs one agent turn and streams AgentEvents as SSE.
 * Body: { conversationId?, content, captchaVerifyParam?, resume? }
 * - captchaVerifyParam: one-time param from Z.ai's own widget (relay —
 *   the user solved it in the browser); needed on every completions.
 * - resume: captcha retry — the user message is already persisted. */
export async function POST(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized

  let conversationId = ''
  let content = ''
  let captchaVerifyParam = ''
  let resume = false
  try {
    const body = (await req.json()) as {
      conversationId?: string
      content?: string
      captchaVerifyParam?: string
      resume?: boolean
    }
    conversationId = String(body.conversationId || '')
    content = String(body.content || '').trim()
    captchaVerifyParam = String(body.captchaVerifyParam || '').slice(0, 4096)
    resume = Boolean(body.resume)
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
      // on a captcha retry the conversation must exist already
      if (resume)
        return new Response(JSON.stringify({ error: 'conversation required for resume' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
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

  // per-user anonymous chat.z.ai session (minted on first use, stored on the
  // User row; the user never handles any token)
  let zaiSessionToken: string | null = null
  try {
    zaiSessionToken = (await getUserZaiSession(user?.id ?? null)).token
  } catch {
    zaiSessionToken = null // fall back to chatWeb's own guest flow
  }

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
        await runAgentTurn(cid, content, emit, {
          zaiSessionToken,
          captchaVerifyParam: captchaVerifyParam || undefined,
          skipUserMessage: resume,
        })
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
