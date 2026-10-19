// T15 E2E: telegram bot <-> site account linking, against the REAL prod.
// Uses the webhook's designed smoke path (Authorization: Bearer <bot token>,
// same trust level as the webhook secret). Synthetic chat ids are beyond the
// real Telegram id range -> tgSend replies fail harmlessly ("chat not found").
// update_id: continues prod's counter (+1, +2) so nothing real is skipped.
const { execSync } = require('child_process')
const { readFileSync } = require('fs')
const SITE = 'https://vebai-six.vercel.app'
const EMAIL = `t15prod_${Date.now()}@vebai-test.app`
const PASSWORD = 'T15-pass-123'
const CHAT = 9999990001 // beyond real Telegram user ids -> no real chat touched
let PASS = 0, FAIL = 0
function check(name, cond, extra = '') {
  if (cond) { PASS++; console.log(`  ✓ ${name}`) }
  else { FAIL++; console.log(`  ✗ ${name} ${extra}`) }
}
function botToken() {
  const line = readFileSync('.env.vercel.local', 'utf8')
    .split('\n').find((l) => l.startsWith('TELEGRAM_BOT_TOKEN='))
  return line ? line.slice('TELEGRAM_BOT_TOKEN='.length).replace(/"/g, '').trim() : ''
}
function dbq(sql, params = []) {
  const out = execSync(
    `DATABASE_URL=$(grep '^DATABASE_URL=' .env.vercel.local | cut -d= -f2- | tr -d '"') node scripts/dbq.js '${sql.replace(/'/g, "'\\''")}' '${JSON.stringify(params)}'`,
    { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return JSON.parse(out.trim() || '[]')
}
async function webhook(text, updateId) {
  return fetch(SITE + '/api/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botToken()}` },
    body: JSON.stringify({
      update_id: updateId,
      message: { message_id: updateId, text, chat: { id: CHAT, type: 'private' }, from: { id: CHAT, first_name: 'T15Probe', username: 't15probe' } },
    }),
  })
}

async function main() {
  if (!botToken()) { console.error('no TELEGRAM_BOT_TOKEN in .env.vercel.local'); process.exit(2) }

  console.log('== 1. pages intact ==')
  const home = await fetch(SITE + '/')
  check('site 200', home.status === 200)
  const mini = await fetch(SITE + '/tg')
  check('mini app 200', mini.status === 200)
  const html = await home.text()
  check('«Подключить Telegram» in app bundle', html.includes('Подключить Telegram') || html.includes('Подкл'), 'button missing')

  console.log('== 2. register throwaway site user A ==')
  const reg = await fetch(SITE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'T15 Prod' }),
  })
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0]
  check('register ok', reg.status === 200 && !!cookie, `HTTP ${reg.status}`)

  console.log('== 3. link API (site side) ==')
  const un = await fetch(SITE + '/api/settings/telegram/link')
  check('unauth -> 401', un.status === 401, `got ${un.status}`)
  const st0 = await fetch(SITE + '/api/settings/telegram/link', { headers: { cookie } }).then((r) => r.json())
  check('connected=false initially', st0.connected === false, JSON.stringify(st0))
  const link = await fetch(SITE + '/api/settings/telegram/link', { method: 'POST', headers: { cookie } }).then((r) => r.json())
  const m = /start=connect_([0-9a-f]+)/.exec(link.url || '')
  check('deep link with one-time token', !!m, JSON.stringify(link).slice(0, 160))
  if (!m) process.exit(2)
  const token = m[1]
  const tokRow = dbq(`SELECT data FROM "StudioState" WHERE key = 'tgLinkTokens'`, [])
  check('token stored (24h ttl)', tokRow.length === 1 && !!JSON.parse(tokRow[0].data)[token], 'missing')

  console.log('== 4. webhook: stranger /start -> auto-account ==')
  const L = (dbq(`SELECT data FROM "StudioState" WHERE key = 'telegramBot'`, [])[0] || {})
  const lastId = (JSON.parse(L.data || '{}').lastUpdateId) || 0
  let r1 = await webhook('/start', lastId + 1)
  check('/start accepted', r1.status === 200)
  const auto = dbq(`SELECT id, "telegramChatId" FROM "User" WHERE email = $1`, [`tg_${CHAT}@telegram.vebai.app`])
  check('auto-account by telegram user id', auto.length === 1 && auto[0].telegramChatId === String(CHAT), JSON.stringify(auto).slice(0, 140))
  const usersMap = dbq(`SELECT data FROM "StudioState" WHERE key = 'tgUsers'`, [])[0]
  check('tgUsers entry created', usersMap && !!JSON.parse(usersMap.data)[String(CHAT)], 'missing entry')

  console.log('== 5. webhook: /start connect_<token> -> link + merge ==')
  let r2 = await webhook(`/start connect_${token}`, lastId + 2)
  check('connect accepted', r2.status === 200)
  const a1 = dbq(`SELECT id, email, "telegramChatId", "telegramUsername" FROM "User" WHERE id = $1`, [JSON.parse(tokRow[0].data)[token].userId])
  check('site account linked to chat', a1.length === 1 && a1[0].telegramChatId === String(CHAT), JSON.stringify(a1).slice(0, 160))
  check('telegram username captured', a1[0]?.telegramUsername === 't15probe', String(a1[0]?.telegramUsername))
  const autoAfter = dbq(`SELECT "telegramChatId" FROM "User" WHERE id = $1`, [auto[0]?.id])
  check('auto-account detached from chat', autoAfter.length === 1 && autoAfter[0].telegramChatId === null, JSON.stringify(autoAfter))
  const merged = dbq(
    `SELECT count(*)::int AS n FROM "Conversation" WHERE "userId" = $1 AND title LIKE 'Telegram%'`,
    [a1[0]?.id],
  )
  check('bot conversation merged into account', (merged[0]?.n || 0) >= 1, JSON.stringify(merged))
  const tokGone = dbq(`SELECT data FROM "StudioState" WHERE key = 'tgLinkTokens'`, [])[0]
  check('token burned after use', tokGone && !JSON.parse(tokGone.data)[token], 'still valid')
  const st1 = await fetch(SITE + '/api/settings/telegram/link', { headers: { cookie } }).then((r) => r.json())
  check('GET reports connected', st1.connected === true && st1.chatId === String(CHAT), JSON.stringify(st1))

  console.log('== 6. cleanup ==')
  await dbq(`DELETE FROM "User" WHERE email = $1 OR email = $2`, [EMAIL, `tg_${CHAT}@telegram.vebai.app`])
  const mapRow = dbq(`SELECT data FROM "StudioState" WHERE key = 'tgUsers'`, [])[0]
  if (mapRow) {
    const map = JSON.parse(mapRow.data)
    delete map[String(CHAT)]
    dbq(`UPDATE "StudioState" SET data = $1 WHERE key = 'tgUsers'`, [JSON.stringify(map)])
  }
  const left = dbq(`SELECT count(*)::int AS n FROM "User" WHERE email LIKE 't15prod_%' OR email LIKE 'tg\\_9999990001%' ESCAPE '\\'`, [])
  check('test users gone', (left[0]?.n || 0) === 0, JSON.stringify(left))
  console.log('  (prod lastUpdateId advanced by 2 — real Telegram ids are higher, nothing skipped)')

  console.log(`=== T15 prod E2E: ${FAIL === 0 ? 'PASS' : 'FAIL'} (${PASS} ok, ${FAIL} failed) ===`)
  process.exitCode = FAIL === 0 ? 0 : 2
}

main().catch((e) => { console.error('e2e crashed:', e); process.exit(2) })
