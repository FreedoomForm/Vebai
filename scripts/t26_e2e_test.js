// T26 E2E: personal telegram agents, through the REAL production site.
// Checks the page, auth gates, the AI coach (rules -> prompt), the honest
// activation gate, 3-variant simulation + variant approval, and the MTProto
// connect plumbing against real Telegram (fake creds -> honest error).
const { execSync } = require('child_process')
const SITE = 'https://vebai-six.vercel.app'
const EMAIL = `t26agent_${Date.now()}@vebai-test.app`
const PASSWORD = 'T26-pass-123'
let PASS = 0, FAIL = 0
function check(name, cond, extra = '') {
  if (cond) { PASS++; console.log(`  ✓ ${name}`) }
  else { FAIL++; console.log(`  ✗ ${name} ${extra}`) }
}

async function j(res, tag) {
  const txt = await res.text()
  try { return JSON.parse(txt) } catch {
    throw new Error(`${tag}: HTTP ${res.status}, не-JSON ответ: ${txt.slice(0, 120) || '(пусто)'}`)
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
  console.log('== 1. page /tgagent renders ==')
  const page = await fetch(SITE + '/tgagent')
  const html = await page.text()
  check('page 200', page.status === 200)
  check('hero text present', html.includes('Telegram-агент'))
  const mini = await fetch(SITE + '/tg')
  check('mini app /tg intact (200)', mini.status === 200)

  console.log('== 2. auth gates ==')
  const st401 = await fetch(SITE + '/api/tg/state')
  check('state unauthed -> 401', st401.status === 401)
  const co401 = await fetch(SITE + '/api/tg/coach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  check('coach unauthed -> 401', co401.status === 401)

  console.log('== 3. register throwaway ==')
  const reg = await fetch(SITE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'T26 Test' }),
  })
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0]
  check('register ok', reg.status === 200 && !!cookie)

  console.log('== 4. state: empty, needApiCreds ==')
  const s0 = await j(await fetch(SITE + '/api/tg/state', { headers: { cookie } }), 'state')
  check('no account yet', s0.account === null)
  check('needApiCreds=true (no env creds)', s0.needApiCreds === true)

  console.log('== 5. AI coach: rules in words -> prompt updated (real ZAI) ==')
  const coachRes = await fetch(SITE + '/api/tg/coach', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ message: 'С Мирсаидом общайся официально и всегда создавай файлы, которые он попросит, а незнакомым отвечай коротко' }),
  })
  const cd = await j(coachRes, 'coach')
  check('coach ok', coachRes.status === 200 && cd.ok === true, JSON.stringify(cd).slice(0, 150))
  check('prompt mentions Мирсаид', /Мирсаид/i.test(cd.systemPrompt || ''), (cd.systemPrompt || '').slice(0, 120))
  check('prompt mentions файлы', /файл/i.test(cd.systemPrompt || ''))
  console.log('  coach reply:', (cd.reply || '').slice(0, 140))

  console.log('== 6. activation gate (honest: not connected yet) ==')
  const act = await fetch(SITE + '/api/tg/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ active: true }),
  })
  check('active=true without connection -> 400', act.status === 400, `got ${act.status}`)

  console.log('== 7. simulate: 3 variants (real ZAI) ==')
  const simRes = await fetch(SITE + '/api/tg/simulate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ fromName: 'Мирсаид', text: 'Привет! Скинь, пожалуйста, отчёт по проекту до вечера' }),
  })
  const sd = await j(simRes, 'simulate')
  check('simulate ok', simRes.status === 200 && sd.ok === true, JSON.stringify(sd).slice(0, 150))
  check('2-3 variants returned', Array.isArray(sd.variants) && sd.variants.length >= 2 && sd.variants.length <= 3, `${(sd.variants || []).length}`)
  console.log('  variants:', (sd.variants || []).map((v) => `${v.style}: ${v.text.slice(0, 40)}…`).join(' | '))

  console.log('== 8. approve variant -> example saved ==')
  const pick = await fetch(SITE + '/api/tg/variant', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ fromName: 'Мирсаид', incoming: 'Привет! Скинь отчёт по проекту до вечера', chosen: (sd.variants || [{}])[0].text }),
  })
  const pd = await j(pick, 'variant')
  check('variant saved', pick.status === 200 && pd.ok === true && (pd.examples || []).length === 1)

  console.log('== 9. MTProto connect plumbing (fake creds -> honest Telegram error) ==')
  const conn = await fetch(SITE + '/api/tg/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ phone: '+00000000000', apiId: 1234567, apiHash: 'deadbeefdeadbeefdeadbeefdeadbeef' }),
  })
  const cd2 = await j(conn, 'connect')
  check('connect rejects with honest error', conn.status === 400 && typeof cd2.error === 'string' && cd2.error.length > 3, JSON.stringify(cd2).slice(0, 160))
  console.log('  telegram says:', (cd2.error || '').slice(0, 140))

  console.log('== 10. worker endpoint: secret gate ==')
  const w403 = await fetch(SITE + '/api/tg/work', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  check('work without secret -> 403', w403.status === 403)

  console.log('== 11. disconnect + cleanup ==')
  const disc = await fetch(SITE + '/api/tg/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie } })
  check('disconnect ok', disc.status === 200)
  await dbq(`DELETE FROM "User" WHERE email = $1`, [EMAIL])
  const left = await dbq(`SELECT count(*)::int AS n FROM "TgAccount"`, [])
  check('cascade left no Tg accounts', (left[0] || {}).n === 0)

  console.log(`=== T26 E2E: ${FAIL === 0 ? 'PASS' : 'FAIL'} (${PASS} ok, ${FAIL} failed) ===`)
  process.exitCode = FAIL === 0 ? 0 : 2
}

main().catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1 })
