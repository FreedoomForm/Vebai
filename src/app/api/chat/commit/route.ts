import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { messageToDTO } from '@/lib/agent/tools'

export const dynamic = 'force-dynamic'

/**
 * POST /api/chat/commit — persist the assistant's answer after the browser
 * streamed it directly from chat.z.ai (v10 browser-direct).
 *
 * Body: { conversationId, content, tools?: [{name, summary}] }
 * -> { message }
 */
export async function POST(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'нет сессии' }, { status: 401 })

  let conversationId = ''
  let content = ''
  let tools: { name: string; summary?: string }[] = []
  try {
    const body = (await req.json()) as {
      conversationId?: string
      content?: string
      tools?: { name?: string; summary?: string }[]
    }
    conversationId = String(body.conversationId || '')
    content = String(body.content || '').slice(0, 120_000)
    tools = Array.isArray(body.tools)
      ? body.tools
          .filter((t) => t && typeof t.name === 'string')
          .slice(0, 12)
          .map((t) => ({ name: String(t.name).slice(0, 60), summary: String(t.summary || '').slice(0, 200) }))
      : []
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!conversationId || !content.trim())
    return NextResponse.json({ error: 'conversationId and content are required' }, { status: 400 })

  // scope: the conversation must belong to the user
  const conv = await db.conversation.findUnique({ where: { id: conversationId } })
  if (!conv || (conv.userId && conv.userId !== user.id))
    return NextResponse.json({ error: 'нет такого диалога' }, { status: 404 })

  const meta = tools.length
    ? { tools: tools.map((t) => ({ name: t.name, args: {}, status: 'ok' as const, summary: t.summary || '' })) }
    : {}
  const m = await db.message.create({
    data: {
      conversationId,
      role: 'assistant',
      kind: 'text',
      content: content.trim(),
      meta: JSON.stringify(meta),
    },
  })
  await db.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
  return NextResponse.json({ message: messageToDTO(m) })
}
