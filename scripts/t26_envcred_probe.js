// T26 follow-up probe: run AFTER TELEGRAM_API_ID/TELEGRAM_API_HASH are added
// to Vercel (Production) + redeploy. Verifies prod picked the service creds up:
//   1) /api/tg/state -> needApiCreds === false
//   2) /api/tg/connect with NO api fields in body -> the error must come from
//      the PHONE check (MTProto handshake passed), not 'нужен api_id'.
// Uses a throwaway user and cleans it up. No secrets in this file.
const { execSync } = require('child_process')
const SITE = 'https://vebai-six.vercel.app'
const EMAIL = `t26probe_${Date.now()}@vebai-test.app`
const PASSWORD = 'T26-probe-123'
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
  const reg = await fetch(SITE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'T26 Probe' }),
  })
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0]
  check('register ok', reg.status === 200 && !!cookie)
  if (!cookie) process.exit(2)

  const s0 = await j(await fetch(SITE + '/api/tg/state', { headers: { cookie } }), 'state')
  check('needApiCreds=false (service creds in env)', s0.needApiCreds === false, JSON.stringify(s0).slice(0, 120))

  // Well-formed but unregistered number; NO api fields -> server must use env creds
  const conn = await fetch(SITE + '/api/tg/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ phone: '+00000000000' }),
  })
  const cd = await j(conn, 'connect')
  const err = String(cd.error || '')
  const credsRejection = /нужен api_id|api_hash/i.test(err) || /API_ID_INVALID/i.test(err)
  check('connect passed MTProto handshake (phone-level error, not creds error)',
    conn.status === 400 && err.length > 3 && !credsRejection, err.slice(0, 160))
  console.log('  telegram says:', err.slice(0, 140))

  await fetch(SITE + '/api/tg/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie } }).catch(() => {})
  await dbq(`DELETE FROM "User" WHERE email = $1`, [EMAIL])
  const left = await dbq(`SELECT count(*)::int AS n FROM "TgAccount"`, [])
  check('cleanup left no Tg accounts', (left[0] || {}).n === 0)

  console.log(`=== T26 env-cred probe: ${FAIL === 0 ? 'PASS' : 'FAIL'} (${PASS} ok, ${FAIL} failed) ===`)
  process.exitCode = FAIL === 0 ? 0 : 2
}

main().catch((e) => { console.error('probe crashed:', e.message); process.exit(2) })
