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
    <div className="flex items-start gap-2 border-b border-amber-900/50 bg-amber-950/25 px-3 py-2 sm:px-4">
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
      <p className="flex-1 text-[11px] leading-relaxed text-amber-200/80">
        ИИ-запросы выполняет агент <span className="font-medium text-amber-200">chat.z.ai (Z.ai)</span> со
        встроенным поиском — под <span className="font-medium text-amber-200">твоим собственным аккаунтом Z.ai</span>, на твою личную квоту
        (email/пароль работают и на chat.z.ai). Сервис неофициальный и не аффилирован с Z.ai.
      </p>
      <button
        aria-label="Скрыть предупреждение"
        onClick={() => {
          try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* noop */ }
          setVisible(false)
        }}
        className="rounded p-1 text-amber-400/70 hover:bg-amber-950/50 hover:text-amber-300"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
