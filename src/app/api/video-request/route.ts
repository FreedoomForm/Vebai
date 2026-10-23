import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { createVideoTask } from '@/lib/agent/video'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/video-request — queue the Wan 2.1 1.3B video pipeline (Kaggle GPU,
 * 2x T4) for a prompt.
 *
 * T49: the composer's 🎬 toggle is gone (owner request: "удали кнопки … video
 * web search из поле ввода") — the CHAT MODEL now queues videos itself with
 * ```video-request``` blocks (see src/lib/agent/video.ts, the shared
 * implementation). This endpoint remains as the legacy/API entry.
 *
 * Body: { conversationId, prompt, testMode? }
 * -> { task }
 */
export async function POST(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'нет сессии' }, { status: 401 })

  let conversationId = ''
  let prompt = ''
  let testMode = false
  try {
    const body = (await req.json()) as { conversationId?: string; prompt?: string; testMode?: boolean }
    conversationId = String(body.conversationId || '')
    prompt = String(body.prompt || '').trim()
    testMode = Boolean(body.testMode)
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!prompt)
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 })

  // scope
  const conv = await db.conversation.findUnique({ where: { id: conversationId } })
  if (!conv || (conv.userId && conv.userId !== user.id))
    return NextResponse.json({ error: 'нет такого диалога' }, { status: 404 })

  try {
    const { task } = await createVideoTask(conversationId, prompt, testMode)
    return NextResponse.json({ task })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.slice(0, 200) : 'не удалось поставить видео в очередь' },
      { status: 500 },
    )
  }
}
