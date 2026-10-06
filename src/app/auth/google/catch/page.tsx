'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, ShieldCheck, ShieldAlert, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Phase = 'working' | 'ok' | 'error' | 'empty'

/**
 * /auth/google/catch (v6) — the AUTOMATIC end of the Google bridge.
 *
 * The "⚡ Vebai — забрать токен" bookmarklet, clicked once on a logged-in
 * chat.z.ai tab, navigates the browser here with the Z.ai session token in
 * the URL fragment (`#token=…`). A plain navigation cannot be blocked by
 * CSP/CORS, needs no clipboard permissions and works in any desktop browser.
 *
 * Byte-verified research recap: chat.z.ai returns its Google-login JWT only
 * to its own whitelisted domains (sso_redirect whitelist is exact-hostname:
 * zread.ai / test.cgx.dev / z.ai / www.chatglm.site), so a 100% seamless
 * redirect is impossible — this one extra click is the shortest honest path.
 *
 * Behaviour:
 *   1. read the token from #hash (or ?query — both supported),
 *   2. detect mode: no Vebai session → 'login' (claim creates/enters the
 *      local account keyed by the Z.ai email), Vebai session present →
 *      'link' (attach to the CURRENT user),
 *   3. POST /api/auth/google/claim (live validation on chat.z.ai),
 *   4. popup flow (opened by the auth screen): close this window — the
 *      opener polls /api/auth/me and enters the app; standalone tab:
 *      redirect to '/'.
 */
export default function GoogleCatchPage() {
  const [phase, setPhase] = useState<Phase>('working')
  const [message, setMessage] = useState('Забираю токен из ссылки…')
  const [error, setError] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async () => {
    try {
      const hash = window.location.hash.replace(/^#/, '')
      const search = window.location.search.replace(/^\?/, '')
      const raw = (hash || search).slice(0, 8192)
      if (!raw || !/token=/i.test(raw)) {
        setPhase('empty')
        return
      }

      // mode detection: this browser already has a Vebai session?
      let mode: 'login' | 'link' = 'login'
      try {
        const me = await fetch('/api/auth/me', { cache: 'no-store' })
        if (me.ok) mode = 'link'
      } catch { /* keep 'login' */ }

      const res = await fetch('/api/auth/google/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw, mode }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        zaiEmail?: string
        created?: boolean
      }
      if (!res.ok) {
        setError(data.error || `Ошибка ${res.status}`)
        setPhase('error')
        return
      }
      setMessage(
        mode === 'link'
          ? `Аккаунт Z.ai подключён${data.zaiEmail ? ` (${data.zaiEmail})` : ''} — работаем на твоей квоте.`
          : `Вход выполнен${data.zaiEmail ? ` как ${data.zaiEmail}` : ''}.${data.created ? ' Аккаунт создан автоматически.' : ''}`,
      )
      setPhase('ok')
      // popup flow: close and let the opener's poll take over; a standalone
      // tab (bookmarklet in a normal tab) just goes home
      setTimeout(() => {
        try {
          if (window.opener && !window.opener.closed) {
            window.close()
            setTimeout(() => {
              if (!window.closed) window.location.replace('/')
            }, 800)
            return
          }
        } catch { /* fall through to home */ }
        window.location.replace('/')
      }, 1200)
    } catch {
      setError('Сеть недоступна, попробуй ещё раз')
      setPhase('error')
    }
  }

  const openZaiGoogle = () =>
    window.open('https://chat.z.ai/oauth/google/login?t=2', 'zai_google', 'width=560,height=760')

  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-950 px-4 py-10">
      <div className="w-full max-w-md space-y-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-800/40">
            <Sparkles className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 leading-tight">
              {phase === 'ok' ? 'Готово' : phase === 'error' ? 'Не получилось' : 'Мост Google → Vebai'}
            </h1>
            <p className="text-xs text-zinc-500 leading-tight">автоматический перенос токена Z.ai</p>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-3">
          {phase === 'working' && (
            <p className="flex items-center gap-2 text-[13px] text-zinc-300">
              <Loader2 className="h-4 w-4 animate-spin text-emerald-400" /> {message}
            </p>
          )}

          {phase === 'ok' && (
            <>
              <p className="flex items-start gap-2 text-[13px] leading-relaxed text-emerald-400">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> {message}
              </p>
              <p className="text-[12px] text-zinc-500">Сейчас перебросим тебя в приложение…</p>
            </>
          )}

          {phase === 'empty' && (
            <>
              <p className="flex items-start gap-2 text-[13px] leading-relaxed text-amber-300">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                В ссылке нет токена. Открой chat.z.ai, войди (например через Google), затем нажми
                закладку <span className="font-semibold">⚡ Vebai — забрать токен</span> прямо на
                их странице — она сама перебросит тебя сюда с токеном.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  onClick={openZaiGoogle}
                  className="bg-emerald-500/90 text-zinc-950 hover:bg-emerald-400 font-medium"
                >
                  Открыть Google-вход Z.ai
                </Button>
                <Button asChild variant="outline" className="border-zinc-700 text-zinc-200 hover:bg-zinc-800">
                  <Link href="/">На главную</Link>
                </Button>
              </div>
            </>
          )}

          {phase === 'error' && (
            <>
              <p className="flex items-start gap-2 text-[13px] leading-relaxed text-red-400">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  onClick={() => void run()}
                  className="bg-emerald-500/90 text-zinc-950 hover:bg-emerald-400 font-medium"
                >
                  Попробовать снова
                </Button>
                <Button
                  onClick={openZaiGoogle}
                  variant="outline"
                  className="border-zinc-700 text-zinc-200 hover:bg-zinc-800"
                >
                  Залогиниться в Z.ai заново
                </Button>
                <Button asChild variant="ghost" className="text-zinc-400 hover:text-zinc-200">
                  <Link href="/">На главную</Link>
                </Button>
              </div>
            </>
          )}
        </div>

        <p className="text-[11px] leading-relaxed text-zinc-600">
          Токен проверяется напрямую на chat.z.ai и сохраняется только в твоём аккаунте Vebai —
          запросы к агенту пойдут под твоим аккаунтом Z.ai и на твою личную квоту.
        </p>
      </div>
    </div>
  )
}
