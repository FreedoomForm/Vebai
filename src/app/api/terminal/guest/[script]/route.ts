import { NextRequest, NextResponse } from 'next/server'
import { guestInitSh, guestRestoreSh } from '@/lib/terminal/guest-scripts'

export const dynamic = 'force-dynamic'

/**
 * GET /api/terminal/guest/[script] — shell scripts executed INSIDE the VM:
 *   wget -qO- "<origin>/api/terminal/guest/init.sh" | sh -s <origin> <sid> <secret>
 * Plain text, never cached.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ script: string }> }) {
  const { script } = await params
  let body: string
  if (script === 'init.sh') body = guestInitSh()
  else if (script === 'restore.sh') body = guestRestoreSh()
  else return NextResponse.json({ error: 'not found' }, { status: 404 })

  return new NextResponse(body, {
    headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
