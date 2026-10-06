/**
 * E2E self-check for Vebai auth + chat proxy.
 *
 * Usage:  bun scripts/e2e-auth.ts            (BASE_URL defaults to localhost:3000)
 * Needs DATABASE_URL pointing at the same Postgres the server uses (to read
 * the captcha answer for the happy path).
 *
 * Steps:
 *  1. GET / renders the landing
 *  2. GET /api/auth/captcha returns an SVG challenge
 *  3. register with a WRONG captcha -> 400 (and the challenge is consumed)
 *  4. register with the CORRECT captcha -> 200 + session cookie
 *  5. GET /api/auth/me -> session user
 *  6. POST /api/chat -> SSE stream (deltas / tool / error events)
 *  7. GET /api/agent/state -> worker payload
 */

import { PrismaClient } from '@prisma/client'

const BASE = process.env.BASE_URL || 'http://localhost:3000'
const EMAIL = `e2e-${Date.now().toString(36)}@vebai.test`
const PASSWORD = 'e2e-password-123'
const db = new PrismaClient()

let cookie = ''
let failures = 0

function ok(name: string, cond: boolean, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init?.headers || {}),
    },
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  return res
}

async function main() {
  // 1. landing
  const page = await fetch(`${BASE}/`)
  const html = await page.text()
  ok('GET / renders', page.status === 200 && /Нейро-Архитектор/.test(html), `status ${page.status}`)

  // 2. captcha endpoint
  const capRes = await api('/api/auth/captcha')
  const cap = (await capRes.json()) as { id: string; svg: string }
  ok('GET /api/auth/captcha', capRes.status === 200 && !!cap.id && cap.svg.startsWith('<svg'), `${cap?.id}`)

  // 3. wrong captcha rejected
  const badRes = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'E2E', captchaId: cap.id, captchaText: 'XXXXX' }),
  })
  const bad = (await badRes.json()) as { error?: string }
  ok('register wrong captcha -> 400', badRes.status === 400, bad.error || '')
  const consumed = await db.captcha.findUnique({ where: { id: cap.id } })
  ok('wrong attempt consumes challenge', consumed === null, '')

  // 4. correct captcha
  const cap2Res = await api('/api/auth/captcha')
  const cap2 = (await cap2Res.json()) as { id: string; svg: string }
  const row = await db.captcha.findUnique({ where: { id: cap2.id } })
  ok('challenge stored in DB', !!row?.answer, '')
  const regRes = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'E2E', captchaId: cap2.id, captchaText: row!.answer }),
  })
  const reg = (await regRes.json()) as { user?: { id: string }; error?: string }
  ok('register correct captcha -> 200', regRes.status === 200 && !!reg.user?.id, reg.error || reg.user?.id || '')
  ok('session cookie set', cookie.startsWith('vb_session='), '')

  // 5. session
  const meRes = await api('/api/auth/me')
  const me = (await meRes.json()) as { user?: { email: string } }
  ok('GET /api/auth/me', meRes.status === 200 && me.user?.email === EMAIL, me.user?.email || '')

  // 6. chat via proxy (guest or ZAI_JWT; guest may hit z.ai captcha — both are valid outcomes)
  console.log('— POST /api/chat (SSE)…')
  const chatRes = await api('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ content: 'Ответь ровно одним словом: работает' }),
  })
  ok('POST /api/chat starts stream', chatRes.status === 200 && !!chatRes.body, `status ${chatRes.status}`)
  if (chatRes.body) {
    const reader = (chatRes.body as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    let buf = ''
    let text = ''
    const events = new Map<string, number>()
    const deadline = Date.now() + 60_000
    let errored = ''
    outer: while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try {
          const evt = JSON.parse(payload) as { type?: string; text?: string; message?: string }
          const t = evt.type || '?'
          events.set(t, (events.get(t) || 0) + 1)
          if (t === 'delta' && evt.text) text += evt.text
          if (t === 'error') errored = evt.message || 'unknown'
          if (t === 'done') break outer
        } catch { /* heartbeat or partial */ }
      }
    }
    const flat = text.replace(/\s+/g, ' ').trim()
    ok('chat stream produced events', events.size > 0, `types: ${[...events.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}`)
    if (errored) console.log(`[INFO] upstream says: ${errored.slice(0, 200)}`)
    else ok('chat produced answer text', flat.length > 0, `"${flat.slice(0, 120)}"`)
  }

  // 7. agent state
  const stateRes = await api('/api/agent/state')
  ok('GET /api/agent/state', stateRes.status === 200, `status ${stateRes.status}`)

  await db.$disconnect()
  console.log(failures === 0 ? '\nE2E: ALL PASS' : `\nE2E: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E crashed:', e)
  process.exit(1)
})
