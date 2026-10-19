// T29: fix "Telegram недоступен: Request was unsuccessful 1 time(s)".
// Root cause: clientOpts() set requestRetries=1. In GramJS _call() the retry
// loop is `for (attempt=0; attempt<_requestRetries; attempt++)`, and errors
// like PHONE_MIGRATE_X / NETWORK_MIGRATE_X (number lives on another DC —
// Uzbek numbers are on DC5 while a fresh US-lambda client connects to its
// nearest DC) and ServerError/RPC_CALL_FAIL are handled by switching DC /
// sleeping and RE-SENDING on the NEXT loop iteration. With requestRetries=1
// there is no next iteration -> "Request was unsuccessful 1 time(s)" even
// though Telegram answered normally.
//
// A/B probe against PROD:
//   --expect old : +998-number connect MUST fail with "Request was unsuccessful"
//                  (baseline, proves the diagnosis on prod before the fix)
//   --expect new : after the fix the same call must give an honest phone-level
//                  answer (PHONE_NUMBER_UNEXISTED / code sent / FLOOD_WAIT ...) —
//                  i.e. the migrated request actually reached the home DC.
// Probe A (+00000000000) is a no-migration regression: must ALWAYS be an
// honest phone-level error, never "Request was unsuccessful".
// Throwaway user, full cleanup, no secrets in this file.
const { execSync } = require('child_process')
const SITE = 'https://vebai-six.vercel.app'
const EMAIL = `t29probe_${Date.now()}@vebai-test.app`
const PASSWORD = 'T29-probe-123'
const EXPECT = (process.argv.includes('--expect') ? process.argv[process.argv.indexOf('--expect') + 1] : 'new') || 'new'
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
  console.log(`mode: --expect ${EXPECT}`)
  const reg = await fetch(SITE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'T29 Probe' }),
  })
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0]
  check('register ok', reg.status === 200 && !!cookie)
  if (!cookie) process.exit(2)

  const s0 = await j(await fetch(SITE + '/api/tg/state', { headers: { cookie } }), 'state')
  check('needApiCreds=false (service creds in env)', s0.needApiCreds === false, JSON.stringify(s0).slice(0, 120))

  async function connect(phone) {
    const res = await fetch(SITE + '/api/tg/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ phone }),
    })
    return { res, body: await j(res, `connect ${phone}`) }
  }

  // ---- Probe A: no-migration regression (+000 number) -------------------
  const a = await connect('+00000000000')
  const aErr = String(a.body.error || '')
  const credsRejection = /нужен api_id|api_hash/i.test(aErr) || /API_ID_INVALID/i.test(aErr)
  check('A: handshake ok, honest phone-level error (not creds, not retries-exhausted)',
    a.res.status === 400 && aErr.length > 3 && !credsRejection && !/Request was unsuccessful/i.test(aErr),
    aErr.slice(0, 160))
  console.log('  A telegram says:', aErr.slice(0, 140))

  // ---- Probe B: Uzbek-format number (home DC5, lambda connects elsewhere) --
  const b = await connect('+998999999999')
  const bErr = String(b.body.error || '')
  const wasUnsuccessful = /Request was unsuccessful/i.test(bErr)
  if (EXPECT === 'old') {
    check('B(old): bug reproduced on prod — "Request was unsuccessful"', wasUnsuccessful,
      `unexpected answer: ${bErr.slice(0, 140)} ok=${b.body.ok}`)
  } else {
    check('B(new): no "Request was unsuccessful" — migrated request reached home DC',
      !wasUnsuccessful, bErr.slice(0, 160))
  }
  console.log('  B telegram says:', (bErr || `ok, viaApp=${b.body.viaApp}`).slice(0, 140))

  // ---- cleanup ------------------------------------------------------------
  await fetch(SITE + '/api/tg/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie } }).catch(() => {})
  await dbq(`DELETE FROM "TgAccount" WHERE "userId" IN (SELECT id FROM "User" WHERE email = $1)`, [EMAIL])
  await dbq(`DELETE FROM "User" WHERE email = $1`, [EMAIL])
  const left = await dbq(`SELECT count(*)::int AS n FROM "TgAccount" WHERE phone = '+998999999999'`, [])
  check('cleanup left no probe TgAccount rows', (left[0] || {}).n === 0)

  console.log(`=== T29 probe (expect=${EXPECT}): ${FAIL === 0 ? 'PASS' : 'FAIL'} (${PASS} ok, ${FAIL} failed) ===`)
  process.exitCode = FAIL === 0 ? 0 : 2
}

main().catch((e) => { console.error('probe crashed:', e.message); process.exit(2) })
