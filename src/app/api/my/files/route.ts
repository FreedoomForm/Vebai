import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/my/files — files produced by THIS user's tasks (Telegram bot or
 * site agent), newest first. Files are linked to conversations via
 * TerminalFile.conversationId; conversations belong to the session user.
 * Download links point to /api/terminal/files/<id> (cookie-auth works).
 */
export async function GET(req: NextRequest) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized

  const take = Math.min(Number(new URL(req.url).searchParams.get('limit') || 40), 100)
  const files = await db.terminalFile.findMany({
    where: user
      ? { conversation: { userId: user.id } }
      : {},
    orderBy: { updatedAt: 'desc' },
    take,
    select: {
      id: true,
      path: true,
      size: true,
      mime: true,
      tgOk: true,
      updatedAt: true,
      conversationId: true,
    },
  })
  return NextResponse.json({
    files: files.map((f) => ({
      id: f.id,
      name: f.path.split('/').pop() || f.path,
      path: f.path,
      size: f.size,
      mime: f.mime,
      tgOk: f.tgOk,
      conversationId: f.conversationId,
      updatedAt: f.updatedAt.toISOString(),
      url: `/api/terminal/files/${f.id}`,
    })),
  })
}
