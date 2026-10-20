import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { db } from '@/lib/db'
import { uploadToTelegram } from '@/lib/telegram'
import { formatBytes } from '@/lib/utils'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Vercel serverless request body cap is ~4.5 MB — stay honestly below it */
const MAX_TOTAL = 4 * 1024 * 1024
const MAX_FILES = 5

/**
 * POST /api/chat/attach — T40 (owner request: файлы из чатов сайта и бота
 * сохраняются в Telegram-канале, как и остальные файлы).
 *
 * multipart/form-data: files[] + conversationId?
 * Every attached file is mirrored to the owner's channel via the same
 * uploadToTelegram() path the terminal/video files use (caption carries the
 * chat + author + time). Small scope on purpose: the channel IS the archive —
 * the chat message only annotates what was attached, no binary storage.
 */
export async function POST(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'нет сессии' }, { status: 401 })

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'некорректная форма' }, { status: 400 })
  }

  const conversationId = String(form.get('conversationId') || '').trim()
  const raw = form.getAll('files')
  const files = raw.filter((f): f is File => f instanceof File && f.size > 0)
  if (files.length === 0)
    return NextResponse.json({ error: 'файлов нет' }, { status: 400 })
  if (files.length > MAX_FILES)
    return NextResponse.json({ error: `не больше ${MAX_FILES} файлов за раз` }, { status: 413 })

  const total = files.reduce((s, f) => s + f.size, 0)
  if (total > MAX_TOTAL)
    return NextResponse.json(
      { error: `суммарно до ${formatBytes(MAX_TOTAL)} на запрос (лимит Vercel) — сейчас ${formatBytes(total)}` },
      { status: 413 },
    )

  // caption context: the chat title (if the conversation exists and is ours)
  let title = 'новый чат'
  if (conversationId) {
    const conv = await db.conversation.findUnique({ where: { id: conversationId } })
    if (conv && (!conv.userId || conv.userId === user.id)) title = conv.title || title
  }

  const tgFiles: { name: string; data: Buffer; mime?: string }[] = []
  for (const f of files) {
    const data = Buffer.from(await f.arrayBuffer())
    if (data.byteLength === 0) continue
    tgFiles.push({ name: (f.name || 'file.bin').slice(0, 120), data, mime: f.type || undefined })
  }
  if (tgFiles.length === 0)
    return NextResponse.json({ error: 'файлы пустые' }, { status: 400 })

  const stamp = new Date().toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const who = user.name || user.email
  const saved = await uploadToTelegram(
    tgFiles,
    `📎 чат «${title.slice(0, 60)}» • ${who.slice(0, 60)} • ${stamp} (веб-чат Vebai)`,
  )
  if (!saved)
    return NextResponse.json(
      { error: 'не удалось сохранить в Telegram-канал (бот админ канала? проверь /status)' },
      { status: 502 },
    )

  return NextResponse.json({
    ok: true,
    saved,
    files: tgFiles.map((f) => ({ name: f.name, size: f.data.byteLength })),
  })
}
