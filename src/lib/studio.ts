import { unzipSync } from 'fflate'
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

function pushKernel(def: KernelDef): Promise<unknown> {
  return kernelPush({
    slug: def.slug,
    title: def.title,
    notebook: def.notebook,
    isPrivate: true,
    enableInternet: true,
    // the 2xT4 accelerator; enableGpu alone is the safe fallback server-side
    enableGpu: def.gpu,
    machineShape: def.gpu ? 'NvidiaTeslaT4' : undefined,
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
  const unzipped = unzipSync(new Uint8Array(zip))
  return Object.entries(unzipped)
    .filter(([name]) => !name.startsWith('__MACOSX') && !name.endsWith('/'))
    .map(([name, data]) => ({ name, data: Buffer.from(data) }))
}

/** worker outputs carry job_<id>.mp4 files; deliver them into Job.videoData */
async function tryDeliverWorker(sources: FileMap[]): Promise<number> {
  let delivered = 0
  const jobs = await db.job.findMany({ where: { status: 'generating' } })
  for (const job of jobs) {
    const fname = `job_${job.id}.mp4`
    let data: Buffer | null = null
    for (const src of sources) {
      const c = src.get(`out/${fname}`) || src.get(fname)
      if (c && c.byteLength > 30_000) { data = c; break }
    }
    if (!data) continue
    await db.job.update({
      where: { id: job.id },
      data: { status: 'complete', videoData: toBytes(data) },
    })
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
  await writeState({
    kernelStatus: status,
    kernelStatusAt: new Date().toISOString(),
    activeBatchId: st.activeBatchId,
  })

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
