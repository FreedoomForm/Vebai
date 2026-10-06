'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * TEMPORARY captcha diagnostics page (vebai-8, secret-gated ?k=).
 * Loads the REAL Aliyun widget (both Z.ai scenes), and on a solved
 * verification immediately tests the one-time param against chat.z.ai
 * signup/signin from OUR OWN backend — surfacing the exact upstream
 * response. Used to explain "green but rejected" captcha reports.
 */

const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
const SCENES: Record<string, string> = { chat: 'didk33e0', auth: '36qgs6xb' }

declare global {
  interface Window {
    AliyunCaptchaConfig?: { region: string; prefix: string }
    initAliyunCaptcha?: (o: Record<string, unknown>) => void
  }
}

export default function CaptchaLab() {
  const [ready, setReady] = useState('loading sdk…')
  const [result, setResult] = useState('')
  const [scene, setScene] = useState<'chat' | 'auth'>('chat')
  const [mode, setMode] = useState<'signup' | 'signin'>('signup')
  const mountRef = useRef<HTMLDivElement | null>(null)
  const keyRef = useRef('')

  useEffect(() => {
    keyRef.current = new URLSearchParams(window.location.search).get('k') || ''
    window.AliyunCaptchaConfig = { region: 'sgp', prefix: 'no8xfe' }
    const s = document.createElement('script')
    s.src = SDK_URL
    s.onload = () => setReady('sdk ready')
    s.onerror = () => setReady('SDK LOAD FAIL')
    document.head.appendChild(s)
  }, [])

  const run = () => {
    const mount = mountRef.current
    if (!mount || !window.initAliyunCaptcha) return
    mount.innerHTML = ''
    const el = document.createElement('div')
    el.id = 'lab-el'
    mount.appendChild(el)
    setReady(`solving ${scene}/${mode}…`)
    window.initAliyunCaptcha({
      SceneId: SCENES[scene],
      mode: 'popup',
      element: '#lab-el',
      region: 'sgp',
      prefix: 'no8xfe',
      language: 'en',
      timeout: 10000,
      success: (param: string) => {
        setReady(`${scene} SOLVED — testing ${mode}…`)
        fetch(`/api/captcha-lab?k=${encodeURIComponent(keyRef.current)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scene, mode, param }),
        })
          .then((r) => r.text())
          .then((t) => {
            setResult(t)
            setReady(`${scene} done`)
          })
          .catch((e) => setReady('report failed: ' + String(e)))
      },
      fail: (e: unknown) => setReady(`${scene} FAIL ${JSON.stringify(e).slice(0, 140)}`),
      onError: (e: unknown) => setReady(`${scene} ERR ${JSON.stringify(e).slice(0, 140)}`),
    })
    setTimeout(() => {
      const btn = el.querySelector<HTMLButtonElement>('#zai-captcha-trigger')
      void btn
      // popup mode needs a bound trigger; use the widget's own button if any,
      // else the embed renders inline — click the first child
      const trigger = document.getElementById('lab-el') as HTMLElement | null
      trigger?.click()
    }, 400)
  }

  return (
    <div style={{ font: '14px system-ui', background: '#111', color: '#eee', padding: 20, minHeight: '100dvh' }}>
      <h1 style={{ fontSize: 16 }}>captcha lab (hidden)</h1>
      <p>{ready}</p>
      <div style={{ display: 'flex', gap: 12, margin: '12px 0' }}>
        <label>
          scene:{' '}
          <select value={scene} onChange={(e) => setScene(e.target.value as 'chat' | 'auth')}>
            <option value="chat">chat (didk33e0)</option>
            <option value="auth">auth (36qgs6xb)</option>
          </select>
        </label>
        <label>
          mode:{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as 'signup' | 'signin')}>
            <option value="signup">signup</option>
            <option value="signin">signin</option>
          </select>
        </label>
        <button onClick={run} style={{ padding: '4px 14px' }}>
          solve &amp; test
        </button>
      </div>
      <div ref={mountRef} />
      <pre style={{ whiteSpace: 'pre-wrap', color: '#9f9', marginTop: 14, fontSize: 12 }}>{result}</pre>
    </div>
  )
}
