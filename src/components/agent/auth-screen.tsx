'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, ShieldAlert, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface CaptchaChallenge {
  id: string
  svg: string
}

/**
 * Landing / auth gate. Shows the mandatory proxy warning prominently:
 * the account is created here (behind a captcha), but AI traffic goes
 * through chat.z.ai and consumes the Z.ai quota of the site's account.
 * Users never provide any Z.ai tokens.
 */
export function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [captcha, setCaptcha] = useState<CaptchaChallenge | null>(null)
  const [captchaText, setCaptchaText] = useState('')
  const [captchaLoading, setCaptchaLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadCaptcha = useCallback(async () => {
    setCaptchaLoading(true)
    setCaptchaText('')
    try {
      const res = await fetch('/api/auth/captcha', { cache: 'no-store' })
      const data = (await res.json().catch(() => null)) as CaptchaChallenge | { error?: string } | null
      if (data && 'id' in data && 'svg' in data) setCaptcha(data as CaptchaChallenge)
    } catch {
      /* network error — user can retry via the refresh button */
    } finally {
      setCaptchaLoading(false)
    }
  }, [])

  useEffect(() => {
    if (mode !== 'register') return
    // queueMicrotask keeps setState out of the synchronous effect body
    const t = setTimeout(() => { void loadCaptcha() }, 0)
    return () => clearTimeout(t)
  }, [mode, loadCaptcha])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const body =
        mode === 'register'
          ? { email, password, name, captchaId: captcha?.id, captchaText }
          : { email, password }
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(data.error || `Ошибка ${res.status}`)
        if (mode === 'register') void loadCaptcha() // captcha is single-use
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
            Аккаунт создаётся здесь (за капчей), но все запросы к ИИ выполняет агент платформы{' '}
            <span className="font-medium text-amber-200">chat.z.ai (Z.ai)</span> — с её встроенным
            поиском и инструментами — и расходует <span className="font-medium text-amber-200">квоту Z.ai</span>,
            закреплённую за сайтом. Никакие токены Z.ai у тебя не запрашиваются.
            Это неофициальный клиент, не аффилированный с Z.ai.
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

          {mode === 'register' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div
                  data-testid="captcha-image"
                  className="flex h-14 w-[172px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950"
                >
                  {captcha ? (
                    <img
                      src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(captcha.svg)))}`}
                      alt="Капча: пять символов с картинки"
                      className="h-14 w-[172px]"
                      draggable={false}
                    />
                  ) : (
                    <span className="text-[11px] text-zinc-600">
                      {captchaLoading ? 'загрузка…' : 'капча недоступна'}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  aria-label="Обновить капчу"
                  onClick={() => void loadCaptcha()}
                  className="rounded-lg border border-zinc-800 p-2.5 text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
                >
                  <RefreshCw className={cn('h-4 w-4', captchaLoading && 'animate-spin')} />
                </button>
              </div>
              <input
                value={captchaText}
                onChange={(e) => setCaptchaText(e.target.value)}
                placeholder="Символы с картинки"
                maxLength={10}
                autoCapitalize="characters"
                autoCorrect="off"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm uppercase tracking-[0.3em] text-zinc-200 placeholder:text-zinc-600 placeholder:tracking-normal placeholder:normal-case outline-none focus:border-emerald-800"
              />
            </div>
          )}

          {error && <p className="text-[12px] text-red-400">{error}</p>}

          <Button
            onClick={submit}
            disabled={busy || !email || !password || (mode === 'register' && (!captchaText || !captcha))}
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
