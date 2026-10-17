import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { uploadToTelegram } from '@/lib/telegram'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

interface GhFile {
  path?: string
  b64?: string
  mime?: string
}

/**
 * POST /api/terminal/gh/result — the GitHub Actions executor reports back.
 * Same auth as /claim (TerminalSession kind='gh' + secret). On completion:
 * saves files as TerminalFile rows (inline <=3.5MB), mirrors them to the
 * owner's Telegram channel, and posts the result message into the chat.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    secret?: string
    session?: string
    cmdId?: string
    status?: string
    exitCode?: number
    output?: string
    files?: GhFile[]
  }
  const secret = String(body.secret || '')
  const sessionId = String(body.session || '')
  const cmdId = String(body.cmdId || '')
  if (!secret || !sessionId || !cmdId)
    return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 })

  const session = await db.terminalSession.findUnique({ where: { id: sessionId } })
  if (!session || session.kind !== 'gh' || session.secret !== secret)
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })

  const cmd = await db.terminalCommand.findUnique({ where: { id: cmdId } })
  if (!cmd || cmd.sessionId !== sessionId)
    return NextResponse.json({ ok: false, error: 'command not found' }, { status: 404 })

  const status = body.status === 'done' ? 'done' : 'failed'
  const exit = typeof body.exitCode === 'number' ? Math.trunc(body.exitCode) : status === 'done' ? 0 : 1
  const output = String(body.output || '').slice(0, 20_000)

  const updated = await db.terminalCommand
    .update({
      where: { id: cmdId },
      data: { status, exitCode: exit, output },
    })
    .catch(() => null)
  if (!updated)
    return NextResponse.json({ ok: false, error: 'command not found' }, { status: 404 })

  // ---- files: store inline + mirror to Telegram
  const saved: { id: string; path: string; size: number }[] = []
  const tgFiles: { name: string; data: Buffer; mime?: string }[] = []
  for (const f of (body.files || []).slice(0, 8)) {
    const path = String(f.path || '').replace(/\\/g, '/').slice(0, 200)
    if (!path) continue
    try {
      const buf = Buffer.from(String(f.b64 || ''), 'base64')
      if (buf.byteLength === 0 || buf.byteLength > 3_500_000) continue
      const row = await db.terminalFile.upsert({
        where: { sessionId_path: { sessionId, path } },
        create: {
          sessionId,
          path,
          size: buf.byteLength,
          mime: f.mime || undefined,
          data: new Uint8Array(buf),
        },
        update: { size: buf.byteLength, mime: f.mime || undefined, data: new Uint8Array(buf), tgOk: false },
      })
      saved.push({ id: row.id, path, size: buf.byteLength })
      tgFiles.push({ name: path.split('/').pop() || path, data: buf, mime: f.mime })
    } catch {
      // skip broken file payloads
    }
  }
  if (tgFiles.length > 0) {
    try {
      const n = await uploadToTelegram(
        tgFiles,
        `🗂 файл(ы) команды (GitHub Actions)\n$ ${cmd.command.slice(0, 250)}`,
      )
      if (n > 0)
        await db.terminalFile.updateMany({
          where: { id: { in: saved.map((s) => s.id) } },
          data: { tgOk: true },
        })
    } catch {
      /* mirror is best-effort */
    }
  }

  // ---- chat mirror (same contract as the browser-terminal result route)
  if (cmd.conversationId) {
    const conv = await db.conversation.findUnique({ where: { id: cmd.conversationId } })
    if (conv) {
      const outputView = (output || '(пустой вывод)').slice(0, 6000)
      const filesView = saved
        .map((s) => `📎 [${s.path}](/api/terminal/files/${s.id}) — ${(s.size / 1024).toFixed(1)} КБ`)
        .join('\n')
      const content =
        status === 'done'
          ? `Терминал (GitHub Actions): $ ${cmd.command.slice(0, 300)}\n\`\`\`\n${outputView}\n\`\`\`\nexit code: ${exit}${filesView ? `\n\nФайлы:\n${filesView}` : ''}`
          : `Терминал (GitHub Actions): команда «${cmd.command.slice(0, 120)}» не выполнена (exit ${exit}): ${outputView.slice(0, 400)}${filesView ? `\n\nФайлы:\n${filesView}` : ''}`
      await db.message.create({
        data: {
          conversationId: cmd.conversationId,
          role: 'assistant',
          kind: 'task_result',
          content,
          meta: JSON.stringify({ terminalCommandId: cmd.id }),
        },
      })
      await db.conversation.update({
        where: { id: cmd.conversationId },
        data: { updatedAt: new Date() },
      })
    }
  }

  return NextResponse.json({ ok: true, files: saved.length })
}
