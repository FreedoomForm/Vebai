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

  const params = new URL(req.url).searchParams
  const take = Math.min(Number(params.get('limit') || 40), 100)
  // T17: optional per-chat view — the agent panel lists only the files of the
  // conversation it is opened for (ownership verified against the session user)
  const conversationId = params.get('conversationId')
  const uid = user?.id || ''
  let whereConversation: { conversationId: { in: string[] } | string }
  if (conversationId) {
    const owned = uid
      ? await db.conversation.findFirst({
          where: { id: conversationId, userId: uid },
          select: { id: true },
        })
      : null
    whereConversation = { conversationId: owned ? conversationId : '__none__' }
  } else {
    const convIds = uid
      ? (await db.conversation.findMany({ where: { userId: uid }, select: { id: true } })).map((c) => c.id)
      : []
    whereConversation = { conversationId: { in: convIds } }
  }
  const files = await db.terminalFile.findMany({
    where: whereConversation,
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
