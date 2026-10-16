'use client'

import { useEffect, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * Landing / auth gate — clean welcome card (our own design).
 *
 * REGISTRATION is instant: a local email+password account, nothing external.
 * AI runs server-side on the site's official Z.ai API (free GLM models) —
 * no Z.ai logins, no captchas, no sessions.
 */

export function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // auto-enter when a session cookie already exists
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' })
        if (res.ok) onAuthed()
      } catch { /* offline — keep polling */ }
    }, 2500)
    return () => clearInterval(t)
  }, [onAuthed])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          mode === 'register' ? { email, password, name } : { email, password },
        ),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        user?: { id: string; email: string; name: string }
      }
      if (!res.ok) {
        setError(data.error || `Ошибка ${res.status}`)
        return
      }
      onAuthed()
    } catch {
      setError('Сеть недоступна, попробуй ещё раз')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-50 px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        {/* welcome card */}
        <div className="rounded-3xl border border-stone-200/80 bg-white p-7 shadow-[0_16px_48px_rgba(28,25,23,0.07)]">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-stone-900">
              <Sparkles className="h-7 w-7 text-white" />
            </div>
            <h1 className="font-display mt-4 text-2xl text-stone-900">Добро пожаловать в Vebai</h1>
            <p className="mt-1 text-[13px] text-stone-500">
              ИИ-агент на бесплатных моделях GLM — работает 24/7
            </p>
          </div>

          <div className="mt-6 space-y-3">
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-stone-50 p-1 border border-stone-200">
              {(['register', 'login'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m)
                    setError('')
                  }}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors',
                    mode === m ? 'bg-stone-900 text-white' : 'text-stone-500 hover:text-stone-800',
                  )}
                >
                  {m === 'register' ? 'Регистрация' : 'Вход'}
                </button>
              ))}
            </div>

            {mode === 'register' && (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Имя (необязательно)"
                className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 outline-none focus:border-stone-400"
              />
            )}
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="email"
              placeholder="Email"
              className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 outline-none focus:border-stone-400"
            />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              placeholder="Пароль (мин. 6 символов)"
              className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 outline-none focus:border-stone-400"
            />

            {error && <p className="text-[12px] leading-relaxed text-red-500">{error}</p>}

            <Button
              onClick={() => void submit()}
              disabled={busy || !email || !password}
              className="w-full rounded-xl bg-stone-900 text-white hover:bg-stone-700 font-medium"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === 'register' ? 'Создать аккаунт и начать' : 'Войти'}
            </Button>

            <p className="text-[11px] leading-relaxed text-stone-400">
              Диалоги привязаны к аккаунту. Фоновые задачи продолжают выполняться после закрытия
              браузера, результаты появятся в чате.
            </p>
          </div>
        </div>

        {/* info note */}
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex items-start gap-2 text-emerald-800">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-[11.5px] leading-relaxed text-emerald-800/90">
              Чат работает на официальном API Z.ai с бесплатными моделями GLM-4.5-Flash (по
              умолчанию) и GLM-4.7-Flash (резерв). Никаких внешних логинов и капч — просто
              регистрируйся и работай: веб-поиск и фоновое создание видео включены.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
