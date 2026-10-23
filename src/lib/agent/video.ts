import { db } from '@/lib/db'
import { zai } from '@/lib/zai'
import { taskToDTO } from '@/lib/agent/tools'

/**
 * T49 (owner request 2026-10-23): the video pipeline is no longer behind a
 * composer toggle — the CHAT MODEL queues it itself with a
 * ```video-request``` fenced block, so video creation works BY DEFAULT
 * (the toggle buttons were removed from the input field).
 *
 * Shared by:
 *  - POST /api/video-request (legacy entry, still works)
 *  - POST /api/chat/stream  (launchVideoBlocks — the model's own decision)
 */

export interface VideoTaskResult {
  task: ReturnType<typeof taskToDTO>
  shots: number
  title: string
}

/**
 * Structure the prompt into Wan 2.1 shots server-side (one small completion
 * under the site owner's free quota — "разбей идею на кадры") and queue the
 * Kaggle video task. Fallback: a single shot with the raw prompt, so the
 * request never dies if the API hiccups.
 */
export async function createVideoTask(
  conversationId: string,
  prompt: string,
  testMode = false,
): Promise<VideoTaskResult> {
  let title = prompt.replace(/\s+/g, ' ').trim().slice(0, 60)
  let shots: { title: string; video_prompt?: string; h3_prompt?: string; seconds: 5 | 10 }[] = []
  try {
    const res = await zai.chat.completions({
      messages: [
        {
          role: 'user',
          content:
            `Разбей идею на короткие видеокадры для генеративной модели (Wan 2.1 1.3B — тихое видео без звука, 480p). Идея: «${prompt.slice(0, 900)}».\n` +
            `Если в идее есть длительность (например «1 минута»), подбери кадры так, чтобы СУММА длин была близка к ней: один кадр 5 или 10 секунд, максимум 6 кадров (1 минута = 6 кадров по 10 секунд). Если длительность не указана — 2-3 кадра по 5 секунд.\n` +
            `Ответь ТОЛЬКО JSON без пояснений: {"title": "короткое название видео", "shots": [{"title": "название кадра", "video_prompt": "eng prompt: subject, motion, camera, lighting", "seconds": 10}]}.\n` +
            `Максимум 6 кадров, каждый 5 или 10 секунд. video_prompt — на английском, кинематографично (Wan любит детальные описания SUBJECT и ДВИЖЕНИЯ: действия, физика движения, движение камеры; звук НЕ описывать — модель генерирует видео без звуковой дорожки), без текста на экране; кадры должны продолжать друг друга (единый сюжет).`,
        },
      ],
      max_tokens: 1536,
    })
    const txt = res.choices?.[0]?.message?.content || ''
    const m = txt.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as {
        title?: string
        shots?: { title?: string; video_prompt?: string; h3_prompt?: string; seconds?: number }[]
      }
      if (parsed.title) title = String(parsed.title).slice(0, 80)
      shots = (parsed.shots || [])
        .map((s) => ({ ...s, text: String(s.video_prompt ?? s.h3_prompt ?? '') }))
        .filter((s) => s && typeof s.text === 'string' && s.text.trim())
        .slice(0, 6)
        .map((s) => ({
          title: String(s.title || 'Кадр').slice(0, 120),
          video_prompt: s.text.trim().slice(0, 1500),
          seconds: (Number(s.seconds) === 10 ? 10 : 5) as 5 | 10,
        }))
    }
  } catch (e) {
    // structuring is best-effort — a hiccup still allows the single-shot fallback
    console.error(
      `[video-request] shot structuring failed: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`,
    )
  }
  if (shots.length === 0)
    shots = [{ title: title.slice(0, 120), video_prompt: prompt.slice(0, 1500), seconds: 5 }]

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

  return { task: taskToDTO(task), shots: shots.length, title }
}
