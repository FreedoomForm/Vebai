/**
 * Per-user REAL chat.z.ai accounts + bulletproof guest fallback (v4).
 *
 * A linked user owns a real chat.z.ai account: their JWT lives on the User
 * row, their AI traffic consumes THEIR OWN Z.ai quota, and chat completions
 * under a real account do NOT require the per-message captcha.
 *
 * resolveSession() refreshes a still-valid JWT via GET /auths/ (sliding
 * expiry). If a stored JWT dies (long inactivity), we DO NOT block the
 * user anymore: the request transparently continues on a fresh anonymous
 * guest session and the stream emits a typed `zai_downgraded` event — the
 * UI shows the "Подключить аккаунт Z.ai" card while the user keeps chatting
 * (guest sessions face Z.ai's per-message chat-scene captcha, which works
 * from our domain). The dead JWT is KEPT on the row: the account link (and
 * the fact that the user owns a real account) is restored via /api/auth/link.
 */

import { db } from '@/lib/db'
import { peekZaiJwtEmail, resolveSession, type ChatWebSession } from '@/lib/chatweb'

const GUEST_EMAIL_RE = /^guest-\d+@guest\.com$/i

export interface UserZaiSession {
  token: string
  zaiUserId: string
  role: string
  /** true when a fresh session had to be minted during this call */
  refreshed: boolean
  /** true when the stored real-account JWT died and a guest session took over */
  downgraded: boolean
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
 * Resolve the chat.z.ai session for a site user. NEVER throws for a dead
 * JWT — it downgrades to a guest session instead (the show goes on).
 */
export async function getUserZaiSession(userId: string | null | undefined): Promise<UserZaiSession> {
  if (userId) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { zaiToken: true },
    })
    if (user?.zaiToken) {
      const storedEmail = peekZaiJwtEmail(user.zaiToken)
      if (!storedEmail || GUEST_EMAIL_RE.test(storedEmail)) {
        // a stored guest token is the user's own per-user anonymous session
        // (minted on an earlier chat) — refresh it in place to keep chat
        // history continuity; it is NOT a linked account and must never
        // shadow a real one
        const session = await resolveSession(user.zaiToken)
        if (session.token !== user.zaiToken) await persist(userId, session)
        return { token: session.token, zaiUserId: session.userId, role: session.role, refreshed: true, downgraded: false }
      }
      try {
        const session = await resolveSession(user.zaiToken)
        // resolveSession may refresh the token — persist the latest
        if (session.token !== user.zaiToken) await persist(userId, session)
        return { token: session.token, zaiUserId: session.userId, role: session.role, refreshed: false, downgraded: false }
      } catch {
        // stored real JWT died — KEEP it on the row (it marks account
        // ownership and blocks the silent-downgrade overwrite) and continue
        // THIS request on a guest session; resolveSession now throws for
        // dead real tokens instead of silently returning a guest session
        const session = await resolveSession(null)
        return { token: session.token, zaiUserId: session.userId, role: session.role, refreshed: true, downgraded: true }
      }
    }
  }
  const session = await resolveSession(null)
  await persist(userId ?? null, session)
  return { token: session.token, zaiUserId: session.userId, role: session.role, refreshed: true, downgraded: false }
}
