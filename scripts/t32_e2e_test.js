// T32: the site agent can READ the owner's Telegram correspondence.
// Chain: model answer ```run-tg-read``` block -> AgentTask(type='tg_read')
// -> /api/tg/work hands it to the resident worker (decrypted session) ->
// worker fetches the last N messages -> /api/tg/outbox-result kind=read ->
// transcript lands in the chat -> continueAfterRead() auto-continues the
// order (LLM, chain<=3).
//
// This probe verifies the SITE side of the protocol on PROD end-to-end (the
// real MTProto read needs the owner's connected account, which does not exist
// yet — the worker-side read is covered by code review + honest-error paths
// here). Synthetic rows only, full cleanup, secret never printed.
//   A) /api/tg/work 200 + outbox array (merged send/read contract)
//   B) read task for a broken-session account -> honest fail + account error
//   C) read task with valid crypto -> claimed by /api/tg/work with kind=read
//   D) /api/tg/outbox-result: wrong secret -> 403 (negative control)
//   E) happy-path read report: transcript in chat + AUTO-CONTINUATION message
//   F) chain cap: task with chain=3 completes WITHOUT a continuation
const { PrismaClient } = require('@prisma/client')
const crypto = require('crypto')
const { execSync } = require('child_process')

const SITE = 'https://vebai-six.vercel.app'
const GH_SESSION_ID = '42dabdf5-75f7-44b4-baad-4af0a313f0fc' // alive gh session (public id)
const EMAIL = `t32probe_${Date.now()}@vebai-test.app`
const PASSWORD = 'T32-probe-123'
const CHAT_Q = '@t32_nobody_' + Math.random().toString(36).slice(2, 8)

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

function readPayload(accountId, extra = {}) {
  return JSON.stringify({
    kind: 'read', chat: CHAT_Q, limit: 50, search: null,
    accountId, attempts: 0, chain: 0, ...extra,
  })
}

const SYNTHETIC_MSGS = [
  { id: '101', out: false, date: '2026-10-20T09:00:00.000Z', from: 'Тест Т32', text: 'Привет! Когда будет готов сценарий?' },
  { id: '102', out: true, date: '2026-10-20T09:01:00.000Z', from: 'Я (владелец)', text: 'Уже работаю над ним.' },
  { id: '103', out: false, date: '2026-10-20T09:02:00.000Z', from: 'Тест Т32', text: 'Хорошо, жду до вечера.' },
]

async function main() {
  const db = new PrismaClient()
  const url = execSync(
    `grep '^DATABASE_URL=' .env.vercel.local | cut -d= -f2- | tr -d '"'`,
    { encoding: 'utf8' },
  ).trim()
  process.env.DATABASE_URL = url
  const prod = new PrismaClient({ datasources: { db: { url } } })

  const gh = await prod.terminalSession.findUnique({ where: { id: GH_SESSION_ID } })
  const SECRET = gh && gh.secret
  check('gh session secret found in DB', typeof SECRET === 'string' && SECRET.length >= 32)
  if (!SECRET) process.exit(2)

  const reg = await fetch(SITE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'T32 Probe' }),
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

  // ---- A: worker contract (merged sends + reads)
  const wRes = await fetch(SITE + '/api/tg/work', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET }),
  })
  const wBody = await wRes.json().catch(() => ({}))
  check('A: /api/tg/work 200 + accounts', wRes.status === 200 && Array.isArray(wBody.accounts))
  check('A: /api/tg/work carries merged outbox array (T32 contract)', Array.isArray(wBody.outbox))

  // ---- B: broken session -> honest fail
  const acc1 = await prod.tgAccount.create({
    data: {
      userId, phone: '+000000000032', apiId: 1,
      apiHashEnc: 't32-garbage', sessionEnc: 't32-garbage',
      status: 'connected', active: false,
      statusText: 't32 synthetic (broken session)',
    },
  })
  const t1 = await prod.agentTask.create({
    data: {
      conversationId: convId, type: 'tg_read',
      title: 'T32 probe: read (broken session)',
      status: 'queued',
      payload: readPayload(acc1.id),
    },
  })
  await fetch(SITE + '/api/tg/work', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET }),
  })
  const t1Final = await pollDb(() => prod.agentTask.findUnique({ where: { id: t1.id } }), 60_000)
  check('B: read task honestly failed on undecryptable session',
    t1Final && t1Final.status === 'failed' && /расшифровать/i.test(t1Final.error || ''),
    t1Final && `status=${t1Final.status} error=${(t1Final.error || '').slice(0, 120)}`)
  const acc1After = await prod.tgAccount.findUnique({ where: { id: acc1.id } })
  check('B: broken account marked error', acc1After && acc1After.status === 'error')

  // ---- C: valid crypto -> claimed with kind=read
  const validEnc = encryptLikeSite('t32-fake-session', SECRET)
  const acc2 = await prod.tgAccount.create({
    data: {
      userId, phone: '+000000000033', apiId: 1,
      apiHashEnc: encryptLikeSite('t32-fake-hash', SECRET), sessionEnc: validEnc,
      status: 'connected', active: false,
      statusText: 't32 synthetic (valid crypto, fake MTProto session)',
    },
  })
  const t2 = await prod.agentTask.create({
    data: {
      conversationId: convId, type: 'tg_read',
      title: 'T32 probe: read (claim)',
      status: 'queued',
      payload: readPayload(acc2.id, { limit: 200, search: 'сценарий' }),
    },
  })
  const w2 = await fetch(SITE + '/api/tg/work', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET }),
  })
  const w2Body = await w2.json().catch(() => ({}))
  const handed = (w2Body.outbox || []).find((j) => j.id === t2.id)
  let handedOk = false
  if (handed) {
    handedOk = handed.kind === 'read' && handed.chat === CHAT_Q && handed.limit === 200 &&
      handed.search === 'сценарий' && typeof handed.session === 'string' && handed.session.length > 0
    check('C: worker received the read job (kind=read, chat/limit/search, decrypted session)', handedOk,
      JSON.stringify({ kind: handed.kind, chat: handed.chat, limit: handed.limit, hasSession: !!handed.session }).slice(0, 200))
  } else {
    const t2Claimed = await prod.agentTask.findUnique({ where: { id: t2.id } })
    handedOk = t2Claimed && t2Claimed.status !== 'queued'
    check('C: real resident worker claimed the read job first (left queued) — pass', handedOk,
      t2Claimed && `status=${t2Claimed.status} error=${(t2Claimed.error || '').slice(0, 100)}`)
  }

  // ---- D: wrong secret -> 403
  const bad = await fetch(SITE + '/api/tg/outbox-result', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'wrong-' + Date.now(), id: t2.id, ok: true, kind: 'read' }),
  })
  check('D: outbox-result wrong secret -> 403', bad.status === 403, `HTTP ${bad.status}`)

  // ---- E: happy-path read report -> transcript + AUTO-CONTINUATION
  const t3 = await prod.agentTask.create({
    data: {
      conversationId: convId, type: 'tg_read',
      title: 'T32 probe: read + auto-continue (перепиши кратко, что прочитал)',
      status: 'running',
      payload: readPayload(acc2.id, { attempts: 1 }),
    },
  })
  const rep = await fetch(SITE + '/api/tg/outbox-result', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: SECRET, id: t3.id, ok: true, kind: 'read',
      info: { peerId: '999000032', peerName: 'Тест Т32', count: SYNTHETIC_MSGS.length },
      messages: SYNTHETIC_MSGS,
    }),
  })
  check('E: read report accepted', rep.status === 200, `HTTP ${rep.status}`)
  const t3After = await prod.agentTask.findUnique({ where: { id: t3.id } })
  check('E: read task completed with summary', t3After && t3After.status === 'completed' &&
    /Прочитал/.test(t3After.result || ''), t3After && `status=${t3After.status}`)
  const trMsg = await prod.message.findFirst({
    where: { conversationId: convId, kind: 'task_result', content: { contains: 'Прочитал 3 сообщений' } },
    orderBy: { createdAt: 'desc' },
  })
  check('E: transcript task_result landed in the chat (3 lines)', !!trMsg && /\[20.10 09:02\]/.test(trMsg.content || ''),
    trMsg && (trMsg.content || '').slice(0, 80))
  const contMsg = await pollDb(() => prod.message.findFirst({
    where: { conversationId: convId, role: 'assistant', meta: { contains: '"autoContinue":true' } },
    orderBy: { createdAt: 'desc' },
  }), 180_000, 6000)
  check('E: auto-continuation LLM message appeared in the chat', !!contMsg && String(contMsg.content || '').length > 10,
    contMsg ? `len=${(contMsg.content || '').length}` : 'no continuation within 180s')

  // ---- F: chain cap -> no continuation
  const t4 = await prod.agentTask.create({
    data: {
      conversationId: convId, type: 'tg_read',
      title: 'T32 probe: read (chain cap)',
      status: 'running',
      payload: readPayload(acc2.id, { attempts: 1, chain: 3 }),
    },
  })
  const rep4 = await fetch(SITE + '/api/tg/outbox-result', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: SECRET, id: t4.id, ok: true, kind: 'read',
      info: { peerId: '999000033', peerName: 'Тест Т32b', count: 1 },
      messages: [SYNTHETIC_MSGS[0]],
    }),
  })
  const t4After = await prod.agentTask.findUnique({ where: { id: t4.id } })
  check('F: chain=3 report accepted + completed', rep4.status === 200 && t4After && t4After.status === 'completed')
  await sleep(30_000)
  const cont4 = await prod.message.findFirst({
    where: { conversationId: convId, meta: { contains: `"taskId":"${t4.id}"` } },
    orderBy: { createdAt: 'desc' },
  })
  check('F: no auto-continuation at chain cap (only the transcript itself)', !cont4)

  // duplicate read report must be a no-op
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
  console.log(`=== T32 probe: ${FAIL === 0 ? 'PASS' : 'FAIL'} (${PASS} ok, ${FAIL} failed) ===`)
  process.exitCode = FAIL === 0 ? 0 : 2
}

main().catch((e) => { console.error('probe crashed:', e.message); process.exit(2) })
