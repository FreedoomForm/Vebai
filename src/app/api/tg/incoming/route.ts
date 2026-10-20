/**
 * T26: POST /api/tg/incoming — the worker reports a fresh incoming private
 * message on a user's account; the site dedupes, logs it and DECIDES what to
 * do about it. The actual sending happens in the worker, and only then
 * /api/tg/sent logs the outgoing message (T21 rule: the log reflects
 * reality, not intentions).
 *
 * T38 (owner request 2026-10-20): the message no longer goes "straight to
 * the AI" for a canned reply — it goes to the AGENT, which weighs its
 * durable memory (memory.md), the recent history of THIS chat and the
 * owner's teaching, and picks the action itself:
 *   reply   -> the worker sends <text> (same contract as before)
 *   ignore  -> nothing is sent (spam / no answer needed)
 *   owner   -> the owner gets a bot notification; the person may get a
 *              polite holding line
 *   approve (T39) -> the agent's reply becomes a DRAFT card in the owner's
 *              bot chat with ✅/✏️/❌; the person gets it only after «✅"
 * At the END of every request the agent silently appends a brief summary of
 * the interaction to memory.md (after() — never delays the reply).
 */
import crypto from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import {
  agentDecide,
  createDraft,
  draftKeyboard,
  loadAgentContext,
  parseExamples,
  readAgentMemory,
  rememberInteraction,
  renderDraftMessage,
  setDraftStatus,
  type TgDraft,
} from '@/lib/tguser'

export const runtime = 'nodejs'
export const maxDuration = 60

const RATE_PER_HOUR = 30
const HISTORY_TURNS = 12

function secretOk(s: unknown): boolean {
  const expected = process.env.GH_TERM_SECRET || ''
  const given = String(s || '')
  if (!expected || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** bot-cache owner chat (fallback: TELEGRAM_CHAT_ID env) — the escalation
 *  target when the agent hands a conversation back to the owner */
async function ownerChatId(): Promise<string> {
  try {
    const row = await db.studioState.findUnique({ where: { key: 'telegramBot' } })
    const id = row ? String((JSON.parse(row.data) as { ownerChatId?: string }).ownerChatId || '') : ''
    if (id) return id
  } catch { /* fall through */ }
  return String(process.env.TELEGRAM_CHAT_ID || '')
}

async function notifyOwner(text: string): Promise<void> {
  const chatId = await ownerChatId()
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!chatId || !token) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3800) }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch { /* best-effort */ }
}

/** one-line digest of the decision for the worker logs and for memory.md */
function outcomeLine(decision: { action: string; text: string }): string {
  if (decision.action === 'reply') return `ответил от имени владельца: «${decision.text.slice(0, 200)}»`
  if (decision.action === 'ignore') return 'решил не отвечать (сообщение не требовало ответа)'
  if (decision.action === 'approve')
    return `предложил черновик ответа на одобрение владельцу: «${decision.text.slice(0, 200)}»`
  return `передал вопрос владельцу${decision.text ? `, человеку сказано: «${decision.text.slice(0, 150)}»` : ' (молча)'}`
}

/** bot sendMessage that returns the created message_id (0 = failed) — draft
 *  cards need the id so the webhook can re-render the card after the owner's
 *  decision (approve / edit / cancel) */
async function sendBotMessage(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<number> {
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!chatId || !token) return 0
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 3800),
        link_preview_options: { is_disabled: true },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await res.json()) as { ok?: boolean; result?: { message_id?: number } }
    return json.ok ? Number(json.result?.message_id) || 0 : 0
  } catch { return 0 }
}

/** where draft approval cards go: the ACCOUNT owner's own bot chat first
 *  (multi-user correctness), then the bot owner, then the env fallback */
async function draftTargetChatId(userId: string): Promise<string> {
  try {
    const u = await db.user.findUnique({ where: { id: userId } })
    if (u?.telegramChatId) return u.telegramChatId
  } catch { /* fall through */ }
  return ownerChatId()
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  if (!secretOk(body.secret)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const accountId = String(body.accountId || '')
  const chatId = String(body.chatId || '')
  const msgId = String(body.msgId || '')
  const chatName = String(body.chatName || '').slice(0, 120) || null
  const text = String(body.text || '').slice(0, 2000)
  if (!accountId || !chatId || !msgId || !text.trim())
    return NextResponse.json({ skip: 'bad-request' })

  const account = await db.tgAccount.findUnique({ where: { id: accountId }, include: { config: true } })
  if (!account || account.status !== 'connected' || !account.active)
    return NextResponse.json({ skip: 'inactive' })

  // dedupe (worker restarts / Telegram replays must not double-reply)
  const dup = await db.tgAgentMessage.findUnique({
    where: { accountId_chatId_msgId_direction: { accountId, chatId, msgId, direction: 'in' } },
  }).catch(() => null)
  if (dup) return NextResponse.json({ skip: 'dup' })
  await db.tgAgentMessage.create({
    data: { accountId, chatId, chatName, msgId, direction: 'in', text },
  }).catch(() => {})

  // server-side hourly cap (belt & suspenders on top of the worker limiter)
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const sentCount = await db.tgAgentMessage.count({
    where: { accountId, direction: 'out', createdAt: { gt: hourAgo } },
  })
  if (sentCount >= RATE_PER_HOUR) return NextResponse.json({ skip: 'rate' })

  let me: { firstName?: string; username?: string } = {}
  try { me = JSON.parse(account.meInfo || '{}') } catch { /* ignore */ }

  // the agent's three memory sources, gathered in parallel:
  // memory.md (durable), the per-chat transcript (DB), the owner's teaching
  // (site «TG-агент» conversation)
  const [context, memory, chatRows] = await Promise.all([
    loadAgentContext(account.userId).catch(() => ''),
    readAgentMemory(account.userId).catch(() => ''),
    db.tgAgentMessage.findMany({
      where: { accountId, chatId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_TURNS,
    }).catch(() => []),
  ])
  chatRows.reverse() // oldest -> newest
  const history = chatRows.map((m) => {
    const who = m.direction === 'in' ? (m.chatName || chatName || 'Собеседник') : 'Ты (агент)'
    return `${who}: ${(m.text || '').replace(/\s+/g, ' ').slice(0, 300)}`
  })

  try {
    const decision = await agentDecide(
      me,
      account.config?.systemPrompt || '',
      parseExamples(account.config?.examples),
      chatName || '',
      text,
      context,
      memory,
      history,
    )

    // T38: the silent under-the-hood memory write at the END of the request
    // — runs after the HTTP response, never delays or breaks the decision
    after(() =>
      rememberInteraction(account.userId, chatName || '', text, outcomeLine(decision)).catch(() => {}),
    )

    if (decision.action === 'ignore') return NextResponse.json({ skip: 'agent-ignore' })

    if (decision.action === 'owner') {
      after(() =>
        notifyOwner(
          `📩 Входящее от ${chatName || chatId}:\n${text.slice(0, 1200)}\n\n` +
            `🤖 Агент передал вопрос тебе (сам не стал отвечать).`,
        ).catch(() => {}),
      )
      if (decision.text) return NextResponse.json({ reply: decision.text })
      return NextResponse.json({ skip: 'agent-owner' })
    }

    // T39: the agent KNOWS what to answer but wants the owner's blessing —
    // the reply becomes a draft card in the owner's bot chat (✅/✏️/❌).
    // The worker sends NOTHING now; the person receives the text only after
    // «✅» (the webhook then queues a tg_outbox job — the worker delivers).
    if (decision.action === 'approve') {
      const target = await draftTargetChatId(account.userId)
      if (!target) return NextResponse.json({ skip: 'draft-no-target' })
      const draft: TgDraft = {
        id: crypto.randomUUID(),
        chatId,
        chatName: chatName || '',
        incoming: text,
        text: decision.text,
        ownerChatId: target,
        status: 'pending',
        createdAt: new Date().toISOString(),
      }
      await createDraft(account.id, draft)
      // inline (not after()): the owner MUST reliably get the card — one
      // Telegram call fits the worker's 90s HTTP timeout comfortably
      const msgId = await sendBotMessage(target, renderDraftMessage(draft), draftKeyboard(draft.id))
      if (msgId) await setDraftStatus(account.id, draft.id, 'pending', { botMsgId: msgId }).catch(() => {})
      return NextResponse.json({ skip: 'draft-pending' })
    }

    if (!decision.text) return NextResponse.json({ skip: 'empty-reply' })
    return NextResponse.json({ reply: decision.text })
  } catch (e) {
    return NextResponse.json({ skip: 'ai-error', error: e instanceof Error ? e.message.slice(0, 200) : 'ошибка ИИ' })
  }
}
