import AdmZip from 'adm-zip'
import { db } from '@/lib/db'
import {
  JOBS_DATASET,
  KERNEL,
  OUTPUTS_DATASET,
  WORKER_KERNEL,
  WORKER_TEST_KERNEL,
  datasetDownloadZip,
  datasetLatestFileTime,
  datasetPush,
  downloadOutputFile,
  kernelOutputFiles,
  kernelPush,
  kernelStatus,
  waitForDatasetReady,
  type DatasetFileInput,
} from '@/lib/kaggle'
import {
  KERNEL_RMC_STUDIO_REAL,
  KERNEL_RMC_STUDIO_TEST,
  KERNEL_RMC_STUDIO_WORKER_REAL,
  KERNEL_RMC_STUDIO_WORKER_TEST,
} from '@/lib/kernels'

// MiniMax H3 frame counts used by the proven storyboard pipeline
const FRAMES_BY_SECONDS: Record<number, number> = { 5: 124, 10: 243 }
const BATCH_CAP = 6
const TERMINAL_KERNEL = new Set([
  'COMPLETE', 'ERROR', 'CANCEL_ACKNOWLEDGED', 'CANCELLED', 'CANCEL_REQUESTED', 'NOT_FOUND',
])
/** worker state.json entries that mean the job itself failed */
const WORKER_FAIL_STATES = new Set(['failed', 'error', 'prep_failed'])
const MAX_WORKER_RESTARTS = 4

export interface StudioState {
  kernelStatus: string
  kernelStatusAt: string
  activeBatchId: string | null
  outputsLastUpdated: string
  lastSyncAt: string
  lastError?: string
  /** idle: nothing running; worker: persistent worker mode; ondemand: legacy */
  mode: 'idle' | 'worker' | 'ondemand'
  workerType: 'real' | 'test' | null
  workerRestarts: number
  workerEventAt: string
}

const STATE_KEY = 'studio'

/** Prisma Bytes (Uint8Array<ArrayBuffer>) from a Node Buffer */
function toBytes(b: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b) // copy -> fresh ArrayBuffer, satisfies Prisma Bytes
}

const DEFAULT_STATE: StudioState = {
  kernelStatus: 'UNKNOWN',
  kernelStatusAt: '',
  activeBatchId: null,
  outputsLastUpdated: '',
  lastSyncAt: '',
  mode: 'idle' as const,
  workerType: null,
  workerRestarts: 0,
  workerEventAt: '',
}

async function readState(): Promise<StudioState> {
  try {
    const row = await db.studioState.findUnique({ where: { key: STATE_KEY } })
    if (row) return { ...DEFAULT_STATE, ...(JSON.parse(row.data) as StudioState) }
  } catch { /* fall through to defaults */ }
  return { ...DEFAULT_STATE }
}

async function writeState(patch: Partial<StudioState>): Promise<StudioState> {
  const s = await readState()
  const next = { ...s, ...patch }
  await db.studioState.upsert({
    where: { key: STATE_KEY },
    create: { key: STATE_KEY, data: JSON.stringify(next) },
    update: { data: JSON.stringify(next) },
  })
  return next
}

/* --------------------------------------------------------------- frame prep */

/** first frame -> 864x480 canvas (the H3 geometry anchor; plain stretch otherwise) */
export async function prepFrameData(orig: Buffer | null): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  const bg = { r: 0x15, g: 0x1a, b: 0x20 }
  if (orig) {
    try {
      return await sharp(orig)
        .resize(864, 480, { fit: 'contain', background: bg })
        .jpeg({ quality: 88 })
        .toBuffer()
    } catch { /* unparsable input -> neutral canvas */ }
  }
  return sharp({ create: { width: 864, height: 480, channels: 3, background: bg } })
    .jpeg()
    .toBuffer()
}

/* ------------------------------------------------------- kernel definitions */

interface KernelDef {
  slug: string
  title: string
  codeFile: string
  notebook: string
  gpu: boolean
}

function kernelDefs(): Record<'real' | 'test' | 'workerReal' | 'workerTest', KernelDef> {
  return {
    real: {
      slug: KERNEL, title: 'rmc-studio-h3', codeFile: 'rmc_studio_real.ipynb',
      notebook: KERNEL_RMC_STUDIO_REAL, gpu: true,
    },
    test: {
      slug: KERNEL, title: 'rmc-studio-h3', codeFile: 'rmc_studio_test.ipynb',
      notebook: KERNEL_RMC_STUDIO_TEST, gpu: false,
    },
    workerReal: {
      slug: WORKER_KERNEL, title: 'rmc-studio-worker', codeFile: 'rmc_studio_worker_real.ipynb',
      notebook: KERNEL_RMC_STUDIO_WORKER_REAL, gpu: true,
    },
    workerTest: {
      slug: WORKER_TEST_KERNEL, title: 'rmc-studio-worker-test', codeFile: 'rmc_studio_worker_test.ipynb',
      notebook: KERNEL_RMC_STUDIO_WORKER_TEST, gpu: false,
    },
  }
}

/* ------------------------------- accelerator configuration ----------------
 * GPU only (owner request, 2026-10-16: TPU path removed). The H3 pipeline is
 * CUDA-only — it cannot run on a TPU (no PyTorch-XLA port exists), so the
 * proven 2x T4 (NvidiaTeslaT4, ~47 TFLOPS fp16 aggregate) is the only target.
 */
const MACHINE_SHAPE = process.env.KAGGLE_MACHINE_SHAPE || 'NvidiaTeslaT4'

function pushKernel(def: KernelDef): Promise<unknown> {
  return kernelPush({
    slug: def.slug,
    title: def.title,
    notebook: def.notebook,
    isPrivate: true,
    enableInternet: true,
    enableGpu: def.gpu,
    machineShape: def.gpu ? MACHINE_SHAPE : undefined,
    datasetSources: [JOBS_DATASET, OUTPUTS_DATASET],
  })
}

/** make sure the outputs (insurance) dataset exists BEFORE the kernel runs:
 * the kernel attaches it as a data source and its create-first insurance push
 * relies on the slug being present */
async function ensureOutputsDataset() {
  const lu = await datasetLatestFileTime(OUTPUTS_DATASET)
  if (lu) return
  const r = await datasetPush(
    [{ name: 'README.txt', data: Buffer.from('H3 studio insurance outputs are pushed here by the kernel.\n') }],
    OUTPUTS_DATASET,
    'studio outputs seed',
  )
  if (!r.ok) throw new Error(`outputs dataset seed failed: ${r.detail}`)
}

/** build the jobs dataset files (manifest + frames + done ids) fully in memory */
async function buildJobsFiles(jobs: {
  id: string; prompt: string; seconds: number; framePrepped: Buffer | null; testMode: boolean
}[]): Promise<DatasetFileInput[]> {
  const files: DatasetFileInput[] = []
  const manifest = [] as Record<string, unknown>[]
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i]
    const num = i + 1
    if (j.prompt.startsWith('CMD:')) {
      // terminal command: CMD:<terminalId>|<timeoutS>|<command>
      const rest = j.prompt.slice(4)
      const sep1 = rest.indexOf('|')
      const sep2 = sep1 >= 0 ? rest.indexOf('|', sep1 + 1) : -1
      manifest.push({
        num,
        mode: 'cmd',
        terminal_id: sep1 >= 0 ? rest.slice(0, sep1) : 'default',
        timeout_s: sep2 >= 0 ? Number(rest.slice(sep1 + 1, sep2)) || 240 : 240,
        cmd: sep2 >= 0 ? rest.slice(sep2 + 1) : rest,
        seconds: 0,
        job_id: j.id,
      })
      continue
    }
    if (j.prompt.startsWith('MERGE:')) {
      // stitch job: MERGE:<jobId1>,<jobId2>,... — input clips ship as files
      // (unique per-merge names: two merges can share one batch)
      const inputIds = j.prompt.slice(6).split(',').filter(Boolean)
      const inputFiles: string[] = []
      for (let k = 0; k < inputIds.length; k++) {
        const src = await db.job.findUnique({ where: { id: inputIds[k] } })
        if (src?.videoData && src.videoData.byteLength > 0) {
          const name = `mergein_${j.id}_${k + 1}.mp4`
          files.push({
            name,
            data: Buffer.from(src.videoData),
            contentType: 'video/mp4',
          })
          inputFiles.push(name)
        }
      }
      manifest.push({
        num,
        mode: 'merge',
        inputs: inputIds,
        input_files: inputFiles,
        title: `merge ${inputIds.length}`,
        seconds: j.seconds,
        job_id: j.id,
      })
      continue
    }
    const frameName = `shot_${String(num).padStart(2, '0')}.jpg`
    files.push({
      name: frameName,
      data: await prepFrameData(j.framePrepped),
      contentType: 'image/jpeg',
    })
    manifest.push({
      num,
      title: j.prompt.slice(0, 60),
      seconds: j.seconds,
      frames: FRAMES_BY_SECONDS[j.seconds] || j.seconds * 24 + 4,
      gear_primary: '0.4',
      gear_fallback: '0.3',
      prompt: j.prompt,
      frame: frameName,
      job_id: j.id,
    })
  }
  files.push({ name: 'shots.json', data: Buffer.from(JSON.stringify(manifest, null, 1)), contentType: 'application/json' })
  if (jobs[0].testMode)
    files.push({ name: 'test_mode.txt', data: Buffer.from('studio test batch\n') })
  // worker config: telegram mirror credentials (files the agent produces in
  // the terminal are uploaded straight from the container)
  try {
    const { botToken, resolveChatId } = await import('@/lib/telegram')
    const chatId = await resolveChatId()
    // terminal workspaces: latest telegram snapshot file_id per terminal id
    // (the worker restores the workspace from it on a fresh Kaggle session)
    let termSnapshots: Record<string, string> = {}
    try {
      const snaps = await db.studioState.findMany({ where: { key: { startsWith: 'term:' } } })
      for (const s of snaps) {
        try {
          const rec = JSON.parse(s.data) as { fileId?: string }
          if (rec.fileId) termSnapshots[s.key.slice(5)] = rec.fileId
        } catch { /* skip broken record */ }
      }
    } catch { /* non-fatal */ }
    files.push({
      name: 'config.json',
      data: Buffer.from(JSON.stringify({
        telegram_token: botToken() || null,
        telegram_chat_id: chatId,
        term_snapshots: termSnapshots,
      })),
      contentType: 'application/json',
    })
  } catch { /* config optional */ }
  // cumulative completed ids: the worker uses them to skip finished jobs
  // after a restart without regenerating anything
  const dones = await db.job.findMany({
    where: { status: 'complete' },
    select: { id: true },
    orderBy: { updatedAt: 'desc' },
    take: 2000,
  })
  files.push({ name: 'done_ids.json', data: Buffer.from(JSON.stringify(dones.map((d) => d.id))), contentType: 'application/json' })
  return files
}

/** worker-mode submit: push one jobs-dataset version and make sure a matching
 * persistent worker is alive; the worker picks the batch up via the API.
 * Returns 'ondemand' when the caller should fall back to the batch kernel. */
async function submitWorkerBatch(jobs: {
  id: string; prompt: string; seconds: number; framePrepped: Buffer | null; testMode: boolean
}[]): Promise<'worker' | 'ondemand'> {
  const batchId = `b${Date.now().toString(36)}`
  const isTest = jobs[0].testMode
  await ensureOutputsDataset()

  const pushed = await datasetPush(await buildJobsFiles(jobs), JOBS_DATASET, `studio batch ${batchId}`)
  if (!pushed.ok) throw new Error(`jobs dataset push failed: ${pushed.detail}`)
  // NOTE: no waitForDatasetReady -- unlike mount-based kernels, the worker
  // polls via the Kaggle API and re-downloads until the fresh version is ready

  // adopt an already-alive worker when possible (the GPU worker also handles
  // test batches via ffmpeg stubs; a CPU test worker self-exits on real jobs)
  const st = await readState()
  const realStatus = await kernelStatus(WORKER_KERNEL)
  let workerType: 'real' | 'test' = isTest ? 'test' : 'real'
  let adopted: string | null = null
  if (realStatus === 'RUNNING' || realStatus === 'QUEUED') {
    workerType = 'real'
    adopted = realStatus
  } else if (isTest) {
    const testStatus = await kernelStatus(WORKER_TEST_KERNEL)
    if (testStatus === 'RUNNING' || testStatus === 'QUEUED') {
      workerType = 'test'
      adopted = testStatus
    } else {
      await pushKernel(kernelDefs().workerTest)
    }
  } else {
    await pushKernel(kernelDefs().workerReal)
  }

  for (let i = 0; i < jobs.length; i++) {
    await db.job.update({
      where: { id: jobs[i].id },
      data: { status: 'generating', batchId, shotNum: i + 1, error: null },
    })
  }
  await writeState({
    activeBatchId: batchId,
    mode: 'worker',
    workerType,
    kernelStatus: adopted || 'QUEUED',
    kernelStatusAt: new Date().toISOString(),
    workerEventAt: adopted ? st.workerEventAt : new Date().toISOString(),
    workerRestarts: 0,
    lastError: undefined,
  })
  return 'worker'
}

/* ---------------------------------------------------------------- delivery */

/** extract a flat key like "job_x.mp4" / "out/state.json" lookup map from a
 * worker outputs payload; keys are matched against both "out/<name>" and "<name>" */
type FileMap = Map<string, Buffer>

function mapFromFileEntries(entries: { name: string; data: Buffer }[]): FileMap {
  const m: FileMap = new Map()
  for (const e of entries) {
    const norm = e.name.replace(/^\/+|\/+$/g, '')
    m.set(norm, e.data)
    const base = norm.split('/').pop()
    if (base && !m.has(base)) m.set(base, e.data)
  }
  return m
}

function unzipToEntries(zip: Buffer): { name: string; data: Buffer }[] {
  // NOTE: fflate's unzipSync crashes with "Array buffer allocation failed" on
  // Kaggle-built zips (misparsed sizes -> huge alloc); adm-zip reads them fine.
  const az = new AdmZip(zip)
  return az
    .getEntries()
    .filter((e) => !e.isDirectory && !e.entryName.startsWith('__MACOSX'))
    .map((e) => ({ name: e.entryName, data: e.getData() }))
}

/** worker outputs carry job_<id>.mp4 files; deliver them into Job.videoData.
 * CMD jobs deliver cmd_<id>.txt (JSON record of the shell run) instead. */
async function tryDeliverWorker(sources: FileMap[]): Promise<number> {
  let delivered = 0
  const jobs = await db.job.findMany({ where: { status: 'generating' } })
  for (const job of jobs) {
    const isCmd = job.prompt.startsWith('CMD:')
    const fname = isCmd ? `cmd_${job.id}.txt` : `job_${job.id}.mp4`
    const minSize = isCmd ? 2 : 30_000
    let data: Buffer | null = null
    for (const src of sources) {
      const c = src.get(`out/${fname}`) || src.get(fname)
      if (c && c.byteLength > minSize) { data = c; break }
    }
    if (!data) continue
    await db.job.update({
      where: { id: job.id },
      data: { status: 'complete', videoData: toBytes(data) },
    })
    // terminal command: remember the workspace snapshot file_id so the next
    // worker session can restore the terminal state (cd, files, venv)
    if (isCmd) {
      try {
        const rec = JSON.parse(data.toString('utf8')) as {
          terminal_id?: string; snapshot_file_id?: string | null
        }
        if (rec.terminal_id && rec.snapshot_file_id) {
          const key = `term:${rec.terminal_id}`
          await db.studioState.upsert({
            where: { key },
            create: { key, data: JSON.stringify({ fileId: rec.snapshot_file_id, at: new Date().toISOString() }) },
            update: { data: JSON.stringify({ fileId: rec.snapshot_file_id, at: new Date().toISOString() }) },
          })
        }
      } catch { /* non-fatal */ }
    }
    delivered++
  }
  return delivered
}

/** read the worker's state.json from the outputs payload and fail jobs the
 * worker reported as failed/prep_failed; needs_gpu/refused_time stay
 * generating -- the site restarts a matching worker for those instead */
async function applyWorkerStateFailures(sources: FileMap[]): Promise<void> {
  for (const src of sources) {
    const raw = src.get('out/state.json') || src.get('state.json')
    if (!raw) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch { continue }
    const jobsState = (parsed.jobs || parsed.shots || {}) as Record<string, {
      status?: string; error?: string
    }>
    const generating = await db.job.findMany({ where: { status: 'generating' } })
    for (const job of generating) {
      const rec = jobsState[job.id]
      if (!rec?.status) continue
      if (WORKER_FAIL_STATES.has(rec.status)) {
        await db.job.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            error: String(rec.error || rec.status).slice(0, 280),
          },
        })
      }
    }
  }
}

/** fetch the latest kernel-session output files (per-file signed URLs) */
async function kernelOutputFileMap(slug: string): Promise<{ map: FileMap; log: string }> {
  const { files, log } = await kernelOutputFiles(slug)
  const entries: { name: string; data: Buffer }[] = []
  for (const f of files) {
    try {
      entries.push({ name: f.fileName, data: await downloadOutputFile(f) })
    } catch { /* individual file failures are non-fatal */ }
  }
  return { map: mapFromFileEntries(entries), log }
}

/** pull the last Python error out of a kernel run log */
function extractErrorFromLog(log: string): string | null {
  const lines = log.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^([A-Za-z]+(?:Error|Exception))\b[: ]*(.*)/)
    if (m) return `${m[1]}: ${m[2] || lines[i + 1] || ''}`.slice(0, 280)
  }
  return null
}

async function pollWorker() {
  const st = await readState()
  const slug = st.workerType === 'test' ? WORKER_TEST_KERNEL : WORKER_KERNEL
  const status = await kernelStatus(slug)
  const alive = status === 'RUNNING' || status === 'QUEUED'
  await writeState({
    kernelStatus: status,
    kernelStatusAt: new Date().toISOString(),
    activeBatchId: st.activeBatchId,
    // worker confirmed alive -> a submit failure note from an earlier attempt
    // (or a token-less run on a foreign machine sharing the DB) is stale
    ...(alive ? { lastError: undefined } : {}),
  })

  // zombie watchdog: the worker self-limits to 8.4h and Kaggle hard-kills at
  // 9h -- a session still claiming RUNNING/QUEUED past ~8.7h is a lie (silent
  // livelock). Re-push the kernel: Kaggle cancels the old session, the fresh
  // one re-picks pending jobs (done_ids prevents regenerating finished ones).
  const ageMs = st.workerEventAt ? Date.now() - Date.parse(st.workerEventAt) : 0
  if (alive && ageMs > 8.7 * 3_600_000) {
    const restarts = st.workerRestarts ?? 0
    if (restarts < MAX_WORKER_RESTARTS) {
      const wanted = st.workerType === 'test' ? 'workerTest' : 'workerReal'
      await pushKernel(kernelDefs()[wanted])
      await writeState({
        kernelStatus: 'QUEUED',
        kernelStatusAt: new Date().toISOString(),
        workerRestarts: restarts + 1,
        workerEventAt: new Date().toISOString(),
        lastError: undefined,
      })
      console.warn(
        `[studio] zombie worker: ${Math.round(ageMs / 3_600_000)}h ${status} with no output -> re-pushed ${wanted}`,
      )
    } else {
      const remaining = await db.job.findMany({ where: { status: 'generating' } })
      for (const job of remaining) {
        await db.job.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            error: `воркер Kaggle завис (${Math.round(ageMs / 3_600_000)} ч без результата), лимит перезапусков исчерпан`,
          },
        })
      }
      await writeState({ activeBatchId: null, workerRestarts: 0 })
    }
    return readState()
  }

  // incremental delivery: the worker pushes the outputs dataset after every job
  const lu = await datasetLatestFileTime(OUTPUTS_DATASET)
  const cur = await readState()
  if (lu && lu !== cur.outputsLastUpdated) {
    try {
      const zip = await datasetDownloadZip(OUTPUTS_DATASET)
      const map = mapFromFileEntries(unzipToEntries(zip))
      const n = await tryDeliverWorker([map])
      await applyWorkerStateFailures([map])
      if (n > 0) await writeState({ outputsLastUpdated: lu })
    } catch (e) {
      console.error('[studio] outputs delivery failed:', e instanceof Error ? e.message : e)
    }
  }

  if (TERMINAL_KERNEL.has(status)) {
    // final pickup from the kernel output itself (has everything in working/)
    const { map } = await kernelOutputFileMap(slug)
    await tryDeliverWorker([map])
    await applyWorkerStateFailures([map])

    const remaining = await db.job.findMany({ where: { status: 'generating' } })
    if (remaining.length > 0) {
      const restarts = cur.workerRestarts ?? 0
      if (restarts < MAX_WORKER_RESTARTS) {
        // relaunch: the worker re-picks pending jobs (done_ids prevents
        // regenerating finished ones; refused_time entries are retried too)
        const wanted = remaining[0].testMode ? 'workerTest' : 'workerReal'
        await pushKernel(kernelDefs()[wanted])
        await writeState({
          mode: 'worker',
          workerType: wanted === 'workerTest' ? 'test' : 'real',
          kernelStatus: 'QUEUED',
          kernelStatusAt: new Date().toISOString(),
          workerRestarts: restarts + 1,
          workerEventAt: new Date().toISOString(),
        })
      } else {
        for (const job of remaining) {
          await db.job.update({
            where: { id: job.id },
            data: {
              status: 'failed',
              error: `воркер Kaggle завершился (${status}), лимит перезапусков исчерпан`,
            },
          })
        }
        await writeState({ activeBatchId: null, workerRestarts: 0 })
      }
    } else {
      await writeState({ activeBatchId: null, workerRestarts: 0 })
    }
  }
  // everything delivered -> reset the restart budget for the next batch
  const gen = await db.job.count({ where: { status: 'generating' } })
  if (gen === 0) await writeState({ workerRestarts: 0 })
}

/* ------------------------------------------------------- on-demand batches */

async function startBatch(jobs: {
  id: string; prompt: string; seconds: number; framePrepped: Buffer | null; testMode: boolean
}[]) {
  const batchId = `b${Date.now().toString(36)}`
  await ensureOutputsDataset()

  const pushed = await datasetPush(await buildJobsFiles(jobs), JOBS_DATASET, `studio batch ${batchId}`)
  if (!pushed.ok) throw new Error(`jobs dataset push failed: ${pushed.detail}`)
  // CRITICAL: never push the kernel while the dataset version is still
  // processing -- Kaggle then silently mounts an empty /kaggle/input
  for (const slug of [JOBS_DATASET, OUTPUTS_DATASET]) {
    const ok = await waitForDatasetReady(slug)
    if (!ok) throw new Error(`dataset ${slug} not ready after timeout`)
  }

  const def = jobs[0].testMode ? kernelDefs().test : kernelDefs().real
  await pushKernel(def)

  for (let i = 0; i < jobs.length; i++) {
    await db.job.update({
      where: { id: jobs[i].id },
      data: { status: 'generating', batchId, shotNum: i + 1, error: null },
    })
  }
  await writeState({
    activeBatchId: batchId,
    kernelStatus: 'QUEUED',
    kernelStatusAt: new Date().toISOString(),
    lastError: undefined,
  })
  return batchId
}

async function tryDeliverBatch(batchId: string, map: FileMap): Promise<number> {
  let delivered = 0
  const jobs = await db.job.findMany({ where: { batchId, status: 'generating' } })
  for (const job of jobs) {
    if (!job.shotNum) continue
    const fname = `shot_${String(job.shotNum).padStart(2, '0')}.mp4`
    const data = map.get(`out/${fname}`) || map.get(fname)
    if (!data || data.byteLength <= 30_000) continue
    await db.job.update({
      where: { id: job.id },
      data: { status: 'complete', videoData: toBytes(data) },
    })
    delivered++
  }
  return delivered
}

async function pollBatch(batchId: string) {
  const status = await kernelStatus()
  await writeState({
    kernelStatus: status,
    kernelStatusAt: new Date().toISOString(),
    activeBatchId: batchId,
  })

  // incremental delivery: insurance dataset (works while the session runs)
  const lu = await datasetLatestFileTime(OUTPUTS_DATASET)
  const st = await readState()
  if (lu && lu !== st.outputsLastUpdated) {
    try {
      const zip = await datasetDownloadZip(OUTPUTS_DATASET)
      const map = mapFromFileEntries(unzipToEntries(zip))
      const n = await tryDeliverBatch(batchId, map)
      if (n > 0) await writeState({ outputsLastUpdated: lu })
    } catch (e) {
      console.error('[studio] batch delivery failed:', e instanceof Error ? e.message : e)
    }
  }

  if (TERMINAL_KERNEL.has(status)) {
    // final pickup from the kernel output itself
    const { map, log } = await kernelOutputFileMap(KERNEL)
    await tryDeliverBatch(batchId, map)

    const remaining = await db.job.findMany({ where: { batchId, status: 'generating' } })
    const errText = extractErrorFromLog(log) || `kernel session ended with ${status} before this clip was saved`
    for (const job of remaining) {
      await db.job.update({
        where: { id: job.id },
        data: { status: 'failed', error: errText },
      })
    }
    await writeState({ activeBatchId: null, kernelStatus: status })
  }
}

/* -------------------------------------------------------------- main entry */

let syncing = false

/** called by /api/jobs GET and the agent worker; pushes/polls Kaggle via REST */
export async function syncStudio(): Promise<StudioState> {
  if (syncing) return readState()
  syncing = true
  try {
    const generating = await db.job.findMany({
      where: { status: 'generating' },
      orderBy: { createdAt: 'asc' },
    })
    if (generating.length > 0) {
      const st = await readState()
      if (st.mode === 'ondemand' && generating[0].batchId) {
        await pollBatch(generating[0].batchId)
      } else {
        await pollWorker()
      }
      await writeState({ lastSyncAt: new Date().toISOString() })
      return readState()
    }
    const queued = await db.job.findMany({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
    })
    if (queued.length === 0) {
      const st = await readState()
      if (st.workerType) {
        // idle: keep the worker badge fresh (cheap single status call)
        const slug = st.workerType === 'test' ? WORKER_TEST_KERNEL : WORKER_KERNEL
        const status = await kernelStatus(slug)
        await writeState({
          kernelStatus: status,
          kernelStatusAt: new Date().toISOString(),
          activeBatchId: null,
        })
      } else {
        await writeState({ activeBatchId: null })
      }
      await writeState({ lastSyncAt: new Date().toISOString() })
      return readState()
    }
    // batch = oldest contiguous run of same testMode
    const flag = queued[0].testMode
    const batch = queued
      .filter((j) => j.testMode === flag)
      .slice(0, BATCH_CAP)
      .map((j) => ({
        id: j.id,
        prompt: j.prompt,
        seconds: j.seconds,
        framePrepped: j.framePrepped ? Buffer.from(j.framePrepped) : null,
        testMode: j.testMode,
      }))
    try {
      await submitWorkerBatch(batch)
    } catch (e) {
      // fallback: the proven on-demand batch kernel (mounts the datasets
      // itself, one session per batch)
      const msg = e instanceof Error ? e.message : String(e)
      console.error('worker submit failed, falling back to on-demand:', msg)
      await writeState({ lastError: `worker: ${msg.slice(0, 200)}` })
      await startBatch(batch)
      await writeState({ mode: 'ondemand', workerType: null })
    }
    await writeState({ lastSyncAt: new Date().toISOString() })
    return readState()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await writeState({ lastError: msg.slice(0, 300) })
    return readState()
  } finally {
    syncing = false
  }
}
