/**
 * Per-user anonymous chat.z.ai sessions.
 *
 * Every site user gets their OWN anonymous (guest) session on chat.z.ai:
 * the session is minted server-side, stored on the User row and reused.
 * The user never sees or provides any token; the Z.ai quota is consumed
 * by that anonymous session. If the stored session dies (401), we mint a
 * fresh one transparently.
 *
 * Chat completions additionally require Z.ai's own captcha param (relay —
 * see src/components/agent/zai-captcha.tsx and src/lib/chatweb.ts), so the
 * session alone grants nothing without a human solving the widget.
 */

import { db } from '@/lib/db'
import { resolveSession, type ChatWebSession } from '@/lib/chatweb'

export interface UserZaiSession {
  token: string
  zaiUserId: string
  role: string
  /** true when a fresh session had to be minted during this call */
  refreshed: boolean
}

async function persist(userId: string | null, session: ChatWebSession): Promise<void> {
  if (!userId) return
  try {
    await db.user.update({
      where: { id: userId },
      data: {
        zaiToken: session.token,
        zaiUserId: session.userId,
        zaiSessionAt: new Date(),
      },
    })
  } catch {
    // user row may be gone mid-request — non-fatal
  }
}

/** Resolve (or mint) the chat.z.ai session for a site user. */
export async function getUserZaiSession(userId: string | null | undefined): Promise<UserZaiSession> {
  if (userId) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { zaiToken: true },
    })
    if (user?.zaiToken) {
      try {
        const session = await resolveSession(user.zaiToken)
        // resolveSession may refresh the token — persist the latest
        if (session.token !== user.zaiToken) await persist(userId, session)
        return { token: session.token, zaiUserId: session.userId, role: session.role, refreshed: false }
      } catch {
        // stale/invalid session — fall through and mint a new one
      }
    }
  }
  const session = await resolveSession(null)
  await persist(userId ?? null, session)
  return { token: session.token, zaiUserId: session.userId, role: session.role, refreshed: true }
}
