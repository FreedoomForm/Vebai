const { PrismaClient } = require('@prisma/client')
const fs = require('fs'); const path = require('path')
function envVal(key) {
  const f = path.join(process.cwd(), '.env.vercel.local')
  const line = fs.readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith(key + '='))
  return line ? line.slice(key.length + 1).replace(/^"|"$/g, '') : ''
}
const db = new PrismaClient({ datasources: { db: { url: envVal('DATABASE_URL') } } })
;(async () => {
  const email = 't17visual@vebai-test.app'
  const u = await db.user.findUnique({ where: { email } })
  if (!u) return console.log('no test user')
  const convs = await db.conversation.findMany({ where: { userId: u.id }, select: { id: true } })
  const ids = convs.map((c) => c.id)
  await db.message.deleteMany({ where: { conversationId: { in: ids } } })
  await db.terminalFile.deleteMany({ where: { conversationId: { in: ids } } })
  await db.conversation.deleteMany({ where: { id: { in: ids } } })
  await db.user.delete({ where: { id: u.id } })
  console.log('deleted test user +', ids.length, 'conversations')
  await db.$disconnect()
})().catch((e) => { console.error(e.message); process.exit(1) })
