// T33 E2E probe: "Telegram app on the agent's computer".
// Site side: /api/tg/session (worker-auth bootstrap endpoint) on PROD.
// App side: real GramJS run — (C) locally from the sandbox, (D) on the actual
// GitHub Actions runner via the resident executor command queue.
// The secret is read from the DB at runtime and NEVER printed; session strings
// are only ever printed as lengths.
//   A) /api/tg/session with a wrong secret -> 403 (negative control)
//   B) /api/tg/session with the real secret -> honest shape (ok:true + account
//      fields, or ok:false + error when no account is connected)
//   C) if connected: node .github/tg.js whoami from HERE (real MTProto, read-only)
//   D) runner E2E: TerminalCommand `git reset --hard origin/main && node
//      $GITHUB_WORKSPACE/.github/tg.js whoami` -> output lands in DB
const { execSync } = require('child_process')
const SITE = 'https://vebai-six.vercel.app'
const EMAIL = `t33probe_${Date.now()}@vebai-test.app`
const GH_SESSION_ID = '42dabdf5-75f7-44b4-baad-4af0a313f0fc' // alive gh session (public id)
let PASS = 0, FAIL = 0
function check(name, cond, extra = '') {
  if (cond) { PASS++; console.log(`  ok ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name} ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function dbq(sql, params = []) {
  const out = execSync(
    `DATABASE_URL=$(grep '^DATABASE_URL=' .env.vercel.local | cut -d= -f2- | tr -d '"') node scripts/dbq.js '${sql.replace(/'/g, "'\\''")}' '${JSON.stringify(params)}'`,
    { encoding: 'utf8', timeout: 60_000, cwd: __dirname + '/..' })
  try { return JSON.parse(out) } catch { throw new Error('dbq не-JSON: ' + out.slice(0, 150)) }
}

async function j(res, tag) {
  const txt = await res.text()
  try { return JSON.parse(txt) } catch {
    throw new Error(`${tag}: HTTP ${res.status}, не-JSON: ${txt.slice(0, 120) || '(пусто)'}`)
  }
}

;(async () => {
  console.log('== T33 probe against', SITE)
  const secret = (() => {
    const rows = dbq(`SELECT secret FROM "TerminalSession" WHERE id = $1 AND kind = 'gh'`, [GH_SESSION_ID])
    if (!rows.length || !rows[0].secret) throw new Error('gh session/secret not found in DB')
    return rows[0].secret
  })()
  const accCount = dbq(
    `SELECT count(*)::int AS n FROM "TgAccount" WHERE status = 'connected' AND active = true`, [])
  console.log(`connected accounts: ${accCount[0].n}`)

  // A) wrong secret -> 403
  {
    const res = await fetch(SITE + '/api/tg/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'wrong' }),
    })
    const data = await j(res, 'A')
    check('A: 403 on wrong secret', res.status === 403 && data.error === 'forbidden')
  }

  // B) real secret -> shape
  let boot = null
  {
    const res = await fetch(SITE + '/api/tg/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    })
    const data = await j(res, 'B')
    boot = data
    if (data.ok) {
      check('B: ok:true + account shape', !!data.account && typeof data.account.session === 'string'
        && data.account.session.length > 50 && typeof data.account.apiId === 'number'
        && typeof data.account.apiHash === 'string' && data.account.apiHash.length >= 32)
      console.log(`   account: id=${data.account.id} session_len=${data.account.session.length} me=${JSON.stringify(data.account.me).slice(0, 80)}`)
    } else {
      check('B: honest no-account error', typeof data.error === 'string' && data.error.length > 10)
      console.log(`   no account: ${data.error.slice(0, 100)}`)
    }
  }

  // C) local real-MTProto whoami (read-only)
  if (boot && boot.ok) {
    const out = execSync(
      `SECRET=${JSON.stringify(secret)} SITE=${SITE} node .github/tg.js whoami`,
      { encoding: 'utf8', timeout: 90_000, cwd: __dirname + '/..' })
      .trim()
    const data = JSON.parse(out)
    check('C: local tg.js whoami ok:true', data.ok === true && !!data.me)
    console.log(`   me: ${JSON.stringify(data.me || {}).slice(0, 120)}`)
  } else {
    console.log('   C skipped (no connected account yet)')
  }

  // D) runner E2E via resident executor queue
  const cmd = `cd "$GITHUB_WORKSPACE" && git fetch -q origin main && git reset -q --hard FETCH_HEAD && echo "commit: $(git rev-parse --short HEAD)" && node "$GITHUB_WORKSPACE/.github/tg.js" whoami`
  const row = dbq(
    `INSERT INTO "TerminalCommand" (id, "sessionId", command, status, source, "createdAt", "updatedAt")
     VALUES (md5(random()::text), $1, $2, 'pending', 'agent', now(), now()) RETURNING id`, [GH_SESSION_ID, cmd])
  const cmdId = row[0].id
  console.log('   queued runner command:', cmdId)
  let done = null
  const t0 = Date.now()
  while (Date.now() - t0 < 8 * 60_000) {
    await sleep(15_000)
    const rows = dbq(`SELECT status, output, "exitCode" FROM "TerminalCommand" WHERE id = $1`, [cmdId])
    if (rows.length && rows[0].status !== 'pending' && rows[0].status !== 'running') { done = rows[0]; break }
  }
  check('D: runner command reached terminal state', !!done, '(таймаут 8 мин — смежный резидент-воркер не забрал?)')
  if (done) {
    const out = String(done.output || '')
    console.log(`   runner status=${done.status} exit=${done.exitCode} output(200)=${JSON.stringify(out.slice(0, 200))}`)
    if (boot && boot.ok) {
      check('D: runner tg.js whoami ok:true', /"ok":true/.test(out) && /"me"/.test(out))
    } else {
      check('D: honest no-account JSON on runner', /"ok":false/.test(out) && /подключ/.test(out))
    }
  }
  dbq(`DELETE FROM "TerminalCommand" WHERE id = $1`, [cmdId])

  console.log(`\nPASS=${PASS} FAIL=${FAIL}`)
  process.exit(FAIL ? 1 : 0)
})().catch((e) => { console.error('probe error:', e.message); process.exit(1) })
