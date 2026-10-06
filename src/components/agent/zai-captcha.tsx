'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Z.ai captcha relay.
 *
 * Renders (and drives) the VERY SAME Aliyun Captcha 2.0 widget chat.z.ai
 * uses — same script, same region/prefix, same SceneId ('didk33e0', their
 * main scene; Aliyun does not bind it to their domain, verified live).
 *
 * Flow: solveZaiCaptcha() opens the widget popup; in clean browsers Z.ai's
 * risk engine passes the session instantly and invisibly (smart verification),
 * otherwise the user slides the puzzle — a normal captcha experience. The
 * success callback yields a one-time `captcha_verify_param` which our backend
 * forwards to chat.z.ai with the chat request; chat.z.ai verifies it with
 * Aliyun. This is literally Z.ai's server captcha protecting our site —
 * no homemade captcha and no tokens anywhere.
 *
 * Like chat.z.ai's own frontend, the widget is RE-INITIALIZED for every
 * verification (their code resets the instance and calls initAliyunCaptcha
 * again) — one widget lifetime equals one captcha_verify_param.
 */

const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
const REGION = 'sgp'
const PREFIX = 'no8xfe'
const SCENE_ID = 'didk33e0'
/** chat.z.ai's signup/login scene (embed mode, visible in-form widget) */
export const AUTH_SCENE_ID = '36qgs6xb'
const ELEMENT_ID = 'zai-captcha-element'
const BUTTON_ID = 'zai-captcha-trigger'

/** RU labels for the widget (Aliyun supports custom lang packs via upLang) */
const RU_LANG = {
  START_VERIFY: 'Подтвердить',
  POPUP_TITLE: 'Подтвердите, что вы не робот',
  SLIDE_TIP: 'Зажмите ползунок и потяните вправо',
  CHECK_BOX_TIP: 'Подтвердите, что вы не робот',
  PUZZLE_TIP: 'Перетащите ползунок, чтобы собрать картинку',
  INPAINTING_TIP: 'Перетащите ползунок, чтобы восстановить картинку',
  VERIFYING: 'Проверяем...',
  SUCCESS: 'Готово!',
  SLIDE_FAIL: 'Не получилось, попробуйте ещё раз',
  CAPTCHA_FAIL: 'Проверка не пройдена, попробуйте ещё раз',
  CONGESTION: 'Сеть перегружена, обновите и попробуйте снова',
  CAPTCHA_COMPLETED: 'Готово',
  FINISH_CAPTCHA: 'Сначала пройдите проверку!',
}

type CaptchaInstance = { refresh?: () => void } & Record<string, unknown>

interface AliyunCaptchaInit {
  SceneId: string
  mode: 'popup' | 'embed' | 'inline'
  element: string
  /** popup mode binds the trigger to this button; embed mode ignores it */
  button?: string
  captchaLogoImg?: string
  upLang?: Record<string, Record<string, string>>
  language?: string
  region?: string
  prefix?: string
  timeout?: number
  delayBeforeSuccess?: boolean
  immediate?: boolean
  slideStyle?: { width: number; height: number }
  success: (captchaVerifyParam: string) => void
  fail?: (e: unknown) => void
  onError?: (e: unknown) => void
  onClose?: () => void
  getInstance?: (instance: CaptchaInstance) => void
}

declare global {
  interface Window {
    AliyunCaptchaConfig?: { region: string; prefix: string }
    initAliyunCaptcha?: (init: AliyunCaptchaInit) => void
    __zaiCaptchaSdkReady?: Promise<void>
  }
}

function safeStr(e: unknown): string {
  if (typeof e === 'string') return e.slice(0, 140)
  try {
    return JSON.stringify(e).slice(0, 140)
  } catch {
    return 'unknown'
  }
}

/** Inject the hidden mount nodes once. The trigger button must stay
 * RENDERED (the SDK measures/binds it) — park it off-screen instead of
 * display:none, which breaks the popup in some builds. */
function ensureDom(): void {
  if (!document.getElementById(ELEMENT_ID)) {
    const el = document.createElement('div')
    el.id = ELEMENT_ID
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    el.style.top = '-9999px'
    el.style.width = '1px'
    el.style.height = '1px'
    el.style.overflow = 'hidden'
    document.body.appendChild(el)
  }
  if (!document.getElementById(BUTTON_ID)) {
    const btn = document.createElement('button')
    btn.id = BUTTON_ID
    btn.type = 'button'
    btn.setAttribute('aria-hidden', 'true')
    btn.style.position = 'fixed'
    btn.style.left = '-9999px'
    btn.style.top = '-9999px'
    btn.style.width = '1px'
    btn.style.height = '1px'
    btn.style.opacity = '0'
    document.body.appendChild(btn)
  }
}

/** Load the Aliyun SDK once per page (idempotent). */
function ensureSdk(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  if (window.__zaiCaptchaSdkReady) return window.__zaiCaptchaSdkReady
  window.__zaiCaptchaSdkReady = new Promise<void>((resolve, reject) => {
    window.AliyunCaptchaConfig = { region: REGION, prefix: PREFIX }
    if (window.initAliyunCaptcha) {
      ensureDom()
      resolve()
      return
    }
    const s = document.createElement('script')
    s.id = 'zai-captcha-sdk'
    s.src = SDK_URL
    s.async = true
    s.onload = () =>
      setTimeout(() => {
        try {
          ensureDom()
          resolve()
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }, 50)
    s.onerror = () => reject(new Error('Не удалось загрузить капчу Z.ai (скрипт Aliyun)'))
    document.head.appendChild(s)
  })
  return window.__zaiCaptchaSdkReady
}

/**
 * Run one verification and resolve with the one-time captcha_verify_param.
 * In trusted browsers this is instant and invisible (smart verification);
 * otherwise Z.ai shows its slider for the user to solve.
 */
export function solveZaiCaptcha(): Promise<string> {
  return ensureSdk().then(
    () =>
      new Promise<string>((resolve, reject) => {
        let settled = false
        const finish = (fn: () => void) => {
          if (settled) return
          settled = true
          fn()
        }
        let timer: ReturnType<typeof setTimeout> | null = null
        try {
          // fresh widget per verification (same as chat.z.ai's frontend)
          window.initAliyunCaptcha!({
            SceneId: SCENE_ID,
            mode: 'popup',
            element: `#${ELEMENT_ID}`,
            button: `#${BUTTON_ID}`,
            captchaLogoImg: 'https://z-cdn.chatglm.cn/z-ai/static/logo.svg',
            upLang: { en: RU_LANG },
            language: 'en',
            region: REGION,
            prefix: PREFIX,
            timeout: 10_000,
            delayBeforeSuccess: false,
            success: (param) =>
              finish(() => {
                if (timer) clearTimeout(timer)
                resolve(String(param || ''))
              }),
            fail: (e) =>
              finish(() => {
                if (timer) clearTimeout(timer)
                reject(new Error(`Капча Z.ai не прошла (${safeStr(e)}) — попробуй ещё раз`))
              }),
            onError: (e) =>
              finish(() => {
                if (timer) clearTimeout(timer)
                reject(new Error(`Капча Z.ai недоступна (${safeStr(e)})`))
              }),
            onClose: () =>
              finish(() => {
                if (timer) clearTimeout(timer)
                reject(new Error('Капча закрыта — попробуй ещё раз'))
              }),
          })
        } catch (e) {
          reject(new Error(`Капча Z.ai: ${safeStr(e)}`))
          return
        }
        // popup mode is bound to the (off-screen) trigger button; give the
        // SDK a beat to bind its click handler before firing it
        const btn = document.getElementById(BUTTON_ID) as HTMLButtonElement | null
        if (!btn) {
          finish(() => reject(new Error('Капча Z.ai не инициализирована')))
          return
        }
        setTimeout(() => {
          if (settled) return
          btn.click()
        }, 350)
        // safety timeout — widget stuck / network dead
        timer = setTimeout(
          () => finish(() => reject(new Error('Капча Z.ai не ответила — попробуй ещё раз'))),
          180_000,
        )
      }),
  )
}

/**
 * Invisible warm-up: loads the SDK + hidden DOM so the first solve starts
 * without extra latency. Safe to call on mount.
 */
export function preloadZaiCaptcha(): void {
  if (typeof window === 'undefined') return
  void ensureSdk().catch(() => {
    /* surfaced on the next solve attempt */
  })
}

/* ------------------------------------------------------------ auth scene */

const AUTH_ELEMENT_PREFIX = 'zai-auth-captcha-element'

/**
 * Visible, in-form AUTH-scene widget (the exact UX of chat.z.ai's own
 * signup/login page): embed mode, SceneId '36qgs6xb'. The user clicks the
 * bar; trusted sessions pass instantly, others get the rotate/inpainting
 * puzzle. Success yields a one-time captcha_verify_param that the backend
 * forwards to /auths/signup or /auths/signin.
 *
 * Re-initialized for every verification (one widget life = one param).
 * `token` (optional) forces a fresh init when it changes.
 */
export function ZaiAuthCaptcha({
  onParam,
  onError,
  token,
}: {
  onParam: (param: string) => void
  onError?: (message: string) => void
  /** change to force a re-init (e.g. after a failed submit) */
  token?: string | number
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle')
  const [msg, setMsg] = useState('')
  const mountRef = useRef<HTMLDivElement | null>(null)
  const idxRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const elementId = `${AUTH_ELEMENT_PREFIX}-${idxRef.current}`
    setState('idle')
    setMsg('')

    ensureSdk()
      .then(() => {
        if (cancelled) return
        const mount = mountRef.current
        if (!mount) return
        // fresh mount node per init (one widget life = one param)
        mount.innerHTML = ''
        const el = document.createElement('div')
        el.id = elementId
        mount.appendChild(el)

        const finishErr = (m: string) => {
          if (cancelled) return
          setState('error')
          setMsg(m)
          onError?.(m)
        }
        window.initAliyunCaptcha!({
          SceneId: AUTH_SCENE_ID,
          mode: 'embed',
          element: `#${elementId}`,
          region: REGION,
          prefix: PREFIX,
          language: 'en',
          upLang: { en: RU_LANG },
          slideStyle: { width: 320, height: 40 },
          captchaLogoImg: 'https://z-cdn.chatglm.cn/z-ai/static/logo.svg',
          success: (param) => {
            if (cancelled) return
            setState('ok')
            setMsg('')
            onParam(String(param || ''))
          },
          fail: (e) => finishErr(`Капча не прошла (${safeStr(e)}) — нажми проверку ещё раз`),
          onError: (e) => finishErr(`Капча недоступна (${safeStr(e)})`),
          onClose: () => {
            /* user closed the puzzle — widget stays for another attempt */
          },
        })
      })
      .catch((e) => {
        if (cancelled) return
        const m = e instanceof Error ? e.message : 'Капча Z.ai не загрузилась'
        setState('error')
        setMsg(m)
        onError?.(m)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  return (
    <div className="space-y-1.5">
      <div ref={mountRef} data-testid="zai-auth-captcha" className="min-h-[46px] [&_iframe]:max-w-full" />
      {state === 'ok' && (
        <p className="text-[11px] text-emerald-400">Проверка Z.ai пройдена ✓</p>
      )}
      {msg && <p className="text-[11px] text-red-400">{msg}</p>}
    </div>
  )
}
