import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * TEMPORARY diagnostic (vebai-8): accepts a REAL, human/automation-solved
 * Aliyun captcha param and immediately tests it against chat.z.ai signup.
 * Returns the EXACT upstream status + body so we can see WHY a solved
 * captcha is rejected ("green but captcha_failed" user report).
 *
 * Secret-gated by ?k= — remove after the captcha question is settled.
 */
const LAB_SECRET = 'lab-2f8a41c9d7e64b35'
const BASE = 'https://chat.z.ai'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  if (url.searchParams.get('k') !== LAB_SECRET)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let param = ''
  let scene = 'chat'
  let mode = 'signup'
  let email = ''
  let password = ''
  try {
    const body = (await req.json()) as Record<string, unknown>
    param = String(body.param || '').slice(0, 8192)
    scene = String(body.scene || 'chat')
    mode = String(body.mode || 'signup')
    email = String(body.email || `captchatest${Date.now()}@proton.me`)
    password = String(body.password || 'VebaiLab!2026')
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 })
  }
  if (!param) return NextResponse.json({ error: 'no param' }, { status: 400 })

  const endpoint = mode === 'signin' ? '/api/v1/auths/signin' : '/api/v1/auths/signup'
  const payload =
    mode === 'signin'
      ? { email, password, captcha_verify_param: param }
      : {
          name: email.split('@')[0],
          email,
          password,
          profile_image_url: '/static/favicon.png',
          sso_redirect: '',
          captcha_verify_param: param,
        }

  try {
    const res = await fetch(`${BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: BASE,
        Referer: `${BASE}/`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    })
    const txt = await res.text().catch(() => '')
    return NextResponse.json({
      tested: { endpoint, mode, scene, email, password },
      status: res.status,
      upstream: txt.slice(0, 500),
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
