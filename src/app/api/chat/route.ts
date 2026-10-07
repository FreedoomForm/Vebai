import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { runAgentTurn } from '@/lib/agent/loop'
import { requireAuth } from '@/lib/auth'
import { getUserZaiSession } from '@/lib/zai-session'
import type { AgentEvent } from '@/lib/agent/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // hobby-plan cap; SSE heartbeat keeps proxies from idling

/** Whitelisted upstream models (the composer's model selector maps here).
 * Anything else silently falls back to the server default — no client-side
 * model id can switch us onto an unvetted/level-gated upstream model. */
const MODEL_WHITELIST = new Set(['x-preview-l', 'glm-5.2', 'glm-4.7'])
const EFFORTS = new Set(['high', 'max'])

/** POST /api/chat — runs one agent turn and streams AgentEvents as SSE.
 * Body: { conversationId?, content, captchaVerifyParam?, resume?, model?, webSearch?, effort? }
 * - captchaVerifyParam: one-time param from Z.ai's own widget (relay —
 *   the user solved it in the browser); rarely needed — real accounts
 *   chat without the per-message captcha.
 * - resume: captcha retry — the user message is already persisted.
 * - model/webSearch/effort: the composer's selector state (z.ai-style UI).
 *
 * Guest mode is REMOVED: without a linked Z.ai account the stream emits a
 * typed `error` (code `zai_not_linked`) and NOTHING is persisted — the UI
 * opens the "Подключить аккаунт Z.ai" card. */
export async function POST(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized

  let conversationId = ''
  let content = ''
  let captchaVerifyParam = ''
  let resume = false
  let model = ''
  let webSearch = false
  let effort: 'high' | 'max' = 'max'
  try {
    const body = (await req.json()) as {
      conversationId?: string
      content?: string
      captchaVerifyParam?: string
      resume?: boolean
      model?: string
      webSearch?: boolean
      effort?: string
    }
    conversationId = String(body.conversationId || '')
    content = String(body.content || '').trim()
    captchaVerifyParam = String(body.captchaVerifyParam || '').slice(0, 4096)
    resume = Boolean(body.resume)
    model = MODEL_WHITELIST.has(String(body.model || '')) ? String(body.model) : ''
    webSearch = Boolean(body.webSearch)
    effort = EFFORTS.has(String(body.effort || '')) ? (String(body.effort) as 'high' | 'max') : 'max'
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
        // adopt legacy conversations created before auth
        await db.conversation.update({ where: { id: exists.id }, data: { userId: user.id } })
      }
    }
    if (!conversationId && resume)
      return new Response(JSON.stringify({ error: 'conversation required for resume' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // per-user REAL chat.z.ai account session (JWT stored on the User row).
  // Resolved BEFORE any conversation/user-message is persisted, so a user
  // without a linked account never leaves empty rows behind.
  let zaiSessionToken: string | null = null
  let sessionError: { message: string; code: string } | null = null
  try {
    const s = await getUserZaiSession(user?.id ?? null)
    zaiSessionToken = s.token
  } catch (e) {
    zaiSessionToken = null
    sessionError = {
      message: e instanceof Error ? e.message.slice(0, 300) : 'сессия Z.ai недоступна',
      code: (e as { code?: string }).code || 'zai_session_error',
    }
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
        if (sessionError) {
          // nothing persisted, nothing created — the UI opens the link card
          emit({ type: 'error', message: sessionError.message, code: sessionError.code })
          emit({ type: 'done' })
          return
        }
        // new conversation: created only for users with a live Z.ai session
        if (!conversationId) {
          const conv = await db.conversation.create({ data: { userId: user?.id ?? null } })
          conversationId = conv.id
        }
        const cid = conversationId
        await runAgentTurn(cid, content, emit, {
          zaiSessionToken,
          captchaVerifyParam: captchaVerifyParam || undefined,
          skipUserMessage: resume,
          model: model || undefined,
          webSearch,
          effort,
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
      ...(conversationId ? { 'X-Conversation-Id': conversationId } : {}),
    },
  })
}
