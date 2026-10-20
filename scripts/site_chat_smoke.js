// Live smoke test of the SITE chat (fast path, no GitHub involved):
// register a throwaway user -> session cookie -> POST /api/chat/stream ->
// read the SSE stream -> expect real model content. Also pings /api/conversations.
const SITE = 'https://vebai-six.vercel.app'
const EMAIL = `sitecheck_${Date.now()}@vebai-test.app`

async function main() {
  console.log('== 1. register ==')
  const reg = await fetch(SITE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: 'Sitecheck#2026', name: 'Site Check' }),
  })
  console.log('  register:', reg.status)
  const setCookie = reg.headers.get('set-cookie') || ''
  const cookie = setCookie.split(';')[0]
  if (reg.status !== 200 || !cookie) {
    console.log('  body:', (await reg.text()).slice(0, 200))
    process.exit(1)
  }

  console.log('== 2. conversations ==')
  const convs = await fetch(SITE + '/api/conversations', { headers: { cookie } })
  console.log('  conversations:', convs.status, (await convs.text()).slice(0, 120))

  console.log('== 3. chat stream (real model call) ==')
  const t0 = Date.now()
  const res = await fetch(SITE + '/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Ответь ровно одним словом: работает' }],
      conversationId: '',
    }),
  })
  console.log('  stream status:', res.status, '| content-type:', res.headers.get('content-type'))
  if (res.status !== 200) {
    console.log('  body:', (await res.text()).slice(0, 300))
    process.exit(1)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', deltas = 0, firstDeltaMs = 0, sample = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    for (const line of buf.split('\n\n')) {
      const m = line.match(/^data: (.*)$/m)
      if (!m) continue
      try {
        const ev = JSON.parse(m[1])
        if (ev.type === 'delta' && ev.text) {
          if (!firstDeltaMs) firstDeltaMs = Date.now() - t0
          deltas++
          sample += ev.text
        }
        if (ev.type === 'error') console.log('  STREAM ERROR EVENT:', JSON.stringify(ev).slice(0, 300))
      } catch { /* not json */ }
    }
    buf = buf.slice(buf.lastIndexOf('\n\n') + 2)
    if (Date.now() - t0 > 90_000) break
  }
  console.log(`  deltas: ${deltas}, first delta in ${firstDeltaMs}ms`)
  console.log('  answer sample:', JSON.stringify(sample.slice(0, 200)))
  console.log(deltas > 0 ? '  PASS - site chat streams real model output' : '  FAIL - no deltas from the model')
  process.exit(deltas > 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
