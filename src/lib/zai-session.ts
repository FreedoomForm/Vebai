/**
 * Per-user REAL chat.z.ai accounts.
 *
 * Registration on this site creates a REAL chat.z.ai account with the
 * email/password the user chose (behind Z.ai's own auth-scene captcha).
 * The returned JWT is stored on the User row and reused for all their AI
 * traffic — the user owns the account and consumes their OWN Z.ai quota.
 * Chat completions under a real account do NOT require the per-message
 * captcha (that gate only exists for anonymous guest sessions).
 *
 * resolveSession() refreshes a still-valid JWT via GET /auths/ (sliding
 * expiry). If a stored JWT dies (long inactivity), we surface a typed
 * `zai_session_expired` error so the user re-logs in — we deliberately do
 * NOT downgrade to an anonymous guest session (that would lose ownership
 * of the account and reintroduce the per-message captcha).
 */

import { db } from '@/lib/db'
import { resolveSession, ChatWebError, type ChatWebSession } from '@/lib/chatweb'

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

/**
 * Resolve the chat.z.ai session for a site user.
 * - Real account (stored JWT): refresh via /auths/; dead JWT → typed
 *   ChatWebError('zai_session_expired') — the UI asks for a re-login.
 * - No stored JWT (legacy/anon rows): mint an anonymous guest session
 *   (legacy behaviour — those users still face Z.ai's per-message captcha).
 */
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
        // stored JWT is dead — do NOT silently downgrade to a guest session:
        // the user owns a real account and must re-login to keep it.
        throw new ChatWebError(
          'Сессия Z.ai истекла — войди заново (капча Z.ai потребуется один раз).',
          'zai_session_expired',
        )
      }
    }
  }
  const session = await resolveSession(null)
  await persist(userId ?? null, session)
  return { token: session.token, zaiUserId: session.userId, role: session.role, refreshed: true }
}
