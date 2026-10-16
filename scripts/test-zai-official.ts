/**
 * Runtime smoke test of the new zai.ts (official API, fallback chain, SSE
 * parsing) — no Next.js server, no DB needed. Run: npx tsx scripts/test-zai-official.ts
 */
process.env.ZAI_API_KEY = 'e8ddbdfa72164220991ddfff79a69c6d.cOQgKpBD9NyRk1Ww'
process.env.ZAI_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
process.env.ZAI_MODEL = 'glm-4.7-flash'

import { zai } from '../src/lib/zai'
import { Readable } from 'node:stream'

async function testNonStreaming() {
  console.log('== 1) non-streaming completions (with fallback chain)')
  const res = await zai.chat.completions({
    messages: [{ role: 'user', content: 'Ответь одним словом: работает?' }],
    max_tokens: 256,
  })
  const msg = res.choices?.[0]?.message
  console.log('   content:', JSON.stringify((msg?.content || '').slice(0, 80)))
  console.log('   reasoning tail:', JSON.stringify((msg?.reasoning_content || '').slice(-60)))
  if (!msg || (!msg.content && !msg.reasoning_content)) throw new Error('empty completion')
}

async function testStream() {
  console.log('== 2) streaming completions (SSE parse + model_used event)')
  const stream = await zai.streamChat({
    messages: [{ role: 'user', content: 'Посчитай от 1 до 5 через запятую.' }],
    stream: true,
    thinking: { type: 'enabled' },
  })
  let content = ''
  let reasoning = 0
  let modelUsed = ''
  const nodeStream = Readable.fromWeb(stream as never)
  for await (const chunk of nodeStream) {
    const text = String(chunk)
    for (const line of text.split('\n')) {
      const l = line.trim()
      if (!l.startsWith('data:')) continue
      const data = l.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let p: {
        model_used?: string
        choices?: { delta?: { content?: string; reasoning_content?: string } }[]
        error?: { message?: string }
      }
      try { p = JSON.parse(data) } catch { continue }
      if (p.model_used) { modelUsed = p.model_used; continue }
      if (p.error) throw new Error(`upstream error: ${p.error.message}`)
      const delta = p.choices?.[0]?.delta
      if (delta?.reasoning_content) reasoning++
      if (delta?.content) content += delta.content
    }
  }
  console.log('   model_used:', modelUsed)
  console.log('   reasoning chunks:', reasoning)
  console.log('   content:', JSON.stringify(content.slice(0, 100)))
  if (!content.trim() && reasoning === 0) throw new Error('empty stream')
}

async function testSearch() {
  console.log('== 3) free web_search (bing rss)')
  const res = (await zai.functions.invoke('web_search', { query: 'MiniMax H3 video model', num: 3 })) as unknown as {
    data?: unknown
  }
  const items = (res as { data?: unknown[] })?.data || (res as unknown as unknown[])
  const arr = Array.isArray(items) ? items : []
  console.log('   results:', arr.length, arr.slice(0, 2).map((i) => (i as { name?: string }).name))
}

async function main() {
  await testNonStreaming()
  await testStream()
  await testSearch()
  console.log('\nALL SMOKE TESTS PASSED')
}

main().catch((e) => {
  console.error('SMOKE TEST FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
