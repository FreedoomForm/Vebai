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

/* NOTE: image tasks were removed (CogView became a paid API — owner request).
 * The background worker only handles video tasks now. */

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
  // ATOMIC CLAIM: two ticks can run concurrently (browser-driven + GitHub
  // heartbeat). Both used to pass the queued check and create duplicate Jobs
  // (2x GPU spend). updateMany ... WHERE status='queued' lets exactly one
  // tick win; the loser sees count=0 and exits.
  const claim = await db.agentTask.updateMany({
    where: { id: taskId, status: 'queued' },
    data: { status: 'running' },
  })
  if (claim.count !== 1) return
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
          data: { status: 'queued', progress: 'Жду первый кадр от генерации изображений…' },
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

  let payload: { shots?: ShotSpec[]; testMode?: boolean; mergeJobId?: string } = {}
  try { payload = JSON.parse(task.payload || '{}') } catch { /* ignore */ }

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

  // ---- auto-merge phase: stitch all shots into ONE file on the worker (ffmpeg)
  if (freshDone.length === fresh.length && fresh.length > 1) {
    if (!payload.mergeJobId) {
      const totalSec = Math.min(freshDone.reduce((s, j) => s + (j.seconds || 0), 0), 120)
      const orderedIds = freshDone
        .sort((a, b) => jobIds.indexOf(a.id) - jobIds.indexOf(b.id))
        .map((j) => j.id)
        .join(',')
      const merge = await db.job.create({
        data: {
          prompt: `MERGE:${orderedIds}`,
          seconds: totalSec,
          testMode: payload.testMode === true,
          status: 'queued',
        },
      })
      await db.agentTask.update({
        where: { id: task.id },
        data: {
          payload: JSON.stringify({ ...payload, mergeJobId: merge.id }),
          progress: 'Склеиваю кадры в один файл (ffmpeg на Linux-воркере)…',
        },
      })
      globalForWorker.__agentLastVideoSync = 0
      return
    }
    const mergeJob = await db.job.findUnique({ where: { id: payload.mergeJobId } })
    if (mergeJob && mergeJob.status === 'queued') {
      // merge job waiting for the next syncStudio batch push
      const now2 = Date.now()
      if (now2 - (globalForWorker.__agentLastVideoSync || 0) > 15_000) {
        globalForWorker.__agentLastVideoSync = now2
        await syncStudio()
      }
      return
    }
    if (mergeJob && (mergeJob.status === 'generating')) {
      const progress = 'Склейка кадров на Linux-воркере (ffmpeg)…'
      if (progress !== task.progress) {
        await db.agentTask.update({ where: { id: task.id }, data: { progress } })
      }
      const now3 = Date.now()
      if (now3 - (globalForWorker.__agentLastVideoSync || 0) > 15_000) {
        globalForWorker.__agentLastVideoSync = now3
        await syncStudio()
      }
      return
    }
    if (mergeJob && mergeJob.status === 'complete' && mergeJob.videoData) {
      const mergedArtifacts = [
        { kind: 'video' as const, url: `/api/video/${mergeJob.id}`, title: `Итоговое видео (${fresh.length} кадр(ов) склеено)` },
        ...artifacts.map((a, i) => ({ ...a, title: `Кадр ${i + 1}` })),
      ]
      await db.agentTask.update({
        where: { id: task.id },
        data: {
          status: 'completed',
          progress: null,
          result: JSON.stringify({ artifacts: mergedArtifacts, summary: `Видео готово: ${fresh.length} кадр(ов) склеены в один файл` }),
        },
      })
      await postResultMessage(
        task.conversationId,
        `Видео «${task.title}» готово — ${fresh.length} кадр(ов) сгенерированы и автоматически склеены в один файл (сверху). Ниже — отдельные кадры.`,
        { artifacts: mergedArtifacts, taskId: task.id },
      )
      await mirrorVideoTask(task, mergeJob, freshDone)
      return
    }
    // merge failed -> fall back to clips-only completion
  }

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
    await mirrorVideoTask(task, null, freshDone)
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

/* -------------------------------------------------------------- telegram */

/** mirror a finished video task: merged file + individual clips -> channel */
async function mirrorVideoTask(
  task: { id: string; conversationId: string; title: string },
  merged: { id: string; videoData: Uint8Array<ArrayBuffer> | null } | null,
  clips: { id: string; videoData: Uint8Array<ArrayBuffer> | null; seconds: number }[],
): Promise<void> {
  try {
    const { uploadToTelegram } = await import('@/lib/telegram')
    const files: { name: string; data: Buffer; mime?: string }[] = []
    if (merged?.videoData) {
      files.push({ name: `vebai-${task.id}-merged.mp4`, data: Buffer.from(merged.videoData), mime: 'video/mp4' })
    }
    clips.forEach((c, i) => {
      if (c.videoData) files.push({ name: `vebai-${task.id}-shot${String(i + 1).padStart(2, '0')}.mp4`, data: Buffer.from(c.videoData), mime: 'video/mp4' })
    })
    const n = await uploadToTelegram(files, `🎬 «${task.title}» | vebai task ${task.id} | терминал/чат ${task.conversationId}`)
    if (n > 0) console.log(`[telegram] mirrored ${n} file(s) for task ${task.id}`)
  } catch (e) {
    console.error('[telegram] video mirror failed:', e instanceof Error ? e.message : e)
  }
}

/* ------------------------------------------------------------ terminal tasks */

interface TerminalPayload {
  command?: string
  terminalId?: string
  timeoutS?: number
  testMode?: boolean
}

/** owner policy (2026-10-17): Kaggle is VIDEO-ONLY. Terminal commands never
 * go to the Kaggle worker — they are queued as TerminalCommand for the
 * user's browser VM (Alpine v86 at /terminal), which polls the queue every
 * ~3s, executes on the serial console and posts the output back to the chat
 * (see /api/terminal/sessions/[id]/commands/[cmdId] POST). */
async function startTerminalTask(taskId: string) {
  const task = await db.agentTask.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'queued') return
  // ATOMIC CLAIM (same race as video tasks — see startVideoTask)
  const claim = await db.agentTask.updateMany({
    where: { id: taskId, status: 'queued' },
    data: { status: 'running' },
  })
  if (claim.count !== 1) return
  let payload: TerminalPayload = {}
  try { payload = JSON.parse(task.payload || '{}') } catch { /* ignore */ }
  const command = String(payload.command || '').trim()
  if (!command) {
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: 'failed', error: 'терминал: пустая команда' },
    })
    return
  }
  await db.agentTask.update({
    where: { id: task.id },
    data: { status: 'running', progress: 'Команда в очереди браузерного терминала…' },
  })
  try {
    // session resolution: explicit session id -> latest active browser
    // session of the conversation owner -> create a fresh one
    const conv = await db.conversation.findUnique({ where: { id: task.conversationId } })
    let session = payload.terminalId
      ? await db.terminalSession.findFirst({ where: { id: payload.terminalId, kind: 'browser' } })
      : null
    if (!session) {
      session = await db.terminalSession.findFirst({
        where: { kind: 'browser', status: 'active', userId: conv?.userId ?? undefined },
        orderBy: { updatedAt: 'desc' },
      })
    }
    if (!session) {
      session = await db.terminalSession.create({
        data: {
          kind: 'browser', userId: conv?.userId ?? null,
          title: 'Терминал агента', secret: crypto.randomUUID().replace(/-/g, ''),
        },
      })
    }
    const cmd = await db.terminalCommand.create({
      data: { sessionId: session.id, conversationId: task.conversationId, command, source: 'agent' },
    })
    await db.terminalSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } })
    await db.agentTask.update({
      where: { id: task.id },
      data: { jobIds: JSON.stringify([cmd.id]) },
    })
    const stale = !session.lastSeenAt || Date.now() - session.lastSeenAt.getTime() > 90_000
    if (stale) {
      const { sendTelegramText } = await import('@/lib/telegram')
      void sendTelegramText(
        `🧠 Агенту нужен твой компьютер: команда ждёт в очереди браузерного терминала.\nОткрой вкладку «Терминал»: ${process.env.NEXT_PUBLIC_SITE_URL || 'https://vebai-six.vercel.app'}/terminal\n$ ${command.slice(0, 200)}`,
      ).catch(() => {})
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: 'failed', error: `очередь команды: ${msg.slice(0, 250)}` },
    })
  }
}

/** give the browser VM a fair chance to connect before giving up on the card */
const TERMINAL_CMD_TIMEOUT_MS = 20 * 60_000

async function syncTerminalTask(taskId: string) {
  const task = await db.agentTask.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'running') return
  let ids: string[] = []
  try { ids = JSON.parse(task.jobIds || '[]') as string[] } catch { /* ignore */ }
  if (ids.length === 0) return
  const cmd = await db.terminalCommand.findUnique({ where: { id: ids[0] } })
  if (!cmd) return

  if (cmd.status === 'pending') {
    if (Date.now() - cmd.createdAt.getTime() > TERMINAL_CMD_TIMEOUT_MS) {
      await db.agentTask.update({
        where: { id: task.id },
        data: {
          status: 'failed',
          progress: null,
          error: 'браузерный терминал не подключался 20 минут; команда осталась в очереди и выполнится, как только откроют вкладку /terminal',
        },
      })
    } else {
      const progress = 'Жду браузерный терминал (вкладка /terminal должна быть открыта)…'
      if (progress !== task.progress) {
        await db.agentTask.update({ where: { id: task.id }, data: { progress } })
      }
    }
    return
  }

  if (cmd.status === 'running') {
    const progress = 'Выполняется в браузерной VM (Alpine v86)…'
    if (progress !== task.progress) {
      await db.agentTask.update({ where: { id: task.id }, data: { progress } })
    }
    return
  }

  // done | failed — the chat + Telegram message is posted by the
  // /api/terminal/sessions/[id]/commands/[cmdId] route; here we only mirror
  // the terminal state onto the AgentTask card
  const exit = cmd.exitCode ?? 0
  const output = (cmd.output || '(пустой вывод)').slice(0, 2000)
  await db.agentTask.update({
    where: { id: task.id },
    data: cmd.status === 'done'
      ? {
          status: 'completed',
          progress: null,
          result: JSON.stringify({ summary: `Команда выполнена в браузерном терминале (exit ${exit})`, output }),
        }
      : {
          status: 'failed',
          progress: null,
          error: `команда не выполнена (exit ${exit}): ${output.slice(0, 240)}`,
        },
  })
}

/* -------------------------------------------------------------- main worker */

async function tick() {
  try {
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

    const termQueued = await db.agentTask.findFirst({
      where: { type: 'terminal', status: 'queued' },
      orderBy: { createdAt: 'asc' },
    })
    if (termQueued) await startTerminalTask(termQueued.id)

    const termRunning = await db.agentTask.findMany({
      where: { type: 'terminal', status: 'running' },
      orderBy: { createdAt: 'asc' },
    })
    for (const t of termRunning) await syncTerminalTask(t.id)
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
