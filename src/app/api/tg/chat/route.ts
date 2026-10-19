/**
 * T28: POST /api/tg/chat — get-or-create the user's agent conversation.
 * This is the chat the owner opens with the «TG-агент» composer connector;
 * its transcript is the context the personal agent uses when it answers
 * incoming Telegram DMs (see /api/tg/incoming + loadAgentContext).
 */
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getAgentConversation } from '@/lib/tguser'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const conversationId = await getAgentConversation(user.id)
    return NextResponse.json({ conversationId })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.slice(0, 200) : 'не удалось открыть чат агента' },
      { status: 500 },
    )
  }
}
