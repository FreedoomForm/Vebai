/**
 * Telegram mirror: every artifact the agent (or its terminal) produces is
 * uploaded to the owner's channel through the Bot API, captioned with the
 * terminal/conversation id, so progress survives browser closes and worker
 * restarts. Fire-and-forget: upload failures never break the pipeline.
 *
 * Setup (one-time, owner): add @ozodbekartificialintelegencebot to the
 * channel as an ADMIN. The numeric chat id is then auto-discovered from
 * getUpdates and cached in StudioState (key "telegram").
 */

import { db } from '@/lib/db'

const TG_CACHE_KEY = 'telegram'

interface TelegramCache {
  chatId?: string | number
  lastDiscoveryAt?: number
  botUsername?: string
}

async function readCache(): Promise<TelegramCache> {
  try {
    const row = await db.studioState.findUnique({ where: { key: TG_CACHE_KEY } })
    if (row) return JSON.parse(row.data) as TelegramCache
  } catch { /* fall through */ }
  return {}
}

async function writeCache(patch: Partial<TelegramCache>): Promise<void> {
  const c = { ...(await readCache()), ...patch }
  await db.studioState.upsert({
    where: { key: TG_CACHE_KEY },
    create: { key: TG_CACHE_KEY, data: JSON.stringify(c) },
    update: { data: JSON.stringify(c) },
  })
}

export function botToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN || ''
}

/** ask Bot API for updates and pick the first channel/group the bot can see */
async function discoverChatId(): Promise<string | null> {
  const token = botToken()
  if (!token) return null
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20`, {
      signal: AbortSignal.timeout(15_000),
    })
    const json = (await res.json()) as {
      ok?: boolean
      result?: { channel_post?: { chat?: { id?: number; type?: string } }; my_chat_member?: { chat?: { id?: number; type?: string } } }[]
    }
    for (const u of json.result || []) {
      const chat = u.channel_post?.chat || u.my_chat_member?.chat
      if (chat?.id && (chat.type === 'channel' || chat.type === 'group' || chat.type === 'supergroup')) {
        return String(chat.id)
      }
    }
  } catch { /* offline / not admin yet */ }
  return null
}

/** resolve the target chat id: env override -> cached -> auto-discovery */
export async function resolveChatId(): Promise<string | null> {
  const envId = process.env.TELEGRAM_CHAT_ID
  if (envId) return envId
  const cache = await readCache()
  if (cache.chatId) return String(cache.chatId)
  const now = Date.now()
  if (now - (cache.lastDiscoveryAt || 0) < 5 * 60_000) return null // throttle
  await writeCache({ lastDiscoveryAt: now })
  const found = await discoverChatId()
  if (found) await writeCache({ chatId: found })
  return found
}

export interface TgFile {
  name: string
  data: Buffer
  /** video/* -> sendVideo, else sendDocument */
  mime?: string
}

async function sendOne(
  token: string, chatId: string, file: TgFile, caption: string,
): Promise<boolean> {
  const isVideo = (file.mime || '').startsWith('video/') || file.name.toLowerCase().endsWith('.mp4')
  const method = isVideo ? 'sendVideo' : 'sendDocument'
  const field = isVideo ? 'video' : 'document'
  const form = new FormData()
  form.append('chat_id', chatId)
  form.append('caption', caption.slice(0, 900))
  form.append(field, new Blob([new Uint8Array(file.data)], { type: file.mime || 'application/octet-stream' }), file.name)
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(110_000),
    })
    const json = (await res.json()) as { ok?: boolean; description?: string }
    if (!json.ok) console.error(`[telegram] ${method} ${file.name}:`, json.description)
    return !!json.ok
  } catch (e) {
    console.error('[telegram] upload failed:', e instanceof Error ? e.message : e)
    return false
  }
}

/** id of the owner's private chat with the bot (locked via /start in the
 * webhook flow) - null if nobody has bound the bot yet */
export async function botOwnerChatId(): Promise<string | null> {
  try {
    const row = await db.studioState.findUnique({ where: { key: 'telegramBot' } })
    if (!row) return null
    return (JSON.parse(row.data) as { ownerChatId?: string }).ownerChatId || null
  } catch { return null }
}

/** upload produced files to the owner channel (or an explicit chat);
 * returns count delivered */
export async function uploadToTelegram(
  files: TgFile[], caption: string, chatIdOverride?: string,
): Promise<number> {
  const token = botToken()
  if (!token || files.length === 0) return 0
  const chatId = chatIdOverride || (await resolveChatId())
  if (!chatId) return 0 // bot not admin yet (or invite-only) — skip silently
  let n = 0
  for (const f of files.slice(0, 10)) {
    if (f.data.byteLength === 0 || f.data.byteLength > 49 * 1024 * 1024) continue
    if (await sendOne(token, chatId, f, caption)) n++
  }
  return n
}

/** one plain text message (used for terminal command logs) */
export async function sendTelegramText(text: string, chatIdOverride?: string): Promise<boolean> {
  const token = botToken()
  if (!token) return false
  const chatId = chatIdOverride || (await resolveChatId())
  if (!chatId) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3800) }),
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await res.json()) as { ok?: boolean }
    return !!json.ok
  } catch { return false }
}
