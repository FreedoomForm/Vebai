'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, ShieldAlert, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ZaiAuthCaptcha, preloadZaiCaptcha } from './zai-captcha'
import { BookmarkletLink } from './bookmarklet'

/**
 * Landing / auth gate (v7) — z.ai-style welcome card (our own design).
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
 * GOOGLE (bridge, v6): byte-level research proved chat.z.ai only returns
 * its Google-login session to its own whitelisted domains (the sso_redirect
 * whitelist is exact-hostname and we are not on it), so no 100% seamless
 * redirect exists. Our button opens Z.ai's REAL Google login (popup) and the
 * "⚡ Vebai — забрать токен" bookmarklet — one click on the logged-in
 * chat.z.ai tab — navigates the browser to /auth/google/catch#token=… (plain
 * navigation: no CSP/CORS can block it); the catch page claims the token
 * server-side and this screen auto-enters the app via the /api/auth/me poll.
 * Manual paste stays as the fallback.
 */
export function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [emailOpen, setEmailOpen] = useState(false)
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

  const openZaiSso = (provider: 'google' | 'github') => {
    window.open(
      `https://chat.z.ai/oauth/${provider}/login?t=2`,
      `zai_${provider}`,
      'width=560,height=760',
    )
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-50 px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        {/* welcome card (z.ai-style) */}
        <div className="rounded-3xl border border-stone-200/80 bg-white p-7 shadow-[0_16px_48px_rgba(28,25,23,0.07)]">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-stone-900">
              <Sparkles className="h-7 w-7 text-white" />
            </div>
            <h1 className="font-display mt-4 text-2xl text-stone-900">Добро пожаловать в Vebai</h1>
            <p className="mt-1 text-[13px] text-stone-500">
              Открой все возможности — вход за пару секунд
            </p>
          </div>

          {codeStep ? (
            <div className="mt-6 space-y-4">
              <p className="text-[13px] font-semibold text-stone-800">Код из письма Z.ai</p>
              <p className="text-[12px] leading-relaxed text-stone-500">
                Письмо отправил chat.z.ai на <span className="text-stone-700">{email}</span>. Введи
                код подтверждения — аккаунт Z.ai станет твоим (как будто регистрировался у них).
              </p>
              <input
                ref={codeRef}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Код из письма"
                className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm tracking-[0.3em] text-stone-800 placeholder:text-stone-400 outline-none focus:border-stone-400"
              />
              {info && <p className="text-[12px] leading-relaxed text-amber-600">{info}</p>}
              {error && <p className="text-[12px] leading-relaxed text-red-500">{error}</p>}
              <Button
                onClick={() => void submitCode(false)}
                disabled={busy || !code}
                className="w-full rounded-xl bg-stone-900 text-white hover:bg-stone-700 font-medium"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Подтвердить и войти
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => void resendCode()}
                  disabled={busy}
                  className="rounded-xl px-3 py-1.5 text-[12px] text-stone-500 hover:text-stone-800"
                >
                  Отправить код снова
                </button>
                <button
                  onClick={() => void submitCode(true)}
                  disabled={busy}
                  className="rounded-xl px-3 py-1.5 text-[12px] text-stone-400 hover:text-stone-600"
                >
                  Позже — войти сейчас
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-6 space-y-3">
              {/* dark Google button first — z.ai order */}
              <button
                type="button"
                onClick={() => openZaiSso('google')}
                className="flex w-full items-center justify-center gap-2.5 rounded-xl bg-gradient-to-b from-stone-800 to-stone-950 px-4 py-3 text-[14px] font-medium text-white shadow-md transition-all hover:from-stone-700 hover:to-stone-900 hover:shadow-lg"
              >
                <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" aria-hidden>
                  <path
                    fill="#EA4335"
                    d="M12 10.2v3.9h5.5c-.25 1.3-1.66 3.8-5.5 3.8-3.32 0-6.03-2.74-6.03-6.1S8.68 5.7 12 5.7c1.9 0 3.16.8 3.88 1.5l2.65-2.55C16.83 3 14.62 2 12 2 6.98 2 2.9 6.03 2.9 12S6.98 22 12 22c5.77 0 9.6-4.05 9.6-9.75 0-.66-.07-1.16-.16-1.66H12z"
                    transform="translate(0 .5) scale(.98)"
                  />
                </svg>
                Продолжить с Google
              </button>

              <div className="flex items-center gap-3 py-1">
                <div className="h-px flex-1 bg-stone-200" />
                <span className="text-[11px] text-stone-400">или</span>
                <div className="h-px flex-1 bg-stone-200" />
              </div>

              <button
                type="button"
                onClick={() => setEmailOpen((v) => !v)}
                className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-[14px] font-medium text-stone-800 transition-colors hover:bg-stone-100"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-stone-500" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m3 7 9 6 9-6" />
                </svg>
                Продолжить с Email
              </button>

              {emailOpen && (
                <div className="space-y-3 rounded-2xl border border-stone-200 bg-stone-50/60 p-4">
                  <div className="grid grid-cols-2 gap-1 rounded-xl bg-white p-1 border border-stone-200">
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
                          'rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors',
                          mode === m
                            ? 'bg-stone-900 text-white'
                            : 'text-stone-500 hover:text-stone-800',
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

                  {/* Z.ai's own auth captcha — OPTIONAL: starts the real Z.ai
                      account creation right here; skipping is fine */}
                  {mode === 'register' && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] leading-relaxed text-stone-500">
                        Капча Z.ai — запускает создание твоего аккаунта на их стороне (рекомендую,
                        но не обязательно: можно подключиться позже из приложения).
                      </p>
                      <ZaiAuthCaptcha onParam={onWidgetParam} token={captchaToken} />
                    </div>
                  )}

                  {info && <p className="text-[12px] leading-relaxed text-amber-600">{info}</p>}
                  {error && <p className="text-[12px] leading-relaxed text-red-500">{error}</p>}

                  <Button
                    onClick={() => void submit()}
                    disabled={busy || !email || !password}
                    className="w-full rounded-xl bg-stone-900 text-white hover:bg-stone-700 font-medium"
                  >
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                    {mode === 'register' ? 'Создать аккаунт' : 'Войти'}
                  </Button>

                  <p className="text-[11px] leading-relaxed text-stone-400">
                    Диалоги привязаны к аккаунту. Фоновые задачи продолжают выполняться после
                    закрытия браузера, результаты появятся в чате.
                  </p>
                </div>
              )}

              {/* GitHub — secondary, like z.ai */}
              <button
                type="button"
                onClick={() => openZaiSso('github')}
                className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-[13px] font-medium text-stone-600 transition-colors hover:bg-stone-50"
              >
                GitHub-вход Z.ai
              </button>
            </div>
          )}
        </div>

        {/* transparency note */}
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-2 text-amber-800">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-[11.5px] leading-relaxed text-amber-800/90">
              Прозрачный прокси к Z.ai: регистрация мгновенная. Кнопка Google открывает{' '}
              <span className="font-medium">настоящий Google-вход chat.z.ai</span>; капча Z.ai (их
              же виджет Aliyun) нужна только чтобы создать твой настоящий аккаунт chat.z.ai — все
              запросы пойдут под твоим аккаунтом и на твою личную квоту. Неофициальный клиент, не
              аффилирован с Z.ai.
            </p>
          </div>
        </div>

        {/* Google bridge — the honest one-click token handoff */}
        <div className="rounded-2xl border border-stone-200 bg-white p-4 space-y-2.5">
          <p className="text-[13px] font-semibold text-stone-800">Автокопирование токена — 1 клик</p>
          <ol className="list-decimal space-y-0.5 pl-4 text-[11px] leading-relaxed text-stone-500">
            <li>
              <span className="text-stone-700">Один раз</span>: перетащи кнопку «⚡ Vebai — забрать
              токен» ниже на панель закладок браузера.
            </li>
            <li>Нажми «Продолжить с Google» выше и войди своим Google-аккаунтом.</li>
            <li>
              На вкладке chat.z.ai нажми закладку <span className="text-stone-700">⚡ Vebai</span> —
              токен перебросится нам <span className="text-stone-700">автоматически</span>, и эта
              страница сама войдёт в приложение.
            </li>
            <li>Не хочешь закладку — просто вставь адрес из адресной строки chat.z.ai в поле ниже.</li>
          </ol>
          <div className="rounded-xl border border-dashed border-stone-300 bg-stone-50 p-2.5">
            <BookmarkletLink className="inline-block cursor-grab rounded-md border border-stone-300 bg-white px-3 py-1.5 text-[12px] font-semibold text-stone-800 hover:border-stone-500" />
            <p className="mt-1 text-[10px] leading-relaxed text-stone-400">
              Перетащи кнопку на панель закладок (клик — скопирует код закладки). Работает один раз
              на каждый вход в Z.ai — дальше в один клик.
            </p>
          </div>
          <textarea
            value={bridgeRaw}
            onChange={(e) => setBridgeRaw(e.target.value)}
            onPaste={() => setTimeout(() => void claimGoogle(), 120)}
            rows={2}
            placeholder="Вставь сюда скопированный адрес chat.z.ai/auth#token=…"
            className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-[12px] text-stone-800 placeholder:text-stone-400 outline-none focus:border-stone-400"
          />
          {bridgeError && (
            <p className="text-[12px] leading-relaxed text-red-500">{bridgeError}</p>
          )}
          <Button
            onClick={() => void claimGoogle()}
            disabled={bridgeBusy || !bridgeRaw.trim()}
            variant="outline"
            className="w-full rounded-xl border-stone-300 text-stone-800 hover:bg-stone-100 font-medium"
          >
            {bridgeBusy && <Loader2 className="h-4 w-4 animate-spin" />}
            Войти через Z.ai-аккаунт Google
          </Button>
          <p className="text-[10.5px] leading-relaxed text-stone-400">
            Почему так: Z.ai отдаёт токен Google-входа только своим доменам (whitelist зашит у них
            в коде и в настройках OAuth у Google — проверено по их фронтенду), поэтому полностью
            бесшовный перехват невозможен. Букмарклет сокращает ручной шаг до одного клика.
          </p>
        </div>
      </div>
    </div>
  )
}
