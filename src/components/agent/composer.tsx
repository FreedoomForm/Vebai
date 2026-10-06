'use client'

import { useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Composer({
  onSend,
  disabled,
  connected,
}: {
  onSend: (content: string) => void
  disabled: boolean
  connected: boolean
}) {
  const [value, setValue] = useState('')
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    setValue('')
    if (taRef.current) taRef.current.style.height = 'auto'
    onSend(text)
  }

  return (
    <div className="px-3 pb-3 sm:px-6 sm:pb-4 pt-1">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/90 p-2 shadow-lg shadow-black/20 focus-within:border-emerald-800/60 transition-colors">
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={1}
            disabled={disabled}
            placeholder={
              disabled
                ? 'Агент работает…'
                : connected
                  ? 'Опиши задачу: видео, изображения, исследование…'
                  : 'Соединение…'
            }
            className="max-h-[180px] min-h-[40px] flex-1 resize-none bg-transparent px-2.5 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none disabled:opacity-60"
          />
          <button
            onClick={submit}
            disabled={disabled || !value.trim()}
            aria-label="Отправить сообщение"
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all',
              value.trim() && !disabled
                ? 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400'
                : 'bg-zinc-800 text-zinc-600 cursor-not-allowed',
            )}
          >
            <ArrowUp className="h-4.5 w-4.5" />
          </button>
        </div>
        <p className="mt-2 text-center text-[11px] text-zinc-600">
          Enter — отправить · Shift+Enter — новая строка · агент работает 24/7, результаты придут в чат
        </p>
      </div>
    </div>
  )
}
