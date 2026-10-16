import { NextRequest, NextResponse } from 'next/server'
import { kernelStatus, kernelOutputFiles } from '@/lib/kaggle'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * TEMPORARY diagnostic: worker kernel status + run log tail + state summary.
 * Gated by a one-off secret (?k=...). REMOVE after the stuck-worker diagnosis.
 */
export async function GET(req: NextRequest) {
  const KEY = 'diag-9f2x7q1m'
  if (req.nextUrl.searchParams.get('k') !== KEY)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const state = await db.studioState.findUnique({ where: { key: 'studio' } })
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(state?.data || '{}') as Record<string, unknown> } catch { /* */ }

  const out: Record<string, unknown> = {
    state: parsed,
    jobs: await db.job.findMany({
      where: { batchId: 'bmvb4ju66' },
      select: { shotNum: true, status: true, error: true, updatedAt: true },
      orderBy: { shotNum: true },
    }),
  }
  try {
    out.kernelStatus = await kernelStatus('freedomform/rmc-studio-worker')
  } catch (e) {
    out.kernelStatus = `ERR: ${e instanceof Error ? e.message : String(e)}`
  }
  try {
    const { files, log } = await kernelOutputFiles('freedomform/rmc-studio-worker')
    out.outputFiles = files.map((f) => f.fileName).slice(0, 20)
    out.logTail = log.slice(-4000)
  } catch (e) {
    out.logTail = `ERR: ${e instanceof Error ? e.message : String(e)}`
  }
  return NextResponse.json(out)
}
