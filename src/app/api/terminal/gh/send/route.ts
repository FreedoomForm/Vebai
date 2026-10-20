import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  uploadToTelegram,
  sendTelegramText,
  botOwnerChatId,
  resolveChatId,
  taskChat,
  type TgFile,
} from '@/lib/telegram'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

interface SendFile {
  name?: string
  b64?: string
  mime?: string
}

/**
 * POST /api/terminal/gh/send — the agent-mode runner explicitly delivers
 * texts/files to a person through the Telegram bot (owner request 2026-10-18:
 * "организуй отправку нужных файлов и текстов нужному человеку").
 *
 * Recipients (scoped to the TASK SENDER since the bot went multi-user):
 *   "owner"/"me" (default) -> the sender's own chat (for the owner's tasks
 *                             that is the owner's private chat, for guest
 *                             tasks - the guest who sent the task)
 *   "channel"              -> the archive channel (OWNER ONLY)
 *   "-100..." | "@user"    -> explicit third party (OWNER ONLY)
 *
 * Auth is identical to /claim, /result and /progress (TerminalSession
 * kind='gh' + secret). The route also doubles as a keep-alive: it refreshes
 * the session heartbeat and touches the running command row.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    secret?: string
    session?: string
    chat?: string
    text?: string
    caption?: string
    files?: SendFile[]
  }
  const secret = String(body.secret || '')
  const sessionId = String(body.session || '')
  if (!secret || !sessionId)
    return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 })

  const session = await db.terminalSession.findUnique({ where: { id: sessionId } })
  if (!session || session.kind !== 'gh' || session.secret !== secret)
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })

  // ---- keep-alive + origin resolution (who is the task sender?) ----------
  await db.terminalSession
    .update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } })
    .catch(() => null)
  const cmd = await db.terminalCommand
    .findFirst({ where: { sessionId, status: 'running' }, orderBy: { updatedAt: 'desc' } })
    .catch(() => null)
  const origin = await taskChat(cmd?.conversationId).catch(() => null)
  const isOwnerTask = !!origin?.isOwner

  // ---- resolve the recipient ----------------------------------------------
  const raw = String(body.chat || 'owner').trim()
  const alias = raw.toLowerCase()
  let chatId: string | null = null
  if (!raw || alias === 'owner' || alias === 'me' || alias === 'владелец') {
    // "me" = the person who sent the task (owner alias keeps working for
    // the owner's own tasks)
    chatId = origin?.chatId || (await botOwnerChatId())
  } else if (alias === 'channel' || alias === 'канал') {
    if (!isOwnerTask)
      return NextResponse.json(
        { ok: false, error: 'отправка в канал доступна только владельцу — отправь файл себе (to=owner)' },
        { status: 403 },
      )
    chatId = await resolveChatId()
  } else if (/^-?\d{3,}$/.test(raw) || /^@[a-zA-Z][a-zA-Z0-9_]{3,63}$/.test(raw)) {
    if (!isOwnerTask)
      return NextResponse.json(
        { ok: false, error: 'отправка третьим лицам доступна только владельцу — отправь файл себе (to=owner)' },
        { status: 403 },
      )
    chatId = raw
  } else
    return NextResponse.json(
      { ok: false, error: `непонятный получатель «${raw.slice(0, 60)}» — owner | channel | chat_id | @username` },
      { status: 400 },
    )
  if (!chatId)
    return NextResponse.json(
      { ok: false, error: 'получатель ещё не привязан (владелец должен отправить боту /start)' },
      { status: 400 },
    )

  // ---- what to deliver ------------------------------------------------------
  const text = String(body.text || '').trim()
  const files: TgFile[] = []
  for (const f of (body.files || []).slice(0, 3)) {
    const name = String(f.name || '')
      .replace(/[\\/\r\n]/g, '_')
      .slice(0, 120)
    if (!name) continue
    try {
      const buf = Buffer.from(String(f.b64 || ''), 'base64')
      if (buf.byteLength === 0 || buf.byteLength > 3_400_000) continue
      files.push({ name, data: buf, mime: f.mime })
    } catch {
      /* skip broken payloads */
    }
  }
  if (!text && files.length === 0)
    return NextResponse.json({ ok: false, error: 'нечего отправлять: нет ни текста, ни файлов' }, { status: 400 })

  const errors: string[] = []
  let textSent = 0
  let filesSent = 0

  if (files.length > 0) {
    // file message(s); the body text becomes the caption
    const caption = (String(body.caption || '') || text).slice(0, 900) || '📎 от агента Vebai'
    try {
      filesSent = await uploadToTelegram(files, caption, chatId)
      if (filesSent < files.length) errors.push('часть файлов не доставлена')
    } catch (e) {
      errors.push(`файлы не доставлены: ${e instanceof Error ? e.message.slice(0, 120) : 'ошибка'}`)
    }
  } else {
    // text-only: send in chunks (Telegram cap ~4096 chars per message)
    const chunks = text.match(/[\s\S]{1,3500}(?=\s|$)|[\s\S]{1,3500}/g) || [text]
    for (const c of chunks.slice(0, 8)) {
      if (await sendTelegramText(c, chatId)) textSent++
      else errors.push('текст не доставлен')
    }
  }

  // ---- transparency: the owner always sees third-party sends ---------------
  try {
    const ownerId = await botOwnerChatId()
    if (isOwnerTask && chatId !== ownerId) {
      const what = files.length
        ? `файл(ы): ${files.map((f) => f.name).join(', ').slice(0, 200)}`
        : `текст: ${text.slice(0, 150)}`
      await sendTelegramText(`📤 Агент отправил ${what} получателю ${raw}`)
    }
  } catch {
    /* best-effort */
  }

  // ---- keep-alive touch of the running command (same contract as /progress)
  if (cmd) {
    await db.terminalCommand
      .update({
        where: { id: cmd.id },
        data: {
          output: `[агент] отправка получателю ${raw}: текст ${textSent ? 'доставлен' : '—'}, файлов ${filesSent}/${files.length}`,
        },
      })
      .catch(() => null)
  }

  const ok = errors.length === 0 && (textSent > 0 || filesSent > 0)
  return NextResponse.json({
    ok,
    chat: raw || 'owner',
    textSent,
    filesSent,
    errors: errors.slice(0, 3),
  })
}
