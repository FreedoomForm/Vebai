import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** T47: tiny liveness probe that touches the DB exactly once per call.
 * Vercel cron hits it daily (vercel.json) — one `SELECT 1` a day counts as
 * activity for the Supabase free tier, whose projects pause after 7 days
 * WITHOUT any activity (the exact reason this app fled Supabase for Neon
 * back then). Zero cost on the unlimited-hours plan; doubles as an honest
 * uptime probe: 200 = app + database healthy, 503 = database unavailable. */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`
    return NextResponse.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { ok: false, error: `database unavailable: ${msg.slice(0, 160)}` },
      { status: 503 },
    )
  }
}
