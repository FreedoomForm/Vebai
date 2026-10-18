import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { db } from '@/lib/db'
import {
  createSessionToken,
  sessionCookieHeader,
} from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/telegram — Telegram Mini App login (owner request 2026-10-18:
 * "при открытии мини аппа пользователь автоматически регистрировался и
 * попадал на страницу своего аккаунта со всей историей").
 *
 * The mini app page (/tg) sends window.Telegram.WebApp.initData. We verify it
 * the official way (HMAC-SHA256 with the bot token derived secret), then:
 *   1. a user with this telegramChatId -> log them in
 *   2. otherwise -> auto-register a new user (no password; login is only
 *      possible through a valid telegram signature)
 * EVERY telegram user therefore lands in THEIR OWN account - never in an
 * account that happens to have a session cookie in this browser (the old
 * auto-link path hijacked the owner's account that way). Linking a site
 * account to telegram happens ONLY consciously via the
 * "Подключить Telegram" button (Settings -> /start connect_<token>).
 * The bot conversation (StudioState tgUsers map / legacy owner conv) is bound
 * to the account, so all Telegram tasks and files show up on the site too.
 */
export async function POST(req: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!token)
    return NextResponse.json({ error: 'бот не настроен (нет TELEGRAM_BOT_TOKEN)' }, { status: 500 })

  let initData = ''
  try {
    const body = (await req.json()) as { initData?: string }
    initData = String(body.initData || '')
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!initData || !initData.includes('hash='))
    return NextResponse.json({ error: 'нет initData — открой приложение из Telegram' }, { status: 400 })

  // ---- official Telegram WebApp initData validation
  // Verified against the official test vector (Bot API 8.0+ initData that
  // contains the `signature` field): the HMAC data-check-string includes ALL
  // received fields EXCEPT `hash` — the `signature` field STAYS IN. Deleting
  // it here made every real client fail with "подпись Telegram недействительна"
  // (synthetic tests passed only because they never sent a signature).
  const params = new URLSearchParams(initData)
  const hash = params.get('hash') || ''
  params.delete('hash')
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest()
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  if (!hash || hash.length !== computed.length ||
      !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(computed)))
    return NextResponse.json({ error: 'подпись Telegram недействительна' }, { status: 401 })

  const authDate = Number(params.get('auth_date') || 0)
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > 86_400)
    return NextResponse.json({ error: 'данные Telegram устарели — переоткрой мини-апп' }, { status: 401 })

  let tg: {
    id?: number | string
    first_name?: string
    last_name?: string
    username?: string
    photo_url?: string
  } = {}
  try { tg = JSON.parse(params.get('user') || '{}') } catch { /* ignore */ }
  const chatId = String(tg.id || '')
  if (!chatId)
    return NextResponse.json({ error: 'в initData нет пользователя' }, { status: 400 })
  const name = `${tg.first_name || ''} ${tg.last_name || ''}`.trim().slice(0, 60) || tg.username || 'Пользователь'

  // ---- resolve / create the account (always the telegram user's OWN one;
  // an existing site session in this browser is deliberately ignored)
  let user = null as { id: string; email: string; name: string } | null

  // 1) account already created via the bot / a previous mini-app login /
  //    linked through "Подключить Telegram"
  const byTg = await db.user.findUnique({ where: { telegramChatId: chatId } })
  if (byTg) user = { id: byTg.id, email: byTg.email, name: byTg.name }

  // 2) fresh user from the mini app
  if (!user) {
    const created = await db.user.create({
      data: {
        email: `tg_${chatId}@telegram.vebai.app`,
        passwordHash: `s2$disabled$${chatId}-${Date.now()}`,
        name,
        telegramChatId: chatId,
        telegramUsername: tg.username || null,
      },
    })
    user = { id: created.id, email: created.email, name: created.name }
  }

  // ---- bind the bot conversation(s) so Telegram history appears on the site
  try {
    const mapRow = await db.studioState.findUnique({ where: { key: 'tgUsers' } })
    const map = mapRow ? (JSON.parse(mapRow.data) as Record<string, { convId?: string; userId?: string }>) : {}
    const entry = map[chatId]
    if (entry?.convId) {
      await db.conversation.updateMany({
        where: { id: entry.convId },
        data: { userId: user.id },
      })
      // the map must follow the account the user just logged into (after
      // "Подключить Telegram" this is the site account, not the old guest row)
      if (entry.userId !== user.id) {
        map[chatId] = { ...entry, userId: user.id }
        await db.studioState.upsert({
          where: { key: 'tgUsers' },
          create: { key: 'tgUsers', data: JSON.stringify(map) },
          update: { data: JSON.stringify(map) },
        })
      }
    }
    // legacy: the owner's single Telegram conversation (key 'telegramBot')
    const botRow = await db.studioState.findUnique({ where: { key: 'telegramBot' } })
    if (botRow) {
      const bot = JSON.parse(botRow.data) as { ownerChatId?: string; convId?: string }
      if (bot.ownerChatId === chatId && bot.convId) {
        await db.conversation.updateMany({
          where: { id: bot.convId, userId: null },
          data: { userId: user.id },
        })
      }
    }
  } catch { /* binding is best-effort */ }

  const res = NextResponse.json({ ok: true, user })
  res.headers.append('Set-Cookie', sessionCookieHeader(createSessionToken(user.id)))
  return res
}
