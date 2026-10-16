// Local replica of studio.ts pollWorker delivery: outputs zip -> cmd txt -> Job update
const { unzipSync } = require('fflate')
process.env.KAGGLE_API_TOKEN = 'KGAT_abba3bba83ed8f6a11855f7a819228ea'
const BASE = 'https://api.kaggle.com/v1'

async function call(service, method, body) {
  const res = await fetch(`${BASE}/${service}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KAGGLE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${service}/${method} ${res.status}: ${text.slice(0, 150)}`)
  return JSON.parse(text)
}

;(async () => {
  const lu = await call('datasets.DatasetApiService', 'ListDatasetFiles', { ownerSlug: 'freedomform', datasetSlug: 'rmc-studio-outputs', pageSize: 200 })
  const dates = (lu.datasetFiles || []).map((f) => f.creationDate || '').sort()
  console.log('latestFileTime:', dates[dates.length - 1])

  const res = await fetch(`${BASE}/datasets.DatasetApiService/DownloadDataset`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KAGGLE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerSlug: 'freedomform', datasetSlug: 'rmc-studio-outputs' }),
    redirect: 'follow',
  })
  console.log('download status:', res.status, 'bytes:', res.headers.get('content-length') || res.headers.get('x-final-url') || '?')
  if (!res.ok) { console.log(await res.text().slice ? '' : ''); process.exit(1) }
  const zip = Buffer.from(await res.arrayBuffer())
  console.log('zip bytes:', zip.byteLength)
  const entries = Object.entries(unzipSync(new Uint8Array(zip)))
    .filter(([n]) => !n.startsWith('__MACOSX') && !n.endsWith('/'))
  console.log('entries:', entries.map(([n]) => n))
  const want = 'cmd_cmvav74nn0000kx07fj9y8s28.txt'
  const hit = entries.find(([n]) => n === want || n === `out/${want}` || n.split('/').pop() === want)
  if (!hit) { console.log('NO MATCH for', want); process.exit(1) }
  const rec = JSON.parse(Buffer.from(hit[1]).toString('utf8'))
  console.log('CMD RECORD:', JSON.stringify({ cmd: rec.cmd, exit_code: rec.exit_code, output: (rec.output || '').slice(0, 300), terminal_id: rec.terminal_id, snapshot: rec.snapshot_file_id, files_sent: rec.files_sent }, null, 1))
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
