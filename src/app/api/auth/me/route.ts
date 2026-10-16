import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_REQUIRED, requireAuth } from '@/lib/auth'
import { DEFAULT_CHAT_MODEL } from '@/lib/zai-config'

export const dynamic = 'force-dynamic'

/** GET /api/auth/me — current session user (401 when auth is required and missing) */
export async function GET(req: NextRequest) {
  if (!AUTH_REQUIRED)
    return NextResponse.json({ user: null, authRequired: false, model: DEFAULT_CHAT_MODEL })

  const { user } = await requireAuth(req)
  if (!user) return NextResponse.json({ user: null, authRequired: true }, { status: 401 })
  return NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name },
    authRequired: true,
    model: DEFAULT_CHAT_MODEL,
  })
}
