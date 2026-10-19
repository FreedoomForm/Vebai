#!/usr/bin/env node
/**
 * T26: personal-telegram-agents supervisor for the resident GitHub Actions
 * shift. Runs alongside terminal_executor.py as a parallel job: every 30 s it
 * asks the site (POST /api/tg/work, GH_TERM_SECRET) which user accounts are
 * connected AND switched on, keeps a GramJS MTProto client per account, and
 * answers incoming PRIVATE messages: /api/tg/incoming (dedupe + AI reply per
 * the owner's rules) -> sendMessage from the user's own account -> /api/tg/sent.
 *
 * Safety: private chats only, never bots, never first messages, replay guard
 * (msg age < 4 min + per-chat high-water id), 30 s per-chat cooldown, 25
 * replies/hour cap, and NOTHING about message text is ever logged (ids and
 * lengths only) - the GH Actions log stays clean per the executor policy.
 * Stdlib + telegram (GramJS); `npm i --no-save telegram` happens in the job.
 */

const SITE = (process.env.SITE || 'https://vebai-six.vercel.app').replace(/\/$/, '')
const SECRET = process.env.SECRET || ''
const POLL_MS = 30_000
const COOLDOWN_MS = 30_000
const HOUR_CAP = 25

const clients = new Map() // accountId -> { client, sig }

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, payload, timeoutMs = 60_000) {
  const res = await fetch(SITE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 200)}`)
  return data
}

async function connectAccount(a, sig) {
  const { TelegramClient } = require('telegram')
  const { StringSession } = require('telegram/sessions')
  const { NewMessage } = require('telegram/events')

  const client = new TelegramClient(new StringSession(a.session), a.apiId, a.apiHash, {
    connectionRetries: 3,
    // T29: >=2 so PHONE_MIGRATE/server hiccups (handled by GramJS _call via
    // switchDC+resend on the next iteration) don't kill the request outright.
    requestRetries: 3,
    useWSS: true,
    floodSleepThreshold: 2,
    deviceModel: 'Vebai Agent',
    systemVersion: 'vebai-six.vercel.app',
  })
  await client.connect()

  const lastPerChat = new Map() // high-water message id per chat (replay guard)
  const lastSentAt = new Map() // per-chat cooldown
  let hourStart = Date.now()
  let sentThisHour = 0

  client.addEventHandler(async (event) => {
    let peerId = '?'
    try {
      const msg = event.message
      if (!msg || msg.out || !event.isPrivate) return
      peerId = String((msg.peerId && msg.peerId.userId) || '')
      if (!peerId) return
      const sender = await msg.getSender().catch(() => null)
      if (sender && sender.bot) return
      // freshness: on reconnect Telegram replays history - only fresh messages
      const ageSec = Math.abs(Date.now() / 1000 - (msg.date || 0))
      if (ageSec > 240) return
      const seen = lastPerChat.get(peerId) || 0
      if (msg.id <= seen) return
      lastPerChat.set(peerId, msg.id)

      const now = Date.now()
      if (now - (lastSentAt.get(peerId) || 0) < COOLDOWN_MS) return log('cooldown skip chat', peerId)
      if (now - hourStart > 3_600_000) { hourStart = now; sentThisHour = 0 }
      if (sentThisHour >= HOUR_CAP) return log('hourly cap reached, skipping')

      const text = String(msg.message || '').trim()
      if (!text) return
      const name = sender ? [sender.firstName, sender.lastName].filter(Boolean).join(' ') : ''
      log(`incoming chat=${peerId} len=${text.length} -> asking site`)
      const res = await api('/api/tg/incoming', {
        secret: SECRET, accountId: a.id, chatId: peerId,
        chatName: name, msgId: String(msg.id), text,
      }, 90_000)
      if (!res.reply) return log('site skipped:', res.skip || '?', res.error || '')
      await client.sendMessage(peerId, { message: res.reply })
      lastSentAt.set(peerId, Date.now())
      sentThisHour++
      await api('/api/tg/sent', {
        secret: SECRET, accountId: a.id, chatId: peerId,
        chatName: name, msgId: String(msg.id), text: res.reply,
      })
      log(`replied chat=${peerId} out_len=${res.reply.length} (hour total=${sentThisHour})`)
    } catch (e) {
      log('handler error chat=' + peerId + ':', (e && e.message) || e)
    }
  }, new NewMessage({}))

  clients.set(a.id, { client, sig })
  log('listening: account', a.id, '(me:', (a.me && a.me.username) || a.me?.firstName || 'unknown' + ')')
}

async function pollConfigs() {
  const res = await api('/api/tg/work', { secret: SECRET })
  const accounts = Array.isArray(res.accounts) ? res.accounts : []
  const wanted = new Map(accounts.map((a) => [a.id, a]))

  for (const [id, entry] of [...clients]) {
    if (!wanted.has(id)) {
      try { await entry.client.disconnect() } catch { /* gone */ }
      clients.delete(id)
      log('stopped listening:', id)
    }
  }
  for (const a of accounts) {
    const sig = JSON.stringify([a.session, a.systemPrompt, (a.examples || []).length])
    const cur = clients.get(a.id)
    if (cur && cur.sig === sig) continue
    if (cur) {
      try { await cur.client.disconnect() } catch { /* gone */ }
      clients.delete(a.id)
      log('reconnecting (config changed):', a.id)
    }
    try {
      await connectAccount(a, sig)
    } catch (e) {
      log('connect failed for', a.id, ':', (e && e.message) || e)
    }
  }
  log(`tick: ${accounts.length} active account(s), listening: ${clients.size}`)
}

async function main() {
  if (!SECRET) {
    console.error('SECRET is empty - refusing to start')
    process.exit(1)
  }
  log('tg_userbot supervisor started; site:', SITE)
  for (;;) {
    try {
      await pollConfigs()
    } catch (e) {
      log('poll error:', (e && e.message) || e)
    }
    await sleep(POLL_MS)
  }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1) })
