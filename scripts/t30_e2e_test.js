// T30: GH_TERM_SECRET was never set in Vercel prod env, so
//  (a) session encryption failed AFTER Telegram had already sent the login
//      code («Telegram недоступен: GH_TERM_SECRET не задан ...»), and
//  (b) the resident tg-worker could never authenticate to
//      /api/tg/work|sent|incoming (routes compare body.secret vs env).
// Fix: GH_TERM_SECRET set in Vercel = the secret of the ALIVE gh
// TerminalSession row (proven equal to the GH Actions secret by fresh
// claim heartbeats). This probe verifies on PROD, reading the secret from
// the DB at runtime (never hardcoded, never printed):
//   1) /api/tg/state -> needApiCreds=false AND encReady=true (crypto self-test)
//   2) POST /api/tg/work with the real secret -> 200 (worker auth live)
//   3) POST /api/tg/work with a wrong secret -> 403 (negative control)
// Throwaway user, full cleanup.
const { execSync } = require('child_process')
const SITE = 'https://vebai-six.vercel.app'
const EMAIL = `t30probe_${Date.now()}@vebai-test.app`
const PASSWORD = 'T30-probe-123'
const SESSION_ID = '42dabdf5-75f7-44b4-baad-4af0a313f0fc' // alive gh TerminalSession (id is public)
let PASS = 0, FAIL = 0
function check(name, cond, extra = '') {
  if (cond) { PASS++; console.log(`  ✓ ${name}`) }
  else { FAIL++; console.log(`  ✗ ${name} ${extra}`) }
}
async function j(res, tag) {
  const txt = await res.text()
  try { return JSON.parse(txt) } catch {
    throw new Error(`${tag}: HTTP ${res.status}, не-JSON: ${txt.slice(0, 120) || '(пусто)'}`)
  }
}
function dbq(sql, params = []) {
  const out = execSync(
    `DATABASE_URL=$(grep '^DATABASE_URL=' .env.vercel.local | cut -d= -f2- | tr -d '"') node scripts/dbq.js '${sql.replace(/'/g, "'\\''")}' '${JSON.stringify(params)}'`,
    { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return JSON.parse(out.trim() || '[]')
}

async function main() {
  const rows = dbq(`SELECT secret FROM "TerminalSession" WHERE id = $1 AND kind = 'gh'`, [SESSION_ID])
  const secret = rows[0] && rows[0].secret
  check('gh session secret found in DB', typeof secret === 'string' && secret.length >= 32)
  if (!secret) process.exit(2)

  const reg = await fetch(SITE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'T30 Probe' }),
  })
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0]
  check('register ok', reg.status === 200 && !!cookie)
  if (!cookie) process.exit(2)

  const s0 = await j(await fetch(SITE + '/api/tg/state', { headers: { cookie } }), 'state')
  check('needApiCreds=false (service creds in env)', s0.needApiCreds === false, JSON.stringify(s0).slice(0, 120))
  check('encReady=true (AES key derivable on prod)', s0.encReady === true, `encReady=${s0.encReady}`)

  const okRes = await fetch(SITE + '/api/tg/work', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret }),
  })
  const okBody = await j(okRes, 'work ok')
  check('POST /api/tg/work: real secret -> 200 (worker auth live)', okRes.status === 200 && Array.isArray(okBody.accounts),
    `HTTP ${okRes.status}: ${JSON.stringify(okBody).slice(0, 120)}`)

  const badRes = await fetch(SITE + '/api/tg/work', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'wrong-' + Date.now() }),
  })
  check('POST /api/tg/work: wrong secret -> 403 (negative control)', badRes.status === 403, `HTTP ${badRes.status}`)

  await dbq(`DELETE FROM "TgAccount" WHERE "userId" IN (SELECT id FROM "User" WHERE email = $1)`, [EMAIL])
  await dbq(`DELETE FROM "User" WHERE email = $1`, [EMAIL])
  const left = await dbq(`SELECT count(*)::int AS n FROM "User" WHERE email = $1`, [EMAIL])
  check('cleanup removed probe user', (left[0] || {}).n === 0)

  console.log(`=== T30 probe: ${FAIL === 0 ? 'PASS' : 'FAIL'} (${PASS} ok, ${FAIL} failed) ===`)
  process.exitCode = FAIL === 0 ? 0 : 2
}

main().catch((e) => { console.error('probe crashed:', e.message); process.exit(2) })
