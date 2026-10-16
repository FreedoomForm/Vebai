'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserTerminal } from '@/lib/terminal/browser-terminal'

const RAM_DEFAULT = 1024

type Stage = 'no-session' | 'booting' | 'login' | 'ready' | 'busy' | 'error'

const STAGE_LABEL: Record<Stage, string> = {
  'no-session': 'нет сессии',
  booting: 'загрузка Linux…',
  login: 'ожидание шелла…',
  ready: 'готов',
  busy: 'выполняется команда агента',
  error: 'ошибка',
}

interface SessionInfo {
  id: string
  title: string
  lastSeenAt: string | null
  createdAt: string
  files: number
  commands: number
}

export default function TerminalPage() {
  const termRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<BrowserTerminal | null>(null)
  const xtermRef = useRef<{ term: any; dispose: () => void } | null>(null)

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('no-session')
  const [detail, setDetail] = useState<string>('')
  const [notices, setNotices] = useState<string[]>([])
  const [pending, setPending] = useState(0)
  const [paused, setPaused] = useState(false)
  const [ram, setRam] = useState(RAM_DEFAULT)
  const [booted, setBooted] = useState(false)

  const notice = useCallback((t: string) => {
    setNotices((n) => [...n.slice(-4), `${new Date().toLocaleTimeString('ru-RU')} — ${t}`])
  }, [])

  /* load session list */
  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/terminal/sessions')
      if (!res.ok) return
      const j = (await res.json()) as { sessions: SessionInfo[] }
      setSessions(j.sessions)
      return j.sessions
    } catch {
      return []
    }
  }, [])

  const openSessionRef = useRef<((sid: string) => Promise<void>) | null>(null)

  useEffect(() => {
    void (async () => {
      const saved = typeof window !== 'undefined' ? window.localStorage.getItem('vbterm:lastSession') : null
      const list = (await refreshSessions()) || []
      if (saved && list.some((s) => s.id === saved)) void openSessionRef.current?.(saved)
    })()
  }, [refreshSessions])

  /* xterm setup */
  const ensureXterm = useCallback(async () => {
    if (xtermRef.current) return xtermRef.current
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ])
    await import('@xterm/xterm/css/xterm.css')
    const term = new Terminal({
      fontFamily: '"Sarasa Mono SC", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#0b1020', foreground: '#d6e2f0' },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    if (termRef.current) {
      term.open(termRef.current)
      fit.fit()
    }
    term.writeln('\x1b[36mVebai Terminal — настоящий Alpine Linux в браузере (v86)\x1b[0m')
    xtermRef.current = { term, dispose: () => term.dispose() }
    return xtermRef.current
  }, [])

  const openSession = useCallback(
    async (sid: string) => {
      if (engineRef.current) {
        engineRef.current.destroy()
        engineRef.current = null
      }
      setBooted(false)
      setNotices([])
      setCurrentId(sid)
      window.localStorage.setItem('vbterm:lastSession', sid)

      const { term } = await ensureXterm()
      term.reset()
      term.writeln('\x1b[33mСтартую VM…\x1b[0m')

      let secret = ''
      try {
        const res = await fetch(`/api/terminal/sessions/${sid}`)
        if (res.ok) secret = ((await res.json()) as { session: { secret: string } }).session.secret
      } catch { /* handled by engine error */ }

      const engine = new BrowserTerminal({
        sid,
        secret,
        origin: window.location.origin,
        ramMb: ram,
        wispUrl: process.env.NEXT_PUBLIC_WISP_URL || '',
        term,
        callbacks: {
          onStatus: (s, d) => {
            setStage(s as Stage)
            setDetail(d || '')
            if (s === 'ready') setBooted(true)
            if (s === 'error') notice('Ошибка: ' + (d || 'неизвестно'))
          },
          onQueue: (n) => setPending(n),
          onNotice: notice,
        },
      })
      engineRef.current = engine
      await engine.start()
    },
    [ensureXterm, notice, ram],
  )

  useEffect(() => {
    openSessionRef.current = openSession
  }, [openSession])

  const createSession = useCallback(async () => {
    const res = await fetch('/api/terminal/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!res.ok) {
      notice('Не удалось создать сессию (нужен вход?)')
      return
    }
    const j = (await res.json()) as { session: { id: string } }
    await refreshSessions()
    void openSession(j.session.id)
  }, [openSession, notice, refreshSessions])

  useEffect(() => () => engineRef.current?.destroy(), [])

  const wispConfigured = !!process.env.NEXT_PUBLIC_WISP_URL

  return (
    <div className="flex min-h-screen flex-col bg-[#070b16] text-slate-200">
      {/* header */}
      <header className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3">
        <a href="/" className="text-sm font-semibold text-emerald-400 hover:underline">
          ← Vebai
        </a>
        <h1 className="text-sm font-semibold">Linux-терминал (в браузере)</h1>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            stage === 'ready'
              ? 'bg-emerald-500/15 text-emerald-400'
              : stage === 'error'
                ? 'bg-red-500/15 text-red-400'
                : stage === 'busy'
                  ? 'bg-amber-500/15 text-amber-400'
                  : 'bg-slate-500/15 text-slate-300'
          }`}
        >
          {STAGE_LABEL[stage]}
          {detail ? `: ${detail}` : ''}
        </span>
        {pending > 0 && (
          <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-xs text-sky-300">
            в очереди: {pending}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-slate-400">
            RAM:
            <select
              value={ram}
              onChange={(e) => setRam(Number(e.target.value))}
              disabled={booted}
              className="rounded border border-white/10 bg-white/5 px-1 py-0.5 text-xs"
            >
              <option value={512}>512 МБ</option>
              <option value={1024}>1 ГБ</option>
            </select>
          </label>
          <button
            onClick={() => {
              const p = !paused
              setPaused(p)
              engineRef.current?.setPaused(p)
            }}
            disabled={!booted}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              paused ? 'bg-amber-500/20 text-amber-300' : 'bg-white/5 hover:bg-white/10'
            } disabled:opacity-40`}
          >
            {paused ? 'Агент на паузе' : 'Агент активен'}
          </button>
          <button
            onClick={() => void engineRef.current?.saveSnapshot()}
            disabled={!booted}
            className="rounded-md bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white/10 disabled:opacity-40"
          >
            Сохранить снапшот
          </button>
          <button
            onClick={() => void createSession()}
            className="rounded-md bg-emerald-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600"
          >
            Новая сессия
          </button>
        </div>
      </header>

      {/* sessions strip */}
      {sessions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2 text-xs">
          <span className="text-slate-500">Сессии:</span>
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => void openSession(s.id)}
              className={`rounded-full px-2 py-1 transition ${
                s.id === currentId ? 'bg-emerald-600/30 text-emerald-300' : 'bg-white/5 text-slate-300 hover:bg-white/10'
              }`}
            >
              {s.title || s.id.slice(0, 8)}
              {s.files > 0 ? ` · 📄${s.files}` : ''}
            </button>
          ))}
        </div>
      )}

      {/* terminal */}
      <main className="flex min-h-0 flex-1 flex-col px-2 py-2">
        <div ref={termRef} className="min-h-[420px] flex-1 rounded-lg border border-white/10 bg-[#0b1020] p-2" />
        <div className="mt-2 flex flex-col gap-1 text-xs text-slate-400">
          {notices.map((n, i) => (
            <div key={i} className="rounded bg-white/5 px-2 py-1">
              {n}
            </div>
          ))}
          <div className="text-slate-500">
            Ядро: Alpine Linux x86 · движок v86 (BSD-2) · RAM {ram} МБ · снапшоты в браузере · файлы → Telegram ·
            {' '}сеть: {wispConfigured ? 'WISP relay настроен' : 'WISP relay не настроен (NEXT_PUBLIC_WISP_URL)'}
          </div>
        </div>
      </main>
    </div>
  )
}
