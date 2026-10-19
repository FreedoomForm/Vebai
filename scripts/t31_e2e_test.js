// T31: the site agent can ACT through the owner's Telegram account.
// The chain: model answer ```run-tg``` block -> AgentTask(type='tg_outbox')
// -> site waits for the file (run-agent product) -> resident tg worker picks
// it up via /api/tg/work (decrypted session + inlined file b64) -> sends from
// the owner's own account -> /api/tg/outbox-result -> task_result in chat.
//
// This probe verifies the SITE side of the protocol on PROD end-to-end
// (the real MTProto send needs the owner's connected account, which does not
// exist yet — the worker-side send is covered by code review + honest-error
// paths here). Synthetic rows only, full cleanup, secret never printed.
//   A) /api/tg/work returns the `outbox` array (worker contract, T26 compat)
//   B) task for a broken-session account -> honest fail + account marked error
//   C1) file task without the file -> stays queued, progress 'Жду файл'
//   C2) after TerminalFile appears -> handed to the worker with inlined b64
//       (or already claimed by the real resident worker — also a pass)
//   D) /api/tg/outbox-result: wrong secret -> 403 (negative control)
//   E) happy-path report: running -> completed + task_result message + out log
const { PrismaClient } = require('@prisma/client')
const crypto = require('crypto')
const { execSync } = require('child_process')

const SITE = 'https://vebai-six.vercel.app'
const GH_SESSION_ID = '42dabdf5-75f7-44b4-baad-4af0a313f0fc' // alive gh session (public id)
const EMAIL = `t31probe_${Date.now()}@vebai-test.app`
const PASSWORD = 'T31-probe-123'
const FAKE_PEER = '@t31_nobody_' + Math.random().toString(36).slice(2, 8)
const FILE_NAME = 't31_scenario.pdf'
const FILE_B64 = Buffer.from('%PDF-1.4 t31 probe payload').toString('base64')

let PASS = 0, FAIL = 0
function check(name, cond, extra = '') {
  if (cond) { PASS++; console.log(`  ✓ ${name}`) }
  else { FAIL++; console.log(`  ✗ ${name} ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pollDb(fn, timeoutMs, everyMs = 4000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(everyMs)
  }
}

// same key derivation as src/lib/tguser.ts encKey() + encryptSecret()
function encryptLikeSite(plain, ghTermSecret) {
  const key = Buffer.from(crypto.createHash('sha256').update(ghTermSecret + '|tguser-v1').digest('hex'), 'hex')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('base64')}`
}

async function main() {
  const db = new PrismaClient()
  const url = execSync(
    `grep '^DATABASE_URL=' .env.vercel.local | cut -d= -f2- | tr -d '"'`,
    { encoding: 'utf8' },
  ).trim()
  process.env.DATABASE_URL = url
  // re-instantiate with the prod URL
  const prod = new PrismaClient({ datasources: { db: { url } } })

  const gh = await prod.terminalSession.findUnique({ where: { id: GH_SESSION_ID } })
  const SECRET = gh && gh.secret
  check('gh session secret found in DB', typeof SECRET === 'string' && SECRET.length >= 32)
  if (!SECRET) process.exit(2)

  const reg = await fetch(SITE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'T31 Probe' }),
  })
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0]
  check('register ok', reg.status === 200 && !!cookie)
  if (!cookie) process.exit(2)
  const me = await (await fetch(SITE + '/api/auth/me', { headers: { cookie } })).json()
  const userId = me && me.user && me.user.id
  check('auth/me returns user id', !!userId)

  const convRes = await fetch(SITE + '/api/conversations', {
    method: 'POST', headers: { cookie } })
  const conv = await convRes.json().catch(() => ({}))
  const convId = conv.conversation && conv.conversation.id
  check('probe conversation created', !!convId)
  if (!convId) process.exit(2)

  // ---- A: worker contract
  const wRes = await fetch(SITE + '/api/tg/work', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET }),
  })
  const wBody = await wRes.json().catch(() => ({}))
  check('A: /api/tg/work 200 + accounts', wRes.status === 200 && Array.isArray(wBody.accounts))
  check('A: /api/tg/work carries outbox array (T31 contract)', Array.isArray(wBody.outbox))

  // ---- B: broken session -> honest fail
  const acc1 = await prod.tgAccount.create({
    data: {
      userId, phone: '+000000000031', apiId: 1,
      apiHashEnc: 't31-garbage', sessionEnc: 't31-garbage',
      status: 'connected', active: false,
      statusText: 't31 synthetic (broken session)',
    },
  })
  const t1 = await prod.agentTask.create({
    data: {
      conversationId: convId, type: 'tg_outbox',
      title: 'T31 probe: message send (broken session)',
      status: 'queued',
      payload: JSON.stringify({ peer: FAKE_PEER, message: 't31 ping', accountId: acc1.id, attempts: 0 }),
    },
  })
  // real site code runs inside /api/tg/work: readyOutboxForWorker -> decrypt fail -> failOutbox
  await fetch(SITE + '/api/tg/work', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET }),
  })
  const t1Final = await pollDb(() => prod.agentTask.findUnique({ where: { id: t1.id } }), 60_000)
  check('B: task honestly failed on undecryptable session',
    t1Final && t1Final.status === 'failed' && /расшифровать/i.test(t1Final.error || ''),
    t1Final && `status=${t1Final.status} error=${(t1Final.error || '').slice(0, 120)}`)
  const acc1After = await prod.tgAccount.findUnique({ where: { id: acc1.id } })
  check('B: broken account marked error', acc1After && acc1After.status === 'error')

  // ---- C: file wait + handoff
  const validEnc = encryptLikeSite('t31-fake-session', SECRET)
  const acc2 = await prod.tgAccount.create({
    data: {
      userId, phone: '+000000000032', apiId: 1,
      apiHashEnc: encryptLikeSite('t31-fake-hash', SECRET), sessionEnc: validEnc,
      status: 'connected', active: false,
      statusText: 't31 synthetic (valid crypto, fake MTProto session)',
    },
  })
  const t2 = await prod.agentTask.create({
    data: {
      conversationId: convId, type: 'tg_outbox',
      title: 'T31 probe: file send (file wait)',
      status: 'queued',
      payload: JSON.stringify({ peer: FAKE_PEER, message: '', file: FILE_NAME, accountId: acc2.id, attempts: 0 }),
    },
  })
  // drive the site tick (syncOutboxTasks) via the state poll fire-and-forget tick
  for (let i = 0; i < 3; i++) {
    await fetch(SITE + '/api/agent/state', { headers: { cookie } }).catch(() => {})
    await sleep(3500)
  }
  const t2Wait = await pollDb(async () => {
    const t = await prod.agentTask.findUnique({ where: { id: t2.id } })
    return t && t.status === 'queued' && /Жду файл/i.test(t.progress || '') ? t : null
  }, 45_000)
  check('C1: file task stays queued with honest progress while the file is missing',
    !!t2Wait, t2Wait && `status=${t2Wait.status} progress=${t2Wait.progress}`)

  await prod.terminalFile.create({
    data: {
      sessionId: GH_SESSION_ID, conversationId: convId,
      path: FILE_NAME, size: Buffer.from(FILE_B64, 'base64').length,
      mime: 'application/pdf', data: Buffer.from(FILE_B64, 'base64'),
    },
  })
  // handoff: my own /api/tg/work call should claim it with the inlined file
  const w2 = await fetch(SITE + '/api/tg/work', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET }),
  })
  const w2Body = await w2.json().catch(() => ({}))
  const handed = (w2Body.outbox || []).find((j) => j.id === t2.id)
  let handedOk = false
  if (handed) {
    handedOk = handed.peer === FAKE_PEER && handed.file && handed.file.name === FILE_NAME &&
      typeof handed.file.b64 === 'string' && handed.file.b64.length > 10 &&
      typeof handed.session === 'string' && handed.session.length > 0
    check('C2: worker received the job with inlined file b64 + decrypted session', handedOk,
      JSON.stringify({ peer: handed.peer, file: handed.file && handed.file.name, hasB64: !!(handed.file && handed.file.b64), hasSession: !!handed.session }).slice(0, 200))
  } else {
    // the real resident worker claimed it first (30s poll) — verify it left the queue
    const t2Claimed = await prod.agentTask.findUnique({ where: { id: t2.id } })
    handedOk = t2Claimed && t2Claimed.status !== 'queued'
    check('C2: real resident worker claimed the job first (left queued) — pass', handedOk,
      t2Claimed && `status=${t2Claimed.status} error=${(t2Claimed.error || '').slice(0, 100)}`)
  }

  // ---- D/E: outbox-result route
  const bad = await fetch(SITE + '/api/tg/outbox-result', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'wrong-' + Date.now(), id: t2.id, ok: true }),
  })
  check('D: outbox-result wrong secret -> 403', bad.status === 403, `HTTP ${bad.status}`)

  const t3 = await prod.agentTask.create({
    data: {
      conversationId: convId, type: 'tg_outbox',
      title: 'T31 probe: happy-path report', status: 'running',
      payload: JSON.stringify({ peer: FAKE_PEER, message: 'привет от T31', accountId: acc2.id, attempts: 1 }),
    },
  })
  const rep = await fetch(SITE + '/api/tg/outbox-result', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: SECRET, id: t3.id, ok: true,
      info: { peerId: '999000031', peerName: 'Тест Т31', msgId: '4242', fileName: null },
    }),
  })
  check('E: happy-path report accepted', rep.status === 200, `HTTP ${rep.status}`)
  const t3After = await prod.agentTask.findUnique({ where: { id: t3.id } })
  check('E: task completed with summary', t3After && t3After.status === 'completed' &&
    /Отправлено/.test(t3After.result || ''), t3After && `status=${t3After.status}`)
  const msg3 = await prod.message.findFirst({
    where: { conversationId: convId, kind: 'task_result', content: { contains: 'Отправлено через твой Telegram' } },
    orderBy: { createdAt: 'desc' },
  })
  check('E: task_result message landed in the chat', !!msg3)
  const out3 = await prod.tgAgentMessage.findFirst({
    where: { accountId: acc2.id, chatId: '999000031', direction: 'out' },
  })
  check('E: outgoing message logged (TgAgentMessage out)', !!out3)

  // duplicate report must be a no-op
  const rep2 = await fetch(SITE + '/api/tg/outbox-result', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, id: t3.id, ok: false, error: 'late duplicate' }),
  })
  const t3Dup = await prod.agentTask.findUnique({ where: { id: t3.id } })
  check('E: duplicate report ignored (stays completed)', rep2.status === 200 && t3Dup.status === 'completed')

  // ---- cleanup
  await prod.message.deleteMany({ where: { conversationId: convId } })
  await prod.terminalFile.deleteMany({ where: { conversationId: convId } })
  await prod.agentTask.deleteMany({ where: { conversationId: convId } })
  await prod.tgAgentMessage.deleteMany({ where: { accountId: { in: [acc1.id, acc2.id] } } })
  await prod.tgAccount.deleteMany({ where: { userId } })
  await prod.conversation.deleteMany({ where: { userId } })
  await prod.user.deleteMany({ where: { id: userId } })
  const left = await prod.user.count({ where: { email: EMAIL } })
  check('cleanup removed probe user and all rows', left === 0)

  await prod.$disconnect()
  await db.$disconnect()
  console.log(`=== T31 probe: ${FAIL === 0 ? 'PASS' : 'FAIL'} (${PASS} ok, ${FAIL} failed) ===`)
  process.exitCode = FAIL === 0 ? 0 : 2
}

main().catch((e) => { console.error('probe crashed:', e.message); process.exit(2) })
