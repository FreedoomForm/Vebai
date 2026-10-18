// T12 E2E step 1: direct test of POST /api/terminal/gh/send (deployed).
// Reads the gh TerminalSession (id+secret) from Neon DB, then:
//   (a) text   -> owner   (expect ok:true, textSent:1)
//   (b) file   -> owner   (expect ok:true, filesSent:1)
//   (c) text   -> channel (expect ok:true)
//   (d) bad chat "banana" (expect ok:false, error про получателя)
// Usage: DATABASE_URL=$(grep -m1 '^DATABASE_URL' vebai/.env.vercel.local | cut -d= -f2- | tr -d '"') node scripts/test_send_route.js
const { Client } = require('pg')

const SITE = 'https://vebai-six.vercel.app'

async function send(secret, session, payload) {
  const res = await fetch(SITE + '/api/terminal/gh/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, session, ...payload }),
    signal: AbortSignal.timeout(120000),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

;(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  const s = await c.query(
    `SELECT id, secret, "lastSeenAt" FROM "TerminalSession" WHERE kind='gh' ORDER BY "createdAt" DESC LIMIT 1`)
  await c.end()
  if (!s.rows.length) throw new Error('нет gh-сессии в БД')
  const { id, secret } = s.rows[0]
  console.log('session:', id, '| lastSeen:', s.rows[0].lastSeenAt)

  const fileB64 = Buffer.from('Vebai <send> test file — если ты это видишь, доставка файлов работает.\n').toString('base64')

  console.log('(a) text -> owner:', JSON.stringify(await send(secret, id, {
    chat: 'owner', text: '🧪 Тест нового <send> агента: текстовая доставка работает (можно удалить).',
  })))
  await new Promise(r => setTimeout(r, 1500))
  console.log('(b) file -> owner:', JSON.stringify(await send(secret, id, {
    chat: 'me', files: [{ name: 'vebai_send_test.txt', b64: fileB64 }], text: 'Тестовый файл доставки',
  })))
  await new Promise(r => setTimeout(r, 1500))
  console.log('(c) text -> channel:', JSON.stringify(await send(secret, id, {
    chat: 'channel', text: '🧪 Агент научился отправлять сообщения адресно (тест, можно удалить).',
  })))
  console.log('(d) bad chat:', JSON.stringify(await send(secret, id, {
    chat: 'banana', text: 'x',
  })))
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
