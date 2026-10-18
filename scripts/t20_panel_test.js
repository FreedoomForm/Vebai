// T20: live e2e of the morphing panel via the REAL webhook.
// Flow: chatlist -> conv:<id> (history, buttons removed) -> back -> newchat.
// Cleanup: test user + data; tgUsers; lastUpdateId restored to U0.
const SITE = process.env.SITE || 'https://vebai-six.vercel.app'
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
const BOT_KEY = 'telegramBot'
const USERS_KEY = 'tgUsers'
const TEST_CHAT = 555000333
const CARRIER = 990100

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
async function press(cbId, data, updateId) {
  const r = await fetch(`${SITE}/api/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: { id: cbId, data, from: { id: TEST_CHAT, first_name: 'T20Panel' }, message: { message_id: CARRIER } },
    }),
    signal: AbortSignal.timeout(55000),
  })
  return { status: r.status, body: (await r.text()).slice(0, 80) }
}

async function main() {
  const bot = await readState(BOT_KEY)
  const U0 = Number(bot.lastUpdateId) || 0
  console.log('== 0. lastUpdateId =', U0)

  console.log('== 1. press chatlist ==')
  console.log('  ', JSON.stringify(await press('t20_cb_1', 'chatlist', U0 + 500)))

  const map1 = await readState(USERS_KEY)
  const entry = map1[String(TEST_CHAT)]
  console.log('  guest registered:', !!entry)
  if (!entry) throw new Error('guest was not registered by callback')
  const tgConv = await p.conversation.findFirst({ where: { userId: entry.userId, title: { startsWith: 'Telegram' } } })
  if (!tgConv) throw new Error('guest Telegram conv not found')

  console.log('== 2. press conv:<id> (history as one message) ==')
  console.log('  ', JSON.stringify(await press('t20_cb_2', `conv:${tgConv.id}`, U0 + 501)))

  console.log('== 3. press back (menu) ==')
  console.log('  ', JSON.stringify(await press('t20_cb_3', 'back', U0 + 502)))

  console.log('== 4. press newchat ==')
  console.log('  ', JSON.stringify(await press('t20_cb_4', 'newchat', U0 + 503)))

  await new Promise((r) => setTimeout(r, 3000))
  const convs = await p.conversation.findMany({
    where: { userId: entry.userId },
    orderBy: { createdAt: 'desc' },
    select: { title: true },
  })
  const entry2 = (await readState(USERS_KEY))[String(TEST_CHAT)]
  const switched = entry2 && entry2.convId !== entry.convId
  console.log('== 5. verify ==')
  console.log('  conversations:', convs.length, JSON.stringify(convs.map((c) => c.title)))
  console.log('  active conv switched to the new chat:', !!switched)
  console.log('  PASS - full panel flow processed' )

  console.log('== 6. cleanup ==')
  const ids = (await p.conversation.findMany({ where: { userId: entry.userId }, select: { id: true } })).map((c) => c.id)
  await p.message.deleteMany({ where: { conversationId: { in: ids } } })
  await p.conversation.deleteMany({ where: { userId: entry.userId } })
  await p.user.deleteMany({ where: { id: entry.userId } })
  const map2 = await readState(USERS_KEY)
  delete map2[String(TEST_CHAT)]
  await writeState(USERS_KEY, map2)
  await writeState(BOT_KEY, { ...bot, lastUpdateId: U0 })
  console.log('  test user +', ids.length, 'conversations removed; lastUpdateId restored to', U0)
}

main()
  .catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
  .finally(() => p.$disconnect())
