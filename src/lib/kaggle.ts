/**
 * Kaggle API client — pure `fetch`, zero child processes.
 *
 * Replaces the old Python-CLI wrapper so the app runs on Vercel serverless
 * (no Python, no CLI binary). Auth mirrors the official kaggle CLI 1.7+:
 * `Authorization: Bearer <KAGGLE_API_TOKEN>` (KGAT_... token).
 *
 * Endpoints follow kagglesdk's transport:
 *   POST https://api.kaggle.com/v1/{Service}/{Method}   (camelCase JSON)
 * File uploads go through blobs.BlobApiService/StartBlobUpload -> signed PUT.
 * Dataset downloads return HTTP 302 to a signed URL.
 */

const BASE = process.env.KAGGLE_API_BASE || 'https://api.kaggle.com/v1'
const TOKEN = process.env.KAGGLE_API_TOKEN || ''

export const ACCOUNT = process.env.KAGGLE_ACCOUNT || 'freedomform'
export const JOBS_DATASET = `${ACCOUNT}/rmc-studio-jobs`
export const OUTPUTS_DATASET = `${ACCOUNT}/rmc-studio-outputs`
export const KERNEL = `${ACCOUNT}/rmc-studio-h3`
/** persistent workers: launch once, then feed prompts through the jobs dataset */
export const WORKER_KERNEL = `${ACCOUNT}/rmc-studio-worker`
export const WORKER_TEST_KERNEL = `${ACCOUNT}/rmc-studio-worker-test`

export class KaggleError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function headers(extra?: Record<string, string>): Record<string, string> {
  if (!TOKEN) throw new KaggleError('KAGGLE_API_TOKEN is not configured', 401)
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

async function call<T = Record<string, unknown>>(
  service: string,
  method: string,
  body: unknown,
  timeoutMs = 120_000,
): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}/${service}/${method}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      let msg = `Kaggle ${res.status}`
      try {
        const j = JSON.parse(text) as { error?: { message?: string }; message?: string }
        msg = j.error?.message || j.message || msg
      } catch {
        if (text) msg += `: ${text.slice(0, 200)}`
      }
      throw new KaggleError(msg, res.status)
    }
    return (text ? JSON.parse(text) : {}) as T
  } finally {
    clearTimeout(t)
  }
}

/* ------------------------------------------------------------------ kernels */

export interface SaveKernelResult {
  ref?: string
  url?: string
  versionNumber?: number
  error?: string
}

export interface KernelPushMeta {
  slug: string // "owner/name"
  title: string
  notebook: string // full .ipynb JSON text
  isPrivate?: boolean
  enableGpu?: boolean
  enableInternet?: boolean
  machineShape?: string // e.g. "NvidiaTeslaT4" (the 2xT4 accelerator)
  datasetSources?: string[]
}

/** push a notebook kernel version (equivalent of `kaggle kernels push`) */
export async function kernelPush(meta: KernelPushMeta): Promise<SaveKernelResult> {
  const body: Record<string, unknown> = {
    slug: meta.slug,
    newTitle: meta.title,
    text: meta.notebook,
    language: 'python',
    kernelType: 'notebook',
    isPrivate: meta.isPrivate ?? true,
    enableInternet: meta.enableInternet ?? true,
    datasetDataSources: meta.datasetSources || [],
    competitionDataSources: [],
    kernelDataSources: [],
    modelDataSources: [],
  }
  if (meta.enableGpu) {
    body.enableGpu = true
    if (meta.machineShape) body.machineShape = meta.machineShape
  }
  const res = await call<SaveKernelResult & { error?: string; invalidDatasetSources?: string[] }>(
    'kernels.KernelsApiService',
    'SaveKernel',
    body,
    180_000,
  )
  if (res.error) throw new KaggleError(`kernel push: ${res.error}`, 400)
  return res
}

/** kernel session status: QUEUED | RUNNING | COMPLETE | ERROR | CANCEL_REQUESTED | CANCEL_ACKNOWLEDGED | ... */
export async function kernelStatus(kernel = KERNEL): Promise<string> {
  const [userName, kernelSlug] = kernel.split('/')
  try {
    const r = await call<{ status?: string; failureMessage?: string }>(
      'kernels.KernelsApiService',
      'GetKernelSessionStatus',
      { userName, kernelSlug },
      60_000,
    )
    return (r.status || 'UNKNOWN').replace(/^KernelWorkerStatus\./, '').toUpperCase()
  } catch (e) {
    if (e instanceof KaggleError && (e.status === 404 || e.status === 403)) return 'NOT_FOUND'
    return `UNKNOWN:${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`
  }
}

export interface OutputFile {
  fileName: string
  url: string
}

/** list the files produced by the latest kernel session (signed download URLs) */
export async function kernelOutputFiles(kernel = KERNEL): Promise<{ files: OutputFile[]; log: string }> {
  const [userName, kernelSlug] = kernel.split('/')
  const files: OutputFile[] = []
  let log = ''
  let pageToken = ''
  // paginate defensively; a worker session rarely has >200 files
  for (let i = 0; i < 10; i++) {
    const r = await call<{ files?: OutputFile[]; log?: string; nextPageToken?: string }>(
      'kernels.KernelsApiService',
      'ListKernelSessionOutput',
      { userName, kernelSlug, pageSize: 200, ...(pageToken ? { pageToken } : {}) },
      120_000,
    )
    files.push(...(r.files || []))
    log = r.log || log
    if (!r.nextPageToken) break
    pageToken = r.nextPageToken
  }
  return { files, log }
}

/** download one output file's bytes via its signed URL */
export async function downloadOutputFile(file: OutputFile, timeoutMs = 300_000): Promise<Buffer> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(file.url, { signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok) throw new KaggleError(`output download ${res.status} for ${file.fileName}`, res.status)
    return Buffer.from(await res.arrayBuffer())
  } finally {
    clearTimeout(t)
  }
}

/* ----------------------------------------------------------------- datasets */

async function uploadBlob(
  name: string,
  data: Buffer,
  contentType = 'application/octet-stream',
): Promise<string> {
  const start = await call<{ token?: string; createUrl?: string }>(
    'blobs.BlobApiService',
    'StartBlobUpload',
    {
      type: 'DATASET',
      name,
      contentType,
      contentLength: data.byteLength,
      lastModifiedEpochSeconds: Math.floor(Date.now() / 1000),
    },
    60_000,
  )
  if (!start.createUrl || !start.token)
    throw new KaggleError(`blob upload init failed for ${name}`, 500)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 600_000)
  try {
    const put = await fetch(start.createUrl, {
      method: 'PUT',
      body: new Uint8Array(data),
      headers: { 'Content-Type': 'application/octet-stream' },
      signal: ctrl.signal,
    })
    if (!put.ok) {
      const txt = await put.text().catch(() => '')
      throw new KaggleError(`blob PUT ${put.status} for ${name}: ${txt.slice(0, 200)}`, put.status)
    }
  } finally {
    clearTimeout(t)
  }
  return start.token
}

export interface DatasetFileInput {
  name: string
  data: Buffer
  contentType?: string
}

/** create the dataset if it does not exist yet (create-first, the v3 lesson) */
export async function datasetCreateIfMissing(
  slug: string,
  title: string,
  seedFiles: DatasetFileInput[],
): Promise<boolean> {
  const [ownerSlug, dsSlug] = slug.split('/')
  try {
    const files = [] as { token: string }[]
    for (const f of seedFiles) files.push({ token: await uploadBlob(f.name, f.data, f.contentType) })
    await call('datasets.DatasetApiService', 'CreateDataset', {
      ownerSlug,
      slug: dsSlug,
      title,
      licenseName: 'CC0-1.0',
      isPrivate: true,
      files,
    })
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/already exists|409/i.test(msg)) return false
    throw e
  }
}

/** push a new dataset version from in-memory files (equivalent of `datasets version`) */
export async function datasetPushVersion(
  slug: string,
  files: DatasetFileInput[],
  message: string,
): Promise<{ ok: boolean; detail: string }> {
  const [ownerSlug, dsSlug] = slug.split('/')
  const body = { versionNotes: message, deleteOldVersions: false, files: [] as { token: string }[] }
  for (const f of files) body.files.push({ token: await uploadBlob(f.name, f.data, f.contentType) })
  const res = await call<{ ref?: string; error?: string }>(
    'datasets.DatasetApiService',
    'CreateDatasetVersion',
    { ownerSlug, datasetSlug: dsSlug, body },
    300_000,
  )
  if (res.error) return { ok: false, detail: `create version: ${res.error}` }
  return { ok: true, detail: res.ref || 'pushed' }
}

/** create-if-missing then push a new version (old datasetPush(dir, slug) flow) */
export async function datasetPush(
  files: DatasetFileInput[],
  slug: string,
  message: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    await datasetCreateIfMissing(slug, slug.split('/')[1], [
      { name: 'README.txt', data: Buffer.from(`${slug} — managed by the H3 studio agent.\n`) },
    ])
  } catch {
    /* already exists is fine */
  }
  return datasetPushVersion(slug, files, message)
}

/** 'READY' | 'PROCESSING' | ... for the latest dataset version */
export async function datasetStatus(slug: string): Promise<string> {
  const [ownerSlug, dsSlug] = slug.split('/')
  const r = await call<{ status?: string }>(
    'datasets.DatasetApiService',
    'GetDatasetStatus',
    { ownerSlug, datasetSlug: dsSlug },
    60_000,
  )
  return (r.status || '').toUpperCase()
}

/** wait until the latest dataset version finishes processing (ready-gate) */
export async function waitForDatasetReady(slug: string, timeoutMs = 480_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const s = await datasetStatus(slug)
    if (s === 'READY') return true
    await new Promise((r) => setTimeout(r, 20_000))
  }
  return false
}

/** newest file creationDate inside the dataset — the change-detection signal
 * (replaces the old `datasets list --search` lastUpdated column) */
export async function datasetLatestFileTime(slug: string): Promise<string> {
  const [ownerSlug, dsSlug] = slug.split('/')
  try {
    const r = await call<{ datasetFiles?: { name: string; creationDate?: string }[] }>(
      'datasets.DatasetApiService',
      'ListDatasetFiles',
      { ownerSlug, datasetSlug: dsSlug, pageSize: 200 },
      60_000,
    )
    let max = ''
    for (const f of r.datasetFiles || []) {
      if (f.creationDate && f.creationDate > max) max = f.creationDate
    }
    return max
  } catch (e) {
    if (e instanceof KaggleError && e.status === 404) return '' // dataset not created yet
    throw e
  }
}

/** download the whole latest dataset version as a zip (Buffer) */
export async function datasetDownloadZip(slug = OUTPUTS_DATASET, timeoutMs = 600_000): Promise<Buffer> {
  const [ownerSlug, dsSlug] = slug.split('/')
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}/datasets.DatasetApiService/DownloadDataset`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ownerSlug, datasetSlug: dsSlug }),
      redirect: 'follow', // 302 -> signed bucket URL
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new KaggleError(`dataset download ${res.status}: ${txt.slice(0, 200)}`, res.status)
    }
    return Buffer.from(await res.arrayBuffer())
  } finally {
    clearTimeout(t)
  }
}
