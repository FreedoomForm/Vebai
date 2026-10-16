import { NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { db } from '@/lib/db'
import { zai, type ChatMessage } from '@/lib/zai'
import { DEFAULT_CHAT_MODEL, FALLBACK_CHAT_MODEL } from '@/lib/zai-config'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const HISTORY_LIMIT = 40
const MAX_CHARS = 24_000

function systemPrompt(): string {
  const now = new Date()
  return [
    'Ты — Vebai, дружелюбный ИИ-архитектор и универсальный ассистент внутри сайта Vebai.',
    'Сайт умеет в фоне генерировать ВИДЕО (пользователь включает это кнопкой «Сделать видео» в поле ввода — задачи выполняются на сервере 24/7, результаты приходят в чат даже после закрытия браузера).',
    'Правила:',
    '- Отвечай на языке пользователя (по умолчанию — русский).',
    '- Отвечай по делу: структурируй ответы заголовками и списками, используй markdown; код — в блоках с указанием языка.',
    '- Инструмент видео: сайт умеет генерировать короткие клипы (5 или 10 секунд) через свой фоновый пайплайн на Kaggle (модель MiniMax H3, постоянный GPU-воркер). Если пользователь просит видео — предложи включить кнопку «Сделать видео» в поле ввода и кратко опиши задуманные кадры (сюжет, движение камеры, свет). Видео появляется в чате автоматически, когда готово. Сроки честные: генерация идёт на бесплатных GPU Kaggle — 5-секундный клип считается примерно 45-60 минут, 10-секундный — около 2-2.5 часов; минутное видео (6 клипов по 10 секунд, генерируются парами на двух T4) готово ориентировочно через 6-8 часов. Сразу называй эти сроки, чтобы человек не ждал «через пару минут».',
    '- ДЛИННОЕ ВИДЕО — это НЕ проблема: один клип максимум 10 секунд, но клипы автоматически склеиваются в ОДИН готовый файл (ffmpeg). Поэтому, если просят видео длиннее 10 секунд (например «1 минута: человек играет на пианино»), НЕ отказывайся и не проси сокращать: предложи раскадровку из нужного числа клипов по 10 секунд (1 минута = 6 клипов) с описанием каждого кадра, а сайт сам сгенерирует их и склеит в единый ролик.',
    '- У тебя есть ДВА терминала. (1) terminal (блоки ```run-terminal```): фоновый Linux-воркер (Ubuntu на Kaggle: python3, pip, ffmpeg, git, curl) — работает 24/7 даже при закрытом браузере, но команда выполняется 1-5 минут. (2) ИНТЕРАКТИВНЫЙ терминал (блоки ```run-vterm```): настоящий Alpine Linux в браузере пользователя (v86) — мгновенный отклик, нужен только пользователь, стейт-файлы в Telegram, но медленный CPU и вкладка должна быть открыта; если она закрыта, владелец получит уведомление в Telegram. Для быстрых команд (посчитать, создать файл, посмотреть систему) предпочитай run-vterm; для тяжёлых/долгих (pip с компиляцией, видео, длинные скрипты) — run-terminal.',
    '- ПРОТОКОЛ ВЫПОЛНЕНИЯ КОМАНД: если пользователь просит ВЫПОЛНИТЬ/ЗАПУСТИТЬ команду или код (а не просто показать), в конце ответа добавь блок вида:\n```run-terminal\nкоманда\n``` (фоновый воркер) ИЛИ \n```run-vterm\nкоманда\n``` (интерактивный терминал в браузере) — по одной команде на блок, максимум 3 блока на ответ (для серии команд используй `cmd1 && cmd2` или мини-скрипт). ОБЫЧНЫЕ примеры кода в этот формат НЕ заворачивай — только реальное исполнение. Результат выполнения придёт в чат отдельным сообщением.',
    '- Создание изображений НЕДОСТУПНО (генерация картинок на сайте отключена). Если просят нарисовать/сгенерировать изображение — честно скажи, что генерация изображений на сайте сейчас отключена, и предложи альтернативу: короткое видео по этому же описанию (кнопка «Сделать видео»), либо подробное текстовое описание/промпт, который пользователь сможет использовать в любом внешнем генераторе картинок.',
    '- Не выдумывай факты; если не уверен — честно скажи об этом.',
    `- Текущая дата и время (UTC): ${now.toISOString().slice(0, 19).replace('T', ' ')}`,
  ].join('\n')
}

function sse(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
}

/* ---- terminal dispatch ------------------------------------------------- */

/** the model marks commands to ACTUALLY execute with fenced blocks:
 * ```run-terminal\n<cmd>\n``` — queue each as a terminal AgentTask; the agent
 * worker ships it to the Kaggle Linux worker and posts the output back. */
async function launchTerminalBlocks(text: string, conversationId: string): Promise<number> {
  const re = /```run-terminal\s*\n([\s\S]*?)```/g
  let n = 0
  for (let m = re.exec(text); m && n < 3; m = re.exec(text)) {
    const command = m[1].trim().slice(0, 3400)
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
 *   { type: 'delta', text }             — answer deltas
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

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt() }]

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

  // ---- upstream stream
  let upstream: ReadableStream<Uint8Array>
  try {
    upstream = await zai.streamChat({
      messages,
      stream: true,
      // effort: 'max' → deep thinking; 'high' → fast answers, thinking off
      thinking: { type: effort === 'max' ? 'enabled' : 'disabled' },
      ...(model ? { model } : {}),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 300) : 'Z.ai недоступен'
    return new Response(
      `data: ${JSON.stringify({ type: 'error', message, code: 'upstream_error' })}\n\n`,
      { status: 502, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }

  const decoder = new TextDecoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buf = ''
      let fullAnswer = ''
      const reader = upstream.getReader()
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
              fullAnswer += delta.content
              controller.enqueue(sse({ type: 'delta', text: delta.content }))
            }
          }
        }
        // ---- terminal dispatch: fenced run-terminal blocks -> Linux worker
        if (conversationId) {
          try {
            const conv = await db.conversation.findUnique({ where: { id: conversationId } })
            if (conv && (!conv.userId || conv.userId === user.id)) {
              const n = await launchTerminalBlocks(fullAnswer, conversationId)
              if (n > 0) {
                controller.enqueue(sse({
                  type: 'notice',
                  text: `⌨️ ${n} команда(ы) отправлены в фоновый Linux-воркер — вывод придёт отдельным сообщением через 1-5 минут`,
                }))
              }
              const nv = await launchVtermBlocks(fullAnswer, conversationId, conv.userId)
              if (nv > 0) {
                controller.enqueue(sse({
                  type: 'notice',
                  text: `🖥 ${nv} команда(ы) в очереди интерактивного терминала (/terminal) — вывод придёт, как только вкладка терминала их выполнит`,
                }))
              }
            }
          } catch { /* terminal dispatch is best-effort */ }
        }
        controller.enqueue(sse({ type: 'done' }))
      } catch (e) {
        const message = e instanceof Error ? e.message.slice(0, 300) : 'поток прерван'
        try {
          controller.enqueue(sse({ type: 'error', message, code: 'stream_error' }))
        } catch { /* controller already closed */ }
      } finally {
        reader.releaseLock()
        try { controller.close() } catch { /* already closed */ }
      }
    },
    cancel() {
      void upstream.cancel().catch(() => {})
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
