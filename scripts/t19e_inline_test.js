// T19e live: verify the inline menu callbacks end-to-end via the REAL webhook.
// 1) callback 'chatlist'  -> guest registered, chat list sent
// 2) callback 'newchat'   -> fresh conversation created
// cleanup: test user + data; tgUsers; lastUpdateId restored to U0.
const SITE = process.env.SITE || 'https://vebai-six.vercel.app'
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
const BOT_KEY = 'telegramBot'
const USERS_KEY = 'tgUsers'
const TEST_CHAT = 555000333

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
async function webhook(body) {
  const r = await fetch(`${SITE}/api/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(55000),
  })
  return { status: r.status, body: (await r.text()).slice(0, 100) }
}

async function main() {
  const bot = await readState(BOT_KEY)
  const U0 = bot.lastUpdateId
  console.log('== 0. lastUpdateId =', U0)

  console.log('== 1. callback: chatlist ==')
  let res = await webhook({
    update_id: U0 + 500,
    callback_query: {
      id: 't19e_cb_1',
      data: 'chatlist',
      from: { id: TEST_CHAT, first_name: 'T19E' },
      message: { message_id: 990002 },
    },
  })
  console.log('  webhook HTTP', res.status, res.body)

  console.log('== 2. callback: newchat ==')
  res = await webhook({
    update_id: U0 + 501,
    callback_query: {
      id: 't19e_cb_2',
      data: 'newchat',
      from: { id: TEST_CHAT, first_name: 'T19E' },
      message: { message_id: 990003 },
    },
  })
  console.log('  webhook HTTP', res.status, res.body)

  await new Promise((r) => setTimeout(r, 3000))
  const map = await readState(USERS_KEY)
  const entry = map[String(TEST_CHAT)]
  let convs = []
  if (entry) {
    convs = await p.conversation.findMany({
      where: { userId: entry.userId },
      orderBy: { createdAt: 'desc' },
      select: { title: true, createdAt: true },
    })
  }
  const hasTgConv = convs.some((c) => (c.title || '').startsWith('Telegram'))
  const hasNewChat = convs.some((c) => (c.title || '').startsWith('Чат '))
  console.log('== 3. verify ==')
  console.log('  guest registered:', !!entry, '| conversations:', convs.length, '| Telegram conv:', hasTgConv, '| new «Чат» conv:', hasNewChat)
  console.log(hasTgConv && hasNewChat ? '  PASS - inline callbacks work end-to-end' : '  FAIL - callbacks did not complete')

  console.log('== 4. cleanup ==')
  if (entry) {
    const ids = (await p.conversation.findMany({ where: { userId: entry.userId }, select: { id: true } })).map((c) => c.id)
    await p.message.deleteMany({ where: { conversationId: { in: ids } } })
    await p.conversation.deleteMany({ where: { userId: entry.userId } })
    await p.user.deleteMany({ where: { id: entry.userId } })
    delete map[String(TEST_CHAT)]
    await writeState(USERS_KEY, map)
    console.log('  test user +', ids.length, 'conversations removed')
  }
  await writeState(BOT_KEY, { ...bot, lastUpdateId: U0 })
  console.log('  lastUpdateId restored to', U0)
  if (!(hasTgConv && hasNewChat)) process.exitCode = 1
}

main()
  .catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
  .finally(() => p.$disconnect())
