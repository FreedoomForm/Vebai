'use client'

import { useEffect, useState } from 'react'
import { ShieldAlert, X } from 'lucide-react'

const STORAGE_KEY = 'vebai-proxy-warning-dismissed'

/**
 * In-app reminder of the transparent Z.ai proxy (dismiss persists locally).
 * The full disclosure lives on the landing/auth screen; this compact banner
 * keeps it visible inside the working app.
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
    <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 sm:px-4">
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
      <p className="flex-1 text-[11px] leading-relaxed text-amber-800/90">
        ИИ-запросы выполняет <span className="font-medium text-amber-900">агент chat.z.ai (Z.ai)</span> — режим
        «Агент»: веб-поиск, генерация изображений, работа с файлами и кодом — под{' '}
        <span className="font-medium text-amber-900">твоим собственным аккаунтом Z.ai</span>, на твою личную квоту
        (email/пароль работают и на chat.z.ai). Сервис неофициальный и не аффилирован с Z.ai.
      </p>
      <button
        aria-label="Скрыть предупреждение"
        onClick={() => {
          try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* noop */ }
          setVisible(false)
        }}
        className="rounded p-1 text-amber-500 hover:bg-amber-100 hover:text-amber-700"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
