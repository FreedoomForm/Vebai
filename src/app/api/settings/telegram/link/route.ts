import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * Telegram linking for SITE accounts (owner request 2026-10-18):
 * "в настройках сайта создаём кнопку подключить телеграм, при нажатии
 * пользователь переносится к телеграм боту, и если у него уже есть история
 * в телеграм боте - она объединяется с историей чатов его аккаунта".
 *
 * POST /api/settings/telegram/link
 *   -> one-time deep link https://t.me/<bot>?start=connect_<token>
 *   The user presses START in the bot; the webhook binds their telegramChatId
 *   to this site account and re-binds the bot conversation(s) (the whole bot
 *   history) into the account's conversation list.
 * GET  /api/settings/telegram/link -> { connected, chatId, username }
 */

const TOKENS_KEY = 'tgLinkTokens'
const LINK_TTL_MS = 24 * 60 * 60 * 1000 // deep link lives one day
const BOT_USERNAME_FALLBACK = 'ozodbekartificialintelegencebot'

async function botUsername(): Promise<string> {
  if (process.env.TELEGRAM_BOT_USERNAME) return process.env.TELEGRAM_BOT_USERNAME
  try {
    const row = await db.studioState.findUnique({ where: { key: 'telegram' } })
    const cached = row ? (JSON.parse(row.data) as { botUsername?: string }).botUsername : ''
    if (cached) return cached
  } catch { /* ignore */ }
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (token) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(10_000),
      })
      const json = (await res.json()) as { ok?: boolean; result?: { username?: string } }
      if (json.ok && json.result?.username) {
        const row = await db.studioState.findUnique({ where: { key: 'telegram' } })
        const data = { ...(row ? JSON.parse(row.data) : {}), botUsername: json.result.username }
        await db.studioState.upsert({
          where: { key: 'telegram' },
          create: { key: 'telegram', data: JSON.stringify(data) },
          update: { data: JSON.stringify(data) },
        })
        return json.result.username
      }
    } catch { /* offline -> fallback */ }
  }
  return BOT_USERNAME_FALLBACK
}

interface LinkTokens {
  [token: string]: { userId: string; email: string; exp: number }
}

export async function GET(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  const row = await db.user.findUnique({ where: { id: user!.id } })
  return NextResponse.json({
    connected: !!row?.telegramChatId,
    chatId: row?.telegramChatId || null,
    username: row?.telegramUsername || null,
  })
}

export async function POST(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized

  const row = await db.user.findUnique({ where: { id: user!.id } })
  if (row?.telegramChatId)
    return NextResponse.json({
      ok: true,
      already: true,
      url: `https://t.me/${await botUsername()}`,
    })

  const token = crypto.randomBytes(18).toString('hex')
  const store = await db.studioState.findUnique({ where: { key: TOKENS_KEY } })
  const tokens = (store ? (JSON.parse(store.data) as LinkTokens) : {})
  // drop expired entries so the blob stays small
  const now = Date.now()
  for (const t of Object.keys(tokens)) if (tokens[t].exp < now) delete tokens[t]
  tokens[token] = { userId: user!.id, email: user!.email, exp: now + LINK_TTL_MS }
  await db.studioState.upsert({
    where: { key: TOKENS_KEY },
    create: { key: TOKENS_KEY, data: JSON.stringify(tokens) },
    update: { data: JSON.stringify(tokens) },
  })

  return NextResponse.json({
    ok: true,
    url: `https://t.me/${await botUsername()}?start=connect_${token}`,
  })
}
