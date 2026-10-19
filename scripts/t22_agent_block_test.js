// T22 E2E: site chat -> run-agent block -> resident #!agent loop -> result.
// Registers a throwaway user, talks to /api/chat/start + /api/chat/stream
// like the browser does, expects the model to dispatch a run-agent task for
// a PDF job, then polls the DB until the agent finishes and the result
// message + TerminalFile land in the conversation.
const { execSync } = require('child_process')
const SITE = 'https://vebai-six.vercel.app'
const EMAIL = `t22agent_${Date.now()}@vebai-test.app`
const PASSWORD = 'T22-pass-123'
const PROMPT =
  'Создай PDF-файл t22_loop.pdf: одна страница, заголовок «Тест T22», под ним строка «Цепочка обратной связи работает». Файл должен реально существовать и прийти в чат.'

function dbq(sql, params = []) {
  const out = execSync(
    `DATABASE_URL=$(grep '^DATABASE_URL=' .env.vercel.local | cut -d= -f2- | tr -d '"') node scripts/dbq.js '${sql.replace(/'/g, "'\\''")}' '${JSON.stringify(params)}'`,
    { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return JSON.parse(out.trim() || '[]')
}

async function main() {
  console.log('== 1. register ==')
  const reg = await fetch(SITE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'T22 Test' }),
  })
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0]
  if (reg.status !== 200 || !cookie) {
    console.log('  register failed:', reg.status, (await reg.text()).slice(0, 200))
    process.exit(1)
  }
  console.log('  ok, cookie acquired')

  console.log('== 2. chat/start ==')
  const st = await fetch(SITE + '/api/chat/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ conversationId: '', content: PROMPT }),
  })
  const std = await st.json()
  if (!st.ok || !std.conversationId) {
    console.log('  start failed:', st.status, JSON.stringify(std).slice(0, 200))
    process.exit(1)
  }
  const convId = std.conversationId
  console.log('  conversation:', convId)

  console.log('== 3. chat/stream (expect run-agent dispatch) ==')
  const res = await fetch(SITE + '/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      messages: std.history || [{ role: 'user', content: PROMPT }],
      conversationId: convId,
    }),
  })
  console.log('  stream status:', res.status)
  if (res.status !== 200) {
    console.log('  body:', (await res.text()).slice(0, 300))
    process.exit(1)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let notices = []
  let deltas = ''
  let model = ''
  streamLoop: for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    for (const line of buf.split('\n\n').slice(0, -1)) {
      const m = line.match(/^data: (.*)$/m)
      if (!m) continue
      let ev
      try { ev = JSON.parse(m[1]) } catch { continue }
      if (ev.type === 'start') model = ev.model || model
      if (ev.type === 'notice') notices.push(ev.text)
      if (ev.type === 'delta' && ev.text) deltas += ev.text
      if (ev.type === 'error') { console.log('  STREAM ERROR:', JSON.stringify(ev).slice(0, 300)); break streamLoop }
    }
    buf = buf.slice(buf.lastIndexOf('\n\n') + 2)
  }
  console.log('  model:', model)
  console.log('  notices:', JSON.stringify(notices, null, 2).slice(0, 600))
  console.log('  visible answer (first 200):', deltas.replace(/\s+/g, ' ').slice(0, 200))
  const agentNotice = notices.find((n) => n.includes('автономному агенту'))
  const termNotice = notices.find((n) => n.includes('Linux-воркер'))
  if (!agentNotice) {
    console.log(termNotice ? '  !! model used run-terminal instead of run-agent' : '  !! no dispatch notice at all')
  } else {
    console.log('  ✓ run-agent dispatch notice received')
  }

  console.log('== 4. poll DB for the #!agent task ==')
  const t0 = Date.now()
  let task = null
  while (Date.now() - t0 < 10 * 60_000) {
    const rows = await dbq(
      `SELECT id, status, "payload"::text AS payload, error FROM "AgentTask" WHERE "conversationId"::text = $1 AND type='terminal' ORDER BY "createdAt" DESC LIMIT 1`,
      [convId],
    )
    task = rows[0] || null
    if (task && (task.status === 'completed' || task.status === 'failed')) break
    process.stdout.write(`  [${Math.round((Date.now() - t0) / 1000)}s] status=${task ? task.status : 'none'}\n`)
    await new Promise((r) => setTimeout(r, 15_000))
  }
  if (!task) { console.log('  !! task never appeared'); process.exit(1) }
  const isAgentCmd = (task.payload || '').includes('#!agent')
  console.log(`  task ${task.id}: status=${task.status} #!agent=${isAgentCmd} error=${(task.error || '').slice(0, 120)}`)

  console.log('== 5. verify result message + file ==')
  const msgs = await dbq(
    `SELECT kind, "content" FROM "Message" WHERE "conversationId"::text = $1 ORDER BY "createdAt" DESC LIMIT 3`,
    [convId],
  )
  const result = msgs.find((m) => (m.content || '').startsWith('🤖'))
  console.log('  result message:', result ? result.content.replace(/\s+/g, ' ').slice(0, 220) : 'NOT FOUND')
  const files = await dbq(
    `SELECT path, size FROM "TerminalFile" WHERE "conversationId"::text = $1 ORDER BY "createdAt" DESC LIMIT 5`,
    [convId],
  )
  console.log('  terminal files:', JSON.stringify(files))

  console.log('== 6. cleanup ==')
  await dbq(`DELETE FROM "User" WHERE email = $1`, [EMAIL])
  console.log('  test user (cascade conversations/messages/tasks) deleted')

  const ok = isAgentCmd && task.status === 'completed' && result && files.some((f) => f.path.includes('t22_loop'))
  console.log(ok ? '=== T22 E2E: PASS ===' : '=== T22 E2E: CHECK OUTPUT ABOVE (partial) ===')
  process.exit(ok ? 0 : 2)
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
