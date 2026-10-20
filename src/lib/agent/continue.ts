/**
 * T32 (owner request 2026-10-20): the agent must FINISH the whole order on
 * its own — e.g. "read the last 50 messages from @X and tell me what he
 * asked for" or "read what Marina wrote and send a summary to @ivan". The
 * reading itself is done by the resident Telegram worker (```run-tg-read```
 * -> /api/tg/work); when the transcript arrives, THIS module feeds it back
 * to the chat model so the agent can:
 *   - read more (new ```run-tg-read``` blocks, other chats / search:),
 *   - send a summary/answer to someone (```run-tg```),
 *   - produce files (```run-agent```),
 *   - or simply deliver the final answer to the owner.
 *
 * Runs inside after() on /api/tg/outbox-result — the worker's HTTP response
 * is never blocked. Recursion is bounded by the chain counter (each auto-
 * continuation-emitted read task carries chain+1; stops at MAX_CHAIN).
 */
import { db } from '@/lib/db'
import { zai, type ChatMessage } from '@/lib/zai'
import { systemPrompt } from '@/lib/agent/prompt'
import { createOutboxTasks, createTgReadTasks } from '@/lib/agent/outbox'

const MAX_CHAIN = 3 // read -> continue -> read -> continue -> read -> continue
const HISTORY_MESSAGES = 14
const HISTORY_MSG_CHARS = 2500
const TRANSCRIPT_CHARS = 45_000

export async function continueAfterRead(
  conversationId: string,
  taskId: string,
  transcript: string,
): Promise<void> {
  try {
    const task = await db.agentTask.findUnique({ where: { id: taskId } })
    if (!task || task.conversationId !== conversationId) return
    let chain = 0
    try {
      chain = Math.max(Number(JSON.parse(task.payload || '{}').chain) || 0, 0)
    } catch { /* default */ }
    if (chain >= MAX_CHAIN) return

    const conv = await db.conversation.findUnique({ where: { id: conversationId } })
    if (!conv || !conv.userId) return

    // recent chat history for the model to reconstruct the original order
    const history = await db.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_MESSAGES,
    })
    history.reverse()
    const msgs: ChatMessage[] = []
    let budget = 24_000
    for (const m of history) {
      const role = m.role === 'assistant' ? 'assistant' : 'user'
      const content = String(m.content || '').trim().slice(0, HISTORY_MSG_CHARS)
      if (!content) continue
      const cut = content.slice(0, Math.max(budget, 500))
      budget -= cut.length
      msgs.push({ role, content: cut })
      if (budget <= 0) break
    }
    if (msgs.length === 0 || msgs[msgs.length - 1].role !== 'user') {
      msgs.push({ role: 'user', content: 'Продолжи выполнение моего последнего задания.' })
    }

    const continuation: ChatMessage = {
      role: 'user',
      content: [
        `АВТОПРОДОЛЖЕНИЕ ЗАДАНИЯ. Воркер прочитал сообщения из Telegram по твоему блоку run-tg-read (задача «${task.title.slice(0, 140)}»).`,
        'Транскрипт (от старых к свежим):',
        '',
        transcript.slice(0, TRANSCRIPT_CHARS),
        '',
        'Продолжи выполнение исходного задания пользователя САМ, без его участия:',
        '- если данных мало — выдай новые блоки run-tg-read (другой чат, больше limit, search: по слову);',
        '- если результат нужно кому-то передать — блок run-tg (to:/message:/file:);',
        '- если нужен файл (отчёт/PDF) — блок run-agent с полным ТЗ;',
        '- если задание полностью выполнено — дай финальный ответ по делу.',
        'Не задавай вопросов и не проси подтверждений — действуй.',
      ].join('\n'),
    }
    msgs.push(continuation)

    const sys =
      systemPrompt() +
      '\n\nСЕЙЧАС — АВТОПРОДОЛЖЕНИЕ: ты выполняешь приказ владельца полностью БЕЗ его участия (он может ничего не писать). Результаты чтения Telegram уже у тебя в последнем сообщении — сразу действуй дальше или отчитайся, если всё сделано.'

    const completion = await zai.chat.completions({
      messages: [{ role: 'system', content: sys }, ...msgs],
      max_tokens: 2200,
      temperature: 0.4,
    })
    const answer = String(completion.choices?.[0]?.message?.content || '').trim()
    if (!answer) return

    await db.message.create({
      data: {
        conversationId,
        role: 'assistant',
        kind: 'text',
        content: answer,
        meta: JSON.stringify({ taskId, autoContinue: true, chain }),
      },
    })
    await db.conversation
      .update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
      .catch(() => {})

    // dispatch the follow-up tool blocks the continuation emitted
    const mAgent = answer.match(/```run-agent\s*\n([\s\S]*?)```/)
    if (mAgent) {
      const t = mAgent[1].trim().slice(0, 8000)
      if (t) {
        await db.agentTask.create({
          data: {
            conversationId,
            type: 'terminal',
            title: `🤖 ${t.replace(/\s+/g, ' ').slice(0, 90)}`,
            status: 'queued',
            progress: 'Автономный агент на GitHub Actions возьмёт задачу в течение минуты…',
            payload: JSON.stringify({ command: `#!agent\n${t}`, terminalId: conversationId, timeoutS: 3600 }),
          },
        }).catch(() => {})
      }
    }
    await createOutboxTasks(answer, conversationId, conv.userId)
    const nr = await createTgReadTasks(answer, conversationId, conv.userId, chain + 1)
    if (nr === -1) {
      await db.message
        .create({
          data: {
            conversationId,
            role: 'assistant',
            kind: 'task_result',
            content: '📖 Дочитать ещё сообщения нельзя: Telegram-аккаунт отключён — подключи его на /tgagent и попроси продолжить',
            meta: JSON.stringify({ taskId }),
          },
        })
        .catch(() => {})
    }
  } catch (e) {
    // continuation is best-effort: the transcript itself is already in the chat
    console.error('[continue] failed:', e instanceof Error ? e.message.slice(0, 200) : e)
  }
}
