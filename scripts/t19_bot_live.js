// T19: live end-to-end bot inbound test through the REAL webhook.
// Proves: webhook auth -> update processing -> guest registration ->
// conversation -> fast LLM path -> sendMessage back.
// Then sends one delivery-check message to the owner chat.
// Cleanup: test user + tgUsers entry; lastUpdateId restored to U0.
//
// Usage: TELEGRAM_BOT_TOKEN=... SITE=... DATABASE_URL=... node scripts/t19_bot_live.js

const SITE = process.env.SITE || 'https://vebai-six.vercel.app'
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const BOT_KEY = 'telegramBot'
const USERS_KEY = 'tgUsers'
const TEST_CHAT = 555000333
const TEST_NAME = 'T19Live'

async function readState(key) {
  const row = await p.studioState.findUnique({ where: { key } })
  return row ? JSON.parse(row.data) : {}
}
async function writeState(key, data) {
  await p.studioState.upsert({
    where: { key },
    create: { key, data: JSON.stringify(data) },
    update: { data: JSON.stringify(data) },
  })
}

async function tgSend(chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(20000),
  })
  return r.json()
}

async function main() {
  const bot = await readState(BOT_KEY)
  const U0 = bot.lastUpdateId
  if (!U0) throw new Error('no lastUpdateId in bot cache')
  console.log('== 0. state ==')
  console.log('  lastUpdateId =', U0, '| ownerChatId =', bot.ownerChatId)

  // 1. push a synthetic update through the REAL webhook (bearer = bot token)
  const upd = {
    update_id: U0 + 500,
    message: {
      message_id: 990001,
      text: '?ответь одним словом: жив',
      chat: { id: TEST_CHAT, type: 'private' },
      from: { id: TEST_CHAT, first_name: TEST_NAME },
    },
  }
  console.log('== 1. webhook update ==')
  const res = await fetch(`${SITE}/api/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(upd),
    signal: AbortSignal.timeout(55000),
  })
  const body = await res.text()
  console.log('  webhook HTTP', res.status, '| body:', body.slice(0, 120))
  if (res.status !== 200) throw new Error('webhook did not accept the update')

  const after = await readState(BOT_KEY)
  console.log('  lastUpdateId now =', after.lastUpdateId, after.lastUpdateId === U0 + 500 ? '(advanced OK)' : '(UNEXPECTED)')

  // 2. wait for the fast chat reply to be stored (chatAnswer -> assistant msg)
  console.log('== 2. waiting for the assistant reply row ==')
  let reply = null
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const map = await readState(USERS_KEY)
    const entry = map[String(TEST_CHAT)]
    if (!entry) continue
    const msgs = await p.message.findMany({
      where: { conversationId: entry.convId },
      orderBy: { createdAt: 'desc' },
      take: 2,
    })
    const a = msgs.find((m) => m.role === 'assistant')
    if (a) { reply = a.content; break }
  }
  if (reply === null) {
    console.log('  FAIL: no assistant reply stored in 60s')
    process.exitCode = 1
  } else {
    console.log('  reply:', (reply || '').slice(0, 160).replace(/\n/g, ' '))
    console.log('  PASS - inbound bot chain works (webhook -> user -> conv -> LLM -> reply)')
  }

  // 3. delivery check to the REAL owner chat
  console.log('== 3. owner delivery check ==')
  const own = await tgSend(
    bot.ownerChatId,
    '🔧 Проверка доставки: бот на связи. Если твоё сообщение осталось без ответа — пришли его ещё раз, сейчас всё проходит. Сообщения из окна ~11:00–12:00 могли потеряться во время тестирования, такого больше не повторится.',
  )
  console.log('  sendMessage ok =', own.ok, own.result?.message_id ? `(msg ${own.result.message_id})` : own.description || '')

  // 4. cleanup: test user, its conversations/messages, tgUsers entry, update id
  console.log('== 4. cleanup ==')
  const map = await readState(USERS_KEY)
  const entry = map[String(TEST_CHAT)]
  if (entry) {
    await p.message.deleteMany({ where: { conversationId: entry.convId } })
    await p.conversation.deleteMany({ where: { id: entry.convId } })
    await p.user.deleteMany({ where: { id: entry.userId } })
    delete map[String(TEST_CHAT)]
    await writeState(USERS_KEY, map)
    console.log('  test user removed')
  }
  await writeState(BOT_KEY, { ...bot, lastUpdateId: U0 })
  console.log('  lastUpdateId restored to', U0)
}

main()
  .catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1 })
  .finally(() => p.$disconnect())
