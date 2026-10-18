'use client'

import { useEffect, useState } from 'react'

/**
 * Telegram Mini App entry point. Telegram opens this page inside its
 * in-app browser with window.Telegram.WebApp.initData signed by the bot
 * token. We POST it to /api/auth/telegram: the server verifies the
 * signature, auto-registers/logs the user in, binds the bot conversation
 * (task & file history) to the account and sets the session cookie. Then we
 * land the user in the app root - their account with all conversations,
 * tasks and files.
 */
export default function TelegramMiniAppPage() {
  const [state, setState] = useState<'working' | 'error'>('working')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    interface TgWebApp {
      initData?: string
      ready?: () => void
      expand?: () => void
      openTelegramLink?: (url: string) => void
    }
    const tg = (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp
    try {
      tg?.ready?.()
      tg?.expand?.()
    } catch { /* not in telegram */ }

    async function handshake() {
      const initData = tg?.initData || ''
      if (!initData) {
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
        window.location.replace('/')
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
