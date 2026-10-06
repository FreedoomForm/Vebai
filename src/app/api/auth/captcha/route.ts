import { NextResponse } from 'next/server'
import { createCaptcha } from '@/lib/captcha'

export const dynamic = 'force-dynamic'

/** GET /api/auth/captcha — a fresh SVG challenge for the registration form. */
export async function GET() {
  try {
    const challenge = await createCaptcha()
    return NextResponse.json(challenge, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'captcha unavailable' },
      { status: 500 },
    )
  }
}
