/**
 * E2E test for the Z.ai captcha-relay architecture (Vebai 0.5).
 *
 * Prerequisites:
 *   - dev server on :3000 (AUTH_REQUIRED=true, Postgres via DATABASE_URL)
 *   - a REAL one-time Z.ai captcha param (solved by the relayed Aliyun widget)
 *     passed via ZAI_CAPTCHA_PARAM (see scripts/README or worklog)
 *
 * Steps:
 *   1. GET  /            — landing renders
 *   2. GET  /api/auth/captcha — must be 404 (homemade captcha is REMOVED)
 *   3. POST /api/auth/register without captcha param — rejected 400
 *   4. POST /api/auth/register with a STALE param — rejected 400 (z.ai verify fails)
 *   5. POST /api/auth/register with a REAL param — 200, session cookie, user
 *      gets a private anonymous z.ai session (zaiToken stored server-side)
 *   6. GET  /api/auth/me — user identity
 *   7. POST /api/chat without param — SSE contains captcha_required event
 *      (Z.ai demands the captcha; UI relays the widget)
 *   8. POST /api/chat with a fresh REAL param, resume=true — SSE streams the
 *      agent answer (z.ai accepted the captcha)
 *
 * Usage: ZAI_CAPTCHA_PARAM=... ZAI_CAPTCHA_PARAM2=... tsx scripts/e2e-auth.ts
 */
import crypto from 'node:crypto'

const BASE = process.env.E2E_BASE || 'http://localhost:3000'
const REAL1 = process.env.ZAI_CAPTCHA_PARAM || ''
const REAL2 = process.env.ZAI_CAPTCHA_PARAM2 || ''

let cookie = ''
let pass = 0
let fail = 0

function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  return res
}

/** Read an SSE stream and collect event types + text deltas. */
async function readSSE(res: Response): Promise<{ types: string[]; text: string; captchaRequired: boolean }> {
  const types: string[] = []
  let text = ''
  let captchaRequired = false
  if (!res.body) return { types, text, captchaRequired }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of block.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        try {
          const evt = JSON.parse(t.slice(5)) as { type?: string; text?: string }
          if (evt.type) types.push(evt.type)
          if (evt.type === 'captcha_required') captchaRequired = true
          if (evt.type === 'delta' && evt.text) text += evt.text
          if (evt.type === 'message') {
            const m = evt as unknown as { message?: { content?: string } }
            if (m.message?.content) text += m.message.content
          }
        } catch { /* partial */ }
      }
    }
  }
  return { types, text, captchaRequired }
}

async function main() {
  console.log('\n=== Vebai 0.5 E2E — Z.ai captcha relay ===\n')

  // 1. landing
  const landing = await fetch(`${BASE}/`)
  ok('landing renders', landing.ok)

  // 2. homemade captcha route removed
  const oldCaptcha = await fetch(`${BASE}/api/auth/captcha`)
  ok('old SVG captcha route removed (404)', oldCaptcha.status === 404, `status ${oldCaptcha.status}`)

  // 3. register without captcha
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@vebaitest.org`
  const noCaptcha = await post('/api/auth/register', { email, password: 'e2epass123', name: 'E2E' })
  ok('register without captcha rejected', noCaptcha.status === 400, `status ${noCaptcha.status}`)

  // 4. register with garbage param (unique email — attempts never share rows)
  const email2 = `e2e-${crypto.randomUUID().slice(0, 8)}@vebaitest.org`
  const badCaptcha = await post('/api/auth/register', {
    email: email2, password: 'e2epass123', name: 'E2E', zaiCaptchaParam: 'garbage-param',
  })
  ok('register with fake captcha rejected', badCaptcha.status === 400, `status ${badCaptcha.status}`)

  // 5. register with REAL captcha param
  if (!REAL1) {
    console.log('  ⚠️  ZAI_CAPTCHA_PARAM not set — skipping live steps 5-8')
  } else {
    const email3 = `e2e-${crypto.randomUUID().slice(0, 8)}@vebaitest.org`
    const good = await post('/api/auth/register', {
      email: email3, password: 'e2epass123', name: 'E2E', zaiCaptchaParam: REAL1,
    })
    ok('register with REAL z.ai captcha', good.ok, `status ${good.status}`)
    if (good.ok) {
      // 6. session
      const me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
      const meData = (await me.json().catch(() => ({}))) as { user?: { email?: string } }
      ok('/api/auth/me returns user', meData.user?.email === email3, JSON.stringify(meData).slice(0, 80))

      // 7. chat without param -> captcha_required event
      const chatRes = await post('/api/chat', { content: 'Ответь одним словом: ТЕСТ' })
      const sse1 = await readSSE(chatRes)
      const cid = chatRes.headers.get('X-Conversation-Id') || ''
      ok(
        'chat without param -> captcha_required',
        sse1.captchaRequired,
        `events: ${sse1.types.join(',')}`,
      )

      // 8. chat with fresh param + resume -> real answer
      if (REAL2 && cid) {
        const chat2 = await post('/api/chat', {
          conversationId: cid,
          content: 'Ответь одним словом: ТЕСТ',
          captchaVerifyParam: REAL2,
          resume: true,
        })
        const sse2 = await readSSE(chat2)
        ok(
          'chat with REAL param streams answer',
          sse2.text.trim().length > 0 && !sse2.captchaRequired,
          `answer: ${sse2.text.trim().slice(0, 60) || '(empty)'} | events: ${sse2.types.join(',')}`,
        )
        // no duplicate user message: history must contain exactly one user msg
        // (resume=true skips re-persisting it)
      } else {
        console.log('  ⚠️  ZAI_CAPTCHA_PARAM2 not set — skipping the answered-chat step')
      }
    }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
