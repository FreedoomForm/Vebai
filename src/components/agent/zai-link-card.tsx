'use client'

import { useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ZaiAuthCaptcha } from './zai-captcha'

/**
 * "Подключить аккаунт Z.ai" card (v5).
 *
 * Three ways to attach the user's OWN chat.z.ai account:
 *  1. SIGNUP (captcha → Z.ai emails a code → code step → finish_signup):
 *     creates a real account; the code step completes via /api/auth/zai/verify.
 *  2. SIGNIN (captcha → immediate JWT): an existing Z.ai account.
 *  3. GOOGLE/GITHUB BRIDGE (no captcha): the user logs in on chat.z.ai with
 *     their Google/GitHub account and pastes the address of the page they
 *     land on — its #hash carries the session token. We validate it live
 *     via /api/auth/google/claim (mode=link) and attach it.
 */
export function ZaiLinkCard({
  defaultEmail,
  onLinked,
  onDismiss,
  reason,
}: {
  defaultEmail: string
  onLinked: () => void
  onDismiss?: () => void
  /** why the card opened (e.g. "session expired") */
  reason?: string
}) {
  const [email, setEmail] = useState(defaultEmail)
  const [password, setPassword] = useState('')
  const [param, setParam] = useState('')
  const [widgetToken, setWidgetToken] = useState(0)
  const [busy, setBusy] = useState<'signup' | 'signin' | 'code' | 'claim' | null>(null)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')

  // step 2 of signup: the emailed Z.ai code
  const [codeStep, setCodeStep] = useState(false)
  const [code, setCode] = useState('')

  // google/github bridge
  const [bridgeRaw, setBridgeRaw] = useState('')
  const [bridgeOpen, setBridgeOpen] = useState(false)

  const submit = async (mode: 'signup' | 'signin') => {
    if (busy) return
    if (!param) {
      setError('Сначала пройди проверку Z.ai (зелёная галочка в виджете)')
      return
    }
    setBusy(mode)
    setError('')
    setOk('')
    try {
      const res = await fetch('/api/auth/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, mode, zaiCaptchaParam: param }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        code?: string
        zai?: { linked?: boolean; needsCode?: boolean }
      }
      if (!res.ok) {
        setError(data.error || `Ошибка ${res.status}`)
        setParam('')
        setWidgetToken((t) => t + 1)
        return
      }
      if (mode === 'signup' && data.zai?.needsCode) {
        setCodeStep(true)
        setOk('Z.ai отправил код на этот email — введи его, чтобы завершить создание аккаунта.')
        return
      }
      setOk('Готово — твой аккаунт Z.ai подключён, работаем на твоей квоте.')
      setParam('')
      onLinked()
    } catch {
      setError('Сеть недоступна, попробуй ещё раз')
    } finally {
      setBusy(null)
    }
  }

  const submitCode = async () => {
    if (busy) return
    setBusy('code')
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
      setOk('Готово — аккаунт Z.ai создан и подключён!')
      onLinked()
    } catch {
      setError('Сеть недоступна, попробуй ещё раз')
    } finally {
      setBusy(null)
    }
  }

  const claimBridge = async () => {
    if (busy) return
    setBusy('claim')
    setError('')
    try {
      const res = await fetch('/api/auth/google/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: bridgeRaw, mode: 'link' }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(data.error || `Ошибка ${res.status}`)
        return
      }
      setOk('Готово — Z.ai-сессия из Google/GitHub подключена!')
      onLinked()
    } catch {
      setError('Сеть недоступна, попробуй ещё раз')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      {reason && <p className="text-[12px] leading-relaxed text-amber-300/90">{reason}</p>}
      <p className="text-[12px] leading-relaxed text-zinc-400">
        Подключи <span className="text-zinc-200">свой настоящий аккаунт chat.z.ai</span> — он же
        даёт личную квоту Z.ai. Этот email и пароль будут работать и на самом chat.z.ai.
      </p>

      {codeStep ? (
        <>
          <p className="text-[12px] leading-relaxed text-zinc-500">
            Код отправлен на <span className="text-zinc-300">{email}</span>. Введи его — аккаунт
            Z.ai будет завершён (verify + finish на их стороне).
          </p>
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            placeholder="Код из письма Z.ai"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm tracking-[0.3em] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-emerald-800"
          />
          {ok && (
            <p className="text-[12px] leading-relaxed text-emerald-400">{ok}</p>
          )}
          {error && <p className="text-[12px] leading-relaxed text-red-400">{error}</p>}
          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={() => void submitCode()}
              disabled={busy !== null || !code}
              className="bg-emerald-500/90 text-zinc-950 hover:bg-emerald-400 font-medium"
            >
              {busy === 'code' && <Loader2 className="h-4 w-4 animate-spin" />}
              Подтвердить
            </Button>
            <Button
              onClick={() => {
                setCodeStep(false)
                setError('')
              }}
              variant="outline"
              className="border-zinc-700 text-zinc-200 hover:bg-zinc-800"
            >
              Назад
            </Button>
          </div>
        </>
      ) : (
        <>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            placeholder="Email (какой использовать на Z.ai)"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-emerald-800"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="new-password"
            placeholder="Пароль для Z.ai (мин. 6 символов)"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-emerald-800"
          />

          <div className="space-y-1">
            <p className="text-[11px] leading-relaxed text-zinc-600">
              Официальная капча Z.ai (Aliyun) — нажми на полоску, иногда нужно собрать картинку.
            </p>
            <ZaiAuthCaptcha onParam={setParam} token={widgetToken} />
          </div>

          {ok && (
            <p className="flex items-start gap-1.5 text-[12px] text-emerald-400">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {ok}
            </p>
          )}
          {error && <p className="text-[12px] leading-relaxed text-red-400">{error}</p>}

          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={() => void submit('signup')}
              disabled={busy !== null || !email || !password || !param}
              className="bg-emerald-500/90 text-zinc-950 hover:bg-emerald-400 font-medium"
            >
              {busy === 'signup' && <Loader2 className="h-4 w-4 animate-spin" />}
              Создать аккаунт
            </Button>
            <Button
              onClick={() => void submit('signin')}
              disabled={busy !== null || !email || !password || !param}
              variant="outline"
              className={cn('border-zinc-700 text-zinc-200 hover:bg-zinc-800')}
            >
              {busy === 'signin' && <Loader2 className="h-4 w-4 animate-spin" />}
              У меня есть Z.ai
            </Button>
          </div>
        </>
      )}

      {/* Google / GitHub bridge — paste the address that carries the token */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-2">
        <button
          onClick={() => setBridgeOpen((v) => !v)}
          className="text-left text-[11px] font-semibold leading-relaxed text-zinc-400 hover:text-zinc-200"
        >
          Аккаунт Z.ai через Google / GitHub? {bridgeOpen ? 'Скрыть' : 'Показать мост'}
        </button>
        {bridgeOpen && (
          <>
            <p className="text-[11px] leading-relaxed text-zinc-500">
              Открой настоящий Google-вход chat.z.ai (кнопка ниже), войди, затем скопируй адрес из
              адресной строки (<code className="text-[10px]">chat.z.ai/auth#token=…</code>) и
              вставь сюда — подключим автоматически.
            </p>
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
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:border-emerald-800 hover:text-emerald-300"
              >
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
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:border-emerald-800 hover:text-emerald-300"
              >
                GitHub-вход
              </button>
            </div>
            <textarea
              value={bridgeRaw}
              onChange={(e) => setBridgeRaw(e.target.value)}
              onPaste={() => setTimeout(() => void claimBridge(), 120)}
              rows={2}
              placeholder="Вставь сюда адрес chat.z.ai/auth#token=…"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-emerald-800"
            />
            <Button
              onClick={() => void claimBridge()}
              disabled={busy !== null || !bridgeRaw.trim()}
              variant="outline"
              className="w-full border-zinc-700 text-zinc-200 hover:bg-zinc-800"
            >
              {busy === 'claim' && <Loader2 className="h-4 w-4 animate-spin" />}
              Подключить
            </Button>
          </>
        )}
      </div>

      {onDismiss && (
        <button
          onClick={onDismiss}
          className="w-full rounded-lg px-3 py-1.5 text-[12px] text-zinc-500 hover:text-zinc-300"
        >
          Позже — продолжить в гостевом режиме (своя квота подключится позже)
        </button>
      )}
    </div>
  )
}
