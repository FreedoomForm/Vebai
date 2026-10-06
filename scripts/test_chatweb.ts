/** Runtime test of src/lib/chatweb.ts: guest session -> expect a mapped error
 * (captcha/level), renderPrompt sanity. Run: bun scripts/test_chatweb.ts */
import { renderPrompt, resolveSession, chatWebComplete, DEFAULT_CHATWEB_MODEL } from '../src/lib/chatweb'

async function main() {
  console.log('model default:', DEFAULT_CHATWEB_MODEL)

  const prompt = renderPrompt([
    { role: 'system', content: 'Ты полезный агент.' },
    { role: 'user', content: 'Привет' },
    { role: 'assistant', content: 'Привет! Чем помочь?' },
    { role: 'user', content: 'Скажи одно слово: тест' },
  ])
  console.log('--- rendered prompt ---')
  console.log(prompt)

  console.log('--- resolveSession (guest) ---')
  const session = await resolveSession(null)
  console.log('guest session ok:', session.email, '| role:', session.role, '| uid:', session.userId)

  console.log('--- chatWebComplete (guest, expect mapped error) ---')
  const res = await chatWebComplete(
    [{ role: 'user', content: 'Скажи одно слово: тест' }],
    { model: 'glm-4.7' },
  )
  console.log('answer:', JSON.stringify(res.choices[0].message.content).slice(0, 500))
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e)
  process.exit(1)
})
