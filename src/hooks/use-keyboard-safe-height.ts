'use client'

import { useEffect } from 'react'

/**
 * Mobile-keyboard hygiene for the fixed h-dvh app shell (T17, owner report:
 * "when I start typing on the phone keyboard the input window is not visible").
 *
 * - Chrome Android 108+ honours `interactive-widget=resizes-content`
 *   (see layout.tsx viewport export): the layout viewport — and therefore
 *   100dvh — shrinks with the keyboard. Nothing extra needed.
 * - iOS Safari ignores `interactive-widget`: the layout viewport keeps its
 *   full height while the visual viewport shrinks, so a docked composer hides
 *   behind the keyboard. Here we pin the shell height to visualViewport.height
 *   via the --app-height CSS variable and keep the window scroll pinned to 0
 *   so the flex column (composer at its bottom) always ends above the keyboard.
 */
export function useKeyboardSafeHeight() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const apply = () => {
      root.style.setProperty('--app-height', `${Math.round(vv.height)}px`)
      // iOS pans the page up when the keyboard opens — undo it, the shell
      // already fits the visual viewport.
      if (window.scrollY !== 0) window.scrollTo(0, 0)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    window.addEventListener('orientationchange', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      window.removeEventListener('orientationchange', apply)
      root.style.removeProperty('--app-height')
    }
  }, [])
}
