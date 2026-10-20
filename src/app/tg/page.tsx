'use client'

import { useEffect, useState } from 'react'

/**
 * Telegram Mini App entry point. Telegram opens this page inside its client
 * with window.Telegram.WebApp.initData signed by the bot token. We POST it to
 * /api/auth/telegram: the server verifies the signature, auto-registers/logs
 * the user in, binds the bot conversation (task & file history) to the account
 * and sets the session cookie. Then we land the user in the app root - their
 * account with all conversations, tasks and files.
 *
 * Robustness notes (fixed after "mini app lands on the registration page"):
 * - Telegram Web (browser) runs mini apps inside an iframe and only provides
 *   window.Telegram.WebApp through the official bridge script, which MUST be
 *   loaded by the page. Native clients inject it themselves, but loading the
 *   script is the documented requirement for all clients - without it some
 *   clients see no WebApp at all and initData is empty.
 * - Some clients populate initData a tick after load, so we poll briefly
 *   instead of reading it once.
 * - If we are clearly inside Telegram but got no signed data, we show an
 *   explicit error instead of silently bouncing to '/' (which displayed the
 *   registration screen and looked like "auto-login is broken").
 * - After a successful auth we verify the session cookie actually sticks:
 *   Telegram Web in browsers with third-party cookies fully blocked (e.g.
 *   Safari) cannot keep the cookie in the iframe - the user gets a clear
 *   explanation instead of the registration page again.
 */
export default function TelegramMiniAppPage() {
  const [state, setState] = useState<'working' | 'error'>('working')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    interface TgWebApp {
      initData?: string
      platform?: string
      version?: string
      ready?: () => void
      expand?: () => void
    }
    const getWebApp = (): TgWebApp | undefined =>
      (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    function loadBridge(): Promise<void> {
      return new Promise((resolve) => {
        if (getWebApp()) return resolve()
        const s = document.createElement('script')
        s.src = 'https://telegram.org/js/telegram-web-app.js'
        s.async = true
        s.onload = () => resolve()
        s.onerror = () => resolve()
        document.head.appendChild(s)
        setTimeout(resolve, 3000) // hard cap in case onload never fires
      })
    }

    async function handshake() {
      await loadBridge()
      const tg = getWebApp()
      try {
        tg?.ready?.()
        tg?.expand?.()
      } catch { /* not in telegram */ }

      // poll: several clients fill initData slightly after page load
      let initData = tg?.initData || ''
      const deadline = Date.now() + 2500
      while (!initData && Date.now() < deadline) {
        await sleep(200)
        initData = tg?.initData || ''
      }
      if (cancelled) return

      if (!initData) {
        const platform = tg?.platform || ''
        if (platform && platform !== 'unknown') {
          // we ARE inside Telegram, but there is no signed payload - do not
          // bounce to '/' (that is what produced the registration screen)
          setState('error')
          setError(
            'Telegram не передал данные входа. Открой мини-апп из чата с ботом @ozodbekartificialintelegencebot: кнопка меню 🌐 Vebai или команда /app.',
          )
          return
        }
        // opened outside Telegram (normal browser): if the visitor already has
        // a session cookie, the root app shows the account right away
        window.location.replace('/')
        return
      }

      try {
        const res = await fetch('/api/auth/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        })
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (cancelled) return
        if (!res.ok || !json.ok) {
          setState('error')
          setError(json.error || `ошибка входа (${res.status})`)
          return
        }
        // verify the session cookie actually persists (iframe + blocked
        // third-party cookies would otherwise land on the registration page)
        await sleep(150)
        const me = await fetch('/api/auth/me', { cache: 'no-store' })
        const meJson = (await me.json().catch(() => ({}))) as { user?: unknown }
        if (cancelled) return
        if (me.ok && meJson.user) {
          window.location.replace('/')
          return
        }
        setState('error')
        setError(
          'Сессия не сохранилась: этот браузер блокирует cookie внутри Telegram (WebView/iframe). Открой мини-апп в приложении Telegram или войди на сайте вручную.',
        )
      } catch (e) {
        if (cancelled) return
        setState('error')
        setError(e instanceof Error ? e.message : 'сетевая ошибка')
      }
    }
    handshake()
    return () => { cancelled = true }
  }, [])

  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-600 text-xl font-bold text-white">
          V
        </div>
        {state === 'working' ? (
          <>
            <h1 className="text-lg font-semibold text-stone-900">Входим через Telegram…</h1>
            <p className="mt-2 text-sm text-stone-500">
              Проверяем подпись и открываем твой аккаунт со всей историей задач и файлов.
            </p>
            <div className="mx-auto mt-6 h-6 w-6 animate-spin rounded-full border-2 border-stone-300 border-t-emerald-600" />
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-red-600">Не удалось войти</h1>
            <p className="mt-2 text-sm text-stone-600">{error}</p>
            <p className="mt-3 text-xs text-stone-400">
              Открой мини-апп заново из чата с ботом @ozodbekartificialintelegencebot.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-5 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700"
            >
              Повторить
            </button>
          </>
        )}
      </div>
    </main>
  )
}
