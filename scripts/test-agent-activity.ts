/**
 * Offline verification of the agent-mode activity pipeline:
 * a mock chat.z.ai upstream emits the REAL event shapes observed on
 * chat.z.ai (type:'status', chat:completion phases thinking / tool_call /
 * tool_response / answer) and we assert that chatWebStream converts them
 * into OpenAI content chunks + zai_activity relay lines, and that the
 * agent loop surface (plain parse) keeps the content clean.
 *
 * Run:  ZAI_CHATWEB_BASE_URL=http://127.0.0.1:9099 tsx scripts/test-agent-activity.ts
 */
import http from 'node:http'

const PORT = 9099

const sse = (res: http.ServerResponse, obj: unknown) =>
  res.write(`data: ${JSON.stringify(obj)}\n\n`)

const server = http.createServer((req, res) => {
  if (req.url === '/api/v1/auths/') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      id: 'mock-user-id', token: 'mock.jwt.token', name: 'Mock', email: 'mock@test', role: 'guest',
    }))
    return
  }
  if (req.url === '/api/v1/chats/new') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id: 'mock-chat-id' }))
    return
  }
  if (req.url?.startsWith('/api/v2/chat/completions')) {
    res.setHeader('Content-Type', 'text/event-stream')
    // 1. agent status events (type:'status' — observed on chat.z.ai)
    sse(res, { type: 'status', data: { action: 'web_search', query: 'курс биткоина' } })
    sse(res, { type: 'status', data: { action: 'image_generation', title: 'кот в шляпе' } })
    // 2. thinking phase
    sse(res, { type: 'chat:completion', data: { phase: 'thinking', delta_content: 'думаю…' } })
    // 3. tool_call phase with content_blocks (site shape)
    sse(res, {
      type: 'chat:completion',
      data: {
        phase: 'tool_call',
        content_blocks: [{ type: 'tool_calls', content: [{ function: { name: 'web_search', arguments: { query: 'btc' } } }] }],
      },
    })
    sse(res, { type: 'chat:completion', data: { phase: 'tool_response', delta_content: 'ok' } })
    // 4. answer phase — first a pure delta, then FULL-so-far edit_content
    // (both styles are observed on chat.z.ai; dedupe guard must handle both)
    sse(res, { type: 'chat:completion', data: { phase: 'answer', edit_content: '<details open><summary>Мысль</summary>скрытое</details>Привет!' } })
    sse(res, { type: 'chat:completion', data: { phase: 'answer', delta_content: ' Курс — 100к.' } })
    sse(res, { type: 'chat:completion', data: { phase: 'answer', edit_content: 'Привет! Курс — 100к. Пока!' } })
    sse(res, { type: 'chat:completion', data: { phase: 'answer', edit_content: 'Привет! Курс — 100к. Пока!' } }) // stale resend
    sse(res, { type: 'chat:completion', data: { phase: 'answer', done: true } })
    res.end('data: [DONE]\n\n')
    return
  }
  res.statusCode = 404
  res.end('{}')
})

server.listen(PORT, async () => {
  const { chatWebStream } = await import('../src/lib/chatweb')
  const stream = await chatWebStream(
    [{ role: 'user', content: 'Найди курс биткоина и нарисуй кота' }],
    { transport: { sessionToken: 'mock.jwt.token' } },
  )
  const reader = (stream as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let raw = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    raw += dec.decode(value, { stream: true })
  }
  server.close()

  let content = ''
  const activities: { id: string; name?: string; args?: Record<string, unknown>; done?: boolean }[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const j = JSON.parse(payload)
      if (j.zai_activity) activities.push(j.zai_activity)
      const d = j?.choices?.[0]?.delta?.content
      if (typeof d === 'string') content += d
      if (j.error) console.log('ERROR EVENT:', j.error)
    } catch { /* skip */ }
  }

  const opened = activities.filter((a) => !a.done)
  const closed = activities.filter((a) => a.done)
  const names = opened.map((a) => a.name)

  const checks: [string, boolean][] = [
    ['activity: web_search card', names.includes('web_search')],
    ['activity: image card (generate_image)', names.includes('generate_image')],
    ['activity: thinking card', names.includes('Агент думает')],
    ['activity: tool_call content_blocks parsed', names.filter((n) => n === 'web_search').length >= 1],
    ['every opened card has a matching close', opened.length === closed.length],
    ['content has answer text', content.includes('Привет!') && content.includes('Курс — 100к.')],
    ['full-resend edit_content deduped (Пока! exactly once)', (content.match(/Пока!/g) || []).length === 1],
    ['details/summary stripped from content', !content.includes('скрытое') && !content.includes('details')],
  ]
  let failed = 0
  for (const [name, ok] of checks) {
    console.log(` ${ok ? '✅' : '❌'} ${name}`)
    if (!ok) failed++
  }
  console.log('\nactivities:', JSON.stringify(activities))
  console.log('content:', JSON.stringify(content))
  process.exit(failed ? 1 : 0)
})
