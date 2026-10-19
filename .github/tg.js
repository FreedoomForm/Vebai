#!/usr/bin/env node
/**
 * T33 (owner request 2026-10-20): THE TELEGRAM APP on the agent's computer.
 *
 * The site agent (run-agent on the GitHub Actions executor VM) is a regular
 * agent with a computer. This file is the Telegram application installed on
 * that computer: a full-surface MTProto client CLI that acts FROM THE OWNER'S
 * OWN connected account. Anything the Telegram API can do, the agent can do
 * by running this app in its bash: read any number of messages from any
 * number of chats, send texts/files, reply, edit, delete, forward, react,
 * pin, download media, enumerate dialogs/contacts — and anything not covered
 * by a subcommand via `raw <method> <json>` (the entire MTProto schema).
 *
 * Bootstrap: POST /api/tg/session (GH_TERM_SECRET auth) -> decrypted session
 * of the owner's connected account. The `telegram` (GramJS) npm package is
 * preinstalled by the workflow; if missing, the app installs it itself into
 * /tmp/tgnode (silent, keeps the Actions log clean).
 *
 * Log policy (same as tg_userbot.js): NOTHING textual from messages is ever
 * printed to the GitHub Actions console — the only output is ONE JSON line
 * on stdout, which the executor captures into /tmp files for the site
 * (owner-only surface). console.log must stay untouched.
 *
 * All commands print exactly one JSON object: {ok:true,...} | {ok:false,error}.
 * Exit code 0 on ok, 1 on failure (so `&&` chains in bash behave honestly).
 * Usage: node tg.js <command> [args...] [--timeout 120]
 */
'use strict'

const SITE = (process.env.SITE || 'https://vebai-six.vercel.app').replace(/\/$/, '')
const SECRET = process.env.SECRET || ''

/* ------------------------------------------------------------- utilities */

function out(obj) {
  process.stdout.write(JSON.stringify(obj, jsonReplacer) + '\n')
}
function fail(error, extra = {}) {
  out({ ok: false, error: String(error).slice(0, 400), ...extra })
  process.exit(1)
}
function jsonReplacer(_k, v) {
  if (typeof v === 'bigint') return v.toString()
  if (v && typeof v === 'object' && typeof v.toString === 'function' &&
      (v.constructor && v.constructor.name || '').includes('Long')) return v.toString()
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) return `<buffer ${v.data.length}B>`
  return v
}
function argOf(a) { return String(a ?? '').trim() }

// CLI timeout: `--timeout N` anywhere in argv, default 120 s (media 600 s).
let WATCHDOG_MS = 120_000
const tIdx = process.argv.indexOf('--timeout')
if (tIdx !== -1 && /^\d+$/.test(process.argv[tIdx + 1] || '')) {
  WATCHDOG_MS = Math.min(parseInt(process.argv[tIdx + 1], 10), 900) * 1000
  process.argv.splice(tIdx, 2)
}
const watchdog = setTimeout(() => {
  out({ ok: false, error: `таймаут ${WATCHDOG_MS / 1000} с — Telegram не ответил (подними --timeout или попробуй позже)` })
  process.exit(124)
}, WATCHDOG_MS)
watchdog.unref?.()

/* ------------------------------------------------- GramJS self-bootstrap */

/* mod(p): prefer the workflow-preinstalled package (repo node_modules); if
 * absent (manual run), fall back to the self-installed copy in /tmp/tgnode. */
function mod(p) {
  try { return require(p) } catch { return require('/tmp/tgnode/node_modules/' + p) }
}
function loadTelegram() {
  try { return mod('telegram') } catch { /* not preinstalled */ }
  const { execSync } = require('child_process')
  try {
    execSync('npm install --no-save --no-audit --no-fund --prefix /tmp/tgnode telegram',
      { stdio: 'ignore', timeout: 180_000 })
    return mod('telegram')
  } catch (e) {
    fail(`не удалось установить библиотеку telegram (GramJS): ${String(e && e.message || e).slice(0, 200)}`)
  }
}
const tg = loadTelegram()
const { TelegramClient } = tg
const { StringSession } = mod('telegram/sessions')
const { CustomFile } = mod('telegram/client/uploads')
// keep stdout strictly one-JSON-line: silence the GramJS logger (it prints
// connection INFO to console by default, which would pollute the output)
const { Logger } = mod('telegram/extensions/Logger')
const silentLogger = new Logger('none')

/* ------------------------------------------------------ session bootstrap */

async function fetchSession() {
  if (!SECRET) fail('SECRET (GH_TERM_SECRET) не задан в окружении раннера')
  const res = await fetch(SITE + '/api/tg/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => fail(`сайт недоступен (${SITE}): ${String(e && e.message || e).slice(0, 160)}`))
  const data = await res.json().catch(() => ({}))
  if (!res.ok) fail(`сайт вернул ${res.status}: ${JSON.stringify(data).slice(0, 160)}`)
  if (!data.ok || !data.account || !data.account.session) {
    fail(data.error || 'сайт не вернул сессию аккаунта')
  }
  return data.account
}

async function connect() {
  const acc = await fetchSession()
  const client = new TelegramClient(new StringSession(acc.session),
    acc.apiId, acc.apiHash, {
      connectionRetries: 3,
      requestRetries: 3,
      useWSS: true,
      floodSleepThreshold: 60, // small FLOOD_WAITs sleep silently
      deviceModel: 'Vebai Agent',
      systemVersion: 'tg-app on GH runner',
      baseLogger: silentLogger,
    })
  // bounded connect: a dead/bogus session can stall the handshake forever —
  // fail honestly instead of burning the whole step timeout
  const connectMs = Math.min(WATCHDOG_MS - 5_000, 60_000)
  await Promise.race([
    client.connect(),
    new Promise((_, rej) => setTimeout(
      () => rej(new Error(`подключение к Telegram не уложилось в ${Math.round(connectMs / 1000)} с`)),
      connectMs)),
  ])
  return { client, acc }
}

/* ------------------------------------------------------------ peer logic */

function entityName(e) {
  if (!e) return '?'
  return [e.firstName, e.lastName, e.username, e.title].filter(Boolean).join(' ').slice(0, 120) || '?'
}

/** resolve @username | +phone | "Имя" | t.me/xxx | numeric id -> entity */
async function findPeer(client, q) {
  const s = String(q || '').trim()
  if (!s) throw new Error('пустой адрес чата')
  const cands = [s]
  const tme = s.match(/t\.me\/([A-Za-z0-9_]+)/i)
  if (tme) cands.push('@' + tme[1])
  if (!s.startsWith('@') && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) cands.push('@' + s)
  for (const c of cands) {
    try { const e = await client.getEntity(c); if (e) return e } catch { /* next */ }
  }
  const norm = s.toLowerCase().replace(/^@/, '')
  const phoneDigits = s.replace(/\D/g, '')
  const numId = /^-?\d{6,}$/.test(s) ? s.replace(/^-100/, '-').replace(/^-/, '') : null
  let fuzzy = null
  for await (const d of client.iterDialogs({ limit: 300 })) {
    const e = d.entity
    if (!e) continue
    const un = String(e.username || '').toLowerCase()
    const ph = String(e.phone || '').replace(/\D/g, '')
    const nm = [e.firstName, e.lastName].filter(Boolean).join(' ').toLowerCase()
    const eid = String(e.id ?? '')
    if (numId && (eid === numId || eid === s.replace(/^-/, '') || '-' + eid === s)) return e
    if (un && un === norm) return e
    if (phoneDigits.length >= 7 && ph && ph === phoneDigits) return e
    if (nm && nm === norm) return e
    if (!fuzzy && nm && norm.length >= 3 && (nm.includes(norm) || norm.includes(nm))) fuzzy = e
  }
  if (fuzzy) return fuzzy
  throw new Error('чат не найден в Telegram аккаунта (проверь @username, номер или имя)')
}

function peerClass(e) { return e.className || (e.constructor && e.constructor.name) || '' }

/* ---------------------------------------------------------- serializers */

function userBrief(e) {
  if (!e) return null
  return {
    id: String(e.id ?? ''),
    name: [e.firstName, e.lastName].filter(Boolean).join(' '),
    username: e.username || null,
    phone: e.phone || null,
    bot: !!e.bot,
  }
}

function chatBrief(e) {
  if (!e) return null
  const cls = peerClass(e)
  return {
    id: String(e.id ?? ''),
    name: entityName(e),
    type: cls === 'User' ? (e.bot ? 'bot' : 'user')
      : cls === 'Channel' ? (e.megagroup ? 'group' : 'channel')
      : cls === 'Chat' ? 'group' : cls.toLowerCase(),
    username: e.username || null,
  }
}

async function readMessages(client, peer, limit, search) {
  const opts = { limit: Math.min(Math.max(Number(limit) || 50, 1), 1000) }
  if (search) opts.search = String(search)
  const msgs = await client.getMessages(peer.id, opts)
  const senderCache = new Map()
  const list = []
  for (const m of msgs) {
    if (!m || m.action) continue
    let from
    if (m.out) from = 'Я (владелец)'
    else {
      const pid = String((m.fromId && (m.fromId.userId || m.fromId.channelId || m.fromId.chatId)) || '')
      if (senderCache.has(pid)) from = senderCache.get(pid)
      else {
        let s = null
        try { s = await m.getSender() } catch { /* privacy miss */ }
        from = s ? entityName(s) : pid ? `id${pid}` : '?'
        senderCache.set(pid, from)
      }
    }
    let text = String(m.message || '').trim()
    let media = null
    if (m.media) {
      const mc = String((m.media.className || (m.media.constructor && m.media.constructor.name)) || '')
      media = mc.replace(/^MessageMedia/, '').toLowerCase() || 'attachment'
      if (!text) text = `[медиа: ${media}]`
    }
    if (!text && !media) continue
    list.push({
      id: Number(m.id),
      out: !!m.out,
      date: new Date((m.date || 0) * 1000).toISOString(),
      from,
      text: text.slice(0, 4000),
      media,
    })
    if (list.length >= opts.limit) break
  }
  list.reverse() // oldest first
  return list
}

/* ------------------------------------------------------------- commands */

const HELP = {
  ok: true,
  app: 'tg — приложение Telegram на компьютере агента (действует ОТ ИМЕНИ подключённого аккаунта владельца)',
  usage: 'node "$TG" <команда> [аргументы]',
  commands: {
    whoami: 'инфо о своём аккаунте',
    dialogs: '[limit=100] — список всех чатов (id, имя, тип, username, непрочитанные)',
    contacts: '[запрос] — список контактов',
    read: '<чат> [limit=50] [--search слово] — последние N сообщений чата (лички и группы; столько, сколько нужно)',
    send: '<чат> <текст> — отправить сообщение',
    sendfile: '<чат> <путь-к-файлу> [подпись] — отправить документ из /tmp/ws',
    reply: '<чат> <msgId> <текст> — ответить на сообщение',
    edit: '<чат> <msgId> <новый-текст> — исправить СВОЁ сообщение',
    delete: '<чат> <msgId> [msgId...] — удалить сообщения',
    forward: '<чат-источник> <msgId> <чат-получатель> — переслать',
    react: '<чат> <msgId> <эмодзи> — поставить реакцию',
    pin: '<чат> <msgId> | unpin <чат> <msgId> — закрепить/открепить',
    markread: '<чат> — отметить чат прочитанным',
    media: '<чат> <msgId> [файл] — скачать медиа в /tmp/ws (до 20 МБ)',
    raw: '<метод> [json-аргументы] — ЛЮБОЙ метод MTProto (полный API), напр. raw contacts.search \'{"q":"иван","limit":5}\'',
  },
  notes: [
    'чат = @username | +телефон | "Имя Фамилия" | t.me/ссылка | числовой id',
    'вывод — одна JSON-строка {ok:...}; коды выхода: 0 успех, 1 ошибка, 124 таймаут',
    'это РЕАЛЬНЫЙ аккаунт владельца: то, что ты отправляешь, отправляется по-настоящему',
  ],
}

const CMD = process.argv[2] || 'help'
const ARGS = process.argv.slice(3)

function flag(name) {
  const i = ARGS.indexOf(name)
  if (i === -1) return null
  const v = ARGS[i + 1] ?? ''
  ARGS.splice(i, 2)
  return v
}

async function main() {
  if (CMD === 'help' || CMD === '--help' || CMD === '-h') { out(HELP); return }
  if (!CMD) fail('укажи команду (help — список)')

  const { client, acc } = await connect()

  switch (CMD) {
    case 'whoami': {
      const me = await client.getMe()
      out({ ok: true, me: userBrief(me), accountId: acc.id })
      return
    }
    case 'dialogs': {
      const limit = Math.min(parseInt(argOf(ARGS[0]) || '100', 10) || 100, 500)
      const list = []
      for await (const d of client.iterDialogs({ limit })) {
        list.push({
          ...chatBrief(d.entity),
          unread: d.unreadCount || 0,
          lastDate: d.date ? new Date(d.date * 1000).toISOString() : null,
          pinned: !!d.pinned,
        })
      }
      out({ ok: true, count: list.length, dialogs: list })
      return
    }
    case 'contacts': {
      const q = argOf(ARGS[0] || '')
      if (!q) {
        const res = await client.invoke(new tg.Api.contacts.GetContacts({ hash: BigInt(0) }))
        const users = (res && res.users) || []
        out({ ok: true, count: users.length, users: users.map(userBrief) })
      } else {
        const res = await client.invoke(new tg.Api.contacts.Search({ q: q.slice(0, 100), limit: 30 }))
        out({ ok: true, count: res.users.length, users: res.users.map(userBrief) })
      }
      return
    }
    case 'read': {
      const search = flag('--search')
      const chat = argOf(ARGS[0]); const limit = parseInt(argOf(ARGS[1]) || '50', 10) || 50
      const peer = await findPeer(client, chat)
      const messages = await readMessages(client, peer, limit, search)
      out({ ok: true, chat: chatBrief(peer), count: messages.length, messages })
      return
    }
    case 'send': {
      const chat = argOf(ARGS[0]); const text = ARGS.slice(1).join(' ').trim()
      if (!text) fail('пустой текст сообщения')
      const peer = await findPeer(client, chat)
      const sent = await client.sendMessage(peer.id, { message: text.slice(0, 4000), linkPreview: false })
      out({ ok: true, chat: chatBrief(peer), msgId: Number(sent.id), chars: text.length })
      return
    }
    case 'sendfile': {
      const chat = argOf(ARGS[0]); const path = argOf(ARGS[1]); const caption = ARGS.slice(2).join(' ').trim()
      const fs = require('fs')
      if (!path || !fs.existsSync(path)) fail(`файл не найден: ${path || '(пусто)'}`)
      const buf = fs.readFileSync(path)
      if (buf.length === 0) fail('файл пустой')
      if (buf.length > 45_000_000) fail(`файл ${Math.round(buf.length / 1e6)} МБ больше лимита 45 МБ`)
      const peer = await findPeer(client, chat)
      const sent = await client.sendFile(peer.id, {
        file: new CustomFile(require('path').basename(path), buf.length, '', buf),
        caption: caption.slice(0, 1000) || undefined,
        forceDocument: true,
      })
      out({ ok: true, chat: chatBrief(peer), msgId: Number(sent.id), file: require('path').basename(path), bytes: buf.length })
      return
    }
    case 'reply': {
      const chat = argOf(ARGS[0]); const msgId = parseInt(argOf(ARGS[1]), 10); const text = ARGS.slice(2).join(' ').trim()
      if (!msgId || !text) fail('нужны: чат, msgId, текст')
      const peer = await findPeer(client, chat)
      const sent = await client.sendMessage(peer.id, { message: text.slice(0, 4000), replyTo: msgId, linkPreview: false })
      out({ ok: true, chat: chatBrief(peer), msgId: Number(sent.id), replyTo: msgId })
      return
    }
    case 'edit': {
      const chat = argOf(ARGS[0]); const msgId = parseInt(argOf(ARGS[1]), 10); const text = ARGS.slice(2).join(' ').trim()
      if (!msgId || !text) fail('нужны: чат, msgId, новый текст')
      const peer = await findPeer(client, chat)
      await client.editMessage(peer.id, { message: msgId, text: text.slice(0, 4000) })
      out({ ok: true, chat: chatBrief(peer), msgId })
      return
    }
    case 'delete': {
      const chat = argOf(ARGS[0]); const ids = ARGS.slice(1).map((x) => parseInt(x, 10)).filter(Boolean)
      if (!ids.length) fail('нужны id сообщений')
      const peer = await findPeer(client, chat)
      await client.deleteMessages(peer.id, ids, { revoke: true })
      out({ ok: true, chat: chatBrief(peer), deleted: ids })
      return
    }
    case 'forward': {
      const from = argOf(ARGS[0]); const msgId = parseInt(argOf(ARGS[1]), 10); const to = argOf(ARGS[2])
      if (!msgId || !to) fail('нужны: чат-источник, msgId, чат-получатель')
      const src = await findPeer(client, from)
      const dst = await findPeer(client, to)
      const res = await client.forwardMessages(dst.id, { messages: [msgId], fromPeer: src.id })
      const first = Array.isArray(res) ? res[0] : res
      out({ ok: true, from: chatBrief(src), to: chatBrief(dst), msgId: Number(first && first.id || msgId) })
      return
    }
    case 'react': {
      const chat = argOf(ARGS[0]); const msgId = parseInt(argOf(ARGS[1]), 10); const emoji = argOf(ARGS[2]) || '👍'
      if (!msgId) fail('нужны: чат, msgId')
      const peer = await findPeer(client, chat)
      await client.invoke(new tg.Api.messages.SendReaction({
        peer: await client.getInputEntity(peer.id),
        msgId,
        reaction: [new tg.Api.ReactionEmoji({ emoticon: emoji.slice(0, 16) })],
      }))
      out({ ok: true, chat: chatBrief(peer), msgId, reaction: emoji })
      return
    }
    case 'pin': case 'unpin': {
      const chat = argOf(ARGS[0]); const msgId = parseInt(argOf(ARGS[1]), 10)
      if (!msgId) fail('нужны: чат, msgId')
      const peer = await findPeer(client, chat)
      if (CMD === 'pin') await client.pinMessage(peer.id, msgId)
      else await client.unpinMessage(peer.id, msgId)
      out({ ok: true, chat: chatBrief(peer), msgId, pinned: CMD === 'pin' })
      return
    }
    case 'markread': {
      const chat = argOf(ARGS[0])
      const peer = await findPeer(client, chat)
      const msgs = await client.getMessages(peer.id, { limit: 1 })
      if (msgs[0]) await client.markAsRead(peer.id, msgs[0].id)
      out({ ok: true, chat: chatBrief(peer), marked: true })
      return
    }
    case 'media': {
      const chat = argOf(ARGS[0]); const msgId = parseInt(argOf(ARGS[1]), 10)
      const outfile = argOf(ARGS[2])
      if (!msgId) fail('нужны: чат, msgId')
      const peer = await findPeer(client, chat)
      const msgs = await client.getMessages(peer.id, { ids: [msgId] })
      const m = msgs && msgs[0]
      if (!m || !m.media) fail('у сообщения нет медиа')
      const doc = m.media.document
      const size = Number((doc && doc.size) || 0) // photos have no single size — they are small
      if (size > 20_000_000) fail(`медиа ${Math.round(size / 1e6)} МБ больше лимита 20 МБ`)
      const buf = await client.downloadMedia(m, {})
      if (!buf || !buf.length) fail('скачивание вернуло пустой результат')
      if (buf.length > 20_000_000) fail(`скачано ${Math.round(buf.length / 1e6)} МБ — больше лимита 20 МБ, файл удалён`)
      const fs = require('fs'); const path = require('path')
      const name = outfile || `tg_media_${msgId}_${Date.now()}.bin`
      const p = path.isAbsolute(name) ? name : path.join('/tmp/ws', name)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, buf)
      out({ ok: true, saved: p, bytes: buf.length, chat: chatBrief(peer), msgId })
      return
    }
    case 'raw': {
      const method = argOf(ARGS[0])
      if (!method || !/^[a-z][a-z0-9.]*\.[a-z][a-z0-9]*$/i.test(method)) {
        fail('нужен метод MTProto вида namespace.method, напр. contacts.search')
      }
      let jsonArgs = {}
      const rest = ARGS.slice(1).join(' ').trim()
      if (rest) {
        try { jsonArgs = JSON.parse(rest) } catch { fail('аргументы raw — валидный JSON, напр. \'{"q":"иван","limit":5}\'') }
      }
      const ns = method.split('.')[0]; const fn = method.split('.')[1]
      const Cls = (tg.Api[ns] && tg.Api[ns][fn]) || tg.Api[fn.replace(/^([a-z])/, (c) => c.toUpperCase())]
      if (typeof Cls !== 'function') fail(`неизвестный метод ${method} (смотри схему GramJS: node -e "console.log(Object.keys(require('telegram').Api))")`)
      // конструкторы GramJS ждут camelCase-поля — передаём как есть
      const req = new Cls(jsonArgs)
      const result = await client.invoke(req)
      const asJson = JSON.stringify({ ok: true, method, result }, jsonReplacer)
      if (asJson.length > 60_000) {
        out({ ok: true, method, truncated: true, raw: asJson.slice(0, 58_000) + '…[обрезано]' })
      } else {
        process.stdout.write(asJson + '\n')
      }
      return
    }
    default:
      fail(`неизвестная команда: ${CMD} (help — список команд)`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    const msg = String((e && e.message) || e)
    const flood = msg.match(/FLOOD_WAIT_(\d+)/) || msg.match(/A wait of (\d+) seconds/)
    if (flood) fail(`Telegram просит подождать ${flood[1]} с (FLOOD_WAIT) — повтори позже`)
    if (msg.includes('TIMEOUT') || msg.includes('timed out')) fail('Telegram не ответил вовремя — повтори с большим --timeout')
    fail(`Telegram: ${msg.slice(0, 380)}`)
  })
