import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { zai } from '@/lib/zai'

export const dynamic = 'force-dynamic'

/**
 * TEMPORARY diagnostic endpoint (v13 deploy troubleshooting).
 * GET /api/diag?key=... — checks DB connectivity and Z.ai API presence.
 * Returns masked values only: no credentials, just error texts + hosts.
 * Remove after the deployment is verified.
 */
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key') || ''
  const expected = process.env.CRON_SECRET || 'diag-vebai-2026'
  if (key !== expected) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const report: Record<string, unknown> = {
    time: new Date().toISOString(),
    env: {
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      databaseUrlShape: (process.env.DATABASE_URL || '')
        .replace(/\/\/([^@]+)@/, '//***@')
        .slice(0, 80),
      hasZaiKey: Boolean(process.env.ZAI_API_KEY),
      zaiBaseUrl: process.env.ZAI_BASE_URL || '(default)',
      zaiModel: process.env.ZAI_MODEL || '(default)',
      nodeRuntime: process.env.NEXT_RUNTIME || 'nodejs',
      region: process.env.VERCEL_REGION || '?',
    },
  }

  // ---- DB probe
  const t0 = Date.now()
  try {
    await db.$queryRaw`SELECT 1`
    report.db = { ok: true, ms: Date.now() - t0 }
  } catch (e) {
    report.db = {
      ok: false,
      ms: Date.now() - t0,
      error: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500),
    }
  }

  // ---- Z.ai probe (tiny, cheap call — thinking disabled, 8 tokens)
  try {
    const r = await zai.chat.completions({
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
    })
    report.zai = { ok: true, model: r.choices?.[0]?.message ? 'answered' : 'empty' }
  } catch (e) {
    report.zai = {
      ok: false,
      error: e instanceof Error ? e.message.slice(0, 400) : String(e).slice(0, 400),
    }
  }

  return NextResponse.json(report)
}
