import { zai } from '@/lib/zai'
import { db } from '@/lib/db'
import { buildSystemPrompt } from './prompt'
import { executeTool, isToolName, messageToDTO, type ToolName } from './tools'
import type { AgentEvent, MessageDTO, PlanStepDTO, ToolCallDTO } from './types'
import type { ChatWebTransport } from '@/lib/chatweb'

const MAX_ITERATIONS = 8
const HISTORY_LIMIT = 40

type Emit = (evt: AgentEvent) => void

interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Error carrying a machine-readable transport code out of streamLLM. */
export class TransportError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

/* ------------------------------------------------------- LLM stream utils */

/** parse the Z.ai OpenAI-compatible SSE stream into content deltas.
 * Throws TransportError('captcha_required') when Z.ai demands its captcha —
 * the turn is aborted BEFORE any assistant content and the UI relays
 * Z.ai's own widget, then retries the same message. */
async function* streamLLM(
  messages: LLMMessage[],
  transport?: ChatWebTransport,
): AsyncGenerator<string> {
  const body = await zai.streamChat(
    {
      messages,
      stream: true,
      thinking: { type: 'disabled' },
      temperature: 0.5,
    },
    transport,
  )
  if (!body || typeof body.getReader !== 'function')
    throw new Error('LLM вернул нестриминговый ответ')

  const reader = (body as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const chunk = JSON.parse(payload)
          if (chunk?.error) {
            throw new TransportError(
              String(chunk.error.message || 'Z.ai error').slice(0, 300),
              String(chunk.error.code || 'chatweb_error'),
            )
          }
          const delta: string = chunk?.choices?.[0]?.delta?.content ?? ''
          if (delta) yield delta
        } catch (e) {
          if (e instanceof TransportError) throw e
          /* partial JSON line — skip */
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* noop */ }
  }
}

/** extract the first balanced JSON object from a string (tolerates stray
 * trailing braces/commas that models sometimes emit after the JSON) */
function extractBalancedJson(raw: string): string | null {
  for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return raw.slice(start, i + 1)
      }
    }
  }
  return null
}

/** normalize a parsed tool call: coerce args from string, accept top-level args */
function normalizeToolCall(parsed: Record<string, unknown>): { name: string; args: Record<string, unknown> } | null {
  if (!parsed || typeof parsed.name !== 'string') return null
  let args: Record<string, unknown> = {}
  const a = parsed.args
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    args = a as Record<string, unknown>
  } else if (typeof a === 'string') {
    try {
      const inner = JSON.parse(a)
      if (inner && typeof inner === 'object') args = inner as Record<string, unknown>
    } catch { /* keep {} */ }
  } else if (!a) {
    // maybe the model put the args at the top level next to "name"
    const rest = { ...parsed }
    delete rest.name
    if (Object.keys(rest).length > 0) args = rest
  }
  return { name: parsed.name, args }
}

/** split the model reply into visible text + optional tool call JSON */
function parseReply(full: string): { visible: string; toolCall: { name: ToolName; args: Record<string, unknown> } | null } {
  const parseOne = (s: string): { name: ToolName; args: Record<string, unknown> } | null => {
    try {
      const parsed = JSON.parse(s) as Record<string, unknown>
      const call = normalizeToolCall(parsed)
      if (call && isToolName(call.name)) return { name: call.name, args: call.args }
      return null
    } catch {
      return null
    }
  }

  let visible = full
  let toolCall: { name: ToolName; args: Record<string, unknown> } | null = null
  const matches = [...full.matchAll(/```tool\s*\n?([\s\S]*?)(?:```|$)/gi)]
  if (matches.length > 0) {
    const last = matches[matches.length - 1]
    visible = full.slice(0, last.index).replace(/\s+$/, '')
    const raw = last[1].trim()
    toolCall = parseOne(raw)
    if (!toolCall) {
      // lenient fallback: first balanced JSON object in the block
      const candidate = extractBalancedJson(raw)
      if (candidate) toolCall = parseOne(candidate)
    }
  }
  return { visible, toolCall }
}

/* ------------------------------------------------------- history building */

interface DbMessage {
  id: string
  role: string
  kind: string
  content: string
  meta: string | null
}

function mapHistory(messages: DbMessage[], systemPrompt: string): LLMMessage[] {
  const out: LLMMessage[] = [{ role: 'system', content: systemPrompt }]
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
      continue
    }
    // assistant
    let meta: {
      tools?: { name: string; args?: Record<string, unknown>; summary?: string }[]
      artifacts?: unknown[]
    } | undefined
    if (m.meta) {
      try { meta = JSON.parse(m.meta) } catch { /* ignore */ }
    }
    const call = meta?.tools?.[meta.tools.length - 1]
    if (m.content.trim()) out.push({ role: 'assistant', content: m.content })
    if (call) {
      // reproduce the ReAct structure: tool call + result feedback
      out.push({
        role: 'assistant',
        content: '```tool\n' + JSON.stringify({ name: call.name, args: call.args || {} }) + '\n```',
      })
      out.push({
        role: 'user',
        content: `[TOOL RESULT] ${call.name}: ${call.summary || 'готово'}`,
      })
    }
    if (!m.content.trim() && !call && m.kind === 'task_result') {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  return out
}

/* ---------------------------------------------------------- message persist */

async function persistAssistantMessage(
  conversationId: string,
  content: string,
  meta: MessageDTO['meta'],
): Promise<MessageDTO> {
  const m = await db.message.create({
    data: {
      conversationId,
      role: 'assistant',
      kind: 'text',
      content,
      meta: JSON.stringify(meta || {}),
    },
  })
  await db.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  })
  return messageToDTO(m)
}

/* -------------------------------------------------------------- main loop */

export interface AgentTurnOptions {
  /** per-user chat.z.ai session token (see getUserZaiSession) */
  zaiSessionToken?: string | null
  /** one-time captcha_verify_param relayed from the user's Z.ai widget */
  captchaVerifyParam?: string
  /** captcha retry: the user message is already persisted — don't duplicate */
  skipUserMessage?: boolean
}

export async function runAgentTurn(
  conversationId: string,
  userContent: string,
  emit: Emit,
  opts?: AgentTurnOptions,
): Promise<void> {
  // 1. persist + emit the user message (skipped on captcha retry — the
  // original message is already in the history, a duplicate would confuse
  // both the model and the transcript)
  if (!opts?.skipUserMessage) {
    const userMsg = await db.message.create({
      data: { conversationId, role: 'user', kind: 'text', content: userContent },
    })
    const userDto = messageToDTO(userMsg)
    emit({ type: 'start', conversationId, userMessage: userDto })

    // auto-title the conversation from its first user message
    const conv = await db.conversation.findUnique({ where: { id: conversationId } })
    if (conv && conv.title === 'Новый диалог') {
      const title = userContent.replace(/\s+/g, ' ').trim().slice(0, 48) || 'Новый диалог'
      await db.conversation.update({ where: { id: conversationId }, data: { title } })
      emit({ type: 'title', conversationId, title })
    }
  }

  const systemPrompt = buildSystemPrompt()
  const toolLog: ToolCallDTO[] = []
  const transport: ChatWebTransport = {
    sessionToken: opts?.zaiSessionToken ?? undefined,
    captchaVerifyParam: opts?.captchaVerifyParam || undefined,
  }

  try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const history = await db.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
      })
      const trimmed = history.slice(-HISTORY_LIMIT)
      const llmMessages = mapHistory(trimmed, systemPrompt)

      // 2. stream the model reply, hiding the tool block from the user.
      // Subsequent iterations reuse the SAME one-time captcha param? No —
      // it is single-use; but the param gates the REQUEST, and within one
      // upstream SSE stream the model may run several internal tool rounds,
      // so only the first LLM call per turn needs it. Tool-round iterations
      // here issue new upstream requests — Z.ai may demand the captcha
      // again; then the turn stops and the UI relays the widget.
      let full = ''
      let emitted = 0
      const iterTransport: ChatWebTransport =
        iter === 0 ? transport : { sessionToken: transport.sessionToken }
      for await (const delta of streamLLM(llmMessages, iterTransport)) {
        full += delta
        const idx = full.toLowerCase().indexOf('```tool')
        const visible = idx >= 0 ? full.slice(0, idx).replace(/\s+$/, '') : full
        if (visible.length > emitted) {
          emit({ type: 'delta', text: visible.slice(emitted) })
          emitted = visible.length
        }
      }
      const { visible, toolCall } = parseReply(full)
      if (visible.length > emitted) {
        emit({ type: 'delta', text: visible.slice(emitted) })
        emitted = visible.length
      }

      // 3. no tool call -> final answer; persist and finish
      if (!toolCall) {
        if (visible.trim() || toolLog.length > 0) {
          const meta: MessageDTO['meta'] = {
            ...(toolLog.length ? { tools: toolLog.map((t) => ({ ...t, status: 'ok' as const })) } : {}),
          }
          const msg = await persistAssistantMessage(conversationId, visible.trim(), meta)
          emit({ type: 'message', message: msg })
        }
        emit({ type: 'done' })
        return
      }

      // 4. execute the tool
      const callId = `t${Date.now().toString(36)}${iter}`
      emit({ type: 'tool', id: callId, call: { name: toolCall.name, args: toolCall.args, status: 'running' } })
      let resultSummary = ''
      let plan: { title?: string; steps: PlanStepDTO[] } | undefined
      let taskId: string | undefined
      try {
        const res = await executeTool(toolCall.name, toolCall.args, { conversationId })
        resultSummary = res.summary
        plan = res.plan
        taskId = res.taskId
        emit({
          type: 'tool_result',
          id: callId,
          status: 'ok',
          summary: res.summary,
          ...(taskId ? { taskId } : {}),
          ...(res.plan ? { plan: res.plan } : {}),
        })
        toolLog.push({ name: toolCall.name, args: toolCall.args, status: 'ok', summary: res.summary })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        resultSummary = `ошибка: ${msg}`
        emit({ type: 'tool_result', id: callId, status: 'error', summary: msg.slice(0, 300) })
        toolLog.push({ name: toolCall.name, args: toolCall.args, status: 'error', summary: msg.slice(0, 300) })
      }

      // 5. persist an assistant message carrying the visible text + the tool card
      const meta: MessageDTO['meta'] = {
        tools: [{ name: toolCall.name, args: toolCall.args, status: 'ok', summary: resultSummary }],
        ...(plan ? { plan } : {}),
      }
      const msg = await persistAssistantMessage(conversationId, visible.trim(), meta)
      emit({ type: 'message', message: msg })
      // loop continues: the next iteration sees [TOOL RESULT] via mapHistory
    }

    // iteration budget exhausted — close the turn gracefully
    const msg = await persistAssistantMessage(
      conversationId,
      'Остановился, чтобы не перегружать контекст. Скажи, продолжать ли работу.',
      {},
    )
    emit({ type: 'message', message: msg })
    emit({ type: 'done' })
  } catch (e) {
    // Z.ai demands its captcha: abort cleanly BEFORE any assistant content.
    // The UI relays Z.ai's own widget, the user solves it, and the same
    // message is retried with the fresh one-time param.
    if (e instanceof TransportError && e.code === 'captcha_required') {
      emit({ type: 'captcha_required' })
      emit({ type: 'done' })
      return
    }
    if (e instanceof TransportError && e.code === 'zai_session_expired') {
      // the user's own Z.ai JWT died mid-turn — a re-login is required;
      // surface a typed event instead of a generic error
      emit({ type: 'error', message: e.message.slice(0, 300), code: 'zai_session_expired' })
      emit({ type: 'done' })
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    emit({ type: 'error', message: msg.slice(0, 400) })
    try {
      const msgDto = await persistAssistantMessage(
        conversationId,
        `Произошла ошибка при работе агента: ${msg.slice(0, 300)}. Попробуй ещё раз.`,
        {},
      )
      emit({ type: 'message', message: msgDto })
      emit({ type: 'done' })
    } catch { /* stream already broken */ }
  }
}
