'use client'

import { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'

const STORAGE_KEY = 'vebai-proxy-warning-dismissed'

/**
 * In-app note about how the AI runs (dismiss persists locally).
 */
export function WarningBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setVisible(localStorage.getItem(STORAGE_KEY) !== '1')
      } catch {
        setVisible(true)
      }
    }, 0)
    return () => clearTimeout(t)
  }, [])

  if (!visible) return null

  return (
    <div className="flex items-start gap-2 border-b border-emerald-200 bg-emerald-50 px-3 py-2 sm:px-4">
      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
      <p className="flex-1 text-[11px] leading-relaxed text-emerald-800/90">
        Чат работает на <span className="font-medium text-emerald-900">официальном API Z.ai</span> с
        бесплатной моделью <span className="font-medium text-emerald-900">GLM-4.7-Flash</span> (автофолбэк —
        GLM-4.5-Flash при перегрузке). Веб-поиск и фоновая генерация видео — внутри сайта,
        без внешних логинов и капч.
      </p>
      <button
        aria-label="Скрыть подсказку"
        onClick={() => {
          try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* noop */ }
          setVisible(false)
        }}
        className="rounded p-1 text-emerald-500 hover:bg-emerald-100 hover:text-emerald-700"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
