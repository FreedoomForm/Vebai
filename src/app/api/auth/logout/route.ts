import { NextResponse } from 'next/server'
import { clearSessionCookieHeader } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** POST /api/auth/logout — drop the session cookie */
export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.headers.append('Set-Cookie', clearSessionCookieHeader())
  return res
}
