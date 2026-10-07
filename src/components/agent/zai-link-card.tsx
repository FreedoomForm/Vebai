'use client'

import { useState } from 'react'
import { ClipboardCopy, Loader2, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { BookmarkletLink } from './bookmarklet'

/**
 * "Подключить аккаунт Z.ai" card (v11).
 *
 * Byte-level live probes settled it: Aliyun binds every captcha solve to the
 * domains registered in chat.z.ai's scene config — a param solved on any
 * foreign domain (ours included) is ALWAYS rejected by their backend with
 * "The captcha verification failed", no matter how green the widget was.
 * So this card no longer embeds a doomed captcha and instead:
 *
 *  1. CREATE: copies the email and opens chat.z.ai/auth — the account is
 *     created on THEIR page (their captcha, their domain — the same flow
 *     their own users get), then connected here via the token bridge.
 *  2. BRIDGE (no captcha): the user logs in on chat.z.ai (Google/GitHub/
 *     email — anything) and either clicks the ⚡ bookmarklet on that tab or
 *     pastes the address — the #hash / token is validated live via
 *     /api/auth/google/claim (mode=link) and attached to this user.
 */

const ZAI_AUTH_URL = 'https://chat.z.ai/auth'

export function ZaiLinkCard({
  defaultEmail,
  onLinked,
  reason,
}: {
  defaultEmail: string
  onLinked: () => void
  /** why the card opened (e.g. "session expired") */
  reason?: string
}) {
  const [busy, setBusy] = useState<'claim' | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')

  const [bridgeRaw, setBridgeRaw] = useState('')

  /** Copy the email + open Z.ai's own signup page. */
  const openZaiSignup = async () => {
    try {
      await navigator.clipboard.writeText(`Email: ${defaultEmail}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 4000)
    } catch { /* clipboard denied — the email stays visible above */ }
    window.open(ZAI_AUTH_URL, 'zai_signup', 'width=1180,height=900')
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
      setOk('Готово — твой аккаунт Z.ai подключён, работаем на твоей квоте.')
      onLinked()
    } catch {
      setError('Сеть недоступна, попробуй ещё раз')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      {reason && <p className="text-[12px] leading-relaxed text-amber-600">{reason}</p>}
      <p className="text-[12px] leading-relaxed text-stone-500">
        Чат работает только с подключённым аккаунтом: <span className="text-stone-800">свой
        настоящий аккаунт chat.z.ai</span> — это твоя личная квота Z.ai, без капчи на каждое
        сообщение. Капча Z.ai принимается только на их домене, поэтому аккаунт создаётся на их
        странице и подключается сюда за один клик.
      </p>

      {/* CREATE — on Z.ai's own page */}
      <div className="space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-3">
        <p className="text-[11px] leading-relaxed text-stone-500">
          1. Создай аккаунт на их странице (email{' '}
          <span className="text-stone-700">{defaultEmail}</span> скопируем автоматически; пароль
          придумай любой — он нужен только Z.ai).
        </p>
        <Button
          onClick={() => void openZaiSignup()}
          className="w-full bg-stone-900 text-white hover:bg-stone-700 font-medium"
        >
          <ClipboardCopy className="mr-2 h-4 w-4" />
          {copied ? 'Email скопирован — открываю Z.ai…' : 'Создать аккаунт на Z.ai'}
        </Button>
        <p className="text-[11px] leading-relaxed text-stone-500">
          2. Пройди их капчу, введи код из письма — и нажми закладку ⚡ на вкладке chat.z.ai (или
          вставь адрес ниже). Аккаунт подключится сюда автоматически.
        </p>
      </div>

      {/* BRIDGE — paste / bookmarklet / SSO popups */}
      <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 space-y-2">
        <div className="rounded-lg border border-dashed border-stone-300 bg-white p-2.5">
          <BookmarkletLink className="inline-block cursor-grab rounded-md border border-stone-300 bg-stone-50 px-2.5 py-1 text-[11px] font-semibold text-stone-800 hover:border-stone-500" />
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
            className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-[11px] font-medium text-stone-700 hover:border-stone-500"
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
            className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-[11px] font-medium text-stone-700 hover:border-stone-500"
          >
            GitHub-вход
          </button>
        </div>
        <textarea
          value={bridgeRaw}
          onChange={(e) => setBridgeRaw(e.target.value)}
          onPaste={() => setTimeout(() => void claimBridge(), 120)}
          rows={2}
          placeholder="Вставь сюда адрес chat.z.ai/auth#token=… или сам токен"
          className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-[12px] text-stone-800 placeholder:text-stone-400 outline-none focus:border-stone-400"
        />
        <Button
          onClick={() => void claimBridge()}
          disabled={busy !== null || !bridgeRaw.trim()}
          variant="outline"
          className={cn('w-full border-stone-300 text-stone-800 hover:bg-stone-100')}
        >
          {busy === 'claim' && <Loader2 className="h-4 w-4 animate-spin" />}
          Подключить
        </Button>
      </div>

      {ok && (
        <p className="flex items-start gap-1.5 text-[12px] text-emerald-600">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {ok}
        </p>
      )}
      {error && <p className="text-[12px] leading-relaxed text-red-500">{error}</p>}

      {/* guest mode is removed — the account link is required, no dismiss */}
    </div>
  )
}
