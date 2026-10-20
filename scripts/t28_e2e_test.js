// T28 E2E (prod): agent lives in the chat.
//   0) wait for the deploy: POST /api/tg/chat must answer 401 (route exists),
//      /tgagent must contain the new connect-page markup
//   1) throwaway user -> POST /api/tg/chat creates the agent conversation,
//      second call returns the SAME id (idempotent), StudioState pointer exists
//   2) chat turn INSIDE the agent conversation streams an answer (agent persona)
//   3) a NORMAL new conversation still streams (regression)
//   4) loadAgentContext: the agent-chat transcript is picked up (db check of
//      messages + pointer), then full cleanup
// No secrets in this file; no MTProto calls (connect flow covered by T26/T27).
const { execSync } = require('child_process')
const SITE = 'https://vebai-six.vercel.app'
const EMAIL = `t28probe_${Date.now()}@vebai-test.app`
const PASSWORD = 'T28-probe-123'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** read an SSE chat stream until done/error; returns { answer, error } */
async function streamChat(cookie, conversationId, messages) {
  const res = await fetch(SITE + '/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ messages, conversationId, effort: 'high', model: 'glm-4.7-flash' }),
    signal: AbortSignal.timeout(240_000),
  })
  if (!res.ok || !res.body) return { answer: '', error: `stream ${res.status}` }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', answer = '', error = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      let evt
      try { evt = JSON.parse(line.slice(5).trim()) } catch { continue }
      if (evt.type === 'delta') answer += evt.text || ''
      if (evt.type === 'error') error = evt.message || 'stream error'
    }
  }
  return { answer, error }
}

async function main() {
  // ---- 0) deploy readiness
  let live = false
  for (let i = 0; i < 40; i++) {
    const r = await fetch(SITE + '/api/tg/chat', { method: 'POST' }).catch(() => null)
    if (r && r.status === 401) { live = true; break }
    console.log(`  …deploy ${r ? r.status : 'net'} (try ${i + 1})`)
    await sleep(15_000)
  }
  check('new deploy live (/api/tg/chat -> 401 unauthorized)', live)
  if (!live) process.exit(2)

  const page = await (await fetch(SITE + '/tgagent')).text()
  // SSR renders the loading state (client component) — the deploy marker is
  // the page <title> + absence of the old rules-editor heading in the bundle
  check('/tgagent is the simple connect page (new title, no rules editor)',
    /Подключить Telegram-агента — Vebai/.test(page) && !/Правила агента/.test(page))

  // ---- 1) auth + agent conversation
  const reg = await fetch(SITE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'T28 Probe' }),
  })
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0]
  check('register ok', reg.status === 200 && !!cookie, `status ${reg.status}`)
  if (!cookie) process.exit(2)

  const c1 = await j(await fetch(SITE + '/api/tg/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie } }), 'tg/chat #1')
  check('POST /api/tg/chat -> conversationId', !!c1.conversationId, JSON.stringify(c1).slice(0, 120))
  const c2 = await j(await fetch(SITE + '/api/tg/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie } }), 'tg/chat #2')
  check('second call returns the SAME conversation (idempotent)', c2.conversationId === c1.conversationId, `${c2.conversationId} vs ${c1.conversationId}`)

  const ptr = dbq(`SELECT data FROM "StudioState" WHERE key = $1`, [`tguser-chat:${(await j(await fetch(SITE + '/api/auth/me', { headers: { cookie } }), 'me')).user.id}`])
  check('StudioState pointer tguser-chat:<uid> exists', ptr.length === 1 && String(ptr[0].data || '').includes(c1.conversationId), JSON.stringify(ptr).slice(0, 120))

  const st = await j(await fetch(SITE + '/api/tg/state', { headers: { cookie } }), 'state')
  check('state: account null (not connected yet)', st.account === null)

  // ---- 2) agent-persona turn inside the agent conversation
  const start1 = await j(await fetch(SITE + '/api/chat/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ conversationId: c1.conversationId, content: 'Правило: если кто-то спросит про тест T28 — отвечай коротко «тест идёт».' }),
  }), 'chat/start #1')
  check('chat/start in agent conv ok', !!start1.conversationId && Array.isArray(start1.history), JSON.stringify(start1).slice(0, 100))
  const s1 = await streamChat(cookie, c1.conversationId, start1.history)
  check('agent-conv stream produced an answer', s1.answer.trim().length > 0 && !s1.error, (s1.error || s1.answer.slice(0, 60)).slice(0, 120))

  // commit the answer so loadAgentContext sees the full pair
  await fetch(SITE + '/api/chat/commit', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ conversationId: c1.conversationId, content: s1.answer || 'ок' }),
  })

  // ---- 3) normal chat regression
  const start2 = await j(await fetch(SITE + '/api/chat/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ content: 'Скажи одно слово: работает' }),
  }), 'chat/start #2')
  const s2 = await streamChat(cookie, start2.conversationId, start2.history)
  check('normal (non-agent) chat still streams', s2.answer.trim().length > 0 && !s2.error, (s2.error || s2.answer.slice(0, 60)).slice(0, 120))

  // ---- 4) transcript present in DB (loadAgentContext source)
  const uid = (await j(await fetch(SITE + '/api/auth/me', { headers: { cookie } }), 'me2')).user.id
  const msgs = dbq(`SELECT count(*)::int AS n FROM "Message" WHERE "conversationId" = $1`, [c1.conversationId])
  check('agent conversation has the user+assistant transcript', (msgs[0] || {}).n >= 2, JSON.stringify(msgs))

  // ---- cleanup
  const del = await fetch(`${SITE}/api/conversations/${c1.conversationId}`, { method: 'DELETE', headers: { cookie } })
  await fetch(`${SITE}/api/conversations/${start2.conversationId}`, { method: 'DELETE', headers: { cookie } }).catch(() => {})
  dbq(`DELETE FROM "StudioState" WHERE key = $1`, [`tguser-chat:${uid}`])
  dbq(`DELETE FROM "User" WHERE email = $1`, [EMAIL])
  const leftU = dbq(`SELECT count(*)::int AS n FROM "User" WHERE email = $1`, [EMAIL])
  const leftC = dbq(`SELECT count(*)::int AS n FROM "Conversation" WHERE id = ANY($1)`, [[c1.conversationId, start2.conversationId]])
  check('cleanup: user and conversations removed', (leftU[0] || {}).n === 0 && (leftC[0] || {}).n === 0, JSON.stringify({ leftU, leftC }))
  check('agent conversation DELETE endpoint worked', del.status === 200 || del.status === 404, `status ${del.status}`)

  console.log(`\n=== T28 E2E: ${FAIL === 0 ? 'PASS' : 'FAIL'} (${PASS} ok, ${FAIL} failed) ===`)
  process.exitCode = FAIL === 0 ? 0 : 2
}

main().catch((e) => { console.error('fatal:', e); process.exit(1) })
