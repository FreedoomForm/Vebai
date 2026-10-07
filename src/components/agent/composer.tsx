'use client'

import { useRef, useState } from 'react'
import { ArrowUp, Clapperboard, Globe, Paperclip, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SendOptions {
  captchaVerifyParam?: string
  resume?: boolean
  /** 🎬 toggle: also queue the MiniMax H3 video pipeline for this prompt */
  videoRequest?: boolean
}

export type Effort = 'high' | 'max'

const EFFORT_LABEL: Record<Effort, string> = {
  max: 'Глубокий · Max',
  high: 'Быстрый · High',
}

/**
 * Composer in two variants, mirroring z.ai's chat UX with our own design:
 *  - hero: the big centered first-screen box (a new chat IS the landing page)
 *  - dock: the compact bottom box of an ongoing conversation
 * The 🌐 web-search toggle, the effort (Deep-Think) selector and the 🎬
 * video toggle are real switches wired into the chat/video pipeline.
 */
export function Composer({
  onSend,
  disabled,
  connected,
  variant,
  draft,
  onDraftChange,
  webSearch,
  onWebSearchToggle,
  effort,
  onEffortChange,
  video,
  onVideoToggle,
}: {
  onSend: (content: string, opts?: SendOptions) => void
  disabled: boolean
  connected: boolean
  variant: 'hero' | 'dock'
  draft: string
  onDraftChange: (v: string) => void
  webSearch: boolean
  onWebSearchToggle: () => void
  effort: Effort
  onEffortChange: (e: Effort) => void
  video: boolean
  onVideoToggle: () => void
}) {
  const [effortOpen, setEffortOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const value = draft

  const submit = (opts?: SendOptions) => {
    const text = value.trim()
    if (!text || disabled) return
    onDraftChange('')
    if (taRef.current) taRef.current.style.height = 'auto'
    onSend(text, { videoRequest: video, ...opts })
  }

  const placeholder =
    variant === 'hero'
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

        <div className="mt-1.5 flex items-center gap-1.5">
          {/* attach — stub for now, mirrors z.ai's + button position */}
          <button
            type="button"
            aria-label="Вложение — скоро"
            title="Вложения файлов — скоро"
            disabled
            className="flex h-9 w-9 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 cursor-not-allowed"
          >
            <Paperclip className="h-[18px] w-[18px]" />
          </button>

          {/* web-search toggle — real switch into the upstream payload */}
          <button
            type="button"
            aria-label="Веб-поиск"
            aria-pressed={webSearch}
            onClick={onWebSearchToggle}
            title={webSearch ? 'Веб-поиск включён' : 'Включить веб-поиск'}
            className={cn(
              'flex h-9 items-center gap-1.5 rounded-full px-2.5 text-[13px] transition-colors',
              webSearch
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : 'text-stone-500 hover:bg-stone-100',
            )}
          >
            <Globe className="h-[17px] w-[17px]" />
            {webSearch && <span className="hidden sm:inline">Поиск</span>}
          </button>

          {/* 🎬 video toggle — queues the MiniMax H3 pipeline (Kaggle GPU) */}
          <button
            type="button"
            aria-label="Сделать видео"
            aria-pressed={video}
            onClick={onVideoToggle}
            title={video ? 'Видео будет создано по запросу (Kaggle GPU)' : 'Создать видео по запросу'}
            className={cn(
              'flex h-9 items-center gap-1.5 rounded-full px-2.5 text-[13px] transition-colors',
              video
                ? 'bg-violet-50 text-violet-700 border border-violet-200'
                : 'text-stone-500 hover:bg-stone-100',
            )}
          >
            <Clapperboard className="h-[17px] w-[17px]" />
            {video && <span className="hidden sm:inline">Видео</span>}
          </button>

          <div className="ml-auto flex items-center gap-2">
            {/* effort selector (z.ai's Deep Think Max analogue) */}
            <div className="relative">
              <button
                type="button"
                aria-label="Уровень размышлений"
                onClick={() => setEffortOpen((v) => !v)}
                className="flex h-9 items-center gap-1 rounded-full px-2.5 text-[13px] text-stone-500 hover:bg-stone-100"
              >
                <span className="hidden sm:inline">{EFFORT_LABEL[effort]}</span>
                <span className="sm:hidden">{effort === 'max' ? 'Max' : 'High'}</span>
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {effortOpen && (
                <>
                  <button
                    type="button"
                    aria-label="Закрыть"
                    className="fixed inset-0 z-10 cursor-default"
                    onClick={() => setEffortOpen(false)}
                  />
                  <div className="absolute bottom-11 right-0 z-20 w-52 overflow-hidden rounded-xl border border-stone-200 bg-white p-1 shadow-xl shadow-stone-900/10">
                    {(Object.keys(EFFORT_LABEL) as Effort[]).map((e) => (
                      <button
                        key={e}
                        type="button"
                        onClick={() => {
                          onEffortChange(e)
                          setEffortOpen(false)
                        }}
                        className={cn(
                          'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] transition-colors',
                          e === effort
                            ? 'bg-stone-100 text-stone-900'
                            : 'text-stone-600 hover:bg-stone-50',
                        )}
                      >
                        <span>{EFFORT_LABEL[e]}</span>
                        <span className="text-[11px] text-stone-400">
                          {e === 'max' ? 'агент думает дольше' : 'быстрее ответ'}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* send */}
            <button
              type="button"
              onClick={() => submit()}
              disabled={disabled || !value.trim()}
              aria-label="Отправить сообщение"
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all',
                value.trim() && !disabled
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
