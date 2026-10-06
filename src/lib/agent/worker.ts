import { zai } from '@/lib/zai'
import { db } from '@/lib/db'
import { syncStudio, prepFrameData } from '@/lib/studio'
import { imageArtifactData, messageToDTO, taskToDTO } from './tools'

/** Prisma Bytes (Uint8Array<ArrayBuffer>) from a Node Buffer */
function toBytes(b: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b) // copy -> fresh ArrayBuffer, satisfies Prisma Bytes
}

const globalForWorker = globalThis as unknown as {
  __agentWorkerStarted?: boolean
  __agentLastVideoSync?: number
  __agentLastTick?: number
}

async function postResultMessage(
  conversationId: string,
  content: string,
  meta: {
    artifacts?: { kind: 'image' | 'video'; url: string; title?: string }[]
    taskId?: string
  },
) {
  const m = await db.message.create({
    data: {
      conversationId,
      role: 'assistant',
      kind: 'task_result',
      content,
      meta: JSON.stringify(meta),
    },
  })
  await db.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  })
  return messageToDTO(m)
}

/* -------------------------------------------------------------- image tasks */

async function runImageTask(taskId: string) {
  const task = await db.agentTask.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'queued') return
  let payload: { prompt?: string; size?: string; title?: string } = {}
  try { payload = JSON.parse(task.payload || '{}') } catch { /* ignore */ }
  const prompt = payload.prompt || task.title
  const SIZES = ['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440'] as const
  type ImgSize = (typeof SIZES)[number]
  const size: ImgSize = (SIZES as readonly string[]).includes(payload.size || '')
    ? (payload.size as ImgSize)
    : '1344x768'

  await db.agentTask.update({
    where: { id: task.id },
    data: { status: 'running', progress: 'Генерация изображения…' },
  })

  try {
    const res = await zai.images.generations.create({ prompt, size })
    const b64 = res?.data?.[0]?.base64
    if (!b64) throw new Error('пустой ответ генератора изображений')
    const png = Buffer.from(b64, 'base64')

    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: 'completed',
        progress: null,
        imageData: toBytes(png),
        result: JSON.stringify({
          artifacts: [{ kind: 'image', url: `/api/image/${task.id}`, title: task.title }],
          summary: 'Изображение готово',
        }),
      },
    })
    await postResultMessage(
      task.conversationId,
      `Изображение «${task.title}» готово — можно смотреть выше. Если нужно что-то поправить (стиль, ракурс, детали) — скажи, сгенерирую новый вариант.`,
      {
        artifacts: [{ kind: 'image', url: `/api/image/${task.id}`, title: task.title }],
        taskId: task.id,
      },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: 'failed', error: msg.slice(0, 400) },
    })
    await postResultMessage(
      task.conversationId,
      `Не получилось сгенерировать изображение «${task.title}»: ${msg.slice(0, 200)}. Могу повторить попытку — просто скажи.`,
      { taskId: task.id },
    )
  }
}

/* -------------------------------------------------------------- video tasks */

interface ShotSpec {
  title: string
  h3_prompt: string
  seconds: number
  first_frame_task_id: string | null
}

async function startVideoTask(taskId: string) {
  const task = await db.agentTask.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'queued') return
  let payload: { shots?: ShotSpec[]; testMode?: boolean } = {}
  try { payload = JSON.parse(task.payload || '{}') } catch { /* ignore */ }
  const shots = payload.shots || []
  if (shots.length === 0) {
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: 'failed', error: 'нет кадров в payload' },
    })
    return
  }

  // wait for linked first-frame image tasks to finish
  for (const shot of shots) {
    if (shot.first_frame_task_id) {
      const img = await db.agentTask.findUnique({ where: { id: shot.first_frame_task_id } })
      if (img && (img.status === 'queued' || img.status === 'running')) {
        await db.agentTask.update({
          where: { id: task.id },
          data: { progress: 'Жду первый кадр от генерации изображений…' },
        })
        return // retry on the next tick
      }
    }
  }

  await db.agentTask.update({
    where: { id: task.id },
    data: { status: 'running', progress: 'Готовлю пакет для Kaggle…' },
  })

  const jobIds: string[] = []
  try {
    for (const shot of shots) {
      let frameOrig: Buffer | null = null
      if (shot.first_frame_task_id) {
        frameOrig = await imageArtifactData(shot.first_frame_task_id)
      }
      const prepped = await prepFrameData(frameOrig)
      const job = await db.job.create({
        data: {
          prompt: shot.h3_prompt,
          seconds: shot.seconds,
          frameOrigData: frameOrig ? toBytes(frameOrig) : null,
          framePrepped: toBytes(prepped),
          testMode: payload.testMode === true,
        },
      })
      jobIds.push(job.id)
    }
    await db.agentTask.update({
      where: { id: task.id },
      data: { jobIds: JSON.stringify(jobIds) },
    })
    globalForWorker.__agentLastVideoSync = 0 // force a syncStudio push next tick
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: 'failed', error: `создание задач Kaggle: ${msg.slice(0, 300)}` },
    })
    await postResultMessage(
      task.conversationId,
      `Видео «${task.title}» не удалось поставить в очередь Kaggle: ${msg.slice(0, 200)}`,
      { taskId: task.id },
    )
  }
}

async function syncVideoTask(taskId: string) {
  const task = await db.agentTask.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'running') return
  let jobIds: string[] = []
  try { jobIds = JSON.parse(task.jobIds || '[]') as string[] } catch { /* ignore */ }
  if (jobIds.length === 0) return

  const jobs = await db.job.findMany({ where: { id: { in: jobIds } } })
  const done = jobs.filter((j) => j.status === 'complete')
  const failed = jobs.filter((j) => j.status === 'failed')
  const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'generating')

  // push/poll Kaggle at most every ~15s while this task is in flight
  const now = Date.now()
  if (pending.length > 0 && now - (globalForWorker.__agentLastVideoSync || 0) > 15_000) {
    globalForWorker.__agentLastVideoSync = now
    await syncStudio()
  }

  const fresh = await db.job.findMany({ where: { id: { in: jobIds } } })
  const freshDone = fresh.filter((j) => j.status === 'complete')
  const freshFailed = fresh.filter((j) => j.status === 'failed')
  const freshPending = fresh.filter((j) => j.status === 'queued' || j.status === 'generating')

  if (freshPending.length > 0) {
    const gen = freshPending.filter((j) => j.status === 'generating').length
    const progress = gen > 0
      ? `Генерация: ${freshDone.length}/${fresh.length} готово, ${gen} в работе`
      : `В очереди Kaggle: ${freshDone.length}/${fresh.length} готово`
    if (progress !== task.progress) {
      await db.agentTask.update({ where: { id: task.id }, data: { progress } })
    }
    return
  }

  // every shot reached a terminal state
  const artifacts = freshDone
    .sort((a, b) => jobIds.indexOf(a.id) - jobIds.indexOf(b.id))
    .map((j) => ({ kind: 'video' as const, url: `/api/video/${j.id}`, title: `Кадр: ${j.prompt.slice(0, 60)}` }))

  if (freshDone.length === fresh.length) {
    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: 'completed',
        progress: null,
        result: JSON.stringify({ artifacts, summary: 'Видео готово' }),
      },
    })
    await postResultMessage(
      task.conversationId,
      `Видео «${task.title}» готово — все ${fresh.length} кадр(ов) сгенерированы и уже в чате. Скажи, если нужно перегенерировать какой-то кадр или собрать следующую серию.`,
      { artifacts, taskId: task.id },
    )
  } else if (freshDone.length > 0) {
    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: 'completed',
        progress: null,
        result: JSON.stringify({
          artifacts,
          summary: `${freshDone.length}/${fresh.length} кадров готовы, ${freshFailed.length} с ошибкой`,
        }),
      },
    })
    const err = freshFailed[0]?.error?.slice(0, 200) || 'причина неизвестна'
    await postResultMessage(
      task.conversationId,
      `Часть видео «${task.title}» готова: ${freshDone.length}/${fresh.length} кадров доставлено, ${freshFailed.length} не удалось (${err}). Готовые кадры выше — могу перегенерировать неудачные.`,
      { artifacts, taskId: task.id },
    )
  } else {
    const err = freshFailed[0]?.error?.slice(0, 250) || 'воркер Kaggle не смог сгенерировать кадры'
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: 'failed', progress: null, error: err },
    })
    await postResultMessage(
      task.conversationId,
      `Видео «${task.title}» не получилось: ${err}. Скажи — повторю попытку или перепишу промпты.`,
      { taskId: task.id },
    )
  }
}

/* -------------------------------------------------------------- main worker */

async function tick() {
  try {
    const img = await db.agentTask.findFirst({
      where: { type: 'image', status: 'queued' },
      orderBy: { createdAt: 'asc' },
    })
    if (img) await runImageTask(img.id)

    const vidQueued = await db.agentTask.findFirst({
      where: { type: 'video', status: 'queued' },
      orderBy: { createdAt: 'asc' },
    })
    if (vidQueued) await startVideoTask(vidQueued.id)

    const vidRunning = await db.agentTask.findMany({
      where: { type: 'video', status: 'running' },
      orderBy: { createdAt: 'asc' },
    })
    for (const t of vidRunning) await syncVideoTask(t.id)
  } catch (e) {
    console.error('[agent-worker] tick error:', e instanceof Error ? e.message : e)
  }
}

/** idempotent tick: called by the local setInterval loop OR by the Vercel cron
 * route /api/agent/tick (and opportunistically after UI state polls) */
export async function agentTick(): Promise<void> {
  // debounce overlapping ticks from concurrent triggers (>=2.5s apart)
  const now = Date.now()
  if (now - (globalForWorker.__agentLastTick || 0) < 2_500) return
  globalForWorker.__agentLastTick = now
  await tick()
}

/** local/self-hosted mode only: on Vercel the worker is driven by
 * /api/agent/tick (cron) and opportunistic ticks from state polls */
export function startAgentWorker() {
  if (process.env.VERCEL) return // serverless: cron + on-request ticks instead
  if (globalForWorker.__agentWorkerStarted) return
  globalForWorker.__agentWorkerStarted = true
  console.log('[agent-worker] started — the architect is on duty 24/7')
  setInterval(() => {
    void agentTick()
  }, 3_000)
}

export { taskToDTO }
