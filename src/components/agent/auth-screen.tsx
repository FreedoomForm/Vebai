'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, ShieldAlert, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ZaiAuthCaptcha, preloadZaiCaptcha } from './zai-captcha'

/**
 * Landing / auth gate (v4).
 *
 * REGISTRATION is instant and unconditional: the local account is created
 * immediately — nothing Z.ai-side can block it (the old hard captcha gate
 * produced "green but rejected" dead ends). The Z.ai captcha widget below
 * the form is OPTIONAL: with a solved param we also create the user's REAL
 * chat.z.ai account in the same request (own JWT, own quota); without one
 * the user can connect later from the in-app card.
 *
 * LOGIN needs no captcha at all: local password first, stored Z.ai session
 * refreshes silently, and a dead session is re-linked inside the app.
 */
export function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  // captcha param produced by the embedded auth-scene widget (optional)
  const [captchaParam, setCaptchaParam] = useState('')
  const [captchaToken, setCaptchaToken] = useState(0) // force widget re-init
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  useEffect(() => {
    // warm the SDK so the first verification starts instantly
    preloadZaiCaptcha()
  }, [])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    setInfo('')
    try {
      const body =
        mode === 'register'
          ? { email, password, name, zaiCaptchaParam: captchaParam || undefined }
          : { email, password }
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        zai?: { linked?: boolean; code?: string; detail?: string }
        zaiSession?: string
      }
      if (!res.ok) {
        setError(data.error || `Ошибка ${res.status}`)
        setCaptchaParam('')
        setCaptchaToken((t) => t + 1)
        return
      }
      if (mode === 'register' && data.zai && !data.zai.linked && captchaParam) {
        // registered fine, but Z.ai refused the linking attempt — surface it
        setInfo(
          `Аккаунт создан, но Z.ai не принял привязку: ${data.zai.detail || 'отверг капчу'}. ` +
            'Подключишь позже в приложении — чат уже работает.',
        )
        setTimeout(onAuthed, 2600)
        return
      }
      onAuthed()
    } catch {
      setError('Сеть недоступна, попробуй ещё раз')
    } finally {
      setBusy(false)
    }
  }

  const onWidgetParam = useCallback((param: string) => {
    setCaptchaParam(param)
    setError('')
  }, [])

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
            Регистрация мгновенная и ни от чего не зависит. Капча Z.ai (тот же виджет Aliyun, что у
            них) нужна только чтобы <span className="font-medium text-amber-200">создать твой
            настоящий аккаунт chat.z.ai</span> — этот email и пароль будут работать и на самом
            chat.z.ai, а все запросы пойдут <span className="font-medium text-amber-200">под твоим
            аккаунтом и на твою личную квоту</span>. Агент chat.z.ai в режиме «Агент» сам делает
            веб-поиск, генерацию изображений, работу с файлами и кодом. Никакие токены у тебя не
            запрашиваются. Это неофициальный клиент, не аффилированный с Z.ai.
          </p>
        </div>

        {/* form */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-950 p-1">
            {(['register', 'login'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(''); setInfo(''); setCaptchaParam('') }}
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

          {/* Z.ai's own auth captcha — OPTIONAL: solves the per-user Z.ai
              account creation right here; skipping it is fine (link later) */}
          {mode === 'register' && (
            <div className="space-y-1.5">
              <p className="text-[11px] leading-relaxed text-zinc-600">
                Капча Z.ai — создаёт твой аккаунт на их стороне (рекомендую, но не обязательно:
                можно подключиться позже из приложения). Нажми на полоску, иногда нужно перетащить
                ползунок на картинке.
              </p>
              <ZaiAuthCaptcha onParam={onWidgetParam} token={captchaToken} />
            </div>
          )}

          {info && <p className="text-[12px] leading-relaxed text-amber-300">{info}</p>}
          {error && <p className="text-[12px] leading-relaxed text-red-400">{error}</p>}

          <Button
            onClick={() => void submit()}
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

        {/* Google bridge — honest proxying of Z.ai's own Google auth */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
          <p className="text-[13px] font-semibold text-zinc-200">Вход через Google</p>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Z.ai принимает Google-вход только на своей странице и возвращает сессию только своим
            доменам — перехватить её для чужого сайта технически невозможно. Поэтому мост такой:
            войди через Google на chat.z.ai, задай пароль в профиле Z.ai, затем войди здесь тем же
            email — аккаунт свяжется автоматически, и вся квота Z.ai станет твоей.
          </p>
          <a
            href="https://chat.z.ai/"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-[12px] font-medium text-zinc-200 hover:border-emerald-800 hover:text-emerald-300"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
              <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l-.02.15 3.5 2.7.24.02c2.2-2 3.5-5 3.5-8.6z" />
              <path fill="#34A853" d="M12 24c3.2 0 5.9-1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.2 0-5.9-2.1-6.8-5l-.14.01-3.1 2.4-.04.14C3.9 20.7 7.6 24 12 24z" />
              <path fill="#FBBC05" d="M5.2 14.4c-.25-.7-.4-1.5-.4-2.4s.14-1.6.4-2.4l-.01-.16L2 7.1l-.1.08C.7 9.1 0 10.5 0 12s.7 2.9 1.9 4.8l3.3-2.4z" />
              <path fill="#EA4335" d="M12 4.6c2.3 0 3.8 1 4.7 1.8l3.4-3.3C18 1.2 15.2 0 12 0 7.6 0 3.9 3.3 1.9 7.2l3.3 2.5C6.1 6.7 8.8 4.6 12 4.6z" />
            </svg>
            Войти через Google на chat.z.ai
          </a>
        </div>
      </div>
    </div>
  )
}
