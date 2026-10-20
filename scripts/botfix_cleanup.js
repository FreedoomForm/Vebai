// Cleanup for the bot-fix routing E2E (2026-10-18).
// Removes: canary session, synthetic guest 555000111 (user, conversation,
// messages, tasks), tgUsers entry; restores telegramBot.lastUpdateId to the
// last REAL update id so the full id space is live for real updates again.
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')
function envVal(name) {
  for (const f of ['.env.vercel.local', '.env.local']) {
    const txt = fs.readFileSync(path.join(ROOT, f), 'utf8')
    const m = txt.match(new RegExp('^' + name + '=(.*)$', 'm'))
    if (m) return m[1].replace(/^"|"$/g, '')
  }
  return ''
}
process.env.DATABASE_URL = envVal('DATABASE_URL')
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()

const GUEST_TG_ID = '555000111'
const CANARY = 'probe_canary_dead1'
const LAST_REAL_UPDATE_ID = 1792317743 // owner's last real update before E2E

async function main() {
  // 1. canary session
  const c = await db.terminalSession.deleteMany({ where: { id: CANARY } })
  console.log('canary session deleted:', c.count)

  // 2. synthetic guest
  const user = await db.user.findUnique({ where: { email: `tg_${GUEST_TG_ID}@telegram.vebai.app` } })
  if (user) {
    const convs = await db.conversation.findMany({ where: { userId: user.id }, select: { id: true } })
    for (const cv of convs) {
      await db.message.deleteMany({ where: { conversationId: cv.id } })
      await db.agentTask.deleteMany({ where: { conversationId: cv.id } })
    }
    const dc = await db.conversation.deleteMany({ where: { userId: user.id } })
    const du = await db.user.delete({ where: { id: user.id } })
    console.log(`guest removed: conversations=${dc.count}, user=${du.email}`)
  } else {
    console.log('guest user not found (already clean)')
  }

  // 3. tgUsers map: drop the guest key only
  const mapRow = await db.studioState.findUnique({ where: { key: 'tgUsers' } })
  if (mapRow) {
    const map = JSON.parse(mapRow.data)
    delete map[GUEST_TG_ID]
    await db.studioState.update({ where: { key: 'tgUsers' }, data: { data: JSON.stringify(map) } })
    console.log('tgUsers now:', JSON.stringify(map))
  }

  // 4. restore real update-id space (keep ownerChatId / convId untouched)
  const botRow = await db.studioState.findUnique({ where: { key: 'telegramBot' } })
  const bot = JSON.parse(botRow.data)
  bot.lastUpdateId = LAST_REAL_UPDATE_ID
  await db.studioState.update({ where: { key: 'telegramBot' }, data: { data: JSON.stringify(bot) } })
  console.log('telegramBot:', JSON.stringify(bot))

  // 5. owner sanity
  const owner = await db.user.findUnique({ where: { telegramChatId: '6413804768' } })
  const ownerConvs = owner ? await db.conversation.count({ where: { userId: owner.id } }) : 0
  const live = await db.terminalSession.findUnique({ where: { id: '42dabdf5-75f7-44b4-baad-4af0a313f0fc' } })
  console.log('owner:', owner ? `${owner.email} (convs=${ownerConvs})` : 'MISSING!',
    '| resident session:', live ? live.status : 'MISSING!')
  await db.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
