import { db } from '@/lib/db'
import { syncStudio, prepFrameData } from '@/lib/studio'
import { imageArtifactData, messageToDTO, taskToDTO } from './tools'
import { ghDispatch, ghTerminalSession } from '@/lib/terminal/gh-executor'

/** Prisma Bytes (Uint8Array<ArrayBuffer>) from a Node Buffer */
function toBytes(b: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b) // copy -> fresh ArrayBuffer, satisfies Prisma Bytes
}

const globalForWorker = globalThis as unknown as {
  __agentWorkerStarted?: boolean
  __agentLastVideoSync?: number
  __agentLastTick?: number
  __ghLastDispatch?: number
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
    data: { status: 'running', progress: 'Отправляю на GitHub Actions (Ubuntu)…' },
  })
  try {
    // Headless executor on GitHub Actions (owner rule: Kaggle is video-only).
    const session = await ghTerminalSession()
    const cmd = await db.terminalCommand.create({
      data: {
        sessionId: session.id,
        command: command.slice(0, 20_000),
        conversationId: task.conversationId,
        source: 'agent',
      },
    })
    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: 'running',
        progress: 'Выполняется на GitHub Actions (Ubuntu)…',
        jobIds: JSON.stringify(['cmd:' + cmd.id]),
      },
    })
    void ghDispatch(session.id, cmd.id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: 'failed', error: `очередь команды: ${msg.slice(0, 250)}` },
    })
  }
}

/** keep the resident GitHub executor alive 24/7 (owner request 2026-10-18):
 * the runner shift lasts ~5h40m (GitHub job cap 6h). The claim endpoint
 * doubles as heartbeat; when it goes stale (shift ended or runner died)
 * dispatch a fresh resident run. 10-min dispatch guard avoids spam while
 * GitHub cold-starts. */
async function ghResidentKeepalive() {
  try {
    const session = await db.terminalSession.findFirst({
      where: { kind: 'gh', status: 'active' },
      orderBy: { createdAt: 'desc' },
    })
    if (!session) return
    const staleMs = 12 * 60_000
    if (session.lastSeenAt && Date.now() - session.lastSeenAt.getTime() < staleMs) return
    const st = await db.studioState.findUnique({ where: { key: 'ghKeep' } })
    let dispatchedAt = 0
    try { dispatchedAt = Number(JSON.parse(st?.data || '{}').dispatchedAt) || 0 } catch { /* ignore */ }
    if (Date.now() - dispatchedAt < 10 * 60_000) return
    await db.studioState.upsert({
      where: { key: 'ghKeep' },
      create: { key: 'ghKeep', data: JSON.stringify({ dispatchedAt: Date.now() }) },
      update: { data: JSON.stringify({ dispatchedAt: Date.now() }) },
    })
    void ghDispatch(session.id)
    console.warn('[agent-worker] gh executor heartbeat stale -> resident redispatch')
  } catch { /* non-fatal */ }
}

async function syncTerminalTask(taskId: string) {
  const task = await db.agentTask.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'running') return
  let jobIds: string[] = []
  try { jobIds = JSON.parse(task.jobIds || '[]') as string[] } catch { /* ignore */ }

  // ---- TerminalCommand paths: 'cmd:<id>' (GitHub Actions executor) and
  // bare ids (tasks created while the browser-VM dispatcher was live)
  const first = jobIds[0] || ''
  let cmd = first.startsWith('cmd:')
    ? await db.terminalCommand.findUnique({ where: { id: first.slice(4) } })
    : first
      ? await db.terminalCommand.findUnique({ where: { id: first } })
      : null
  if (cmd) {
    const isGh = cmd.sessionId
      ? (await db.terminalSession.findUnique({ where: { id: cmd.sessionId } }))?.kind === 'gh'
      : false
    if (!first.startsWith('cmd:') && cmd.status === 'pending' && isGh) {
      // bare id + gh session: normalize to the prefixed form for clarity
      await db.agentTask.update({
        where: { id: task.id },
        data: { jobIds: JSON.stringify(['cmd:' + cmd.id]) },
      })
    }
    if (cmd.status === 'pending') {
      if (isGh) {
        // dispatch retry (workflow may have failed to start)
        const now = Date.now()
        if (now - (globalForWorker.__ghLastDispatch || 0) > 90_000) {
          globalForWorker.__ghLastDispatch = now
          void ghDispatch(cmd.sessionId, cmd.id)
        }
      } else {
        // browser VM dispatcher legacy: wait for the tab (owner policy 2026-10-17)
        const progress = 'Жду браузерный терминал (вкладка /terminal должна быть открыта)…'
        if (progress !== task.progress) {
          await db.agentTask.update({ where: { id: task.id }, data: { progress } })
        }
        if (Date.now() - cmd.createdAt.getTime() > 20 * 60_000) {
          await db.agentTask.update({
            where: { id: task.id },
            data: {
              status: 'failed',
              progress: null,
              error: 'браузерный терминал не подключался 20 минут; команда осталась в очереди и выполнится, как только откроют вкладку /terminal',
            },
          })
        }
      }
      return
    }
    if (cmd.status === 'running') {
      if (Date.now() - cmd.updatedAt.getTime() > 30 * 60_000) {
        await db.terminalCommand.update({
          where: { id: cmd.id },
          data: { status: 'failed', output: (cmd.output || '') + '\n[timeout 30 min]' },
        })
        await db.agentTask.update({
          where: { id: task.id },
          data: { status: 'failed', progress: null, error: 'терминал: таймаут 30 минут' },
        })
        await postResultMessage(
          task.conversationId,
          `Терминал (GitHub Actions): команда «${task.title}» не уложилась в 30 минут и снята.`,
          { taskId: task.id },
        )
      }
      return
    }
    // done | failed — the result route already posted the chat message + Telegram
    const output = (cmd.output || '').slice(0, 2000)
    await db.agentTask.update({
      where: { id: task.id },
      data:
        cmd.status === 'done'
          ? {
              status: 'completed',
              progress: null,
              result: JSON.stringify({
                summary: `Команда выполнена (exit ${cmd.exitCode ?? 0})`,
                output,
              }),
            }
          : {
              status: 'failed',
              progress: null,
              error: `терминал: ${(cmd.output || 'ошибка выполнения').slice(0, 250)}`,
            },
    })
    return
  }
  if (jobIds.length === 0) return

  // ---- legacy path: old Kaggle CMD jobs (tasks created before the switch)
  const job = await db.job.findUnique({ where: { id: jobIds[0] } })
  if (!job) return

  if (job.status === 'queued' || job.status === 'generating') {
    const now = Date.now()
    if (now - (globalForWorker.__agentLastVideoSync || 0) > 15_000) {
      globalForWorker.__agentLastVideoSync = now
      await syncStudio()
    }
    return
  }

  if (job.status === 'complete' && job.videoData) {
    let rec: { cmd?: string; exit_code?: number; output?: string } = {}
    try { rec = JSON.parse(Buffer.from(job.videoData).toString('utf8')) } catch { /* raw text */ }
    const output = (rec.output || Buffer.from(job.videoData).toString('utf8') || '(пустой вывод)').slice(0, 6000)
    const exit = typeof rec.exit_code === 'number' ? rec.exit_code : 0
    const content = `Терминал: $ ${rec.cmd || task.title}\n\`\`\`\n${output}\n\`\`\`\nexit code: ${exit}`
    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: 'completed',
        progress: null,
        result: JSON.stringify({ summary: `Команда выполнена (exit ${exit})`, output: output.slice(0, 2000) }),
      },
    })
    await postResultMessage(task.conversationId, content, { taskId: task.id })
    try {
      const { sendTelegramText } = await import('@/lib/telegram')
      await sendTelegramText(`🖥 терминал ${task.conversationId}\n$ ${rec.cmd || command0(task)}\nexit ${exit}\n\n${output.slice(0, 2500)}`)
    } catch { /* non-fatal */ }
    return
  }

  if (job.status === 'failed') {
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: 'failed', error: (job.error || 'воркер не смог выполнить команду').slice(0, 280) },
    })
    await postResultMessage(
      task.conversationId,
      `Терминал: команда «${task.title}» не выполнена: ${(job.error || 'ошибка воркера').slice(0, 200)}`,
      { taskId: task.id },
    )
  }
}

function command0(task: { title: string }): string {
  return task.title.replace(/^\$ /, '')
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

    await ghResidentKeepalive()
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
