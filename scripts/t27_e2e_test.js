// T27 E2E: connect-your-own-Telegram-account FSM inside the official bot —
// against the REAL prod. Drives the webhook directly (Authorization: Bearer
// <bot token>, same trust level as the webhook secret — the designed smoke
// path, see t15). Synthetic chat id is beyond the real Telegram range, so
// tgSend/deleteMessage/answerCallback replies fail harmlessly ("chat not
// found") — nothing real is touched. The MTProto leg is exercised against
// Telegram's real servers with an obviously invalid number (+00000000000 ->
// PHONE_NUMBER_INVALID), so NO real code is ever sent and NO TgAccount row
// is created.
//
// Assertions:
//   A. pages intact (/ , /tg , /tgagent)
//   B. callback tgconnect  -> FSM created (step=phone) in StudioState
//   C. non-phone text      -> honest error path, FSM stays on 'phone'
//   D. +00000000000        -> MTProto PHONE_NUMBER_INVALID, FSM stays 'phone',
//                             ZERO TgAccount rows for the synthetic user
//   E. /start              -> FSM cleared (any /command cancels the connect)
//   F. toggle without account -> callback handled, FSM untouched
//   G. cleanup leaves no synthetic rows
const { execSync } = require('child_process')
const { readFileSync } = require('fs')
const SITE = 'https://vebai-six.vercel.app'
const CHAT = 9999990003 // beyond real Telegram user ids -> no real chat touched
const EMAIL = `tg_${CHAT}@telegram.vebai.app`
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
function ssJson(key) {
  const rows = dbq(`SELECT data FROM "StudioState" WHERE key = $1`, [key])
  return rows.length ? JSON.parse(rows[0].data) : {}
}
function ssWrite(key, data) {
  dbq(`UPDATE "StudioState" SET data = $1, "updatedAt" = now() WHERE key = $2`, [JSON.stringify(data), key])
}

let updateId = 0
function webhook(update) {
  return fetch(SITE + '/api/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botToken()}` },
    body: JSON.stringify({ update_id: ++updateId, ...update }),
  })
}
const msgUpdate = (text, mid) => ({
  message: { message_id: mid, text, chat: { id: CHAT, type: 'private' }, from: { id: CHAT, first_name: 'T27Probe', username: 't27probe' } },
})
const cbUpdate = (data, mid) => ({
  callback_query: { id: `t27cb${Date.now()}`, data, from: { id: CHAT, first_name: 'T27Probe', username: 't27probe' }, message: { message_id: mid } },
})

async function main() {
  if (!botToken()) { console.error('no TELEGRAM_BOT_TOKEN in .env.vercel.local'); process.exit(2) }

  console.log('== A. pages intact ==')
  for (const p of ['/', '/tg', '/tgagent']) {
    const r = await fetch(SITE + p)
    check(`${p} 200`, r.status === 200, `got ${r.status}`)
  }

  console.log('== setup: watermark + clean slate ==')
  const bot = ssJson('telegramBot')
  updateId = Number(bot.lastUpdateId || 0)
  const usersMap = ssJson('tgUsers')
  delete usersMap[String(CHAT)]
  ssWrite('tgUsers', usersMap)
  dbq(`DELETE FROM "User" WHERE email = $1`, [EMAIL])

  console.log('== B. callback tgconnect -> FSM(phone) ==')
  let r = await webhook(cbUpdate('tgconnect', 4100))
  check('webhook 200', r.status === 200)
  let fsm = ssJson('tgBotConnect')[String(CHAT)]
  check('FSM created, step=phone', !!fsm && fsm.step === 'phone', JSON.stringify(fsm))

  console.log('== C. garbage text -> honest error path, FSM holds ==')
  r = await webhook(msgUpdate('привет это не номер', 4101))
  check('webhook 200', r.status === 200)
  fsm = ssJson('tgBotConnect')[String(CHAT)]
  check('FSM still phone', !!fsm && fsm.step === 'phone', JSON.stringify(fsm))

  console.log('== D. invalid intl number -> MTProto rejects, no TgAccount ==')
  r = await webhook(msgUpdate('+00000000000', 4102))
  check('webhook 200', r.status === 200)
  await new Promise((res) => setTimeout(res, 3000)) // MTProto roundtrip finishes async? no - webhook awaited it; small grace anyway
  fsm = ssJson('tgBotConnect')[String(CHAT)]
  check('FSM still phone (no code step)', !!fsm && fsm.step === 'phone', JSON.stringify(fsm))
  const accs = dbq(`SELECT a.id FROM "TgAccount" a JOIN "User" u ON u.id = a."userId" WHERE u.email = $1`, [EMAIL])
  check('no TgAccount rows for probe user', accs.length === 0, JSON.stringify(accs))

  console.log('== E. /start cancels the FSM ==')
  r = await webhook(msgUpdate('/start', 4103))
  check('webhook 200', r.status === 200)
  fsm = ssJson('tgBotConnect')[String(CHAT)]
  check('FSM cleared', !fsm, JSON.stringify(fsm))

  console.log('== F. tgagent toggle without account ==')
  r = await webhook(cbUpdate('tgagent', 4104))
  check('webhook 200', r.status === 200)
  fsm = ssJson('tgBotConnect')[String(CHAT)]
  check('FSM still cleared', !fsm, JSON.stringify(fsm))

  console.log('== G. cleanup ==')
  const users2 = ssJson('tgUsers')
  delete users2[String(CHAT)]
  ssWrite('tgUsers', users2)
  const conn2 = ssJson('tgBotConnect')
  delete conn2[String(CHAT)]
  if (Object.keys(conn2).length || dbq(`SELECT 1 FROM "StudioState" WHERE key = 'tgBotConnect'`).length)
    ssWrite('tgBotConnect', conn2)
  dbq(`DELETE FROM "User" WHERE email = $1`, [EMAIL])
  const left = dbq(`SELECT id FROM "User" WHERE email = $1`, [EMAIL])
  check('probe user removed', left.length === 0, JSON.stringify(left))

  console.log(`\n== T27 E2E: ${FAIL === 0 ? 'PASS' : 'FAIL'} (${PASS} ok, ${FAIL} failed) ==`)
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => { console.error('E2E error:', e); process.exit(1) })
