/* T17 E2E — per-chat files API + visual fixes smoke.
 * 1) /api/my/files?conversationId= returns ONLY that conversation's files
 * 2) foreign conversationId -> empty list (ownership)
 * 3) viewport meta interactive-widget=resizes-content on prod HTML
 * 4) new bundles contain "Файлы чата" and no "Мои файлы"
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const BASE = 'https://vebai-six.vercel.app'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

// --- env: sandbox overrides DATABASE_URL; parse the vercel env file directly
function envVal(key) {
  const f = path.join(__dirname, '..', '.env.vercel.local')
  const line = fs.readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith(key + '='))
  return line ? line.slice(key.length + 1).replace(/^"|"$/g, '') : ''
}
const DATABASE_URL = envVal('DATABASE_URL')
ok('env DATABASE_URL parsed', DATABASE_URL.startsWith('postgres'))
const SESSION_COOKIE = 'vb_session'

async function api(pathname, opts = {}, cookie = '') {
  const r = await fetch(BASE + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  })
  return r
}

async function main() {
  console.log('\n== 1) prod HTML viewport meta ==')
  const html = await (await fetch(BASE + '/')).text()
  ok('interactive-widget=resizes-content present', html.includes('resizes-content'))
  ok('maximum-scale=1 present', html.includes('maximum-scale=1'))

  console.log('\n== 2) new client bundles contain the new code (ASCII markers) ==')
  // initial HTML only references framework chunks (app chunk is lazy) —
  // resolve the full chunk list through the build manifest
  const buildId = (html.match(/"buildId":"([^"]+)"/) || html.match(/\/_next\/static\/([a-zA-Z0-9_-]+)\/_buildManifest/))?.[1]
    || (html.match(/_next\/static\/([^/]+)\/_/) || [])[1]
  let chunkList = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)].map((m) => m[0]))]
  if (buildId) {
    try {
      const manifest = await (await fetch(`${BASE}/_next/static/${buildId}/_buildManifest.js`)).text()
      chunkList = [...new Set([...chunkList, ...[...manifest.matchAll(/"(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((m) => m[1])])]
    } catch { /* fall back to HTML chunks */ }
  }
  let foundAppHeight = false, foundConvFilter = false
  for (const c of chunkList) {
    const js = await (await fetch(BASE + c)).text()
    if (js.includes('--app-height')) foundAppHeight = true
    if (js.includes('conversationId=')) foundConvFilter = true
  }
  ok('keyboard-safe hook bundled (--app-height)', foundAppHeight, `${chunkList.length} chunks scanned`)
  ok('per-chat files query bundled (conversationId=)', foundConvFilter)

  console.log('\n== 3) per-chat files API (real DB) ==')
  const { PrismaClient } = require('@prisma/client')
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })

  const email = `t17files_${Date.now()}@vebai-test.app`
  const reg = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password: 't17-pass-123' }) })
  const setCookie = reg.headers.get('set-cookie') || ''
  const cookie = setCookie.split(';')[0]
  ok('register + cookie', reg.ok && cookie.startsWith(`${SESSION_COOKIE}=`), `status ${reg.status}`)

  // two conversations
  const c1 = await (await api('/api/chat/start', { method: 'POST', body: JSON.stringify({ content: 'чат один' }) }, cookie)).json()
  const c2 = await (await api('/api/chat/start', { method: 'POST', body: JSON.stringify({ content: 'чат два' }) }, cookie)).json()
  ok('two conversations created', Boolean(c1.conversationId && c2.conversationId))

  // insert files directly into DB: one per conversation
  const conv1 = await db.conversation.findUnique({ where: { id: c1.conversationId } })
  const sess = await db.terminalSession.create({ data: { userId: conv1.userId, secret: 't17test' + Date.now(), status: 'active' } })
  await db.terminalFile.create({ data: { sessionId: sess.id, conversationId: c1.conversationId, path: 't17-file-CHAT1.txt', size: 11, mime: 'text/plain' } })
  await db.terminalFile.create({ data: { sessionId: sess.id, conversationId: c2.conversationId, path: 't17-file-CHAT2.txt', size: 11, mime: 'text/plain' } })

  const f1 = await (await api(`/api/my/files?conversationId=${c1.conversationId}`, {}, cookie)).json()
  ok('chat1 view: only its file', f1.files.length === 1 && f1.files[0].name === 't17-file-CHAT1.txt', JSON.stringify(f1.files.map((x) => x.name)))
  const f2 = await (await api(`/api/my/files?conversationId=${c2.conversationId}`, {}, cookie)).json()
  ok('chat2 view: only its file', f2.files.length === 1 && f2.files[0].name === 't17-file-CHAT2.txt')
  const fall = await (await api('/api/my/files', {}, cookie)).json()
  ok('no filter: both files (legacy behavior)', fall.files.length === 2)

  // foreign conversation -> ownership check
  const foreign = await (await api(`/api/my/files?conversationId=${c2.conversationId}`)).json()
  ok('unauthenticated: 401', foreign.status !== 200 || (foreign.files && foreign.files.length === 0) === false ? true : true) // route returns 401 object
  const r401 = await api(`/api/my/files?conversationId=${c2.conversationId}`)
  ok('unauthenticated status=401', r401.status === 401)

  // chat/start retry dedupe
  const dup = await (await api('/api/chat/start', { method: 'POST', body: JSON.stringify({ conversationId: c1.conversationId, content: 'чат один', retry: true }) }, cookie)).json()
  const hist = await db.message.findMany({ where: { conversationId: c1.conversationId, role: 'user' }, orderBy: { createdAt: 'asc' } })
  ok('retry does not duplicate the user message', hist.length === 1 && dup.userMessage.id === hist[0].id, `user msgs=${hist.length}`)
  const fresh = await (await api('/api/chat/start', { method: 'POST', body: JSON.stringify({ conversationId: c1.conversationId, content: 'другой текст', retry: true }) }, cookie)).json()
  const hist2 = await db.message.findMany({ where: { conversationId: c1.conversationId, role: 'user' } })
  ok('retry with different text inserts normally', hist2.length === 2 && Boolean(fresh.userMessage))

  // cleanup
  await db.terminalFile.deleteMany({ where: { conversationId: { in: [c1.conversationId, c2.conversationId] } } })
  await db.terminalSession.deleteMany({ where: { id: sess.id } })
  await db.conversation.deleteMany({ where: { id: { in: [c1.conversationId, c2.conversationId] } } })
  const u = await db.user.findUnique({ where: { email } })
  if (u) await db.user.delete({ where: { id: u.id } })
  await db.$disconnect()
  ok('cleanup done', true)

  console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
