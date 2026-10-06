'use client'

import { useState } from 'react'
import { ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ZaiAuthCaptcha } from './zai-captcha'

/**
 * "Подключить аккаунт Z.ai" card (v4).
 *
 * Attaches the user's OWN chat.z.ai account to their profile: their email +
 * password + one Z.ai captcha solve (mode signup = create the account, mode
 * signin = use an existing one). On success every AI request runs on their
 * own Z.ai quota with no per-message captcha.
 *
 * Also carries the honest Google note: chat.z.ai's own Google login works on
 * THEIR page, but they only hand the session token back to their own
 * whitelisted domains — so Google users connect here via email+password.
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
  const [busy, setBusy] = useState<'signup' | 'signin' | null>(null)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')

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
        zai?: { linked?: boolean }
      }
      if (!res.ok || !data.zai?.linked) {
        setError(data.error || `Ошибка ${res.status}`)
        // one-time param is consumed — require a fresh solve
        setParam('')
        setWidgetToken((t) => t + 1)
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

  return (
    <div className="space-y-3">
      {reason && <p className="text-[12px] leading-relaxed text-amber-300/90">{reason}</p>}
      <p className="text-[12px] leading-relaxed text-zinc-400">
        Подключи <span className="text-zinc-200">свой настоящий аккаунт chat.z.ai</span> — он же
        даёт личную квоту Z.ai. Этот email и пароль будут работать и на самом chat.z.ai.
      </p>

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
        <p className="flex items-center gap-1.5 text-[12px] text-emerald-400">
          <ShieldCheck className="h-3.5 w-3.5" /> {ok}
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

      {/* honest Google bridge */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-1.5">
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Аккаунт Z.ai создан через Google? Открой chat.z.ai, задай пароль в настройках профиля
          (Профиль → Пароль), затем вернись и нажми «У меня есть Z.ai» с этим email — свяжем
          автоматически.
        </p>
        <a
          href="https://chat.z.ai/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-400 hover:text-emerald-300"
        >
          <ExternalLink className="h-3 w-3" />
          Открыть chat.z.ai (вход через Google работает там)
        </a>
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
