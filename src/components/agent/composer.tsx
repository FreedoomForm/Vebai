'use client'

import { useRef, useState } from 'react'
import { ArrowUp, Paperclip, X } from 'lucide-react'
import { cn, formatBytes } from '@/lib/utils'

export interface SendOptions {
  resume?: boolean
  /** T49: the 🎬 video toggle is gone — the model queues the video pipeline
   *  itself with a ```video-request``` block (server-side, prompt.ts);
   *  the composer carries no video/web/effort flags any more */
  /** T40: files attached in the composer — the app uploads them to the
   *  Telegram channel before the turn starts */
  files?: File[]
}

/** T40: the «TG-агент» toggle is gone from the composer (owner request:
 *  "убери кнопку телеграм мод рядом с панелью ввода") — the agent chat is
 *  still reachable via the sidebar button and the ?agent=1 deep link.
 *  The paperclip is REAL now: attached files go to the Telegram channel.
 *
 * T49 (owner request 2026-10-23): the web-search toggle, the video toggle and
 *  the effort (Max/High) selector are GONE from the input field too — the
 *  AGENT decides by itself: fresh web context is fetched automatically
 *  (server-side default ON) and the model queues the video pipeline itself
 *  with a ```video-request``` block when the user asks for video. The
 *  composer keeps only the paperclip and the send button. */

/**
 * Composer in two variants, mirroring z.ai's chat UX with our own design:
 *  - hero: the big centered first-screen box (a new chat IS the landing page)
 *  - dock: the compact bottom box of an ongoing conversation
 * T49: the toggles (web search / video / effort) are gone — capabilities are
 * always on and the model decides itself (see the T49 note above).
 * T40: the paperclip is real — picked files ride along in SendOptions.files
 * and land in the owner's Telegram channel (see /api/chat/attach).
 */
export function Composer({
  onSend,
  disabled,
  connected,
  variant,
  draft,
  onDraftChange,
  tgAgent,
}: {
  onSend: (content: string, opts?: SendOptions) => void
  disabled: boolean
  connected: boolean
  variant: 'hero' | 'dock'
  draft: string
  onDraftChange: (v: string) => void
  tgAgent: boolean
}) {
  const [files, setFiles] = useState<File[]>([])
  const [fileNote, setFileNote] = useState('')
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const pickRef = useRef<HTMLInputElement | null>(null)
  const value = draft

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return
    const next = [...files]
    const skipped: string[] = []
    for (const f of Array.from(list)) {
      if (next.length >= 5) {
        skipped.push(`${f.name} — максимум 5 файлов`)
        continue
      }
      if (f.size > 4 * 1024 * 1024) {
        skipped.push(`${f.name} — больше 4 МБ`)
        continue
      }
      next.push(f)
    }
    setFiles(next)
    setFileNote(skipped.join(' · '))
  }

  const submit = (opts?: SendOptions) => {
    const text = value.trim()
    if ((!text && files.length === 0) || disabled) return
    onDraftChange('')
    if (taRef.current) taRef.current.style.height = 'auto'
    onSend(text, { files: [...files], ...opts })
    setFiles([])
    setFileNote('')
  }

  const placeholder = tgAgent
    ? 'Научи агента: как отвечать людям, которые пишут в твой Telegram…'
    : variant === 'hero'
      ? connected
        ? 'Чем я могу помочь сегодня?'
        : 'Соединение…'
      : disabled
        ? 'Агент работает…'
        : connected
          ? 'Опиши задачу: видео, изображения, исследование…'
          : 'Соединение…'

  return (
    <div className={cn('relative w-full', variant === 'hero' ? 'max-w-3xl' : 'mx-auto max-w-3xl')}>
      <div
        className={cn(
          'border border-stone-200/90 bg-white shadow-[0_10px_36px_rgba(28,25,23,0.06)] transition-colors focus-within:border-stone-300',
          variant === 'hero' ? 'rounded-3xl px-4 pb-3 pt-4' : 'rounded-2xl px-3 pb-2.5 pt-3',
        )}
      >
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => {
            onDraftChange(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={variant === 'hero' ? 2 : 1}
          disabled={disabled}
          placeholder={placeholder}
          className={cn(
            'max-h-[200px] w-full resize-none bg-transparent px-1 text-stone-800 placeholder:text-stone-400 outline-none disabled:opacity-60',
            variant === 'hero' ? 'min-h-[52px] text-[15px]' : 'min-h-[24px] text-sm',
          )}
        />

        {/* T40: picked files — chips above the actions row */}
        {files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <span
                key={`${f.name}-${i}`}
                className="flex max-w-full items-center gap-1.5 rounded-lg border border-stone-200 bg-stone-50 px-2 py-1 text-[12px] text-stone-600"
              >
                <Paperclip className="h-3 w-3 shrink-0 text-stone-400" />
                <span className="max-w-[220px] truncate">{f.name}</span>
                <span className="shrink-0 text-stone-400">{formatBytes(f.size)}</span>
                <button
                  type="button"
                  aria-label={`Убрать ${f.name}`}
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  className="shrink-0 rounded text-stone-400 hover:text-stone-700"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        {fileNote && (
          <p className="mt-2 text-[11px] leading-snug text-amber-700">⚠️ {fileNote}</p>
        )}

        <div className="mt-1.5 flex items-center gap-1.5">
          {/* attach — T40: real file picker; files land in the Telegram channel */}
          <button
            type="button"
            aria-label="Прикрепить файл"
            title="Прикрепить файл (до 5 файлов × 4 МБ — уйдут в Telegram-канал)"
            onClick={() => pickRef.current?.click()}
            className="flex h-9 w-9 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100"
          >
            <Paperclip className="h-[18px] w-[18px]" />
          </button>
          <input
            ref={pickRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
          />

          <div className="ml-auto flex items-center gap-2">
            {/* send */}
            <button
              type="button"
              onClick={() => submit()}
              disabled={disabled || (!value.trim() && files.length === 0)}
              aria-label="Отправить сообщение"
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all',
                (value.trim() || files.length > 0) && !disabled
                  ? 'bg-stone-900 text-white hover:bg-stone-700'
                  : 'bg-stone-200 text-stone-400 cursor-not-allowed',
              )}
            >
              <ArrowUp className="h-4.5 w-4.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
