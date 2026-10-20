import { NextRequest, NextResponse } from 'next/server'
import { agentTick } from '@/lib/agent/worker'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/agent/tick — one unit of background work.
 *
 * On Vercel this is the 24/7 driver: wire it to Vercel Cron (Pro) or any
 * external pinger (cron-job.org, GitHub Actions, UptimeRobot...) with an
 * optional CRON_SECRET: /api/agent/tick?secret=...
 */
export async function GET(req: NextRequest) {
  const required = process.env.CRON_SECRET
  if (required) {
    const provided = req.nextUrl.searchParams.get('secret') ||
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (provided !== required)
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const t0 = Date.now()
  await agentTick()
  return NextResponse.json({ ok: true, ms: Date.now() - t0 })
}
