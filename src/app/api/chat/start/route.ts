import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { messageToDTO } from '@/lib/agent/tools'
import { isGuestToken } from '@/lib/zai-direct'
import type { PlainMessage } from '@/lib/zai-direct'

export const dynamic = 'force-dynamic'

const HISTORY_LIMIT = 40

/**
 * POST /api/chat/start — persist the user's turn and hand the transcript to
 * the browser, which then talks to chat.z.ai DIRECTLY (v10 browser-direct).
 *
 * The server stays out of the AI path: no proxying, no captcha relay, no
 * 300s cap. Its job: account policy (guest mode removed — a linked REAL
 * Z.ai account is required), conversation/message persistence, history.
 *
 * Body: { conversationId?, content }
 * -> { conversationId, userMessage, history: [{role, content}...] }
 * Errors: 400 zai_not_linked | zai_session_expired (typed, UI opens the link card)
 */
export async function POST(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'нет сессии' }, { status: 401 })

  let conversationId = ''
  let content = ''
  try {
    const body = (await req.json()) as { conversationId?: string; content?: string }
    conversationId = String(body.conversationId || '')
    content = String(body.content || '').trim()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!content)
    return NextResponse.json({ error: 'content is required' }, { status: 400 })

  // ---- policy: guest mode removed — a real linked Z.ai account required
  const dbUser = await db.user.findUnique({
    where: { id: user.id },
    select: { zaiToken: true },
  })
  if (!dbUser?.zaiToken || isGuestToken(dbUser.zaiToken))
    return NextResponse.json(
      {
        error:
          'Гостевой режим отключён: сообщения идут только с подключённого аккаунта Z.ai. Нажми «Z.ai» внизу слева и подключи свой аккаунт — это твоя личная квота, без капчи в чате.',
        code: 'zai_not_linked',
      },
      { status: 400 },
    )

  // ---- scope + adopt legacy conversations
  if (conversationId) {
    const exists = await db.conversation.findUnique({ where: { id: conversationId } })
    if (!exists || (exists.userId && exists.userId !== user.id)) conversationId = ''
    else if (!exists.userId)
      await db.conversation.update({ where: { id: exists.id }, data: { userId: user.id } })
  }

  // ---- persist the user message (transaction-ish: create conv if needed)
  let convId = conversationId
  if (!convId) {
    const conv = await db.conversation.create({ data: { userId: user.id } })
    convId = conv.id
  }
  const userMsg = await db.message.create({
    data: { conversationId: convId, role: 'user', kind: 'text', content },
  })

  // ---- auto-title from the first user message
  let titleEmitted: string | null = null
  const conv = await db.conversation.findUnique({ where: { id: convId } })
  if (conv && conv.title === 'Новый диалог') {
    titleEmitted = content.replace(/\s+/g, ' ').trim().slice(0, 48) || 'Новый диалог'
    await db.conversation.update({ where: { id: convId }, data: { title: titleEmitted } })
  }
  await db.conversation.update({ where: { id: convId }, data: { updatedAt: new Date() } })

  // ---- transcript for the browser (recent, non-empty)
  const history = await db.message.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: 'asc' },
  })
  const trimmed = history.slice(-HISTORY_LIMIT)
  const plain: PlainMessage[] = []
  for (const m of trimmed) {
    const c = (m.content || '').trim()
    if (!c) continue
    if (m.role === 'user' || m.role === 'assistant')
      plain.push({ role: m.role, content: c })
  }

  return NextResponse.json({
    conversationId: convId,
    userMessage: messageToDTO(userMsg),
    ...(titleEmitted ? { title: titleEmitted } : {}),
    history: plain,
  })
}
