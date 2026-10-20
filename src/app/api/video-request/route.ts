import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { zai } from '@/lib/zai'
import { taskToDTO } from '@/lib/agent/tools'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/video-request — queue the MiniMax H3 video pipeline (Kaggle GPU)
 * for a prompt (the composer's 🎬 toggle).
 *
 * The shot list is structured SERVER-SIDE with the official Z.ai API
 * (one small completion under the site owner's free quota) —
 * "разбей идею на кадры". Fallback: a single shot with the raw prompt,
 * so the request never dies if the API hiccups.
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

  let title = prompt.replace(/\s+/g, ' ').trim().slice(0, 60)
  let shots: { title: string; h3_prompt: string; seconds: 5 | 10 }[] = []
  try {
    const res = await zai.chat.completions({
      messages: [
        {
          role: 'user',
          content:
            `Разбей идею на короткие видеокадры для генеративной модели (MiniMax H3). Идея: «${prompt.slice(0, 900)}».\n` +
            `Если в идее есть длительность (например «1 минута»), подбери кадры так, чтобы СУММА длин была близка к ней: один кадр 5 или 10 секунд, максимум 6 кадров (1 минута = 6 кадров по 10 секунд). Если длительность не указана — 2-3 кадра по 5 секунд.\n` +
            `Ответь ТОЛЬКО JSON без пояснений: {"title": "короткое название видео", "shots": [{"title": "название кадра", "h3_prompt": "eng prompt: subject, motion, camera, lighting", "seconds": 10}]}.\n` +
            `Максимум 6 кадров, каждый 5 или 10 секунд. h3_prompt — на английском, кинематографично, без текста на экране; кадры должны продолжать друг друга (единый сюжет).`,
        },
      ],
      max_tokens: 1536,
    })
    const txt = res.choices?.[0]?.message?.content || ''
    const m = txt.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as {
        title?: string
        shots?: { title?: string; h3_prompt?: string; seconds?: number }[]
      }
      if (parsed.title) title = String(parsed.title).slice(0, 80)
      shots = (parsed.shots || [])
        .filter((s) => s && typeof s.h3_prompt === 'string' && s.h3_prompt.trim())
        .slice(0, 6)
        .map((s) => ({
          title: String(s.title || 'Кадр').slice(0, 120),
          h3_prompt: String(s.h3_prompt).trim().slice(0, 1500),
          seconds: (Number(s.seconds) === 10 ? 10 : 5) as 5 | 10,
        }))
    }
  } catch (e) {
    // structuring is best-effort — a hiccup still allows the single-shot fallback
    console.error(
      `[video-request] shot structuring failed for ${user.email}: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`,
    )
  }
  if (shots.length === 0)
    shots = [{ title: title.slice(0, 120), h3_prompt: prompt.slice(0, 1500), seconds: 5 }]

  const task = await db.agentTask.create({
    data: {
      conversationId,
      type: 'video',
      title: title.slice(0, 140),
      status: 'queued',
      progress: shots.length > 1 ? `В очереди: ${shots.length} кадров` : 'В очереди: 1 кадр',
      payload: JSON.stringify({ title, shots, testMode }),
    },
  })
  await db.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })

  return NextResponse.json({ task: taskToDTO(task) })
}
