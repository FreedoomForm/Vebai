'use client'

/**
 * T26: /tg — personal Telegram agent service page.
 * Flow: connect your own account (phone + code, my.telegram.org-style),
 * explain the rules to the AI (it maintains the agent's system prompt),
 * test incoming messages and approve the best reply variant (it becomes a
 * few-shot example), switch the agent on — the resident worker then answers
 * incoming private messages from the user's own account.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

interface TgMe { id?: string; firstName?: string; username?: string }
interface TgAccountView {
  id: string
  phone: string
  status: string // pending | 2fa | connected | error
  statusText: string | null
  me: TgMe | null
  active: boolean
  apiId: number
  lastCheckAt: string | null
  systemPrompt: string
  examples: { from?: string; incoming: string; reply: string; at?: string }[]
}
interface TgMessageView { id: string; chatId: string; chatName: string | null; direction: string; text: string; at: string }
interface TgState {
  account: TgAccountView | null
  messages: TgMessageView[]
  worker: { lastWorkerAt: string | null }
  needApiCreds: boolean
  examplesCount: number
  draft: { systemPrompt?: string; examples?: { from?: string; incoming: string; reply: string; at?: string }[] } | null
}
interface Variant { style: string; text: string }

const card = 'rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-6 backdrop-blur'
const input =
  'w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white placeholder:text-white/30 outline-none focus:border-emerald-400/60'
const btnPrimary =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40'
const btnGhost =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 px-4 py-2.5 text-sm font-medium text-white/80 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40'
const h2 = 'text-base sm:text-lg font-semibold text-white'
const label = 'mb-1.5 block text-xs font-medium uppercase tracking-wide text-white/40'

async function api<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error || `ошибка ${res.status}`)
  return data
}

function age(sec: number): string {
  if (sec < 90) return `${sec} с назад`
  if (sec < 5400) return `${Math.round(sec / 60)} мин назад`
  return `${Math.round(sec / 3600)} ч назад`
}

export function TgAgentApp() {
  const [state, setState] = useState<TgState | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  // connect form
  const [step, setStep] = useState<'phone' | 'code'>('phone')
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [needPassword, setNeedPassword] = useState(false)
  const [busy, setBusy] = useState('')

  // rules
  const [promptDraft, setPromptDraft] = useState('')
  const [coachInput, setCoachInput] = useState('')
  const [coachReply, setCoachReply] = useState('')

  // test
  const [fromName, setFromName] = useState('Мирсаид')
  const [testText, setTestText] = useState('')
  const [variants, setVariants] = useState<Variant[] | null>(null)
  const [lastIncoming, setLastIncoming] = useState('')
  const [pickedAt, setPickedAt] = useState('')

  const refresh = useCallback(async () => {
    try {
      const s = await api<TgState>('/api/tg/state', undefined, 'GET')
      setState(s)
      setPromptDraft((prev) => prev || s.account?.systemPrompt || s.draft?.systemPrompt || '')
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [refresh])

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setErr('')
    try { await fn() } catch (e) { setErr(e instanceof Error ? e.message : 'ошибка') } finally { setBusy('') }
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
        setStep('phone'); setCode(''); setPassword(''); setNeedPassword(false)
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        if (/облачный пароль|пароль \(2FA\)/i.test(msg)) setNeedPassword(true)
        throw e
      }
      await refresh()
    })

  const disconnect = () =>
    run('disc', async () => {
      await api('/api/tg/disconnect', {})
      setPromptDraft(''); setVariants(null); setCoachReply('')
      await refresh()
    })

  const savePrompt = () =>
    run('save', async () => {
      await api('/api/tg/config', { systemPrompt: promptDraft })
      await refresh()
    })

  const coach = () =>
    run('coach', async () => {
      const r = await api<{ reply: string; systemPrompt: string }>('/api/tg/coach', { message: coachInput })
      setCoachReply(r.reply)
      setPromptDraft(r.systemPrompt)
      setCoachInput('')
      await refresh()
    })

  const simulate = () =>
    run('sim', async () => {
      const r = await api<{ variants: Variant[] }>('/api/tg/simulate', { fromName, text: testText })
      setVariants(r.variants)
      setLastIncoming(testText)
      setPickedAt('')
    })

  const pick = (v: Variant) =>
    run(`pick-${v.style}`, async () => {
      await api('/api/tg/variant', { fromName, incoming: lastIncoming, chosen: v.text })
      setPickedAt(v.style)
      await refresh()
    })

  const toggleActive = (on: boolean) =>
    run('act', async () => {
      await api('/api/tg/config', { active: on })
      await refresh()
    })

  const clearExamples = () =>
    run('clex', async () => {
      await api('/api/tg/config', { examples: [] })
      await refresh()
    })

  const workerAge = state?.worker.lastWorkerAt
    ? Math.round((Date.now() - new Date(state.worker.lastWorkerAt).getTime()) / 1000)
    : null

  /* ------------------------------------------------------------- render */

  return (
    <main className="min-h-screen bg-[oklch(0.145_0_0)] text-white">
      <div className="mx-auto max-w-3xl space-y-5 px-3 py-6 sm:px-6 sm:py-10">
        {/* hero */}
        <header className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-bold sm:text-2xl">Telegram-агент</h1>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                connected && state?.account?.active
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : connected
                    ? 'bg-white/10 text-white/70'
                    : 'bg-amber-500/15 text-amber-300'
              }`}
            >
              {connected ? (state?.account?.active ? 'активен' : 'подключён, выключен') : 'не подключён'}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-white/60">
            Подключи свой Telegram-аккаунт, объясни агенту правила — тон, что отвечать
            конкретным людям, какие запросы передавать тебе. Протестируй варианты
            ответов, утверди лучшие — и агент начнёт отвечать на личные сообщения
            <b className="text-white/80"> от твоего имени</b>, ровно так, как ты велел.
          </p>
          <a href="/" className="inline-block text-xs text-emerald-400/80 hover:text-emerald-300">← в Vebai</a>
        </header>

        {err && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {err}
          </div>
        )}

        {loading ? (
          <div className={`${card} text-sm text-white/50`}>загружаю состояние…</div>
        ) : (
          <>
            {/* 1. connect */}
            <section className={card} aria-label="Подключение аккаунта">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className={h2}>1. Подключение аккаунта</h2>
                  {connected && state?.account && (
                    <p className="mt-1 text-sm text-emerald-300/90">
                      {state.account.me?.firstName || state.account.me?.username || 'аккаунт'}
                      {state.account.me?.username ? ` (@${state.account.me.username})` : ''} · {state.account.phone}
                    </p>
                  )}
                </div>
                {connected && (
                  <button className={btnGhost} onClick={disconnect} disabled={!!busy}>
                    {busy === 'disc' ? 'отключаю…' : 'Отключить'}
                  </button>
                )}
              </div>

              {!connected && (
                <div className="mt-4 space-y-3">
                  {state?.needApiCreds && step === 'phone' && (
                    <div className="space-y-3 rounded-xl border border-white/10 bg-black/20 p-3">
                      <p className="text-xs leading-relaxed text-white/50">
                        Свои ключи приложения: открой{' '}
                        <a href="https://my.telegram.org" target="_blank" rel="noreferrer" className="text-emerald-400/80 underline">my.telegram.org</a>
                        {' '}=&gt; «API development tools» =&gt; создай приложение =&gt; вставь api_id и api_hash. Они шифруются и хранятся только на сервере.
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className={label} htmlFor="apiId">api_id</label>
                          <input id="apiId" className={input} value={apiId} onChange={(e) => setApiId(e.target.value.replace(/\D/g, ''))} placeholder="1234567" inputMode="numeric" />
                        </div>
                        <div>
                          <label className={label} htmlFor="apiHash">api_hash</label>
                          <input id="apiHash" className={input} value={apiHash} onChange={(e) => setApiHash(e.target.value.trim())} placeholder="32 hex-символа" autoComplete="off" />
                        </div>
                      </div>
                    </div>
                  )}

                  {step === 'phone' ? (
                    <div>
                      <label className={label} htmlFor="phone">Твой номер Telegram</label>
                      <div className="flex gap-2">
                        <input id="phone" className={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+998901234567" inputMode="tel" autoComplete="tel" />
                        <button className={btnPrimary} onClick={sendCode} disabled={!!busy || phone.length < 7}>
                          {busy === 'code' ? 'отправляю…' : 'Получить код'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-white/60">
                        {state?.account?.statusText || 'код отправлен'} на {state?.account?.phone}
                      </p>
                      <div>
                        <label className={label} htmlFor="code">Код подтверждения</label>
                        <input id="code" className={input} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="12345" inputMode="numeric" autoComplete="one-time-code" />
                      </div>
                      {(needPassword || state?.account?.status === '2fa') && (
                        <div>
                          <label className={label} htmlFor="pwd">Облачный пароль (2FA)</label>
                          <input id="pwd" type="password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="пароль Telegram" autoComplete="current-password" />
                        </div>
                      )}
                      <div className="flex gap-2">
                        <button className={btnPrimary} onClick={verify} disabled={!!busy || (code.length < 4 && !password)}>
                          {busy === 'verify' ? 'проверяю…' : 'Подтвердить'}
                        </button>
                        <button className={btnGhost} onClick={() => { setStep('phone'); setCode(''); setPassword(''); setNeedPassword(false) }}>
                          Другой номер
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* 2. rules */}
            <section className={card} aria-label="Правила агента">
              <h2 className={h2}>2. Правила агента</h2>
              <p className="mt-1 text-sm text-white/50">
                Объясни своими словами, как агент должен вести себя в твоём Telegram.
                ИИ сразу перепишет правила — можешь потом подправить вручную.
              </p>
              <div className="mt-3 flex gap-2">
                <input
                  className={input}
                  value={coachInput}
                  onChange={(e) => setCoachInput(e.target.value)}
                  placeholder="например: с Мирсаидом — официально, всегда создавай файлы, что он попросит"
                  onKeyDown={(e) => { if (e.key === 'Enter' && coachInput.trim()) coach() }}
                />
                <button className={btnPrimary} onClick={coach} disabled={!!busy || coachInput.trim().length < 3}>
                  {busy === 'coach' ? 'думаю…' : 'Обновить'}
                </button>
              </div>
              {!connected && <p className="mt-2 text-xs text-amber-300/70">правила можно задать и до подключения — сохранятся как черновик и переедут в агента</p>}
              {coachReply && <p className="mt-2 text-sm text-emerald-300/90">🤖 {coachReply}</p>}

              <div className="mt-4">
                <label className={label} htmlFor="prompt">Текст правил (системный промпт агента)</label>
                <textarea
                  id="prompt"
                  className={`${input} min-h-40 resize-y font-mono text-xs leading-relaxed`}
                  value={promptDraft}
                  onChange={(e) => setPromptDraft(e.target.value)}
                />
                <div className="mt-2 flex items-center gap-2">
                  <button className={btnGhost} onClick={savePrompt} disabled={!!busy}>Сохранить правила</button>
                  {busy === 'save' && <span className="text-xs text-white/40">сохраняю…</span>}
                </div>
              </div>

              {(() => { const examples = state?.account?.examples ?? state?.draft?.examples ?? []; return examples.length ? (
                <div className="mt-4">
                  <div className="flex items-center justify-between">
                    <span className={label}>Одобренные примеры ({examples.length})</span>
                    <button className="text-xs text-white/40 hover:text-red-300" onClick={clearExamples} disabled={!!busy}>очистить</button>
                  </div>
                  <div className="mt-1 max-h-40 space-y-1.5 overflow-y-auto pr-1">
                    {examples.map((ex, i) => (
                      <div key={i} className="rounded-lg border border-white/5 bg-black/20 px-3 py-2 text-xs text-white/60">
                        <b className="text-white/80">{ex.from || 'контакт'}:</b> {ex.incoming.slice(0, 90)} → <span className="text-emerald-300/80">{ex.reply.slice(0, 90)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) })()}
            </section>

            {/* 3. test */}
            <section className={card} aria-label="Тестирование">
              <h2 className={h2}>3. Тест: как агент ответит?</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
                <div>
                  <label className={label} htmlFor="from">От кого</label>
                  <input id="from" className={input} value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Мирсаид" />
                </div>
                <div>
                  <label className={label} htmlFor="test">Пробное входящее сообщение</label>
                  <input id="test" className={input} value={testText} onChange={(e) => setTestText(e.target.value)} placeholder="Салом, скинь отчёт по проекту" />
                </div>
                <button className={btnPrimary} onClick={simulate} disabled={!!busy || testText.trim().length < 1}>
                  {busy === 'sim' ? 'генерирую…' : 'Варианты'}
                </button>
              </div>

              {variants && (
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {variants.map((v) => (
                    <div key={v.style} className="flex flex-col rounded-xl border border-white/10 bg-black/20 p-3">
                      <span className="text-xs font-semibold uppercase tracking-wide text-emerald-400/80">{v.style}</span>
                      <p className="mt-2 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-white/85">{v.text}</p>
                      <button
                        className={`${btnGhost} mt-3 justify-center text-xs`}
                        onClick={() => pick(v)}
                        disabled={!!busy}
                      >
                        {busy === `pick-${v.style}` ? 'сохраняю…' : pickedAt === v.style ? '✓ станет примером' : 'Сделать примером'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {pickedAt && <p className="mt-3 text-xs text-emerald-300/80">вариант «{pickedAt}» добавлен в примеры — агент будет придерживаться такого стиля</p>}
            </section>

            {/* 4. run */}
            <section className={card} aria-label="Запуск и журнал">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className={h2}>4. Запуск</h2>
                  <p className="mt-1 max-w-md text-sm text-white/50">
                    Агент отвечает на новые личные сообщения от твоего имени
                    (воркер на смене GitHub Actions). Журнал — ниже, всё честно.
                  </p>
                </div>
                <button
                  role="switch"
                  aria-checked={!!state?.account?.active}
                  onClick={() => toggleActive(!state?.account?.active)}
                  disabled={!connected || !!busy}
                  className={`relative h-8 w-14 shrink-0 rounded-full transition ${state?.account?.active ? 'bg-emerald-500' : 'bg-white/15'} disabled:opacity-40`}
                >
                  <span className={`absolute top-1 h-6 w-6 rounded-full bg-white transition-all ${state?.account?.active ? 'left-7' : 'left-1'}`} />
                </button>
              </div>
              <p className="mt-2 text-xs text-white/40">
                воркер: {workerAge === null ? 'не виден' : workerAge < 600 ? `жив (${age(workerAge)})` : `не отвечает (${age(workerAge)})`}
                {state?.account?.lastCheckAt && connected ? ` · аккаунт на смене: ${age(Math.round((Date.now() - new Date(state.account.lastCheckAt).getTime()) / 1000))}` : ''}
              </p>

              {!!state?.messages.length && (
                <div className="mt-4 max-h-72 space-y-1.5 overflow-y-auto pr-1">
                  {state.messages.map((m) => (
                    <div key={m.id} className="rounded-lg border border-white/5 bg-black/20 px-3 py-2 text-xs">
                      <div className="mb-0.5 flex items-center gap-2 text-white/40">
                        <span className={m.direction === 'in' ? 'text-sky-300/80' : 'text-emerald-300/80'}>
                          {m.direction === 'in' ? '← входящее' : '→ ответ агента'}
                        </span>
                        <span>{m.chatName || m.chatId.slice(0, 10)}</span>
                        <span>{new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div className="whitespace-pre-wrap text-white/75">{m.text.slice(0, 300)}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <footer className="pb-6 pt-2 text-center text-xs text-white/30">
              Сессия хранится зашифрованной (AES-256-GCM); агент отвечает только в личные сообщения и никогда не пишет первым.
            </footer>
          </>
        )}
      </div>
    </main>
  )
}
