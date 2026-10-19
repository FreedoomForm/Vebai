// T25: extract o_zemle.pdf (the "good" PDF) + one recent PDF from prod DB
// TerminalFile.data (Bytes, base64 via Prisma JSON) and save locally.
const { execSync } = require('child_process')
const fs = require('fs')

function dbq(sql, params = []) {
  const out = execSync(
    `DATABASE_URL=$(grep '^DATABASE_URL=' .env.vercel.local | cut -d= -f2- | tr -d '"') node scripts/dbq.js '${sql.replace(/'/g, "'\\''")}' '${JSON.stringify(params)}'`,
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return JSON.parse(out.trim() || '[]')
}

function saveBytes(row, out) {
  const d = row.data
  if (!d) { console.log('  (no data bytes for', row.path, ')'); return }
  let buf
  if (Buffer.isBuffer(d)) buf = d
  else if (d.type === 'Buffer' && Array.isArray(d.data)) buf = Buffer.from(d.data)
  else if (typeof d === 'string') buf = Buffer.from(d, 'base64')
  else if (d instanceof Uint8Array) buf = Buffer.from(d)
  else if (typeof d === 'object') buf = Buffer.from(Object.values(d)) // bytea via JSON keys
  else { console.log('  unknown data format:', typeof d, Object.keys(d || {})); return }
  fs.writeFileSync(out, buf)
  console.log(`  saved ${out}: ${buf.length} bytes (db size=${row.size})`)
}

async function main() {
  console.log('== o_zemle.pdf (the good one, Oct 18 20:07 Tashkent) ==')
  saveBytes(
    dbq(`SELECT path, size, data FROM "TerminalFile" WHERE id = $1`, ['cmvdymba40001l8088qdv8u8i'])[0] || {},
    '/home/z/my-project/download/t25_o_zemle.pdf',
  )

  console.log('== veliki_dostoprimechatelnosti_uzbekistana.pdf (best recent, Oct 19) ==')
  saveBytes(
    dbq(`SELECT path, size, data FROM "TerminalFile" WHERE id = $1`, ['cmveqzih40003jv08df7n3z6n'])[0] || {},
    '/home/z/my-project/download/t25_veliki_recent.pdf',
  )

  console.log('== ml_intro.pdf (latest, Oct 19) ==')
  saveBytes(
    dbq(`SELECT path, size, data FROM "TerminalFile" WHERE id = $1`, ['cmveuj84y0003jm07zbild6jv'])[0] || {},
    '/home/z/my-project/download/t25_ml_intro_latest.pdf',
  )

  console.log('== land task row ==')
  const t = dbq(
    `SELECT id, title, status, progress, left(payload, 500) AS payload_head, left(coalesce(result,''), 900) AS result_head, error, "createdAt", "updatedAt" FROM "AgentTask" WHERE id = $1`,
    ['cmvdy8nz90006jy07ehzbtkc4'],
  )
  console.log(JSON.stringify(t, null, 2))

  console.log('== land conversation messages (kinds + heads) ==')
  const msgs = dbq(
    `SELECT kind, left("content", 400) AS head, "createdAt" FROM "Message" WHERE "conversationId"::text = $1 ORDER BY "createdAt" ASC LIMIT 12`,
    ['cmvdy8b4r0002jy07lwee9ciw'],
  )
  console.log(JSON.stringify(msgs, null, 2).slice(0, 4000))
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
