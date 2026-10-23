// T53 diagnostics: real DB counts, indexes, and chat-open query cost (before vs slim)
// Reads DATABASE_URL from .env.vercel.local; never prints it.
import fs from 'node:fs'
import path from 'node:path'

const envText = fs.readFileSync(path.join(process.cwd(), '.env.vercel.local'), 'utf8')
const m = envText.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m)
if (!m) { console.error('no DATABASE_URL in .env.vercel.local'); process.exit(1) }
process.env.DATABASE_URL = m[1]

const { PrismaClient } = await import('@prisma/client')
const db = new PrismaClient()

const ms = (t0) => Math.round(performance.now() - t0)

try {
  // 1. baseline roundtrip
  let t0 = performance.now(); await db.$queryRaw`SELECT 1`
  console.log('SELECT 1:', ms(t0), 'ms')
  t0 = performance.now(); await db.$queryRaw`SELECT 1`
  console.log('SELECT 1 (warm):', ms(t0), 'ms')

  // 2. indexes actually present on prod
  const idx = await db.$queryRaw`
    SELECT tablename, indexname FROM pg_indexes
    WHERE tablename IN ('Message','AgentTask','Conversation')
    ORDER BY tablename, indexname`
  console.log('indexes:', idx.map(r => `${r.tablename}.${r.indexname.replace(/^.*_([^_]+)$/,'$1')}`).join(', ') ||
    JSON.stringify(idx))

  // 3. scale of the data
  const [{ n: nconv }] = await db.$queryRaw`SELECT count(*)::int AS n FROM "Conversation"`
  const [{ n: nmsg }] = await db.$queryRaw`SELECT count(*)::int AS n FROM "Message"`
  const [{ n: ntask }] = await db.$queryRaw`SELECT count(*)::int AS n FROM "AgentTask"`
  console.log(`conversations=${nconv} messages=${nmsg} tasks=${ntask}`)

  // biggest chats by message count
  const top = await db.$queryRaw`
    SELECT c.id, c.title, count(m.id)::int AS msgs
    FROM "Conversation" c JOIN "Message" m ON m."conversationId" = c.id
    GROUP BY c.id, c.title ORDER BY msgs DESC LIMIT 5`
  for (const r of top) console.log(`  top: msgs=${r.msgs} "${String(r.title).slice(0, 40)}"`)

  // 4. tasks with imageData = the silent megabyte killer
  const blob = await db.$queryRaw`
    SELECT count(*)::int AS n, coalesce(pg_total_relation_size('AgentTask'),0) AS rel
    FROM "AgentTask" WHERE "imageData" IS NOT NULL`
  const sizes = await db.$queryRaw`
    SELECT "conversationId", count(*)::int AS n, sum(length("imageData"))::bigint AS bytes
    FROM "AgentTask" WHERE "imageData" IS NOT NULL GROUP BY 1 ORDER BY bytes DESC LIMIT 5`
  console.log(`tasks with imageData: ${blob[0].n}`)
  for (const r of sizes) console.log(`  conv ${r.conversationId}: ${r.n} imgs, ${(Number(r.bytes) / 1e6).toFixed(1)} MB`)

  // 5. worst-case chat-open: current query shape vs slim shape (biggest chat)
  const worst = top[0]
  if (worst) {
    const cid = worst.id
    t0 = performance.now()
    const cur = await db.message.findMany({ where: { conversationId: cid }, orderBy: { createdAt: 'asc' } })
    const curMs = ms(t0)
    t0 = performance.now()
    const slim = await db.message.findMany({
      where: { conversationId: cid }, orderBy: { createdAt: 'desc' }, take: 400,
      select: { id: true, role: true, kind: true, content: true, meta: true, createdAt: true },
    })
    slim.reverse()
    const slimMs = ms(t0)
    console.log(`chat ${cid}: full=${cur.length} msgs in ${curMs} ms | slim(400)=${slim.length} in ${slimMs} ms`)

    // tasks cost: full columns (incl. imageData) vs slim select
    t0 = performance.now()
    const tfull = await db.agentTask.findMany({ where: { conversationId: cid }, orderBy: { createdAt: 'asc' } })
    const tfullMs = ms(t0)
    t0 = performance.now()
    const tslim = await db.agentTask.findMany({
      where: { conversationId: cid }, orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, conversationId: true, type: true, title: true, status: true, progress: true, result: true, error: true, createdAt: true },
    })
    tslim.reverse()
    const tslimMs = ms(t0)
    console.log(`tasks: full=${tfull.length} rows in ${tfullMs} ms | slim=${tslim.length} in ${tslimMs} ms`)

    // meta/content weight of the last 400 messages (what actually ships to the browser)
    let bytes = 0
    for (const msg of slim) bytes += msg.content.length + (msg.meta?.length || 0)
    console.log(`payload of last ${slim.length} messages: ${(bytes / 1024).toFixed(0)} KB`)
  }
} catch (e) {
  console.error('DIAG ERROR:', e.message?.slice(0, 300))
  process.exitCode = 1
} finally {
  await db.$disconnect()
}
