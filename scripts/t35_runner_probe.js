// T35 prod probe: verify the RESIDENT runner picked up the NEW agent_runner
// (format_guard present) via a raw shell command through the real queue.
// The python snippet travels base64-encoded -> zero shell-quoting issues.
const { execSync } = require('child_process')
const crypto = require('crypto')
const GH_SESSION_ID = '42dabdf5-75f7-44b4-baad-4af0a313f0fc'

function dbq(sql, params = []) {
  const out = execSync(
    `DATABASE_URL=$(grep '^DATABASE_URL=' .env.vercel.local | cut -d= -f2- | tr -d '"') node scripts/dbq.js '${sql.replace(/'/g, "'\\''")}' '${JSON.stringify(params)}'`,
    { encoding: 'utf8', timeout: 60_000 })
  return JSON.parse(out.trim() || '[]')
}

const py = [
  "import sys, re",
  "sys.path.insert(0, '.github')",
  "import agent_runner as a",
  "print('T35-LIVE' if hasattr(a, 'format_guard') else 'OLD-CODE')",
  "m = re.compile(a.RE_CMD.pattern)",
  "print('QUOTE-OK' if m.search(\"<cmd to='30'>x</cmd>\") else 'QUOTE-BAD')",
].join('\n')
const b64 = Buffer.from(py).toString('base64')
const command = `cd $GITHUB_WORKSPACE && git fetch -q origin main && git reset -q --hard FETCH_HEAD && echo ${b64} | base64 -d | python3 -`

const cmdId = crypto.randomUUID().replace(/-/g, '')
dbq(`INSERT INTO "TerminalCommand" (id, "sessionId", command, status, source, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'pending', 'agent', now(), now())`, [cmdId, GH_SESSION_ID, command])
console.log('queued:', cmdId)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const t0 = Date.now()
  while (Date.now() - t0 < 8 * 60_000) {
    await sleep(15_000)
    const rows = dbq(`SELECT status, output, "exitCode" FROM "TerminalCommand" WHERE id = $1`, [cmdId])
    if (rows.length && !['pending', 'running'].includes(rows[0].status)) {
      const out = String(rows[0].output || '')
      console.log(`status=${rows[0].status} exit=${rows[0].exitCode}`)
      console.log('output:', out.slice(0, 300))
      const live = out.includes('T35-LIVE')
      const quote = out.includes('QUOTE-OK')
      console.log(live && quote ? 'T35 RUNNER PROBE: PASS (new code live, quote fix live)'
        : 'T35 RUNNER PROBE: FAIL')
      process.exit(live && quote ? 0 : 1)
    }
  }
  console.log('T35 RUNNER PROBE: TIMEOUT (8 min)')
  process.exit(2)
})()
