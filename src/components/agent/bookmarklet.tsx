'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * "⚡ Vebai — забрать токен" bookmarklet (v6) — the automatic half of the
 * Google bridge. The user drags this link ONCE onto the bookmarks bar; from
 * then on, one click on ANY logged-in chat.z.ai tab navigates the browser to
 * /auth/google/catch#token=<localStorage.token> — a plain top-level
 * navigation, so no CSP/CORS/clipboard permission can block it.
 *
 * React 19 strips `javascript:` hrefs from JSX, so the href is set
 * imperatively via ref. Clicking (not dragging) copies the code to the
 * clipboard for manual bookmark creation.
 */
export function BookmarkletLink({ className }: { className?: string }) {
  const ref = useRef<HTMLAnchorElement>(null)
  const [copied, setCopied] = useState(false)
  const codeRef = useRef('')

  useEffect(() => {
    const origin = window.location.origin
    // Latin-only strings: the href body is percent-decoded before execution,
    // keep it strictly ASCII and single-line.
    const js =
      "javascript:(function(){var t=localStorage.getItem('token');" +
      "if(!t){alert('Vebai: token not found - sign in to chat.z.ai first, then click this bookmark again');return}" +
      "location.href='" + origin + "/auth/google/catch#token='+encodeURIComponent(t)})()"
    codeRef.current = js
    ref.current?.setAttribute('href', js)
  }, [])

  return (
    <a
      ref={ref}
      href="#"
      draggable
      onClick={(e) => {
        e.preventDefault()
        const code = codeRef.current
        if (!code) return
        void navigator.clipboard
          .writeText(code)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 2600)
          })
          .catch(() => { /* clipboard denied — drag still works */ })
      }}
      title="Перетащи меня на панель закладок браузера (клик — скопировать код закладки)"
      className={className}
    >
      ⚡ Vebai — забрать токен
      {copied && <span className="ml-1 text-emerald-400">— код скопирован ✓</span>}
    </a>
  )
}
