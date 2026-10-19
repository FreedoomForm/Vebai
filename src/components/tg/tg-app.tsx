'use client'

/**
 * T28: /tgagent is now JUST the connection page (owner request: "вместо
 * отдельной страницы для Telegram агента — просто страница подключения").
 * Flow: phone -> «Продолжить» -> code (-> 2FA password if enabled) ->
 * «Продолжить» -> redirected back to the chat with the agent connector
 * preselected (/?agent=1).
 * The agent's rules/context live in the site CHAT now: the user talks to the
 * agent through the composer's «TG-агент» connector and the transcript
 * becomes the context the agent uses when answering people who DM the
 * account. No rules editor / test variants here anymore.
 */

import { useCallback, useEffect, useState } from 'react'

interface TgMe { id?: string; firstName?: string; username?: string }
interface TgAccountView {
  id: string
  phone: string
  status: string // pending | 2fa | connected | error
  statusText: string | null
  me: TgMe | null
  active: boolean
}
interface TgState {
  account: TgAccountView | null
  needApiCreds: boolean
}

const input =
  'w-full rounded-xl border border-white/10 bg-black/30 px-3.5 py-3 text-[15px] text-white placeholder:text-white/30 outline-none focus:border-emerald-400/60'
const btnPrimary =
  'inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40'
const btnGhost =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 px-4 py-2.5 text-sm font-medium text-white/80 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40'
const label = 'mb-1.5 block text-xs font-medium uppercase tracking-wide text-white/40'

async function api<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    const err = new Error(data.error || `ошибка ${res.status}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return data
}

export function TgConnectApp() {
  const [state, setState] = useState<TgState | null>(null)
  const [loading, setLoading] = useState(true)

  // connect form: phone -> code (-> 2FA)
  const [step, setStep] = useState<'phone' | 'code'>('phone')
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [needPassword, setNeedPassword] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [errStatus, setErrStatus] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const s = await api<TgState>('/api/tg/state', undefined, 'GET')
      setState(s)
      if (s.account?.status === '2fa') setStep('code')
      setErr(''); setErrStatus(0)
    } catch (e) {
      const er = e as Error & { status?: number }
      setErr(er instanceof Error ? er.message : 'ошибка загрузки')
      setErrStatus(er?.status || 0)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setErr(''); setErrStatus(0)
    try { await fn() } catch (e) {
      const er = e as Error & { status?: number }
      setErr(er instanceof Error ? er.message : 'ошибка')
      setErrStatus(er?.status || 0)
    } finally { setBusy('') }
  }

  const connected = state?.account?.status === 'connected'

  /* ------------------------------------------------------------ actions */

  const sendCode = () =>
    run('code', async () => {
      await api('/api/tg/connect', {
        phone,
        apiId: apiId ? Number(apiId) : undefined,
        apiHash: apiHash || undefined,
      })
      setStep('code'); setNeedPassword(false)
      await refresh()
    })

  const verify = () =>
    run('verify', async () => {
      const acc = state?.account
      if (!acc) return
      try {
        await api('/api/tg/verify', { accountId: acc.id, code, password })
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        if (/облачный пароль|пароль \(2FA\)|двухфакторная/i.test(msg)) setNeedPassword(true)
        throw e
      }
      // success -> back to the chat, agent connector preselected (T28 flow)
      window.location.href = '/?agent=1'
    })

  const disconnect = () =>
    run('disc', async () => {
      await api('/api/tg/disconnect', {})
      setStep('phone'); setCode(''); setPassword(''); setNeedPassword(false)
      await refresh()
    })

  /* ------------------------------------------------------------- render */

  return (
    <main className="flex min-h-screen items-center justify-center bg-[oklch(0.145_0_0)] px-4 py-10 text-white">
      <div className="w-full max-w-md space-y-5">
        <header className="space-y-2 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-2xl">
            ✈️
          </div>
          <h1 className="text-xl font-bold sm:text-2xl">Telegram-агент</h1>
          <p className="text-sm leading-relaxed text-white/60">
            Подключи свой аккаунт — агент будет отвечать на личные сообщения
            <b className="text-white/80"> от твоего имени</b>, помня всё, что ты ему скажешь в чате на сайте.
          </p>
        </header>

        {err && (errStatus === 401 || /unauthorized/i.test(err) ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            Ты не вошёл в аккаунт сайта — подключение привязывается к твоему аккаунту Vebai.{' '}
            <a href="/" className="font-semibold underline">Открой главную и войди</a>, затем вернись сюда.
          </div>
        ) : (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {err}
          </div>
        ))}

        {loading ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-sm text-white/50">
            загружаю состояние…
          </div>
        ) : connected ? (
          <section className="space-y-4 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-300">подключено</span>
              {state?.account?.active && (
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/70">агент активен</span>
              )}
            </div>
            <p className="text-sm text-white/80">
              {state?.account?.me?.firstName || state?.account?.me?.username || 'аккаунт'}
              {state?.account?.me?.username ? ` (@${state.account.me.username})` : ''} · {state?.account?.phone}
            </p>
            <a href="/?agent=1" className={btnPrimary}>
              Открыть чат с агентом →
            </a>
            <p className="text-xs leading-relaxed text-white/40">
              Правила агенту задаются прямо в чате: кнопка «TG-агент» в панели ввода.
              Всё, что ты ему расскажешь, он учтёт при ответах людям.
            </p>
            <button className={btnGhost} onClick={disconnect} disabled={!!busy}>
              {busy === 'disc' ? 'отключаю…' : 'Отключить аккаунт'}
            </button>
          </section>
        ) : (
          <section className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
            {step === 'phone' ? (
              <>
                <div>
                  <label className={label} htmlFor="phone">Шаг 1 — твой номер Telegram</label>
                  <input
                    id="phone"
                    className={input}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+998901234567"
                    inputMode="tel"
                    autoComplete="tel"
                  />
                  <p className="mt-1.5 text-xs text-white/40">
                    Можно просто 9 цифр — +998 добавится сам. Код придёт в твоё Telegram-приложение.
                  </p>
                </div>
                {state?.needApiCreds && (
                  <div className="space-y-3 rounded-xl border border-white/10 bg-black/20 p-3">
                    <p className="text-xs leading-relaxed text-white/50">
                      Свои ключи приложения:{' '}
                      <a href="https://my.telegram.org" target="_blank" rel="noreferrer" className="text-emerald-400/80 underline">my.telegram.org</a>
                      {' '}=&gt; «API development tools» =&gt; создай приложение =&gt; вставь api_id и api_hash.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <input className={input} value={apiId} onChange={(e) => setApiId(e.target.value.replace(/\D/g, ''))} placeholder="api_id" inputMode="numeric" aria-label="api_id" />
                      <input className={input} value={apiHash} onChange={(e) => setApiHash(e.target.value.trim())} placeholder="api_hash" autoComplete="off" aria-label="api_hash" />
                    </div>
                  </div>
                )}
                <button className={btnPrimary} onClick={sendCode} disabled={!!busy || phone.length < 7}>
                  {busy === 'code' ? 'отправляю код…' : 'Продолжить'}
                </button>
              </>
            ) : (
              <>
                <div>
                  <label className={label} htmlFor="code">Шаг 2 — код подтверждения</label>
                  <p className="mb-2 text-sm text-white/60">
                    {state?.account?.statusText || 'код отправлен'} на {state?.account?.phone}
                  </p>
                  <input
                    id="code"
                    className={`${input} text-center text-lg tracking-[0.3em]`}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="•••••"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                  />
                </div>
                {(needPassword || state?.account?.status === '2fa') && (
                  <div>
                    <label className={label} htmlFor="pwd">Облачный пароль (2FA)</label>
                    <input
                      id="pwd"
                      type="password"
                      className={input}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="пароль Telegram"
                      autoComplete="current-password"
                    />
                  </div>
                )}
                <button className={btnPrimary} onClick={verify} disabled={!!busy || (code.length < 4 && !password)}>
                  {busy === 'verify' ? 'проверяю…' : 'Продолжить'}
                </button>
                <button
                  className="w-full text-center text-xs text-white/40 hover:text-white/70"
                  onClick={() => { setStep('phone'); setCode(''); setPassword(''); setNeedPassword(false) }}
                >
                  ← другой номер
                </button>
              </>
            )}
          </section>
        )}

        <p className="pb-4 text-center text-xs leading-relaxed text-white/30">
          Сессия хранится зашифрованной (AES-256-GCM). Агент отвечает только в личные
          сообщения и никогда не пишет первым.
        </p>
      </div>
    </main>
  )
}
