'use client'

import { useState } from 'react'
import { Loader2, ShieldAlert, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * Landing / auth gate. Shows the mandatory proxy warning prominently:
 * the account is created here, but AI traffic goes through chat.z.ai
 * and consumes Z.ai quota (the user's own token or the site owner's).
 */
export function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'register' ? { email, password, name } : { email, password }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
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
    <div className="flex min-h-dvh items-center justify-center bg-zinc-950 px-4 py-10">
      <div className="w-full max-w-md space-y-5">
        {/* brand */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-800/40">
            <Sparkles className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 leading-tight">Нейро-Архитектор</h1>
            <p className="text-xs text-zinc-500 leading-tight">персистентный ИИ-агент 24/7</p>
          </div>
        </div>

        {/* mandatory proxy disclosure */}
        <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 p-4 space-y-2">
          <div className="flex items-center gap-2 text-amber-400">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <p className="text-[13px] font-semibold leading-tight">
              Важно: прозрачный прокси к Z.ai
            </p>
          </div>
          <p className="text-[12px] leading-relaxed text-amber-200/80">
            Аккаунт создаётся здесь, но все запросы к ИИ выполняются через платформу{' '}
            <span className="font-medium text-amber-200">chat.z.ai (Z.ai)</span> и расходуют её квоту —
            твою собственную (если укажешь свой токен Z.ai в настройках) или аккаунт владельца сайта.
            Это неофициальный клиент, не аффилированный с Z.ai. Регистрируясь, ты подтверждаешь, что
            понимаешь, как работает прокси.
          </p>
        </div>

        {/* form */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-950 p-1">
            {(['register', 'login'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError('') }}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
                  mode === m ? 'bg-emerald-500/90 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200',
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
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-emerald-800"
            />
          )}
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            placeholder="Email"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-emerald-800"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            placeholder="Пароль (мин. 6 символов)"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-emerald-800"
          />

          {error && <p className="text-[12px] text-red-400">{error}</p>}

          <Button
            onClick={submit}
            disabled={busy || !email || !password}
            className="w-full bg-emerald-500/90 text-zinc-950 hover:bg-emerald-400 font-medium"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === 'register' ? 'Создать аккаунт' : 'Войти'}
          </Button>

          <p className="text-[11px] leading-relaxed text-zinc-600">
            Диалоги привязаны к аккаунту. Фоновые задачи (видео, изображения) продолжают
            выполняться после закрытия браузера, результаты появятся в чате.
          </p>
        </div>
      </div>
    </div>
  )
}
