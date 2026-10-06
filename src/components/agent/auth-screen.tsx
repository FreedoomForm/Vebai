'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, ShieldAlert, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ZaiAuthCaptcha, preloadZaiCaptcha } from './zai-captcha'

/**
 * Landing / auth gate.
 *
 * REGISTRATION creates the user's OWN REAL chat.z.ai account (their email +
 * password work on chat.z.ai too) behind Z.ai's own auth-scene captcha — the
 * very Aliyun widget embedded on chat.z.ai's signup page. The resulting JWT
 * lives on the user's row server-side; their AI traffic consumes THEIR OWN
 * Z.ai quota, with no per-message captcha (that gate only hits guests).
 *
 * LOGIN needs Z.ai's captcha only when the stored session expired — the
 * widget appears on demand (same scene as chat.z.ai's login page).
 */
export function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  // captcha param produced by the embedded auth-scene widget (register mode)
  const [captchaParam, setCaptchaParam] = useState('')
  const [captchaToken, setCaptchaToken] = useState(0) // force widget re-init
  const [captchaNeeded, setCaptchaNeeded] = useState(false) // login step 2
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  useEffect(() => {
    // warm the SDK so the first verification starts instantly
    preloadZaiCaptcha()
  }, [])

  const submit = async (overrideParam?: string) => {
    if (busy) return
    const param = overrideParam ?? captchaParam
    if (mode === 'register' && !param) {
      setError('Сначала пройди проверку Z.ai под формой')
      return
    }
    setBusy(true)
    setError('')
    setInfo('')
    try {
      const body =
        mode === 'register'
          ? { email, password, name, zaiCaptchaParam: param }
          : { email, password, zaiCaptchaParam: param || undefined }
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        code?: string
      }
      if (!res.ok) {
        setError(data.error || `Ошибка ${res.status}`)
        // one-time param consumed — a fresh verification is required
        setCaptchaParam('')
        setCaptchaToken((t) => t + 1)
        if (data.code === 'zai_captcha_required') {
          setCaptchaNeeded(true)
          setInfo('Z.ai просит подтвердить вход — пройди капчу под формой и нажми «Войти» ещё раз')
        }
        return
      }
      onAuthed()
    } catch {
      setError('Сеть недоступна, попробуй ещё раз')
    } finally {
      setBusy(false)
    }
  }

  const onWidgetParam = useCallback(
    (param: string) => {
      setCaptchaParam(param)
      setError('')
      // login flow: the param arrived AFTER the first submit — finish it now
      if (mode === 'login' && email && password && busy === false) {
        void submit(param)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, email, password, busy, captchaParam],
  )

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
            Регистрация создаёт <span className="font-medium text-amber-200">твой настоящий аккаунт chat.z.ai</span> —
            этот email и пароль работают и на самом chat.z.ai. Капча Z.ai (тот же виджет Aliyun, что у них)
            нужна только при регистрации и входе. Все запросы к ИИ выполняет агент chat.z.ai (Z.ai) с его
            поиском и инструментами — <span className="font-medium text-amber-200">под твоим аккаунтом и на твою
            личную квоту Z.ai</span>. Никакие токены у тебя не запрашиваются. Это неофициальный клиент,
            не аффилированный с Z.ai.
          </p>
        </div>

        {/* form */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-950 p-1">
            {(['register', 'login'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(''); setInfo(''); setCaptchaParam(''); setCaptchaNeeded(false) }}
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

          {/* Z.ai's own auth captcha — always visible on register; on demand
              on login (when the stored Z.ai session expired) */}
          {(mode === 'register' || captchaNeeded) && (
            <div className="space-y-1.5">
              <p className="text-[11px] leading-relaxed text-zinc-600">
                Официальная капча Z.ai (Aliyun) — та же, что на chat.z.ai: нажми на полоску,
                иногда нужно перетащить ползунок на картинке.
              </p>
              <ZaiAuthCaptcha onParam={onWidgetParam} token={captchaToken} />
            </div>
          )}

          {info && <p className="text-[12px] text-emerald-400">{info}</p>}
          {error && <p className="text-[12px] text-red-400">{error}</p>}

          <Button
            onClick={() => void submit()}
            disabled={busy || !email || !password || (mode === 'register' && !captchaParam)}
            className="w-full bg-emerald-500/90 text-zinc-950 hover:bg-emerald-400 font-medium"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === 'register' ? 'Создать аккаунт Z.ai' : 'Войти'}
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
