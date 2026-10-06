'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, ShieldAlert, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ZaiAuthCaptcha, preloadZaiCaptcha } from './zai-captcha'
import { BookmarkletLink } from './bookmarklet'

/**
 * Landing / auth gate (v6).
 *
 * REGISTRATION is instant and unconditional: the local account is created
 * immediately — nothing Z.ai-side can block it. The Z.ai captcha widget is
 * OPTIONAL: with a solved param we START the user's REAL chat.z.ai account
 * (Z.ai emails a verification code); the user then enters the code on the
 * next step — that completes the real account and links its JWT. Skipping
 * is fine: the account works and can be linked later in-app.
 *
 * LOGIN needs no captcha at all: local password first, stored Z.ai session
 * refreshes silently, and a dead session is re-linked inside the app.
 *
 * GOOGLE (v6 — token AUTO-COPY): byte-level research proved chat.z.ai only
 * returns its Google-login session to its own whitelisted domains (the
 * sso_redirect whitelist is exact-hostname and we are not on it), so no 100%
 * seamless redirect exists. The v6 bridge: our button opens Z.ai's REAL
 * Google login (popup) and the "⚡ Vebai — забрать токен" bookmarklet — one
 * click on the logged-in chat.z.ai tab — navigates the browser to
 * /auth/google/catch#token=… (plain navigation: no CSP/CORS can block it);
 * the catch page claims the token server-side and this screen auto-enters
 * the app via the /api/auth/me poll. Manual paste stays as the fallback.
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

  // step 2 of registration: the Z.ai email verification code
  const [codeStep, setCodeStep] = useState(false)
  const [code, setCode] = useState('')

  // google / github bridge state
  const [bridgeRaw, setBridgeRaw] = useState('')
  const [bridgeBusy, setBridgeBusy] = useState(false)
  const [bridgeError, setBridgeError] = useState('')

  const codeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // warm the SDK so the first verification starts instantly
    preloadZaiCaptcha()
  }, [])

  // v6: the Google bridge finishes in ANOTHER tab/popup (bookmarklet →
  // /auth/google/catch → claim sets the session cookie). Poll /api/auth/me
  // so THIS screen auto-enters the app the moment that happens.
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' })
        if (res.ok) onAuthed()
      } catch { /* offline — keep polling */ }
    }, 2500)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        zai?: { linked?: boolean; needsCode?: boolean; code?: string; detail?: string }
      }
      if (!res.ok) {
        setError(data.error || `Ошибка ${res.status}`)
        setCaptchaParam('')
        setCaptchaToken((t) => t + 1)
        return
      }
      if (mode === 'register' && data.zai?.needsCode) {
        // Z.ai accepted the captcha and emailed the verification code —
        // finish the REAL account right here
        setCodeStep(true)
        setInfo(
          'Аккаунт создан. Z.ai отправил код подтверждения на твой email — введи его ниже, ' +
            'чтобы завершить создание настоящего аккаунта chat.z.ai (своя квота, без капчи в чате). ' +
            'Можно пропустить и подключить позже.',
        )
        setTimeout(() => codeRef.current?.focus(), 150)
        return
      }
      if (mode === 'register' && data.zai && !data.zai.linked && captchaParam) {
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

  const submitCode = async (skip = false) => {
    if (busy) return
    if (skip) {
      onAuthed()
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/auth/zai/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        zai?: { linked?: boolean }
      }
      if (!res.ok || !data.zai?.linked) {
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

  const resendCode = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/auth/zai/resend', { method: 'POST' })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) setError(data.error || `Ошибка ${res.status}`)
      else setInfo('Новый код отправлен на твой email.')
    } catch {
      setError('Сеть недоступна, попробуй ещё раз')
    } finally {
      setBusy(false)
    }
  }

  const claimGoogle = async () => {
    if (bridgeBusy) return
    setBridgeBusy(true)
    setBridgeError('')
    setError('')
    try {
      const res = await fetch('/api/auth/google/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: bridgeRaw, mode: 'login' }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setBridgeError(data.error || `Ошибка ${res.status}`)
        return
      }
      onAuthed()
    } catch {
      setBridgeError('Сеть недоступна, попробуй ещё раз')
    } finally {
      setBridgeBusy(false)
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
            настоящий аккаунт chat.z.ai</span>: Z.ai пришлёт на email код — после него этот email и
            пароль будут работать и на самом chat.z.ai, а все запросы пойдут{' '}
            <span className="font-medium text-amber-200">под твоим аккаунтом и на твою личную
            квоту</span>. Агент chat.z.ai в режиме «Агент» сам делает веб-поиск, генерацию
            изображений, работу с файлами и кодом. Это неофициальный клиент, не аффилированный с
            Z.ai.
          </p>
        </div>

        {/* form */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
          {codeStep ? (
            <>
              <p className="text-[13px] font-semibold text-zinc-200">Код из письма Z.ai</p>
              <p className="text-[12px] leading-relaxed text-zinc-500">
                Письмо отправил chat.z.ai на <span className="text-zinc-300">{email}</span>. Введи
                код подтверждения — аккаунт Z.ai станет твоим (как будто регистрировался у них).
              </p>
              <input
                ref={codeRef}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Код из письма"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm tracking-[0.3em] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-emerald-800"
              />
              {info && <p className="text-[12px] leading-relaxed text-amber-300">{info}</p>}
              {error && <p className="text-[12px] leading-relaxed text-red-400">{error}</p>}
              <Button
                onClick={() => void submitCode(false)}
                disabled={busy || !code}
                className="w-full bg-emerald-500/90 text-zinc-950 hover:bg-emerald-400 font-medium"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Подтвердить и войти
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => void resendCode()}
                  disabled={busy}
                  className="rounded-lg px-3 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200"
                >
                  Отправить код снова
                </button>
                <button
                  onClick={() => void submitCode(true)}
                  disabled={busy}
                  className="rounded-lg px-3 py-1.5 text-[12px] text-zinc-500 hover:text-zinc-300"
                >
                  Позже — войти сейчас
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-950 p-1">
                {(['register', 'login'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setMode(m)
                      setError('')
                      setInfo('')
                      setCaptchaParam('')
                    }}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
                      mode === m
                        ? 'bg-emerald-500/90 text-zinc-950'
                        : 'text-zinc-400 hover:text-zinc-200',
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

              {/* Z.ai's own auth captcha — OPTIONAL: starts the real Z.ai
                  account creation right here; skipping is fine */}
              {mode === 'register' && (
                <div className="space-y-1.5">
                  <p className="text-[11px] leading-relaxed text-zinc-600">
                    Капча Z.ai — запускает создание твоего аккаунта на их стороне (рекомендую, но
                    не обязательно: можно подключиться позже из приложения). Нажми на полоску,
                    иногда нужно перетащить ползунок на картинке.
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
            </>
          )}
        </div>

        {/* Google bridge — honest proxying of Z.ai's own Google auth */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-2.5">
          <p className="text-[13px] font-semibold text-zinc-200">Вход через Google — с автокопированием токена</p>
          <ol className="list-decimal space-y-0.5 pl-4 text-[11px] leading-relaxed text-zinc-500">
            <li>
              <span className="text-zinc-400">Один раз</span>: перетащи кнопку «⚡ Vebai — забрать
              токен» ниже на панель закладок браузера.
            </li>
            <li>
              Нажми «Google-вход chat.z.ai» — откроется настоящий Google-вход chat.z.ai (страница
              выбора аккаунта Google, твой Google-аккаунт, их OAuth).
            </li>
            <li>
              После входа нажми закладку <span className="text-zinc-400">⚡ Vebai</span> прямо на
              вкладке chat.z.ai — токен перебросится нам <span className="text-zinc-400">автоматически</span>,
              эта страница сама войдёт в приложение.
            </li>
            <li>Не хочешь закладку — просто вставь адрес из адресной строки chat.z.ai в поле ниже.</li>
          </ol>
          <div className="rounded-lg border border-dashed border-emerald-900/70 bg-emerald-950/20 p-2.5">
            <BookmarkletLink className="inline-block cursor-grab rounded-md border border-emerald-800/60 bg-zinc-950 px-3 py-1.5 text-[12px] font-semibold text-emerald-300 hover:border-emerald-500" />
            <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
              Перетащи кнопку на панель закладок (клик — скопирует код закладки). Работает один раз
              на каждый вход в Z.ai — дальше в один клик.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                window.open(
                  'https://chat.z.ai/oauth/google/login?t=2',
                  'zai_google',
                  'width=560,height=760',
                )
              }
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-[12px] font-medium text-zinc-200 hover:border-emerald-800 hover:text-emerald-300"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
                <path
                  fill="#4285F4"
                  d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l-.02.15 3.5 2.7.24.02c2.2-2 3.5-5 3.5-8.6z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.2 0 5.9-1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.2 0-5.9-2.1-6.8-5l-.14.01-3.1 2.4-.04.14C3.9 20.7 7.6 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.2 14.4c-.25-.7-.4-1.5-.4-2.4s.14-1.6.4-2.4l-.01-.16L2 7.1l-.1.08C.7 9.1 0 10.5 0 12s.7 2.9 1.9 4.8l3.3-2.4z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.6c2.3 0 3.8 1 4.7 1.8l3.4-3.3C18 1.2 15.2 0 12 0 7.6 0 3.9 3.3 1.9 7.2l3.3 2.5C6.1 6.7 8.8 4.6 12 4.6z"
                />
              </svg>
              Google-вход chat.z.ai
            </button>
            <button
              type="button"
              onClick={() =>
                window.open(
                  'https://chat.z.ai/oauth/github/login?t=2',
                  'zai_github',
                  'width=560,height=760',
                )
              }
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-[12px] font-medium text-zinc-200 hover:border-emerald-800 hover:text-emerald-300"
            >
              GitHub-вход
            </button>
          </div>
          <textarea
            value={bridgeRaw}
            onChange={(e) => setBridgeRaw(e.target.value)}
            onPaste={() => setTimeout(() => void claimGoogle(), 120)}
            rows={2}
            placeholder="Вставь сюда скопированный адрес chat.z.ai/auth#token=…"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-emerald-800"
          />
          {bridgeError && (
            <p className="text-[12px] leading-relaxed text-red-400">{bridgeError}</p>
          )}
          <Button
            onClick={() => void claimGoogle()}
            disabled={bridgeBusy || !bridgeRaw.trim()}
            variant="outline"
            className="w-full border-zinc-700 text-zinc-200 hover:bg-zinc-800 font-medium"
          >
            {bridgeBusy && <Loader2 className="h-4 w-4 animate-spin" />}
            Войти через Z.ai-аккаунт Google
          </Button>
          <p className="text-[11px] leading-relaxed text-zinc-600">
            Почему так: Z.ai отдаёт токен Google-входа только своим доменам (whitelist зашит у них
            в коде и в настройках OAuth у Google — проверено по байтам их фронтенда), поэтому
            полностью бесшовный перехват невозможен. Букмарклет сокращает ручной шаг до одного
            клика: он сам читает токен и перебрасывает нас.
          </p>
        </div>
      </div>
    </div>
  )
}
