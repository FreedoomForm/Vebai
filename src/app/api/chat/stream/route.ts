import { NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { db } from '@/lib/db'
import { zai, type ChatMessage } from '@/lib/zai'
import { DEFAULT_CHAT_MODEL, FALLBACK_CHAT_MODEL } from '@/lib/zai-config'
import { systemPrompt } from '@/lib/agent/prompt'
import { createAnswerStreamFilter, parseAiAnswer, checkAnswerProtocol, formatRetryNote } from '@/lib/agent/answer'
import { compileAgentChatPrompt, readAgentConversationId } from '@/lib/tguser'
import { createOutboxTasks, createTgReadTasks } from '@/lib/agent/outbox'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const HISTORY_LIMIT = 40
const MAX_CHARS = 24_000

function sse(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
}

/* ---- terminal dispatch ------------------------------------------------- */

/** T22 (owner request 2026-10-19): the model hands a REAL job (PDF, report,
 * xlsx, analysis...) to the RESIDENT AGENT with a ```run-agent``` fenced
 * block containing the full natural-language task. The task is queued as an
 * '#!agent' TerminalCommand — the GitHub Actions LLM loop plans its own
 * steps, sees every command's output, fixes mistakes, verifies the result
 * and delivers polished files. THIS is the feedback loop: unlike raw
 * ```run-terminal``` one-shots, the agent reads what each command returns
 * and iterates until the job is actually done. */
async function launchAgentBlocks(text: string, conversationId: string): Promise<number> {
  const re = /```run-agent\s*\n([\s\S]*?)```/g
  let n = 0
  for (let m = re.exec(text); m && n < 2; m = re.exec(text)) {
    const task = m[1].trim().slice(0, 8000)
    if (!task) continue
    await db.agentTask.create({
      data: {
        conversationId,
        type: 'terminal',
        title: `🤖 ${task.replace(/\s+/g, ' ').slice(0, 90)}`,
        status: 'queued',
        progress: 'Автономный агент на GitHub Actions возьмёт задачу в течение минуты…',
        payload: JSON.stringify({ command: `#!agent\n${task}`, terminalId: conversationId, timeoutS: 3600 }),
      },
    })
    n++
  }
  return n
}

/** the model marks commands to ACTUALLY execute with fenced blocks:
 * ```run-terminal\n<cmd>\n``` — queue each as a terminal AgentTask; the agent
 * worker ships it to the GitHub Actions Linux executor (Kaggle is video-only
 * per owner rule) and posts the output back. Quick raw shell for small
 * things — the output returns as a chat message but nothing iterates on it. */
async function launchTerminalBlocks(text: string, conversationId: string): Promise<number> {
  const re = /```run-terminal\s*\n([\s\S]*?)```/g
  let n = 0
  for (let m = re.exec(text); m && n < 3; m = re.exec(text)) {
    const command = m[1].trim().slice(0, 20_000)
    if (!command) continue
    await db.agentTask.create({
      data: {
        conversationId,
        type: 'terminal',
        title: `$ ${command.replace(/\s+/g, ' ').slice(0, 90)}`,
        status: 'queued',
        progress: 'Команда в очереди Linux-воркера…',
        payload: JSON.stringify({ command, terminalId: conversationId, timeoutS: 240 }),
      },
    })
    n++
  }
  return n
}

/** the model can also target the INTERACTIVE browser terminal (v86 VM in the
 * user's tab): ```run-vterm\n<cmd>\n``` — queued as TerminalCommand; the page
 * executes it and the output is posted back to this chat + Telegram. If no
 * terminal page is open (stale heartbeat) the owner gets a Telegram nudge. */
async function launchVtermBlocks(text: string, conversationId: string, userId: string | null): Promise<number> {
  const re = /```run-vterm\s*\n([\s\S]*?)```/g
  let n = 0
  for (let m = re.exec(text); m && n < 3; m = re.exec(text)) {
    const command = m[1].trim().slice(0, 3400)
    if (!command) continue
    let session = await db.terminalSession.findFirst({
      where: { kind: 'browser', status: 'active', userId: userId ?? undefined },
      orderBy: { updatedAt: 'desc' },
    })
    if (!session) {
      session = await db.terminalSession.create({
        data: { kind: 'browser', userId: userId, title: 'Терминал агента', secret: crypto.randomUUID().replace(/-/g, '') },
      })
    }
    await db.terminalCommand.create({
      data: { sessionId: session.id, conversationId, command, source: 'agent' },
    })
    await db.terminalSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } })
    const stale = !session.lastSeenAt || Date.now() - session.lastSeenAt.getTime() > 90_000
    if (stale) {
      const { sendTelegramText } = await import('@/lib/telegram')
      void sendTelegramText(
        `🧠 Агенту нужен твой компьютер: команда ждёт в очереди браузерного терминала.\nОткрой вкладку «Терминал»: ${process.env.NEXT_PUBLIC_SITE_URL || 'https://vebai-six.vercel.app'}/terminal\n$ ${command.slice(0, 200)}`,
      ).catch(() => {})
    }
    n++
  }
  return n
}

/* ---- free web search (shared with the worker's tools) -------------------- */

interface SearchItem {
  url: string
  name: string
  snippet: string
  host_name: string
}

const stripHtml = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

async function bingSearch(query: string, num: number): Promise<SearchItem[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${Math.max(num, 10)}&setlang=${encodeURIComponent(String(process.env.SEARCH_LANG || 'en'))}&cc=US`
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`bing rss ${res.status}`)
  const xml = await res.text()
  const items: SearchItem[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) && items.length < num) {
    const block = m[1]
    const tag = (t: string) => {
      const mm = block.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))
      return mm ? stripHtml(mm[1]) : ''
    }
    const name = tag('title')
    const link = tag('link')
    if (!name || !/^https?:\/\//.test(link)) continue
    let host = ''
    try { host = new URL(link).hostname } catch { continue }
    items.push({ url: link, name, snippet: tag('description').slice(0, 400), host_name: host })
  }
  if (items.length === 0) throw new Error('bing rss: пустой результат')
  return items
}

async function ddgSearch(query: string, num: number): Promise<SearchItem[]> {
  const endpoints = [
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  ]
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) continue
      const html = await res.text()
      const items: SearchItem[] = []
      let m: RegExpExecArray | null
      const seen = new Set<string>()
      const activeRe = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      while ((m = activeRe.exec(html)) && items.length < num) {
        let url = m[1]
        const name = stripHtml(m[2])
        if (!name || name.length < 3) continue
        if (url.startsWith('//')) url = `https:${url}`
        try {
          const u = new URL(url)
          if (/duckduckgo\.com$/.test(u.hostname)) continue
          if (u.hostname === 'localhost') continue
          if (seen.has(u.href)) continue
          seen.add(u.href)
          items.push({ url: u.href, name, snippet: '', host_name: u.hostname })
        } catch { /* bad url */ }
      }
      const snipRe = /(?:class="result-snippet"[^>]*>|class="result__snippet"[^>]*>)([\s\S]*?)<\/(?:td|a)>/gi
      let si = 0
      let s: RegExpExecArray | null
      while ((s = snipRe.exec(html)) && si < items.length) {
        items[si].snippet = stripHtml(s[1]).slice(0, 400)
        si++
      }
      if (items.length > 0) return items
    } catch {
      continue
    }
  }
  throw new Error('DuckDuckGo недоступен')
}

async function freeWebSearch(query: string, num: number): Promise<SearchItem[]> {
  try {
    return await bingSearch(query, num)
  } catch {
    return await ddgSearch(query, num)
  }
}

/**
 * POST /api/chat/stream — server-side SSE proxy to the official Z.ai API.
 *
 * The API key never leaves the server: the browser posts the transcript,
 * this route injects the system prompt (+ optional web-search context) and
 * streams back simplified events:
 *   { type: 'start', model }            — a model answered (after fallback chain)
 *   { type: 'reasoning', text }         — thinking deltas (4.7-flash fallback is a thinking model)
 *   { type: 'delta', text }             — VISIBLE answer deltas (T16: only the
 *                                         text inside <answer>…</answer> is
 *                                         forwarded; everything else the model
 *                                         writes stays internal)
 *   { type: 'done' }                    — stream finished cleanly
 *   { type: 'error', message, code }    — upstream failure
 */
export async function POST(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return new Response(JSON.stringify({ error: 'нет сессии' }), { status: 401 })

  let rawMessages: { role?: string; content?: string }[] = []
  let webSearch = false
  let model = ''
  let effort: 'high' | 'max' = 'max'
  let conversationId = ''
  try {
    const body = (await req.json()) as {
      messages?: { role?: string; content?: string }[]
      webSearch?: boolean
      model?: string
      effort?: string
      conversationId?: string
    }
    rawMessages = Array.isArray(body.messages) ? body.messages : []
    webSearch = Boolean(body.webSearch)
    // whitelist: only the free chat models are selectable from the UI
    const requested = String(body.model || '').trim()
    if (requested === DEFAULT_CHAT_MODEL || requested === FALLBACK_CHAT_MODEL) model = requested
    effort = body.effort === 'high' ? 'high' : 'max'
    conversationId = String(body.conversationId || '').trim()
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400 })
  }

  const clean: ChatMessage[] = []
  let budget = MAX_CHARS
  for (const m of rawMessages.slice(-HISTORY_LIMIT)) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null
    const content = String(m.content || '').trim()
    if (!role || !content) continue
    const cut = content.slice(0, Math.max(budget, 500))
    budget -= cut.length
    clean.push({ role, content: cut })
    if (budget <= 0) break
  }
  if (clean.length === 0 || clean[clean.length - 1].role !== 'user')
    return new Response(JSON.stringify({ error: 'последнее сообщение должно быть от пользователя' }), { status: 400 })

  // ---- T28: the «TG-агент» connector. When the conversation is the user's
  // registered agent chat, the model answers as the OWNER'S PERSONAL
  // TELEGRAM AGENT (not the generic Vebai assistant): the owner teaches it
  // here, and this transcript later feeds /api/tg/incoming replies.
  let sys = systemPrompt()
  if (conversationId) {
    const agentConvId = await readAgentConversationId(user.id)
    if (agentConvId && agentConvId === conversationId) {
      const acc = await db.tgAccount.findFirst({
        where: { userId: user.id },
        orderBy: { updatedAt: 'desc' },
        include: { config: true },
      })
      let me: { firstName?: string; username?: string } = {}
      try { me = JSON.parse(acc?.meInfo || '{}') } catch { /* ignore */ }
      sys = compileAgentChatPrompt(me, acc?.config?.systemPrompt || '')
    }
  }

  const messages: ChatMessage[] = [{ role: 'system', content: sys }]

  // ---- optional web search: RAG-inject fresh results into the context
  if (webSearch) {
    const lastUser = [...clean].reverse().find((m) => m.role === 'user')?.content || ''
    try {
      const items = await freeWebSearch(lastUser.slice(0, 300), 6)
      if (items.length > 0) {
        const block = items
          .map((it, i) => `[${i + 1}] ${it.name}\nURL: ${it.url}\n${it.snippet}`)
          .join('\n\n')
        messages.push({
          role: 'system',
          content:
            `Свежие результаты веб-поиска по запросу «${lastUser.slice(0, 200)}» (источник: Bing/DuckDuckGo, только что):\n\n${block}\n\n` +
            'Используй эти данные как актуальный контекст. Ссылайся на источники в виде markdown-ссылок, когда опираешься на них.',
        })
      }
    } catch {
      // search is best-effort — the chat continues without it
    }
  }
  messages.push(...clean)

  // ---- upstream stream. Acquisition happens INSIDE the SSE stream: when
  // Z.ai's free tier is overloaded, the internal retry chain can exhaust and
  // the old code answered a dead 502 with the real reason invisible (UI
  // showed a bare "stream 502"). Now the connection opens immediately (200)
  // and the user watches live retry notices; only after ~45s does the stream
  // end with an explicit error event (Повторить still works).
  const upstreamRef: { current: ReadableStream<Uint8Array> | null } = { current: null }
  const decoder = new TextDecoder()
  // T16: the model decides what the user sees — only <answer>…</answer>
  // content is forwarded; run-terminal/run-vterm blocks (outside <answer>)
  // are still dispatched below from the RAW text.
  // T35 (owner request 2026-10-20): the protocol is now enforced MECHANICALLY.
  // A reply that is empty / has an empty <answer> / has no <answer> at all
  // triggers an AUTOMATIC repeat (up to 2) with a corrective note — the era of
  // "модель пишет что хочет" and silent empty answers ends here.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const t0 = Date.now()
      const RETRY_BUDGET_MS = 150_000
      const MAX_FORMAT_RETRIES = 2
      let formatRetries = 0
      let fullAnswer = ''
      let answerFilter = createAnswerStreamFilter()

      // one streaming attempt. Returns { raw, failed }: raw is the FULL model
      // output of this attempt (visibility is decided per-delta by the
      // filter), failed means the upstream died mid-flight (error event
      // already emitted — no format retries on transport failures).
      const streamOnce = async (): Promise<{ raw: string; failed: boolean }> => {
        // acquire the upstream with visible retries (overload bursts usually
        // clear within seconds — keep the user informed instead of a dead 502)
        const acqT0 = Date.now()
        let attempt = 0
        for (;;) {
          try {
            upstreamRef.current = await zai.streamChat({
              messages,
              stream: true,
              // effort: 'max' → deep thinking; 'high' → fast answers, thinking off
              thinking: { type: effort === 'max' ? 'enabled' : 'disabled' },
              ...(model ? { model } : {}),
            })
            break
          } catch (e) {
            attempt++
            const reason = e instanceof Error ? e.message.slice(0, 200) : 'Z.ai недоступен'
            if (Date.now() - acqT0 > 45_000 || attempt >= 4) {
              controller.enqueue(
                sse({ type: 'error', message: `Z.ai недоступен: ${reason}`, code: 'upstream_error' }),
              )
              return { raw: '', failed: true }
            }
            controller.enqueue(
              sse({ type: 'notice', text: `Z.ai перегружен — переподключаюсь (попытка ${attempt + 1})…` }),
            )
            await new Promise((r) => setTimeout(r, 3500))
          }
        }
        let raw = ''
        let buf = ''
        const reader = upstreamRef.current!.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            let nl: number
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (!data || data === '[DONE]') continue
              let parsed: {
                model_used?: string
                choices?: { delta?: { content?: string; reasoning_content?: string } }[]
                error?: { message?: string; code?: string }
              }
              try {
                parsed = JSON.parse(data)
              } catch {
                continue
              }
              if (parsed.model_used) {
                controller.enqueue(sse({ type: 'start', model: parsed.model_used }))
                continue
              }
              if (parsed.error) {
                controller.enqueue(
                  sse({
                    type: 'error',
                    message: String(parsed.error.message || 'Z.ai вернул ошибку').slice(0, 300),
                    code: String(parsed.error.code || 'upstream_error'),
                  }),
                )
                continue
              }
              const delta = parsed.choices?.[0]?.delta
              if (!delta) continue
              if (delta.reasoning_content)
                controller.enqueue(sse({ type: 'reasoning', text: delta.reasoning_content.slice(0, 400) }))
              if (delta.content) {
                raw += delta.content
                const visible = answerFilter.push(delta.content)
                if (visible) controller.enqueue(sse({ type: 'delta', text: visible }))
              }
            }
          }
        } catch (e) {
          const message = e instanceof Error ? e.message.slice(0, 300) : 'поток прерван'
          try {
            controller.enqueue(sse({ type: 'error', message, code: 'stream_error' }))
          } catch { /* controller already closed */ }
          return { raw, failed: true }
        } finally {
          reader.releaseLock()
        }
        return { raw, failed: false }
      }

      let failed = false
      for (;;) {
        const { raw: attemptRaw, failed: upFailed } = await streamOnce()
        if (upFailed) {
          failed = true
          break
        }
        fullAnswer = attemptRaw
        const verdict = checkAnswerProtocol(attemptRaw)
        if (verdict.ok) {
          // stream over: emit the tail of an unclosed <answer>
          const tail = answerFilter.flush()
          if (tail) controller.enqueue(sse({ type: 'delta', text: tail }))
          break
        }
        if (formatRetries >= MAX_FORMAT_RETRIES || Date.now() - t0 > RETRY_BUDGET_MS) {
          // retries exhausted / no time left: deliver the cleaned text so the
          // user still gets SOMETHING (legacy fallback behaviour)
          const fb = parseAiAnswer(attemptRaw).text
          if (fb) controller.enqueue(sse({ type: 'delta', text: fb }))
          break
        }
        formatRetries++
        const why =
          verdict.reason === 'empty'
            ? 'пустотой (пустое поле)'
            : verdict.reason === 'empty_answer'
              ? 'пустым тегом <answer></answer>'
              : 'БЕЗ формата <answer>…</answer>'
        controller.enqueue(sse({
          type: 'notice',
          text: `⚠️ Модель ответила ${why} — автоматически повторяю запрос (попытка ${formatRetries + 1}/${MAX_FORMAT_RETRIES + 1})…`,
        }))
        if (attemptRaw.trim()) messages.push({ role: 'assistant', content: attemptRaw.slice(0, 1500) })
        messages.push({ role: 'user', content: formatRetryNote(verdict.reason) })
        answerFilter = createAnswerStreamFilter()
      }
      if (!failed) {
        // ---- terminal dispatch: fenced run-agent blocks -> resident agent,
        // run-terminal blocks -> Linux worker
        if (conversationId) {
          try {
            const conv = await db.conversation.findUnique({ where: { id: conversationId } })
            if (conv && (!conv.userId || conv.userId === user.id)) {
              const na = await launchAgentBlocks(fullAnswer, conversationId)
              if (na > 0) {
                controller.enqueue(sse({
                  type: 'notice',
                  text: `🤖 ${na} задач(а) переданы автономному агенту (GitHub Actions, Ubuntu): он сам спланирует шаги, выполнит команды, проверит результат и пришлёт готовый ответ с файлами (обычно 2-15 минут)`,
                }))
              }
              const n = await launchTerminalBlocks(fullAnswer, conversationId)
              if (n > 0) {
                controller.enqueue(sse({
                  type: 'notice',
                  text: `⌨️ ${n} команда(ы) отправлены в фоновый Linux-воркер (GitHub Actions, Ubuntu) — вывод придёт отдельным сообщением через 1-5 минут`,
                }))
              }
              const nv = await launchVtermBlocks(fullAnswer, conversationId, conv.userId)
              if (nv > 0) {
                controller.enqueue(sse({
                  type: 'notice',
                  text: `🖥 ${nv} команда(ы) в очереди браузерного терминала (/terminal) — вывод придёт, как только вкладка терминала их выполнит`,
                }))
              }
              // T31: ```run-tg``` blocks -> send from the OWNER'S Telegram
              // account (message/file) to the requested contact
              const nt = await createOutboxTasks(fullAnswer, conversationId, user.id)
              if (nt === -1) {
                controller.enqueue(sse({
                  type: 'notice',
                  text: '📤 Задачу отправки через Telegram выполнить нельзя: твой аккаунт Telegram ещё не подключён — подключи его на странице /tgagent и попроси повторить',
                }))
              } else if (nt > 0) {
                controller.enqueue(sse({
                  type: 'notice',
                  text: `📤 ${nt} задача(и) на отправку через твой Telegram-аккаунт поставлены в очередь — если указан файл, он уйдёт, как только агент его создаст; отчёт придёт в чат`,
                }))
              }
              // T32: ```run-tg-read``` blocks -> the worker READS messages from
              // the owner's chats; the transcript lands in the chat and the
              // agent auto-continues the order (continueAfterRead)
              const nr = await createTgReadTasks(fullAnswer, conversationId, user.id)
              if (nr === -1) {
                controller.enqueue(sse({
                  type: 'notice',
                  text: '📖 Задачу чтения Telegram выполнить нельзя: твой аккаунт Telegram ещё не подключён — подключи его на странице /tgagent и попроси повторить',
                }))
              } else if (nr > 0) {
                controller.enqueue(sse({
                  type: 'notice',
                  text: `📖 ${nr} задача(и) на чтение Telegram поставлены в очередь — воркер прочитает сообщения (до 200 за блок), транскрипт придёт в чат, и агент продолжит выполнение сам`,
                }))
              }
            }
          } catch { /* terminal dispatch is best-effort */ }
        }
        controller.enqueue(sse({ type: 'done' }))
      }
      try { controller.close() } catch { /* already closed */ }
    },
    cancel() {
      void upstreamRef.current?.cancel().catch(() => {})
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
