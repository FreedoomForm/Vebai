/**
 * T50: ONE source of truth for the bot's inline menu.
 *
 * Owner request 2026-10-23: «верни все кнопки в телеграм боте» — over the
 * t27..t42 refactors most send paths (task results, agent mirrors, files,
 * fast-chat answers, hints) drifted to bare messages, so the bot felt
 * button-less: the full menu lived only under /menu, /start, /status, /app.
 * Now EVERY message the bot sends carries the same full menu, and any
 * message becomes a live panel when a button on it is pressed (the webhook's
 * handleCallback edits the carrier message in place).
 *
 * The rows are byte-identical to the old route.ts menuKb:
 *   [🆕 Создать чат] [📂 Чаты]
 *   [🌐 Открыть Vebai (аккаунт)]        (web_app mini app)
 *   [📱 Подключить Telegram аккаунт]     (while not connected)   — or —
 *   [🤖 Агент: ВКЛ/ВЫКЛ] [💬 Научить агента (чат)]
 */
import { db } from '@/lib/db'
import { adoptConnectedAccountByChatId } from '@/lib/tguser'

/** must stay in sync with route.ts USERS_KEY (the bot users map) */
const USERS_KEY = 'tgUsers'

const MINI_APP_URL = process.env.VEBAI_MINI_APP_URL || 'https://vebai-six.vercel.app/tg'
const SITE_BASE = MINI_APP_URL.replace(/\/tg$/, '') // deep links to site pages

/** chat -> site user row (canonical binding: User.telegramChatId, same as t41) */
async function userForChat(chatId: string) {
  try {
    return await db.user.findUnique({ where: { telegramChatId: chatId } })
  } catch {
    return null
  }
}

/** the chat's connected personal MTProto account — same resolution order the
 *  webhook's resolveConnected uses: account owned by this chat's user first,
 *  then adoption by MTProto identity (site-connected while chat maps a guest) */
async function connectedForChat(chatId: string): Promise<{ active: boolean } | null> {
  try {
    const u = await userForChat(chatId)
    if (u) {
      const acc = await db.tgAccount.findFirst({
        where: { userId: u.id, status: 'connected' },
        orderBy: { updatedAt: 'desc' },
      })
      if (acc) return { active: acc.active }
    }
    return await adoptConnectedAccountByChatId(chatId)
  } catch {
    return null
  }
}

/** build the full menu rows; NEVER throws — on any failure the connect row
 *  shows (pressing it re-resolves and renders the correct panel) */
export async function botMenuKb(chatId: string): Promise<Record<string, unknown>> {
  const rows: Record<string, unknown>[][] = [
    [
      { text: '🆕 Создать чат', callback_data: 'newchat' },
      { text: '📂 Чаты', callback_data: 'chatlist' },
    ],
    [{ text: '🌐 Открыть Vebai (аккаунт)', web_app: { url: MINI_APP_URL } }],
  ]
  const acc = await connectedForChat(chatId)
  if (!acc) {
    rows.push([{ text: '📱 Подключить Telegram аккаунт', callback_data: 'tgconnect' }])
  } else {
    rows.push([
      { text: acc.active ? '🤖 Агент: ВКЛ — выключить' : '🤖 Агент: ВЫКЛ — включить', callback_data: 'tgagent' },
      { text: '💬 Научить агента (чат)', url: `${SITE_BASE}/?agent=1` },
    ])
  }
  return { inline_keyboard: rows }
}

/** true when the chat belongs to a bot user (private chat with /start history
 *  or a site-bound user). The Telegram ARCHIVE CHANNEL (negative ids, chat
 *  posts from the terminal/video pipeline) is NOT a user chat — buttons there
 *  would be dead weight, so senders use this gate before attaching the menu. */
async function isBotUserChat(chatId: string): Promise<boolean> {
  try {
    const u = await db.user.findUnique({ where: { telegramChatId: chatId } })
    if (u) return true
  } catch {
    /* fall through to the cached users map */
  }
  try {
    const row = await db.studioState.findUnique({ where: { key: USERS_KEY } })
    if (row) {
      const map = JSON.parse(row.data) as Record<string, unknown>
      return !!map[chatId]
    }
  } catch {
    /* fall through */
  }
  return false
}

/** menu for lib senders (results / mirrors / files): rows only when the
 *  target is a bot-user chat, null otherwise (archive channel stays clean) */
export async function menuIfUserChat(chatId: string): Promise<Record<string, unknown> | null> {
  try {
    if (!(await isBotUserChat(String(chatId)))) return null
    return await botMenuKb(String(chatId))
  } catch {
    return null
  }
}
