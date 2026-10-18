// T21: live e2e via the REAL webhook — the chatPicked gate (owner request:
// no talking to the AI agent until a chat is created or picked).
// Flow: text WITHOUT a picked chat -> blocked; newchat callback -> chatPicked;
// text again -> AgentTask created. Cleanup: test user/data, lastUpdateId -> 0
// (T19f rule: NEVER restore a saved counter, synthetic ids must not poison).
const SITE = process.env.SITE || 'https://vebai-six.vercel.app'
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
const BOT_KEY = 'telegramBot'
const USERS_KEY = 'tgUsers'
const TEST_CHAT = 555000444

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
async function sendUpdate(updateId, payload) {
  const r = await fetch(`${SITE}/api/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ update_id: updateId, ...payload }),
    signal: AbortSignal.timeout(55000),
  })
  return { status: r.status, body: (await r.text()).slice(0, 80) }
}
const textMsg = (updateId, text, msgId) => sendUpdate(updateId, {
  message: { message_id: msgId, text, chat: { id: TEST_CHAT, type: 'private' }, from: { id: TEST_CHAT, first_name: 'T21Gate' } },
})
const press = (updateId, data, cbId) => sendUpdate(updateId, {
  callback_query: { id: cbId, data, from: { id: TEST_CHAT, first_name: 'T21Gate' }, message: { message_id: 990200 } },
})

async function main() {
  const bot0 = await readState(BOT_KEY)
  console.log('== 0. neutralize the dup filter for the test (lastUpdateId -> 0) ==')
  await writeState(BOT_KEY, { ...bot0, lastUpdateId: 0 })

  console.log('== 1. text WITHOUT a picked chat must NOT create an AgentTask ==')
  console.log('  ', JSON.stringify(await textMsg(987650001, 'сделай мне сайт', 991001)))
  const map1 = await readState(USERS_KEY)
  const entry = map1[String(TEST_CHAT)]
  if (!entry) throw new Error('guest was not registered')
  const tasks1 = await p.agentTask.count({ where: { conversationId: entry.convId } })
  console.log('  registered:', !!entry, '| agent tasks:', tasks1, '| chatPicked:', entry.chatPicked)
  if (tasks1 !== 0) throw new Error('GATE FAILED: a task was created without a picked chat')
  if (entry.chatPicked) throw new Error('chatPicked must be false here')

  console.log('== 2. "?"-fast chat is blocked the same way (no LLM message) ==')
  console.log('  ', JSON.stringify(await textMsg(987650002, '?привет', 991002)))
  const msgs2 = await p.message.count({ where: { conversationId: entry.convId } })
  console.log('  messages in conv:', msgs2)
  if (msgs2 !== 0) throw new Error('GATE FAILED: fast chat wrote history without a picked chat')

  console.log('== 3. newchat callback -> chatPicked=true ==')
  console.log('  ', JSON.stringify(await press(987650003, 'newchat', 't21_cb_1')))
  const entry2 = (await readState(USERS_KEY))[String(TEST_CHAT)]
  console.log('  chatPicked:', entry2.chatPicked)
  if (!entry2.chatPicked) throw new Error('newchat did not set chatPicked')

  console.log('== 4. text now passes: AgentTask created in the NEW chat ==')
  console.log('  ', JSON.stringify(await textMsg(987650004, 'тестовая задача T21: напиши hello.txt', 991003)))
  await new Promise((r) => setTimeout(r, 2500))
  const convNow = (await readState(USERS_KEY))[String(TEST_CHAT)].convId
  const tasks4 = await p.agentTask.count({ where: { conversationId: convNow, type: 'terminal' } })
  console.log('  active conv:', convNow.slice(-6), '| terminal tasks:', tasks4)
  if (tasks4 < 1) throw new Error('task was not created after a chat was picked')

  console.log('== 5. cleanup (user + data + counter) ==')
  const ids = (await p.conversation.findMany({ where: { userId: entry.userId }, select: { id: true } })).map((c) => c.id)
  await p.agentTask.deleteMany({ where: { conversationId: { in: ids } } })
  await p.terminalCommand.deleteMany({ where: { conversationId: { in: ids } } })
  await p.message.deleteMany({ where: { conversationId: { in: ids } } })
  await p.conversation.deleteMany({ where: { userId: entry.userId } })
  await p.user.deleteMany({ where: { id: entry.userId } })
  const map2 = await readState(USERS_KEY)
  delete map2[String(TEST_CHAT)]
  await writeState(USERS_KEY, map2)
  await writeState(BOT_KEY, { ...bot0, lastUpdateId: 0 })
  console.log('  test user +', ids.length, 'conversation(s) removed; lastUpdateId -> 0 (T19f rule)')

  console.log('\nPASS — T21 gate works end-to-end')
}

main()
  .catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
  .finally(() => p.$disconnect())
