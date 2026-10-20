// Cleanup of T18 site-chat diagnostics: removes throwaway test users and
// everything they own (conversations, messages, tasks).
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

const PATTERNS = ['sitecheck_%@vebai-test.app', 'rawcheck_%@vebai-test.app', 'fullcheck_%@vebai-test.app', 'visual\\_t18_%@vebai-test.app']

async function main() {
  const users = await db.user.findMany({
    where: { OR: PATTERNS.map((p) => ({ email: { startsWith: p.split('%')[0] } })) },
    select: { id: true, email: true },
  })
  for (const u of users) {
    const convs = await db.conversation.findMany({ where: { userId: u.id }, select: { id: true } })
    for (const cv of convs) {
      await db.message.deleteMany({ where: { conversationId: cv.id } })
      await db.agentTask.deleteMany({ where: { conversationId: cv.id } })
    }
    const dc = await db.conversation.deleteMany({ where: { userId: u.id } })
    await db.user.delete({ where: { id: u.id } })
    console.log(`removed ${u.email}: convs=${dc.count}`)
  }
  // owner sanity
  const owner = await db.user.findUnique({ where: { telegramChatId: '6413804768' } })
  console.log('owner intact:', owner ? owner.email : 'MISSING!')
  await db.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
