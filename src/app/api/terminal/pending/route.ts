import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** GET /api/terminal/pending — badge count for the sidebar terminal button */
export async function GET(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized

  const pending = await db.terminalCommand.count({
    where: {
      status: 'pending',
      session: { kind: 'browser', status: 'active', userId: user ? user.id : undefined },
    },
  })
  return NextResponse.json({ pending })
}
