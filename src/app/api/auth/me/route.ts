import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, requireAuth } from '@/lib/auth'
import { DEFAULT_CHATWEB_MODEL } from '@/lib/chatweb'

export const dynamic = 'force-dynamic'

/** GET /api/auth/me — current session user (401 when auth is required and missing) */
export async function GET(req: NextRequest) {
  if (!AUTH_REQUIRED)
    return NextResponse.json({ user: null, authRequired: false, model: DEFAULT_CHATWEB_MODEL })

  const { user } = await requireAuth(req)
  if (!user) return NextResponse.json({ user: null, authRequired: true }, { status: 401 })
  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { zaiToken: true },
  })
  return NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name },
    authRequired: true,
    model: DEFAULT_CHATWEB_MODEL,
    // whether a real chat.z.ai account session is attached to this profile
    zaiLinked: Boolean(row?.zaiToken),
  })
}
