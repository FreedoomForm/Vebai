import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { uploadToTelegram, sendTelegramText, taskChat } from '@/lib/telegram'
import { parseAiAnswer, fileWants } from '@/lib/agent/answer'

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

  // ---- files: store inline + mirror to Telegram (channel + owner's private chat)
  const isAgent = cmd.command.startsWith('#!agent')
  const agentTaskHead = isAgent
    ? cmd.command.slice(7).trim().replace(/\s+/g, ' ').slice(0, 200)
    : ''
  const saved: { id: string; path: string; size: number }[] = []
  const tgFiles: { name: string; data: Buffer; mime?: string }[] = []
  const caption = isAgent
    ? `🗂 файл(ы) агента (GitHub Actions)\n🤖 ${agentTaskHead}`
    : `🗂 файл(ы) команды (GitHub Actions)\n$ ${cmd.command.slice(0, 250)}`
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
          conversationId: cmd.conversationId,
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
    // T16 (owner request): the AGENT chooses which files the user receives
    // via <file>name</file> tags in its final output. Files it did not list
    // stay in the account (files page) but are never sent to the user.
    // A legacy output without <answer> keeps the old "send everything" mode.
    let wanted: string[] | null = null
    let visibleText = output
    if (isAgent) {
      const parsed = parseAiAnswer(output)
      visibleText = parsed.text
      wanted = parsed.files.length > 0 ? parsed.files : parsed.tagged ? [] : null
    }
    const chosenTg = wanted ? tgFiles.filter((f) => fileWants(wanted as string[], f.name)) : tgFiles
    const chosenSaved = wanted ? saved.filter((s) => fileWants(wanted as string[], s.path)) : saved

    // multi-user delivery (2026-10-18): files go to the TASK SENDER's chat;
    // the public channel archive + owner DM remain owner-only (privacy:
    // strangers' files must not land in the owner's channel). The channel
    // mirror stays the FULL archive (owner's bookkeeping, not user chat).
    const origin = await taskChat(cmd.conversationId).catch(() => null)
    try {
      if (chosenTg.length > 0) {
        if (origin?.isOwner) {
          const n = await uploadToTelegram(chosenTg, caption, origin.chatId)
          if (n > 0)
            await db.terminalFile.updateMany({
              where: { id: { in: chosenSaved.map((s) => s.id) } },
              data: { tgOk: true },
            })
          if (saved.length > chosenTg.length) {
            const nAll = await uploadToTelegram(tgFiles, caption)
            if (nAll > 0)
              await db.terminalFile.updateMany({
                where: { id: { in: saved.map((s) => s.id) } },
                data: { tgOk: true },
              })
          }
        } else if (origin) {
          const n = await uploadToTelegram(chosenTg, caption, origin.chatId)
          if (n > 0)
            await db.terminalFile.updateMany({
              where: { id: { in: chosenSaved.map((s) => s.id) } },
              data: { tgOk: true },
            })
        } else {
          // pure site conversation (no telegram user bound): legacy archive
          const n = await uploadToTelegram(tgFiles, caption)
          if (n > 0)
            await db.terminalFile.updateMany({
              where: { id: { in: saved.map((s) => s.id) } },
              data: { tgOk: true },
            })
        }
      }
    } catch {
      /* mirror is best-effort */
    }

    // ---- chat mirror (same contract as the browser-terminal result route)
    if (cmd.conversationId) {
      const conv = await db.conversation.findUnique({ where: { id: cmd.conversationId } })
      if (conv) {
        const answerView = (visibleText || '(агент не вернул текст ответа)').slice(0, 6000)
        const filesView = chosenSaved
          .map((s) => `📎 [${s.path.split('/').pop()}](/api/terminal/files/${s.id}) — ${(s.size / 1024).toFixed(1)} КБ`)
          .join('\n')
        const content = isAgent
          ? status === 'done'
            ? `🤖 ${answerView}${filesView ? `\n\n${filesView}` : ''}`
            : `🤖 Агент не справился с задачей «${agentTaskHead}»: ${answerView.slice(0, 600)}${filesView ? `\n\n${filesView}` : ''}`
          : status === 'done'
            ? `Терминал (GitHub Actions): $ ${cmd.command.slice(0, 300)}\n\`\`\`\n${(output || '(пустой вывод)').slice(0, 6000)}\n\`\`\`\nexit code: ${exit}${filesView ? `\n\nФайлы:\n${filesView}` : ''}`
            : `Терминал (GitHub Actions): команда «${cmd.command.slice(0, 120)}» не выполнена (exit ${exit}): ${(output || '').slice(0, 400)}${filesView ? `\n\nФайлы:\n${filesView}` : ''}`
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
        // Telegram counterpart of this conversation (multi-user: the sender's
        // own chat) -> push the result text there
        try {
          const originT = await taskChat(cmd.conversationId)
          if (originT?.chatId) await sendTelegramText(content, originT.chatId)
        } catch { /* best-effort */ }
      }
    }

    return NextResponse.json({ ok: true, files: saved.length })
  }

  // ---- no files at all: still mirror the (clean) result text into the chat
  if (cmd.conversationId) {
    const conv = await db.conversation.findUnique({ where: { id: cmd.conversationId } })
    if (conv) {
      let visibleText = output
      if (isAgent) visibleText = parseAiAnswer(output).text
      const content = isAgent
        ? status === 'done'
          ? `🤖 ${(visibleText || '(агент не вернул текст ответа)').slice(0, 6000)}`
          : `🤖 Агент не справился с задачей «${agentTaskHead}»: ${(visibleText || '(без деталей)').slice(0, 600)}`
        : status === 'done'
          ? `Терминал (GitHub Actions): $ ${cmd.command.slice(0, 300)}\n\`\`\`\n${(output || '(пустой вывод)').slice(0, 6000)}\n\`\`\`\nexit code: ${exit}`
          : `Терминал (GitHub Actions): команда «${cmd.command.slice(0, 120)}» не выполнена (exit ${exit}): ${(output || '').slice(0, 400)}`
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
      try {
        const origin = await taskChat(cmd.conversationId)
        if (origin?.chatId) await sendTelegramText(content, origin.chatId)
      } catch { /* best-effort */ }
    }
  }

  return NextResponse.json({ ok: true, files: saved.length })
}
