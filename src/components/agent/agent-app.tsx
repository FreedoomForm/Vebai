'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Menu, MessageSquarePlus, Trash2, Sparkles, Activity,
  Loader2, ChevronDown, Check, Globe, AlertCircle, RotateCcw, X, SquareTerminal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useAgentSocket, type AgentStatePayload } from '@/hooks/use-agent-socket'
import { MessageItem } from './message-item'
import { ActivityPanel } from './activity-panel'
import { Composer, type Effort, type SendOptions } from './composer'
import { AuthScreen } from './auth-screen'
import { WarningBanner } from './warning-banner'
import type { AgentEvent, AgentTaskDTO, ConversationDTO, MessageDTO, ToolCallDTO } from '@/lib/agent/types'

interface SessionUser {
  id: string
  email: string
  name: string
  telegramChatId?: string | null
  telegramUsername?: string | null
}

interface ConvSummary extends ConversationDTO {
  messageCount: number
}

interface StreamState {
  text: string
  tools: (ToolCallDTO & { id: string })[]
  plan?: { title?: string; steps: { title: string; status: 'pending' | 'active' | 'done' }[] }
  note?: string
}

/* --------------------------------------------------------------- models */
// free models on the official Z.ai API (whitelisted server-side);
// owner request (2026-10-16): glm-4.7-flash is the default, 4.5-flash is the fallback
const MODEL_OPTIONS = [
  {
    id: 'glm-4.7-flash',
    label: 'GLM-4.7-Flash',
    sub: 'Глубокое мышление — основной выбор',
    badge: 'FREE',
  },
  {
    id: 'glm-4.5-flash',
    label: 'GLM-4.5-Flash',
    sub: 'Быстрая и стабильная — резерв при перегрузке 4.7',
  },
] as const

const SUGGESTIONS = [
  { icon: '🎬', text: 'Сделай план и обучающее видео про физику электронов' },
  { icon: '🌐', text: 'Найди свежие данные о модели MiniMax H3 и перескажи' },
  { icon: '🎥', text: 'Сгенерируй короткое видео: закат над городом с пролетающим дроном' },
  { icon: '✨', text: 'Помоги придумать сценарий трейлера для IT-блога' },
]

const GALLERY = [
  { grad: 'from-stone-800 via-stone-700 to-stone-900', label: 'Лендинг для продукта', dark: true },
  { grad: 'from-emerald-600 via-teal-600 to-emerald-800', label: 'Мини-игра', dark: true },
  { grad: 'from-amber-500 via-orange-600 to-amber-700', label: 'Личный блог', dark: true },
]

export function AgentApp() {
  const [session, setSession] = useState<{ user: SessionUser | null; checked: boolean }>({ user: null, checked: false })
  const [conversations, setConversations] = useState<ConvSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageDTO[]>([])
  const [tasks, setTasks] = useState<AgentTaskDTO[]>([])
  const [stream, setStream] = useState<StreamState | null>(null)
  const [sending, setSending] = useState(false)
  const [errorMsg, setErrorMsg] = useState<{ message: string; code?: string } | null>(null)
  const [worker, setWorker] = useState({ activeTasks: 0, queued: 0, running: 0 })
  const [pendingVterm, setPendingVterm] = useState(0)
  const [navOpen, setNavOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [tgLinkBusy, setTgLinkBusy] = useState(false)
  const [tgLinkNote, setTgLinkNote] = useState('')

  // composer / selector state (persisted)
  const [model, setModel] = useState<string>('glm-4.7-flash')
  const [effort, setEffort] = useState<Effort>('max')
  const [webSearch, setWebSearch] = useState(false)
  const [video, setVideo] = useState(false)
  const [draft, setDraft] = useState('')
  const [modelOpen, setModelOpen] = useState(false)

  const sendingRef = useRef(false)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  /** true once the current turn produced a `start` event (server-side
   * persistence confirmed) — a done/error without it means the temp user
   * bubble must be dropped, otherwise the message ghosts forever */
  const startSeenRef = useRef(false)

  /* --------------------------------------------------- persisted settings */

  useEffect(() => {
    if (!session.user) return
    let stop = false
    const pollVterm = async () => {
      try {
        const r = await fetch('/api/terminal/pending')
        if (r.ok && !stop) setPendingVterm(((await r.json()) as { pending: number }).pending || 0)
      } catch { /* ignore */ }
    }
    setTimeout(pollVterm, 400)
    const t = setInterval(pollVterm, 25_000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [session.user])

  useEffect(() => {
    try {
      const m = localStorage.getItem('vebai_model')
      if (m && MODEL_OPTIONS.some((o) => o.id === m)) setModel(m)
      const e = localStorage.getItem('vebai_effort')
      if (e === 'high' || e === 'max') setEffort(e)
      const w = localStorage.getItem('vebai_websearch')
      if (w === '1') setWebSearch(true)
    } catch { /* private mode */ }
  }, [])

  const selectModel = useCallback((id: string) => {
    setModel(id)
    setModelOpen(false)
    try { localStorage.setItem('vebai_model', id) } catch { /* noop */ }
  }, [])

  const toggleWebSearch = useCallback(() => {
    setWebSearch((v) => {
      try { localStorage.setItem('vebai_websearch', v ? '0' : '1') } catch { /* noop */ }
      return !v
    })
  }, [])

  const toggleVideo = useCallback(() => {
    setVideo((v) => !v)
  }, [])

  const changeEffort = useCallback((e: Effort) => {
    setEffort(e)
    try { localStorage.setItem('vebai_effort', e) } catch { /* noop */ }
  }, [])

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
        startSeenRef.current = true
        setErrorMsg(null)
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
        setStream((s) => ({ text: (s?.text || '') + evt.text, tools: s?.tools || [], note: s?.note }))
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
        // the persisted turn record replaces the live error bubble
        setErrorMsg(null)
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
      case 'notice': {
        // progress notes (thinking model status, web search, …)
        setStream((s) => ({ text: s?.text || '', tools: s?.tools || [], ...(s || {}), note: evt.text }))
        break
      }
      case 'done': {
        sendingRef.current = false
        setSending(false)
        setStream((s) => (s && s.text.trim() ? s : null))
        if (!startSeenRef.current) {
          // the server never persisted this message — drop the optimistic bubble
          setMessages((prev) => prev.filter((m) => m.id !== 'temp-user'))
        }
        void loadConversations()
        const id = activeIdRef.current
        if (id) void fetchState(id)
        break
      }
      case 'error': {
        sendingRef.current = false
        setSending(false)
        setStream(null)
        if (!startSeenRef.current) {
          setMessages((prev) => prev.filter((m) => m.id !== 'temp-user'))
        }
        console.error('[agent]', evt.message, evt.code || '')
        // visible failure — the user must ALWAYS see why
        setErrorMsg({ message: evt.message, code: evt.code })
        break
      }
    }
  }, [fetchState, loadConversations])

  /* -------------------------------------------------------------- socket */

  const { connected, subscribe, unsubscribe } = useAgentSocket({ onEvent, onState: onStateUpdate })

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
      const data = (await res.json()) as {
        user: (SessionUser & { telegramChatId?: string | null }) | null
        authRequired: boolean
      }
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

  /**
   * Chat turn, v13: /api/chat/start (persist the user message + fetch the
   * transcript) → POST /api/chat/stream (OUR server talks to the official
   * Z.ai API with the owner's key — no captchas, no sessions, no browser
   * signing) → /api/chat/commit (persist the answer).
   */
  const runTurn = useCallback(
    async (conversationId: string | null, content: string, resume: boolean) => {
      // 1) persist + fetch the transcript
      let history: { role: 'user' | 'assistant'; content: string }[]
      let convId = conversationId
      try {
        const res = await fetch('/api/chat/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId, content }),
        })
        const data = (await res.json().catch(() => ({}))) as {
          error?: string
          conversationId?: string
          userMessage?: MessageDTO
          title?: string
          history?: { role: 'user' | 'assistant'; content: string }[]
        }
        if (!res.ok || !data.conversationId || !data.userMessage) {
          throw new Error(data.error || `chat start ${res.status}`)
        }
        convId = data.conversationId
        if (convId !== activeIdRef.current) {
          setActiveId(convId)
          activeIdRef.current = convId
          setMessages([])
          setTasks([])
          void loadConversations()
        }
        history = data.history || [{ role: 'user', content }]
        onEvent({ type: 'start', conversationId: convId, userMessage: data.userMessage })
        if (data.title) onEvent({ type: 'title', conversationId: convId, title: data.title })
      } catch (e) {
        const err = e as Error & { code?: string }
        onEvent({ type: 'error', message: err.message.slice(0, 300), code: err.code })
        onEvent({ type: 'done' })
        return
      }

      // 2) stream the answer from OUR server (official Z.ai API inside)
      let answer = ''
      let gotError: { message: string; code?: string } | null = null
      const ac = new AbortController()
      abortRef.current?.abort()
      abortRef.current = ac

      try {
        const res = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history, webSearch, effort, model, conversationId: convId }),
          signal: ac.signal,
        })
        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error || `stream ${res.status}`)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let thinkingNoted = false
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
            if (!data) continue
            let evt: { type?: string; text?: string; message?: string; code?: string; model?: string }
            try {
              evt = JSON.parse(data)
            } catch { continue }
            if (evt.type === 'start') {
              onEvent({ type: 'notice', text: `Модель: ${evt.model || model}` })
            } else if (evt.type === 'notice') {
              onEvent({ type: 'notice', text: evt.text || '' })
            } else if (evt.type === 'reasoning') {
              if (!thinkingNoted) {
                thinkingNoted = true
                onEvent({ type: 'notice', text: 'Модель размышляет…' })
              }
            } else if (evt.type === 'delta') {
              answer += evt.text || ''
              onEvent({ type: 'delta', text: evt.text || '' })
            } else if (evt.type === 'error') {
              gotError = { message: evt.message || 'ошибка потока', code: evt.code }
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          gotError = { message: (e as Error).message.slice(0, 300) || 'поток прерван', code: 'stream_error' }
        }
      }

      if (gotError) {
        onEvent({ type: 'error', message: gotError.message, code: gotError.code })
        onEvent({ type: 'done' })
        return
      }
      if (!answer.trim()) {
        onEvent({ type: 'error', message: 'Пустой ответ модели — попробуй ещё раз', code: 'empty_answer' })
        onEvent({ type: 'done' })
        return
      }

      // 3) persist the answer
      try {
        const res = await fetch('/api/chat/commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: convId,
            content: answer,
          }),
        })
        const data = (await res.json().catch(() => ({}))) as { message?: MessageDTO; error?: string }
        if (!res.ok || !data.message) throw new Error(data.error || `commit ${res.status}`)
        onEvent({ type: 'message', message: data.message })
      } catch (e) {
        onEvent({ type: 'error', message: e instanceof Error ? e.message.slice(0, 300) : 'не удалось сохранить ответ' })
      }
      onEvent({ type: 'done' })
    },
    [model, webSearch, effort, onEvent, loadConversations],
  )

  const handleSend = useCallback(
    (content: string, opts?: SendOptions) => {
      if (sendingRef.current || !content.trim()) return
      sendingRef.current = true
      setSending(true)
      stickToBottomRef.current = true
      startSeenRef.current = false
      setErrorMsg(null)
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

      if (opts?.videoRequest) {
        // 🎬 composer toggle: also queue the Kaggle H3 video pipeline
        void (async () => {
          try {
            const res = await fetch('/api/video-request', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ conversationId: activeIdRef.current, prompt: content }),
            })
            const data = (await res.json().catch(() => ({}))) as {
              task?: AgentTaskDTO
              error?: string
              code?: string
            }
            if (!res.ok || !data.task) {
              onEvent({ type: 'error', message: data.error || `video ${res.status}`, code: data.code })
            } else {
              onEvent({ type: 'task', task: data.task })
            }
          } catch {
            onEvent({ type: 'error', message: 'не удалось поставить видео в очередь' })
          }
        })()
      }

      void runTurn(activeIdRef.current, content, Boolean(opts?.resume))
    },
    [runTurn, onEvent],
  )

  /* --------------------------------------------------------- conversation */

  const selectConversation = useCallback(
    (id: string) => {
      if (sendingRef.current) return
      setActiveId(id)
      activeIdRef.current = id
      setMessages([])
      setTasks([])
      setErrorMsg(null)
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
    setErrorMsg(null)
    setDraft('')
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

  /** "Подключить Telegram": one-time deep link -> bot -> /start connect_<token>
   * binds this account and merges the bot chat history into it */
  const connectTelegram = useCallback(async () => {
    setTgLinkBusy(true)
    setTgLinkNote('')
    try {
      const res = await fetch('/api/settings/telegram/link', { method: 'POST' })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string }
      if (!res.ok || !data.ok || !data.url) {
        setTgLinkNote(data.error || 'не получилось создать ссылку')
        return
      }
      window.open(data.url, '_blank', 'noopener')
      setTgLinkNote('Нажми START в открывшемся боте — история объединится. Обновлю статус через 30 с…')
      setTimeout(() => { void checkSession() }, 30_000)
      setTimeout(() => { void checkSession() }, 90_000)
    } catch {
      setTgLinkNote('сетевая ошибка')
    } finally {
      setTgLinkBusy(false)
    }
  }, [checkSession])

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

  useEffect(() => {
    // abort a running stream when the app unmounts
    return () => abortRef.current?.abort()
  }, [])

  /* ---------------------------------------------------------------- render */

  // auth gate: while the session check runs show a quiet splash
  if (!session.checked) {
    return (
      <div className="flex h-dvh items-center justify-center bg-stone-50">
        <div className="flex items-center gap-3 text-stone-500">
          <Loader2 className="h-5 w-5 animate-spin text-emerald-600" />
          <span className="text-sm">Загрузка…</span>
        </div>
      </div>
    )
  }
  if (session.checked && !session.user) {
    return <AuthScreen onAuthed={() => void checkSession().then(() => void loadInitial())} />
  }

  const activeModel = MODEL_OPTIONS.find((m) => m.id === model) || MODEL_OPTIONS[0]
  const modelSelector = (
    <div className="relative">
      <button
        type="button"
        onClick={() => setModelOpen((v) => !v)}
        className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[14px] font-medium text-stone-800 hover:bg-stone-100 transition-colors"
      >
        {activeModel.label}
        <ChevronDown className="h-4 w-4 text-stone-400" />
      </button>
      {modelOpen && (
        <>
          <button
            type="button"
            aria-label="Закрыть"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setModelOpen(false)}
          />
          <div className="absolute left-0 top-11 z-20 w-80 overflow-hidden rounded-2xl border border-stone-200 bg-white p-2 shadow-xl shadow-stone-900/10">
            {MODEL_OPTIONS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => selectModel(m.id)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left transition-colors',
                  m.id === model ? 'bg-stone-100' : 'hover:bg-stone-50',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-stone-900">{m.label}</span>
                    {'badge' in m && m.badge && (
                      <span className="rounded-md bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        {m.badge}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] leading-snug text-stone-500">{m.sub}</p>
                </div>
                {m.id === model && <Check className="mt-1 h-4 w-4 shrink-0 text-emerald-600" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )

  const sidebar = (
    <div className="flex h-full w-full min-w-0 flex-col bg-stone-50">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-stone-900">
          <Sparkles className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-stone-900 leading-tight">Vebai</p>
          <p className="text-[11px] text-stone-500 leading-tight">агент на базе GLM · 24/7</p>
        </div>
      </div>
      <div className="px-3">
        <Button
          onClick={newChat}
          disabled={sending}
          className="w-full justify-start gap-2 bg-stone-900 text-white hover:bg-stone-700 font-medium"
        >
          <MessageSquarePlus className="h-4 w-4" />
          Новый чат
        </Button>
        <a
          href="/terminal"
          target="_blank"
          rel="noreferrer"
          className="mt-2 flex w-full items-center justify-start gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100"
        >
          <SquareTerminal className="h-4 w-4 text-stone-500" />
          Терминал (Linux)
          {pendingVterm > 0 && (
            <span className="ml-auto rounded-full bg-emerald-600 px-1.5 text-[10px] font-semibold text-white">
              {pendingVterm}
            </span>
          )}
        </a>
      </div>
      <div className="mt-3 flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={cn(
              'group flex items-center gap-1 rounded-xl px-2 py-2 cursor-pointer transition-colors',
              c.id === activeId ? 'bg-stone-200/70' : 'hover:bg-stone-100',
            )}
            onClick={() => selectConversation(c.id)}
          >
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', c.id === activeId ? 'bg-emerald-600' : 'bg-stone-300')} />
            <span className="flex-1 truncate text-sm text-stone-700">{c.title}</span>
            <button
              aria-label="Удалить диалог"
              onClick={(e) => {
                e.stopPropagation()
                void deleteConversation(c.id)
              }}
              className="hidden group-hover:block rounded p-1 text-stone-400 hover:text-red-500 hover:bg-stone-200"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {conversations.length === 0 && (
          <p className="px-3 py-4 text-xs text-stone-400">История диалогов появится здесь</p>
        )}
      </div>
      <div className="border-t border-stone-200 px-4 py-3">
        <div className="flex items-center gap-2 text-[11px] text-stone-500">
          <span className="relative flex h-2 w-2">
            <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-50', connected ? 'bg-emerald-500' : 'bg-amber-500')} />
            <span className={cn('relative inline-flex h-2 w-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-amber-500')} />
          </span>
          {connected ? 'Агент на связи · работает 24/7' : 'Переподключение к агенту…'}
          {worker.activeTasks > 0 && (
            <span className="ml-auto text-emerald-700">{worker.activeTasks} в фоне</span>
          )}
        </div>
        <div className="mt-2 rounded-xl border border-stone-200 bg-stone-50 px-2.5 py-2">
          {session.user?.telegramChatId ? (
            <div className="flex items-center gap-2 text-[11px] text-stone-600">
              <span className="text-emerald-600">✓</span>
              <span className="min-w-0 flex-1 truncate" title={`Telegram · chat ${session.user.telegramChatId}`}>
                Telegram подключён{session.user.telegramUsername ? ` (@${session.user.telegramUsername})` : ''}
              </span>
            </div>
          ) : (
            <>
              <button
                onClick={() => void connectTelegram()}
                disabled={tgLinkBusy}
                className="w-full rounded-lg bg-stone-900 px-2 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-stone-700 disabled:opacity-50"
              >
                {tgLinkBusy ? 'Открываю бота…' : 'Подключить Telegram'}
              </button>
              {tgLinkNote && <p className="mt-1.5 text-[10px] leading-snug text-stone-500">{tgLinkNote}</p>}
            </>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-800 text-[10px] font-semibold text-white">
            {(session.user?.name || session.user?.email || '?').slice(0, 1).toUpperCase()}
          </div>
          <span className="min-w-0 flex-1 truncate text-[11px] text-stone-600" title={session.user?.email}>
            {session.user?.name || session.user?.email}
          </span>
          <button
            onClick={() => void logout()}
            className="rounded px-2 py-1 text-[11px] text-stone-500 hover:bg-stone-100 hover:text-stone-700"
          >
            Выйти
          </button>
        </div>
      </div>
    </div>
  )

  const heroBlock = (
    <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-7 px-4 py-10 text-center">
      <div className="space-y-3">
        <h2 className="font-display text-4xl text-stone-900 sm:text-5xl">
          Что мне построить для тебя?
        </h2>
        <p className="text-sm leading-relaxed text-stone-500">
          Введи задачу — агент сам спланирует, найдёт в интернете, нарисует и смонтирует видео.
        </p>
      </div>

      <Composer
        variant="hero"
        onSend={handleSend}
        disabled={sending}
        connected={connected}
        draft={draft}
        onDraftChange={setDraft}
        webSearch={webSearch}
        onWebSearchToggle={toggleWebSearch}
        effort={effort}
        onEffortChange={changeEffort}
        video={video}
        onVideoToggle={toggleVideo}
      />

      <div className="flex w-full flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.text}
            onClick={() => handleSend(s.text)}
            className="group flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3.5 py-2 text-[13px] text-stone-600 transition-all hover:border-stone-300 hover:bg-stone-50 hover:text-stone-900 hover:shadow-sm"
          >
            <span className="text-[14px] leading-none">{s.icon}</span>
            <span className="max-w-[240px] truncate">{s.text}</span>
          </button>
        ))}
      </div>

      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
        {GALLERY.map((g) => (
          <button
            key={g.label}
            onClick={() => handleSend(`Сделай ${g.label.toLowerCase()}: придумай концепцию и реализуй`)}
            className={cn(
              'group flex h-24 items-end rounded-2xl bg-gradient-to-br p-3 text-left shadow-sm transition-all hover:shadow-md',
              g.grad,
            )}
          >
            <span className="text-[12px] font-medium text-white drop-shadow-sm">
              {g.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="flex h-dvh overflow-hidden bg-white">
      {/* desktop sidebar */}
      <aside className="hidden md:flex w-64 shrink-0 border-r border-stone-200">
        {sidebar}
      </aside>

      {/* mobile sidebar sheet */}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-72 p-0 border-stone-200 bg-stone-50 [&>button]:text-stone-500">
          <SheetHeader className="sr-only">
            <SheetTitle>Диалоги</SheetTitle>
          </SheetHeader>
          {sidebar}
        </SheetContent>
      </Sheet>

      {/* center chat column */}
      <main className="flex min-w-0 flex-1 flex-col">
        <WarningBanner />
        <header className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Диалоги"
            className="md:hidden h-9 w-9 text-stone-600 hover:bg-stone-100"
            onClick={() => setNavOpen(true)}
          >
            <Menu className="h-4 w-4" />
          </Button>
          {modelSelector}
          {webSearch && (
            <span className="hidden sm:inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
              <Globe className="h-3 w-3" /> поиск включён
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {worker.activeTasks > 0 && (
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
                <Loader2 className="h-3 w-3 animate-spin" />
                {worker.activeTasks} фоновых задач
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              aria-label="Активность агента"
              className="lg:hidden h-9 gap-1.5 px-2 text-stone-600 hover:bg-stone-100"
              onClick={() => setActivityOpen(true)}
            >
              <Activity className="h-4 w-4" />
              {worker.activeTasks > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-600 px-1 text-[10px] font-semibold text-white">
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
          {messages.length === 0 && !stream && !sending && !errorMsg ? (
            heroBlock
          ) : (
            <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
              {messages.map((m, i) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  showAvatar={i === 0 || messages[i - 1].role !== 'assistant'}
                />
              ))}

              {/* live stream segment (T16: only the model's chosen text and
                  short status notes — no plans/tools, no intermediate work) */}
              {stream && (stream.note || stream.text.trim()) && (
                <div className="flex gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-stone-900">
                    <Sparkles className="h-4 w-4 text-white" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-3 pt-0.5">
                    {stream.note && !stream.text.trim() && (
                      <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" />
                        <span className="text-[13px] text-amber-800">{stream.note}</span>
                      </div>
                    )}
                    {stream.text.trim() && (
                      <div className="text-[15px] leading-relaxed text-stone-800 whitespace-pre-wrap break-words">
                        {stream.text}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* visible error — a turn can fail (overloaded model, network);
                  the user must ALWAYS see why */}
              {errorMsg && (
                <div className="flex gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-red-200 bg-red-50">
                    <AlertCircle className="h-4 w-4 text-red-500" />
                  </div>
                  <div className="min-w-0 flex-1 rounded-2xl border border-red-200 bg-red-50/70 px-4 py-3">
                    <p className="text-[13px] leading-relaxed text-red-700 break-words">
                      {errorMsg.message}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      {!sending && lastSentRef.current && (
                        <Button
                          size="sm"
                          onClick={() => {
                            const c = lastSentRef.current?.content
                            if (c) handleSend(c)
                          }}
                          className="h-7 gap-1.5 rounded-lg bg-red-600 px-2.5 text-[12px] text-white hover:bg-red-700"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Повторить
                        </Button>
                      )}
                      <button
                        onClick={() => setErrorMsg(null)}
                        aria-label="Закрыть ошибку"
                        className="flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] text-red-500 hover:bg-red-100"
                      >
                        <X className="h-3 w-3" /> Скрыть
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* typing indicator */}
              {sending && !stream && (
                <div className="flex gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-stone-900">
                    <Sparkles className="h-4 w-4 text-white" />
                  </div>
                  <div className="flex items-center gap-1.5 pt-2.5">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400 [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400 [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400 [animation-delay:300ms]" />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {activeId && (
          <div className="px-3 pb-3 sm:px-6 sm:pb-4 pt-1">
            <Composer
              variant="dock"
              onSend={handleSend}
              disabled={sending}
              connected={connected}
              draft={draft}
              onDraftChange={setDraft}
              webSearch={webSearch}
              onWebSearchToggle={toggleWebSearch}
              effort={effort}
              onEffortChange={changeEffort}
              video={video}
              onVideoToggle={toggleVideo}
            />
            <p className="mt-2 text-center text-[11px] text-stone-400">
              Enter — отправить · Shift+Enter — новая строка · агент работает 24/7, результаты придут в чат
            </p>
          </div>
        )}
      </main>

      {/* desktop activity panel */}
      <aside className="hidden lg:flex w-80 shrink-0 border-l border-stone-200">
        <div className="w-full">
          <ActivityPanel tasks={tasks} worker={worker} />
        </div>
      </aside>

      {/* mobile activity sheet */}
      <Sheet open={activityOpen} onOpenChange={setActivityOpen}>
        <SheetContent side="right" className="w-80 p-0 border-stone-200 bg-white [&>button]:text-stone-500">
          <SheetHeader className="sr-only">
            <SheetTitle>Активность агента</SheetTitle>
          </SheetHeader>
          <ActivityPanel tasks={tasks} worker={worker} />
        </SheetContent>
      </Sheet>
    </div>
  )
}
