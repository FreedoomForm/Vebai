// E2E (bot outage fix 2026-10-18): a synthetic "dead" gh session exists with
// NO heartbeat. A guest task sent through the REAL webhook must be routed to
// the live resident session (freshest lastSeenAt), never to the canary.
// Then the resident must claim + complete it (full chain: webhook -> task ->
// dispatch -> GH runner -> result -> conversation).
//
// Usage: node scripts/e2e_botfix_routing.js
//   env: read from .env.vercel.local (DATABASE_URL, TELEGRAM_BOT_TOKEN)
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

const SITE = 'https://vebai-six.vercel.app'
const TOKEN = envVal('TELEGRAM_BOT_TOKEN')
process.env.DATABASE_URL = envVal('DATABASE_URL')
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()

const GUEST_TG_ID = 555000111
const GUEST_EMAIL = `tg_${GUEST_TG_ID}@telegram.vebai.app`
const LIVE_SESSION = '42dabdf5-75f7-44b4-baad-4af0a313f0fc'
const CANARY = 'probe_canary_dead1'

let pass = 0, fail = 0
const ok = (cond, label) => {
  console.log((cond ? '  PASS' : '  FAIL') + ' - ' + label)
  cond ? pass++ : fail++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function webhook(update) {
  const res = await fetch(SITE + '/api/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(update),
  })
  return res.status
}

async function main() {
  console.log('== 0. pre-state ==')
  const botRow = await db.studioState.findUnique({ where: { key: 'telegramBot' } })
  const bot = JSON.parse(botRow.data)
  const U0 = bot.lastUpdateId
  console.log('  lastUpdateId =', U0)

  // canary must be active without heartbeat; live session must be fresh
  const canary = await db.terminalSession.findUnique({ where: { id: CANARY } })
  const live = await db.terminalSession.findUnique({ where: { id: LIVE_SESSION } })
  ok(canary && canary.status === 'active' && !canary.lastSeenAt, 'canary active, no heartbeat')
  ok(live && live.status === 'active' && live.lastSeenAt &&
     Date.now() - live.lastSeenAt.getTime() < 12 * 60_000, 'live resident heartbeat fresh')

  console.log('== 1. guest task through the REAL webhook ==')
  const text = 'создай в своей рабочей папке файл botfix_ok.txt со словом РАБОТАЕТ и закончи'
  const st = await webhook({
    update_id: U0 + 1,
    message: {
      message_id: 999901,
      text,
      chat: { id: GUEST_TG_ID, type: 'private' },
      from: { id: GUEST_TG_ID, first_name: 'Botfix E2E', username: 'botfix_e2e' },
    },
  })
  ok(st === 200, 'webhook 200')
  await sleep(1500)

  const usersMap = JSON.parse((await db.studioState.findUnique({ where: { key: 'tgUsers' } })).data)
  const entry = usersMap[String(GUEST_TG_ID)]
  ok(!!entry && !!entry.convId, 'guest registered in tgUsers with personal conv')

  console.log('== 2. routing discriminator ==')
  // drive the tick worker ourselves (same as the heartbeat workflow does):
  // agentTick converts queued AgentTask -> TerminalCommand
  let cmd = null, task = null
  for (let i = 0; i < 24 && !cmd; i++) {
    fetch(SITE + '/api/agent/tick').then((r) => r.text()).catch(() => {})
    await sleep(5000)
    task = await db.agentTask.findFirst({
      where: { conversationId: entry.convId, type: 'terminal' },
      orderBy: { createdAt: 'desc' },
    })
    if (task?.jobIds) {
      const cmdId = String(task.jobIds).match(/cmd:([a-z0-9]+)/i)?.[1]
      if (cmdId) { cmd = await db.terminalCommand.findUnique({ where: { id: cmdId } }); if (cmd) break }
    }
  }
  ok(!!cmd, 'AgentTask produced a TerminalCommand (tick worker works)')
  if (!cmd) {
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
    await db.$disconnect()
    process.exit(1)
  }
  if (cmd) {
    console.log('  cmd session =', cmd.sessionId)
    ok(cmd.sessionId === LIVE_SESSION, 'routed to LIVE session (not canary) - the deployed fix works')
    ok(cmd.status === 'pending' || cmd.status === 'running', 'cmd queued/running')
  }

  console.log('== 3. resident executes it end-to-end ==')
  let done = false
  const t0 = Date.now()
  for (let i = 0; i < 60 && !done; i++) {
    await sleep(10000)
    const c = await db.terminalCommand.findUnique({ where: { id: cmd.id } })
    task = await db.agentTask.findUnique({ where: { id: task.id } })
    if (c.status === 'done' || c.status === 'failed') done = true
  }
  ok(done, `command finished in ${Math.round((Date.now() - t0) / 1000)}s`)
  const fresh = await db.terminalCommand.findUnique({ where: { id: cmd.id } })
  ok(fresh.status === 'done', 'cmd status done (resident claimed + ran it)')
  const finalTask = await db.agentTask.findUnique({ where: { id: task.id } })
  ok(finalTask.status === 'completed', 'AgentTask completed by tick worker')

  const assistantMsg = await db.message.findFirst({
    where: { conversationId: entry.convId, role: 'assistant' },
    orderBy: { createdAt: 'desc' },
  })
  ok(!!assistantMsg && assistantMsg.content.length > 0, 'assistant result message saved to the conversation')

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  await db.$disconnect()
  process.exit(fail ? 1 : 0)
}

main().catch(async (e) => {
  console.error('FATAL:', e)
  await db.$disconnect()
  process.exit(1)
})
