/**
 * Offline unit test of the Z.ai retry/backoff policy in src/lib/zai.ts.
 * Mocks global.fetch: no network. Run: npx tsx scripts/test-retry.ts
 * (tsx is not a dependency — use `bun run` or `npx tsx`, both work offline
 * for a type-stripped file; bun is present in the dev image.)
 */
import { zai, isRetryableError } from '../src/lib/zai'

type Call = { model: string; n: number }
const calls: Call[] = []
let script: { status: number; body: unknown }[][] = [] // per-call queue

function mockFetch() {
  ;(globalThis as { fetch?: unknown }).fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string }
    const m = calls.find((c) => c.model === body.model)
    if (m) m.n++
    else calls.push({ model: body.model, n: 1 })
    const next = script.shift()
    if (!next) throw new Error('mock: no scripted response for ' + body.model)
    const r = next.shift() as { status: number; body: unknown } | undefined
    if (!r) throw new Error('mock: scripted responses exhausted for ' + body.model)
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

// Run with: ZAI_RETRY_DELAYS_MS=10,20,30 ZAI_API_KEY=test-key bun scripts/test-retry.ts
// (env vars must precede the import — RETRY_DELAYS_MS is read at module load)

const okCompletion = {
  choices: [{ message: { content: 'ok' } }],
  usage: { total_tokens: 1 },
}
const busy = { error: { code: '1302', message: '模型调用过高' } }
const overloaded = { error: { code: '1305', message: '负载已饱和，请稍后重试' } }
const badRequest = { error: { code: '1214', message: 'invalid params' } }

async function expect(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`)
  if (!cond) process.exitCode = 1
}

async function main() {
  // 0. classifier sanity
  expect('1302 classified retryable', isRetryableError(429, JSON.stringify(busy)))
  expect('1305 classified retryable', isRetryableError(500, JSON.stringify(overloaded)))
  expect('1214 NOT retryable', !isRetryableError(400, JSON.stringify(badRequest)))

  // 1. 429 twice then success on the SAME model → no fallback needed
  calls.length = 0
  mockFetch()
  script = [
    [{ status: 429, body: busy }],
    [{ status: 429, body: busy }],
    [{ status: 200, body: okCompletion }],
  ]
  const r1 = await zai.chat.completions({ messages: [{ role: 'user', content: 'hi' }] })
  expect('retry-then-success returns answer', r1.choices?.[0]?.message?.content === 'ok')
  expect('no fallback after successful retry', calls.every((c) => c.model !== 'glm-4.7-flash'), JSON.stringify(calls))

  // 2. persistent 1305 on primary → exhausts retries → falls back to 4.7-flash
  calls.length = 0
  script = [
    [{ status: 500, body: overloaded }],
    [{ status: 500, body: overloaded }],
    [{ status: 500, body: overloaded }],
    [{ status: 500, body: overloaded }], // primary: initial + 3 retries
    [{ status: 200, body: okCompletion }], // fallback succeeds immediately
  ]
  const r2 = await zai.chat.completions({ messages: [{ role: 'user', content: 'hi' }] })
  expect('fallback answers after exhausted retries', r2.choices?.[0]?.message?.content === 'ok')
  const primary = calls.find((c) => c.model === 'glm-4.5-flash')
  const fallback = calls.find((c) => c.model === 'glm-4.7-flash')
  expect('primary tried exactly 4x', primary?.n === 4, `n=${primary?.n}`)
  expect('fallback tried once', fallback?.n === 1, `n=${fallback?.n}`)

  // 3. non-retryable 400 → immediate fail, no fallback, no retries
  calls.length = 0
  script = [[{ status: 400, body: badRequest }]]
  let threw = ''
  try {
    await zai.chat.completions({ messages: [{ role: 'user', content: 'hi' }] })
  } catch (e) {
    threw = (e as Error).message
  }
  expect('non-retryable throws fast', threw.includes('1214'), threw)
  expect('no retry on 400', (calls.find((c) => c.model === 'glm-4.5-flash')?.n || 0) === 1)

  console.log('done. calls:', JSON.stringify(calls))
}

void main()
