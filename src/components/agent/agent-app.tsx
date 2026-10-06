'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bot, Menu, MessageSquarePlus, Trash2, Sparkles, Activity,
  Loader2, Circle, ShieldAlert,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useAgentSocket, type AgentStatePayload } from '@/hooks/use-agent-socket'
import { MessageItem } from './message-item'
import { ActivityPanel } from './activity-panel'
import { Composer } from './composer'
import { AuthScreen } from './auth-screen'
import { WarningBanner } from './warning-banner'
import { solveZaiCaptcha, preloadZaiCaptcha } from './zai-captcha'
import type { AgentEvent, AgentTaskDTO, ConversationDTO, MessageDTO, ToolCallDTO } from '@/lib/agent/types'

interface SessionUser {
  id: string
  email: string
  name: string
}

interface ConvSummary extends ConversationDTO {
  messageCount: number
}

interface StreamState {
  text: string
  tools: (ToolCallDTO & { id: string })[]
  plan?: { title?: string; steps: { title: string; status: 'pending' | 'active' | 'done' }[] }
}

const SUGGESTIONS = [
  { icon: '🎬', text: 'Сделай план и обучающее видео про физику электронов' },
  { icon: '🖼', text: 'Сгенерируй обложку для научного YouTube-канала' },
  { icon: '🌐', text: 'Найди свежие данные о модели MiniMax H3 и перескажи' },
  { icon: '🎨', text: 'Придумай и нарисуй маскота для IT-блога' },
]

export function AgentApp() {
  const [session, setSession] = useState<{ user: SessionUser | null; checked: boolean }>({ user: null, checked: false })
  const [conversations, setConversations] = useState<ConvSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageDTO[]>([])
  const [tasks, setTasks] = useState<AgentTaskDTO[]>([])
  const [stream, setStream] = useState<StreamState | null>(null)
  const [sending, setSending] = useState(false)
  const [worker, setWorker] = useState({ activeTasks: 0, queued: 0, running: 0 })
  const [navOpen, setNavOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [sessionError, setSessionError] = useState('')

  const sendingRef = useRef(false)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  /* ------------------------------------------------------------ fetching */

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations', { cache: 'no-store' })
      const data = await res.json()
      setConversations(data.conversations || [])
    } catch { /* offline */ }
  }, [])

  const fetchState = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setMessages(data.messages || [])
      setTasks(data.tasks || [])
      setWorker((w) => w)
      setStream(null)
    } catch { /* offline */ }
  }, [])

  /* -------------------------------------------------------------- events */

  const onStateUpdate = useCallback((state: AgentStatePayload) => {
    setWorker(state.worker || { activeTasks: 0, queued: 0, running: 0 })
    if (state.conversation?.id && state.conversation.id === activeIdRef.current) {
      setTasks(state.tasks || [])
      if (!sendingRef.current) {
        setMessages(state.messages || [])
      }
    }
  }, [])

  const onEvent = useCallback((evt: AgentEvent) => {
    switch (evt.type) {
      case 'start': {
        if (evt.conversationId !== activeIdRef.current) {
          setActiveId(evt.conversationId)
          activeIdRef.current = evt.conversationId
          setMessages([])
          setTasks([])
          void loadConversations()
        }
        setMessages((prev) => {
          const withoutTemp = prev.filter((m) => m.id !== 'temp-user')
          return [...withoutTemp, evt.userMessage]
        })
        break
      }
      case 'delta': {
        setStream((s) => ({ text: (s?.text || '') + evt.text, tools: s?.tools || [] }))
        break
      }
      case 'tool': {
        setStream((s) => ({
          text: s?.text || '',
          tools: [...(s?.tools || []), { id: evt.id, ...evt.call }],
          plan: s?.plan,
        }))
        break
      }
      case 'tool_result': {
        setStream((s) => {
          if (!s) return s
          const tools = s.tools.map((t) =>
            t.id === evt.id ? { ...t, status: evt.status === 'ok' ? 'ok' as const : 'error' as const, summary: evt.summary } : t,
          )
          const plan = evt.plan
            ? { title: evt.plan.title, steps: evt.plan.steps.map((st) => ({ ...st })) }
            : s.plan
          return { ...s, tools, plan }
        })
        break
      }
      case 'task': {
        setTasks((prev) => {
          const i = prev.findIndex((t) => t.id === evt.task.id)
          if (i < 0) return [...prev, evt.task]
          const next = [...prev]
          next[i] = evt.task
          return next
        })
        break
      }
      case 'message': {
        setMessages((prev) => [...prev, evt.message])
        setStream(null)
        break
      }
      case 'title': {
        setConversations((prev) =>
          prev.map((c) => (c.id === evt.conversationId ? { ...c, title: evt.title } : c)),
        )
        break
      }
      case 'conversation': {
        if (evt.conversationId !== activeIdRef.current) {
          setActiveId(evt.conversationId)
          activeIdRef.current = evt.conversationId
        }
        break
      }
      case 'captcha_required': {
        // Z.ai demands its own captcha for this request — solve it invisibly
        // (smart verification) or via the slider, then retry the same message
        console.info('[agent] Z.ai captcha required — relaying widget')
        void resendRef.current?.()
        break
      }
      case 'done': {
        sendingRef.current = false
        setSending(false)
        setStream((s) => (s && (s.text.trim() || s.tools.length) ? s : null))
        void loadConversations()
        const id = activeIdRef.current
        if (id) void fetchState(id)
        break
      }
      case 'error': {
        sendingRef.current = false
        setSending(false)
        setStream(null)
        console.error('[agent]', evt.message, evt.code || '')
        if (evt.code === 'zai_session_expired') {
          // the user's own Z.ai JWT died — a one-time re-login restores it
          setSessionError('Сессия Z.ai истекла — нажми «Выйти» и войди заново (капча будет один раз).')
        }
        break
      }
    }
  }, [fetchState, loadConversations])

  /* -------------------------------------------------------------- socket */

  const { connected, send, subscribe, unsubscribe } = useAgentSocket({ onEvent, onState: onStateUpdate })

  useEffect(() => {
    const prev = activeIdRef.current
    if (prev && prev !== activeId) unsubscribe(prev)
    if (activeId) subscribe(activeId)
  }, [activeId, subscribe, unsubscribe])

  /* --------------------------------------------------------- auth check */

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' })
      if (res.status === 401) {
        setSession({ user: null, checked: true })
        return
      }
      const data = (await res.json()) as { user: SessionUser | null; authRequired: boolean }
      setSession({ user: data.user, checked: true })
    } catch {
      setSession({ user: null, checked: true })
    }
  }, [])

  useEffect(() => {
    void checkSession()
  }, [checkSession])

  /* --------------------------------------------------------- initial load */

  const loadInitial = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations', { cache: 'no-store' })
      if (res.status === 401) {
        setSession({ user: null, checked: true })
        return
      }
      const data = await res.json()
      const list: ConvSummary[] = data.conversations || []
      setConversations(list)
      if (list.length > 0) {
        setActiveId(list[0].id)
        activeIdRef.current = list[0].id
        await fetchState(list[0].id)
      }
    } catch { /* offline */ }
  }, [fetchState])

  useEffect(() => {
    if (session.user) void loadInitial()
  }, [session.user, loadInitial])

  /* -------------------------------------------------------------- sending */

  const lastSentRef = useRef<{ content: string } | null>(null)
  const resendRef = useRef<(() => void) | null>(null)

  const handleSend = useCallback(
    (content: string, opts?: { captchaVerifyParam?: string; resume?: boolean }) => {
      if (sendingRef.current || !content.trim()) return
      sendingRef.current = true
      setSending(true)
      stickToBottomRef.current = true
      if (!opts?.resume) lastSentRef.current = { content }

      if (!opts?.resume) {
        setMessages((prev) => [
          ...prev,
          {
            id: 'temp-user',
            role: 'user',
            kind: 'text',
            content,
            createdAt: new Date().toISOString(),
          },
        ])
      }

      const viaSocket = send(activeIdRef.current, content, opts)
      if (!viaSocket) {
        // HTTP fallback: read the SSE stream directly
        void (async () => {
          try {
            const res = await fetch('/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                conversationId: activeIdRef.current,
                content,
                captchaVerifyParam: opts?.captchaVerifyParam,
                resume: opts?.resume,
              }),
            })
            const cid = res.headers.get('X-Conversation-Id')
            if (cid && cid !== activeIdRef.current) {
              setActiveId(cid)
              activeIdRef.current = cid
              void loadConversations()
            }
            if (!res.ok || !res.body) throw new Error(`chat api ${res.status}`)
            const reader = res.body.getReader()
            const dec = new TextDecoder()
            let buf = ''
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buf += dec.decode(value, { stream: true })
              let idx: number
              while ((idx = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, idx)
                buf = buf.slice(idx + 2)
                for (const line of block.split('\n')) {
                  const t = line.trim()
                  if (!t.startsWith('data:')) continue
                  try {
                    onEvent(JSON.parse(t.slice(5).trim()) as AgentEvent)
                  } catch { /* ignore */ }
                }
              }
            }
          } catch (e) {
            onEvent({ type: 'error', message: e instanceof Error ? e.message : 'network error' })
            onEvent({ type: 'done' })
          }
        })()
      }
    },
    [send, onEvent, loadConversations],
  )

  /* ------------------------------------------------- Z.ai captcha relay */
  // When Z.ai demands its server captcha, solve it in the browser (usually an
  // invisible smart-pass; worst case a slider) and retry the same message.
  useEffect(() => {
    resendRef.current = () => {
      const last = lastSentRef.current
      if (!last) return
      void (async () => {
        try {
          const param = await solveZaiCaptcha()
          if (param) handleSend(last.content, { captchaVerifyParam: param, resume: true })
        } catch (e) {
          onEvent({
            type: 'error',
            message: e instanceof Error ? e.message : 'капча Z.ai не прошла',
          })
          onEvent({ type: 'done' })
        }
      })()
    }
  }, [handleSend, onEvent])

  useEffect(() => {
    // warm the widget SDK so the first verification starts instantly
    preloadZaiCaptcha()
  }, [])

  /* --------------------------------------------------------- conversation */

  const selectConversation = useCallback(
    (id: string) => {
      if (sendingRef.current) return
      setActiveId(id)
      activeIdRef.current = id
      setMessages([])
      setTasks([])
      void fetchState(id)
      setNavOpen(false)
    },
    [fetchState],
  )

  const newChat = useCallback(() => {
    if (sendingRef.current) return
    setActiveId(null)
    activeIdRef.current = null
    setMessages([])
    setTasks([])
    setStream(null)
    setNavOpen(false)
  }, [])

  const deleteConversation = useCallback(
    async (id: string) => {
      await fetch(`/api/conversations/${id}`, { method: 'DELETE' }).catch(() => {})
      if (activeIdRef.current === id) newChat()
      void loadConversations()
    },
    [loadConversations, newChat],
  )

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    setConversations([])
    setMessages([])
    setTasks([])
    setActiveId(null)
    activeIdRef.current = null
    setSession({ user: null, checked: true })
  }, [])

  /* --------------------------------------------------------------- scroll */

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, stream, sending])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  /* ---------------------------------------------------------------- render */

  // auth gate: while the session check runs show a quiet splash
  if (!session.checked) {
    return (
      <div className="flex h-dvh items-center justify-center bg-zinc-950">
        <div className="flex items-center gap-3 text-zinc-500">
          <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
          <span className="text-sm">Загрузка…</span>
        </div>
      </div>
    )
  }
  if (session.checked && !session.user) {
    return <AuthScreen onAuthed={() => void checkSession().then(() => void loadInitial())} />
  }

  const sidebar = (
    <div className="flex h-full flex-col bg-zinc-950">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 border border-emerald-800/40">
          <Sparkles className="h-4 w-4 text-emerald-400" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-zinc-100 leading-tight">Нейро-Архитектор</p>
          <p className="text-[11px] text-zinc-500 leading-tight">персистентный ИИ-агент</p>
        </div>
      </div>
      <div className="px-3">
        <Button
          onClick={newChat}
          disabled={sending}
          className="w-full justify-start gap-2 bg-emerald-500/90 text-zinc-950 hover:bg-emerald-400 font-medium"
        >
          <MessageSquarePlus className="h-4 w-4" />
          Новый чат
        </Button>
      </div>
      <div className="mt-3 flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={cn(
              'group flex items-center gap-1 rounded-lg px-2 py-2 cursor-pointer transition-colors',
              c.id === activeId ? 'bg-zinc-800/80' : 'hover:bg-zinc-900',
            )}
            onClick={() => selectConversation(c.id)}
          >
            <Bot className={cn('h-3.5 w-3.5 shrink-0', c.id === activeId ? 'text-emerald-400' : 'text-zinc-600')} />
            <span className="flex-1 truncate text-sm text-zinc-300">{c.title}</span>
            <button
              aria-label="Удалить диалог"
              onClick={(e) => {
                e.stopPropagation()
                void deleteConversation(c.id)
              }}
              className="hidden group-hover:block rounded p-1 text-zinc-600 hover:text-red-400 hover:bg-zinc-800"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {conversations.length === 0 && (
          <p className="px-3 py-4 text-xs text-zinc-600">История диалогов появится здесь</p>
        )}
      </div>
      <div className="border-t border-zinc-800/80 px-4 py-3">
        <div className="flex items-center gap-2 text-[11px] text-zinc-500">
          <span className="relative flex h-2 w-2">
            <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-50', connected ? 'bg-emerald-400' : 'bg-amber-400')} />
            <span className={cn('relative inline-flex h-2 w-2 rounded-full', connected ? 'bg-emerald-400' : 'bg-amber-400')} />
          </span>
          {connected ? 'Агент на связи · работает 24/7' : 'Переподключение к агенту…'}
          {worker.activeTasks > 0 && (
            <span className="ml-auto text-emerald-400">{worker.activeTasks} в фоне</span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-semibold text-zinc-300">
            {(session.user?.name || session.user?.email || '?').slice(0, 1).toUpperCase()}
          </div>
          <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-400" title={session.user?.email}>
            {session.user?.name || session.user?.email}
          </span>
          <button
            onClick={() => void logout()}
            className="rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
          >
            Выйти
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex h-dvh overflow-hidden bg-zinc-950">
      {/* desktop sidebar */}
      <aside className="hidden md:flex w-64 shrink-0 border-r border-zinc-800/80">
        {sidebar}
      </aside>

      {/* mobile sidebar sheet */}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-72 p-0 border-zinc-800 bg-zinc-950 [&>button]:text-zinc-400">
          <SheetHeader className="sr-only">
            <SheetTitle>Диалоги</SheetTitle>
          </SheetHeader>
          {sidebar}
        </SheetContent>
      </Sheet>

      {/* center chat column */}
      <main className="flex min-w-0 flex-1 flex-col">
        <WarningBanner />
        {sessionError && (
          <div className="flex items-center gap-2 border-b border-red-900/60 bg-red-950/40 px-4 py-2 text-[12px] text-red-300">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">{sessionError}</span>
            <button
              onClick={() => void logout()}
              className="rounded-md border border-red-800 px-2 py-0.5 text-[11px] text-red-200 hover:bg-red-900/50"
            >
              Выйти и перелогиниться
            </button>
          </div>
        )}
        <header className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-2.5 sm:px-4">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Диалоги"
            className="md:hidden h-8 w-8 text-zinc-400"
            onClick={() => setNavOpen(true)}
          >
            <Menu className="h-4 w-4" />
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0 text-emerald-400 md:hidden" />
            <h1 className="truncate text-sm font-medium text-zinc-200">
              {conversations.find((c) => c.id === activeId)?.title || 'Новый диалог'}
            </h1>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {worker.activeTasks > 0 && (
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-emerald-900/50 bg-emerald-950/30 px-2 py-0.5 text-[11px] text-emerald-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                {worker.activeTasks} фоновых задач
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              aria-label="Активность агента"
              className="lg:hidden h-8 gap-1.5 px-2 text-zinc-400"
              onClick={() => setActivityOpen(true)}
            >
              <Activity className="h-4 w-4" />
              {worker.activeTasks > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-zinc-950">
                  {worker.activeTasks}
                </span>
              )}
            </Button>
          </div>
        </header>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto"
        >
          {messages.length === 0 && !stream && !sending ? (
            <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-6 px-4 py-10 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 border border-emerald-800/40">
                <Sparkles className="h-7 w-7 text-emerald-400" />
              </div>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold text-zinc-100">Нейро-Архитектор</h2>
                <p className="text-sm leading-relaxed text-zinc-500">
                  Опиши задачу — я составлю план и выполню его своими инструментами:
                  поиск в интернете, генерация изображений и видео (MiniMax H3 на Kaggle).
                  Работаю 24/7 — закрой браузер, я продолжу, а результаты сами появятся в чате.
                </p>
              </div>
              <div className="grid w-full gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.text}
                    onClick={() => handleSend(s.text)}
                    className="group flex items-start gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-3 text-left transition-colors hover:border-emerald-900/60 hover:bg-zinc-900"
                  >
                    <span className="text-base leading-none mt-0.5">{s.icon}</span>
                    <span className="text-[13px] leading-snug text-zinc-400 group-hover:text-zinc-200">
                      {s.text}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
              {messages.map((m, i) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  showAvatar={i === 0 || messages[i - 1].role !== 'assistant'}
                />
              ))}

              {/* live stream segment */}
              {stream && (stream.text.trim() || stream.tools.length > 0 || stream.plan) && (
                <div className="flex gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-800/50 bg-emerald-950/40">
                    <Bot className="h-4 w-4 text-emerald-400" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-3 pt-0.5">
                    {stream.plan && (
                      <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/20 p-4">
                        <ol className="space-y-2">
                          {stream.plan.steps.map((step, i) => (
                            <li key={i} className="flex items-start gap-2.5 text-sm">
                              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-emerald-800/60 bg-emerald-900/30 text-[11px] font-medium text-emerald-300">
                                {i + 1}
                              </span>
                              <span className="text-zinc-300 leading-snug">{step.title}</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {stream.tools.map((call) => (
                      <div key={call.id} className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2.5 flex items-center gap-2.5">
                        <Circle
                          className={cn(
                            'h-2.5 w-2.5',
                            call.status === 'running' && 'text-emerald-400 fill-emerald-400 animate-pulse',
                            call.status === 'ok' && 'text-emerald-400',
                            call.status === 'error' && 'text-red-400',
                          )}
                        />
                        <span className="text-sm text-zinc-300">{call.name}</span>
                        {call.status === 'running' && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />
                        )}
                        {call.summary && (
                          <span className="ml-auto truncate text-xs text-zinc-500 max-w-[45%]">{call.summary}</span>
                        )}
                      </div>
                    ))}
                    {stream.text.trim() && (
                      <div className="text-sm leading-relaxed text-zinc-300 whitespace-pre-wrap break-words">
                        {stream.text}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* typing indicator */}
              {sending && !stream && (
                <div className="flex gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-800/50 bg-emerald-950/40">
                    <Bot className="h-4 w-4 text-emerald-400" />
                  </div>
                  <div className="flex items-center gap-1.5 pt-2.5">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400 [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400 [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400 [animation-delay:300ms]" />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <Composer onSend={handleSend} disabled={sending} connected={connected} />
      </main>

      {/* desktop activity panel */}
      <aside className="hidden lg:flex w-80 shrink-0 border-l border-zinc-800/80">
        <div className="w-full">
          <ActivityPanel tasks={tasks} worker={worker} />
        </div>
      </aside>

      {/* mobile activity sheet */}
      <Sheet open={activityOpen} onOpenChange={setActivityOpen}>
        <SheetContent side="right" className="w-80 p-0 border-zinc-800 bg-zinc-950 [&>button]:text-zinc-400">
          <SheetHeader className="sr-only">
            <SheetTitle>Активность агента</SheetTitle>
          </SheetHeader>
          <ActivityPanel tasks={tasks} worker={worker} />
        </SheetContent>
      </Sheet>
    </div>
  )
}
