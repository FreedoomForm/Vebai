#!/usr/bin/env node
/**
 * T26: personal-telegram-agents supervisor for the resident GitHub Actions
 * shift. Runs alongside terminal_executor.py as a parallel job: every 30 s it
 * asks the site (POST /api/tg/work, GH_TERM_SECRET) which user accounts are
 * connected AND switched on, keeps a GramJS MTProto client per account, and
 * answers incoming PRIVATE messages: /api/tg/incoming (dedupe + AI reply per
 * the owner's rules) -> sendMessage from the user's own account -> /api/tg/sent.
 *
 * T31: the same poll also returns `outbox` jobs — the site agent's ```run-tg```
 * blocks. The worker resolves the requested contact (username / phone / name
 * via entity cache + dialogs) and sends a message and/or a document (base64
 * file inlined by the site) FROM the owner's own account, then reports to
 * /api/tg/outbox-result. Only person-to-person chats: channels/groups/bots
 * are refused; nothing about message texts is logged (ids and lengths only).
 *
 * T32: the same outbox array also carries `kind:'read'` jobs — the site
 * agent's ```run-tg-read``` blocks. The worker fetches the LAST N messages of
 * the requested chat (DMs and groups; broadcast channels and bots refused),
 * serializes {from,date,text} (media marked, no media downloads) and reports
 * the transcript to /api/tg/outbox-result (kind=read) — the site feeds it
 * back to the agent, which continues the order on its own. NOTHING textual
 * from the read messages is ever logged (count/lengths only).
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
const sendOnly = new Map() // accountId -> client (outbox-only, no reply handler)

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

function makeClient(a) {
  const { TelegramClient } = require('telegram')
  const { StringSession } = require('telegram/sessions')
  return new TelegramClient(new StringSession(a.session), a.apiId, a.apiHash, {
    connectionRetries: 3,
    // T29: >=2 so PHONE_MIGRATE/server hiccups (handled by GramJS _call via
    // switchDC+resend on the next iteration) don't kill the request outright.
    requestRetries: 3,
    useWSS: true,
    floodSleepThreshold: 2,
    deviceModel: 'Vebai Agent',
    systemVersion: 'vebai-six.vercel.app',
  })
}

async function connectAccount(a, sig) {
  const { NewMessage } = require('telegram/events')

  const client = makeClient(a)
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
  log('listening: account', a.id, '(me:', (a.me && (a.me.username || a.me.firstName)) || 'unknown' + ')')
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
  // T31: drop send-only clients for accounts that disappeared
  for (const [id, so] of [...sendOnly]) {
    if (!wanted.has(id)) {
      try { await so.disconnect() } catch { /* gone */ }
      sendOnly.delete(id)
    }
  }
  return res
}

/* ---------------------------------------------------------------- T31 outbox */

/** entity name for logs/reports — never includes message texts */
function entityName(e) {
  if (!e) return '?'
  return [e.firstName, e.lastName, e.username, e.title].filter(Boolean).join(' ').slice(0, 120) || '?'
}

/** resolve a contact by @username / +phone / display name (entity cache,
 * then a bounded dialogs scan). Throws with an honest message when not found. */
async function findPeer(client, q) {
  const s = String(q || '').trim()
  if (!s) throw new Error('пустой получатель')
  const cands = [s]
  const tme = s.match(/t\.me\/([A-Za-z0-9_]+)/i)
  if (tme) cands.push('@' + tme[1])
  if (!s.startsWith('@') && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) cands.push('@' + s)
  for (const c of cands) {
    try {
      const e = await client.getEntity(c)
      if (e) return e
    } catch { /* try next / dialogs */ }
  }
  const norm = s.toLowerCase().replace(/^@/, '')
  const phoneDigits = s.replace(/\D/g, '')
  let fuzzy = null
  for await (const d of client.iterDialogs({ limit: 200 })) {
    const e = d.entity
    if (!e) continue
    const un = String(e.username || '').toLowerCase()
    const ph = String(e.phone || '').replace(/\D/g, '')
    const nm = [e.firstName, e.lastName].filter(Boolean).join(' ').toLowerCase()
    if (un && un === norm) return e
    if (phoneDigits.length >= 7 && ph && ph === phoneDigits) return e
    if (nm && nm === norm) return e
    if (!fuzzy && nm && norm.length >= 3 && (nm.includes(norm) || norm.includes(nm))) fuzzy = e
  }
  if (fuzzy) return fuzzy
  throw new Error('контакт не найден в твоём Telegram (проверь @username, номер или имя)')
}

/** one outbox job: resolve the peer, send message/document from the owner's
 * account, report to /api/tg/outbox-result. Only person-to-person chats. */
async function runOutboxJob(t) {
  const entry = await outboxClient(t)
  const peer = await findPeer(entry.client, t.peer)
  const cls = peer.className || (peer.constructor && peer.constructor.name) || ''
  if (cls === 'Channel' || cls === 'Chat') {
    throw new Error('получатель — канал/группа: разрешены только личные чаты')
  }
  if (peer.bot) throw new Error('получатель — бот: отправка ботам отключена')

  const info = {
    peerId: String(peer.id),
    peerName: entityName(peer),
    msgId: null,
    fileName: t.file ? t.file.name : null,
  }
  if (t.file) {
    const buf = Buffer.from(String(t.file.b64 || ''), 'base64')
    if (buf.length === 0) throw new Error('файл в задаче пустой')
    const { CustomFile } = require('telegram/client/uploads')
    const sent = await entry.client.sendFile(peer.id, {
      file: new CustomFile(t.file.name, buf.length, '', buf),
      caption: t.message || undefined,
      forceDocument: true,
    })
    info.msgId = String(sent && sent.id)
    log(`outbox ${t.id.slice(-6)}: file=${t.file.name} bytes=${buf.length} to=${info.peerName} ok`)
  } else {
    const sent = await entry.client.sendMessage(peer.id, { message: t.message, linkPreview: false })
    info.msgId = String(sent && sent.id)
    log(`outbox ${t.id.slice(-6)}: text_len=${t.message.length} to=${info.peerName} ok`)
  }
  await api('/api/tg/outbox-result', { secret: SECRET, id: t.id, ok: true, info })
}

/* ------------------------------------------------------------ T32 reads */

/** shared client pool for outbox jobs (send AND read): reuse the listening
 * client when the account is already connected, else a send-only client */
async function outboxClient(t) {
  let entry = clients.get(t.accountId)
  if (!entry) {
    let so = sendOnly.get(t.accountId)
    if (!so) {
      so = makeClient({ session: t.session, apiId: t.apiId, apiHash: t.apiHash })
      await so.connect()
      sendOnly.set(t.accountId, so)
    }
    entry = { client: so }
  }
  return entry
}

/** one read job (T32): resolve the chat, fetch the LAST N messages (optionally
 * Telegram-searched), report the transcript to /api/tg/outbox-result with
 * kind=read. Allowed: personal chats and groups the owner is inside.
 * Refused: broadcast channels and bots. Media is MARKED, never downloaded.
 * The Actions log keeps only counts/lengths — never any message text. */
async function runReadJob(t) {
  const entry = await outboxClient(t)
  const peer = await findPeer(entry.client, t.chat)
  const cls = peer.className || (peer.constructor && peer.constructor.name) || ''
  if (cls === 'Channel' && !peer.megagroup) {
    throw new Error('чтение доступно только из личных чатов и групп — каналы запрещены')
  }
  if (peer.bot) throw new Error('чтение переписки с ботом отключено')
  const limit = Math.min(Math.max(Number(t.limit) || 50, 1), 200)
  const opts = { limit }
  if (t.search) opts.search = String(t.search)
  const msgs = await entry.client.getMessages(peer.id, opts)
  const senderCache = new Map() // fromId -> display name (one getSender per peer)
  const out = []
  for (const m of msgs) {
    if (!m || m.action) continue // service messages skipped
    let from
    if (m.out) from = 'Я (владелец)'
    else {
      const pid = String((m.fromId && (m.fromId.userId || m.fromId.channelId || m.fromId.chatId)) || '')
      if (senderCache.has(pid)) from = senderCache.get(pid)
      else {
        let s = null
        try { s = await m.getSender() } catch { /* privacy/entity miss */ }
        from = s ? entityName(s) : pid ? `id${pid}` : '?'
        senderCache.set(pid, from)
      }
    }
    let text = String(m.message || '').trim()
    if (!text && m.media) {
      const mc = String((m.media.className || m.media.constructor && m.media.constructor.name) || '')
      text = `[медиа: ${mc.replace(/^MessageMedia/, '').toLowerCase() || 'вложение'}]`
    }
    if (!text) continue
    out.push({
      id: String(m.id),
      out: !!m.out,
      date: new Date((m.date || 0) * 1000).toISOString(),
      from,
      text: text.slice(0, 2000),
    })
    if (out.length >= limit) break
  }
  out.reverse() // oldest first — natural reading order for the transcript
  const info = { peerId: String(peer.id), peerName: entityName(peer), count: out.length }
  const chars = out.reduce((a, x) => a + x.text.length, 0)
  log(`read ${t.id.slice(-6)}: chat=${info.peerName} count=${out.length} chars=${chars} search=${t.search ? 'yes' : 'no'}`)
  await api('/api/tg/outbox-result', { secret: SECRET, id: t.id, ok: true, kind: 'read', info, messages: out }, 120_000)
}

async function pollOutbox(res) {
  const jobs = Array.isArray(res.outbox) ? res.outbox : []
  if (jobs.length > 0) log(`outbox: ${jobs.length} job(s) picked up`)
  for (const t of jobs) {
    try {
      if (t.kind === 'read') await runReadJob(t)
      else await runOutboxJob(t)
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 300)
      log(`outbox ${String(t.id).slice(-6)} failed:`, msg)
      await api('/api/tg/outbox-result', {
        secret: SECRET, id: t.id, ok: false,
        error: msg.includes('контакт не найден') || msg.includes('не личный') || msg.includes('бот')
          ? msg
          : `Telegram: ${msg}`,
      }, 60_000).catch((e2) => log('report failed:', (e2 && e2.message) || e2))
    }
  }
}

async function main() {
  if (!SECRET) {
    console.error('SECRET is empty - refusing to start')
    process.exit(1)
  }
  log('tg_userbot supervisor started; site:', SITE)
  for (;;) {
    try {
      const res = await pollConfigs()
      await pollOutbox(res)
    } catch (e) {
      log('poll error:', (e && e.message) || e)
    }
    await sleep(POLL_MS)
  }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1) })
