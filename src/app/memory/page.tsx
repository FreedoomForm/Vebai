'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * T52 (owner request 2026-10-23): the SHARED agent memory page — the agent
 * fills it through <memory>…</memory> and <end> recaps, the owner reads it
 * as plain text and can edit + save right here. Reached from the sidebar
 * profile button in the app.
 */

export default function MemoryPage() {
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [authed, setAuthed] = useState(true)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    fetch('/api/agent/memory', { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 401) {
          setAuthed(false)
          setLoaded(true)
          return
        }
        const j = (await r.json()) as { text?: string }
        setText(String(j.text || ''))
        setLoaded(true)
      })
      .catch(() => {
        setNote('⚠️ не удалось загрузить память')
        setLoaded(true)
      })
  }, [])

  const save = async () => {
    setSaving(true)
    setNote('')
    try {
      const r = await fetch('/api/agent/memory', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (r.status === 401) {
        setAuthed(false)
        return
      }
      if (!r.ok) throw new Error(String(r.status))
      setNote('✅ Память сохранена — агент увидит её в следующих задачах')
    } catch {
      setNote('⚠️ не удалось сохранить — попробуй ещё раз')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100"
          >
            ← В приложение
          </Link>
          <h1 className="text-lg font-semibold">Память агента</h1>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-stone-600">
          Общая память: агент сам дописывает сюда важное тегами{' '}
          <code className="rounded bg-stone-200 px-1 py-0.5 text-[12px]">&lt;memory&gt;</code> и пересказами{' '}
          <code className="rounded bg-stone-200 px-1 py-0.5 text-[12px]">&lt;end&gt;</code>, и читает этот текст
          в каждой задаче и при входящих в Telegram. Правь как хочешь — агент увидит изменения.
        </p>

        {!authed ? (
          <div className="mt-6 rounded-xl border border-stone-200 bg-white p-5 text-sm text-stone-600">
            Нужен вход. <Link href="/" className="font-semibold underline">Открой приложение и войди</Link>, затем
            вернись на эту страницу.
          </div>
        ) : (
          <>
            <textarea
              value={loaded ? text : 'Загрузка…'}
              onChange={(e) => setText(e.target.value)}
              disabled={!loaded || saving}
              rows={20}
              spellCheck={false}
              placeholder="Пока память пуста — агент заполнит её по ходу работы (или напиши здесь важное сам: предпочтения, договорённости, имена)."
              className="mt-4 w-full rounded-xl border border-stone-200 bg-white p-4 font-mono text-[13px] leading-relaxed text-stone-800 shadow-sm outline-none transition focus:border-stone-400 disabled:opacity-60"
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={() => void save()}
                disabled={!loaded || saving}
                className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-700 disabled:opacity-50"
              >
                {saving ? 'Сохраняю…' : 'Сохранить память'}
              </button>
              {note && <span className="text-[13px] text-stone-600">{note}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
