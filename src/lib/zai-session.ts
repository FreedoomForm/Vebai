/**
 * Per-user REAL chat.z.ai accounts only — guest mode is REMOVED (v5).
 *
 * Every user must chat under their OWN linked chat.z.ai account: the JWT
 * lives on the User row and all AI traffic consumes THEIR OWN Z.ai quota.
 * Anonymous/guest sessions (shared quota, per-message captcha, silent
 * "nothing happened" failures) no longer exist.
 *
 * - No linked account (or only a stale per-user guest token on the row)
 *   -> throws ChatWebError code `zai_not_linked`; the UI opens the
 *   "Подключить аккаунт Z.ai" card.
 * - A linked real JWT that died (long inactivity) -> `zai_session_expired`;
 *   the dead JWT is KEPT on the row (it marks account ownership) and the UI
 *   opens the same card for a re-login.
 *
 * resolveSession() refreshes a still-valid JWT via GET /auths/ (sliding
 * expiry) and persists the refreshed token back to the row.
 */

import { db } from '@/lib/db'
import { ChatWebError, peekZaiJwtEmail, resolveSession, type ChatWebSession } from '@/lib/chatweb'

const GUEST_EMAIL_RE = /^guest-\d+@guest\.com$/i

export interface UserZaiSession {
  token: string
  zaiUserId: string
  role: string
  /** true when resolveSession refreshed the stored token during this call */
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

function notLinked(): ChatWebError {
  return new ChatWebError(
    'Гостевой режим отключён: сообщения идут только с подключённого аккаунта Z.ai. Нажми «Z.ai» внизу слева и подключи свой аккаунт — это твоя личная квота, без капчи в чате.',
    'zai_not_linked',
  )
}

/**
 * Resolve the chat.z.ai session for a site user. Throws (never falls back to
 * a guest session): `zai_not_linked` when no real account is attached,
 * `zai_session_expired` when the stored JWT died.
 */
export async function getUserZaiSession(userId: string | null | undefined): Promise<UserZaiSession> {
  if (!userId) throw notLinked()
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { zaiToken: true },
  })
  if (!user?.zaiToken) throw notLinked()
  const storedEmail = peekZaiJwtEmail(user.zaiToken)
  if (!storedEmail || GUEST_EMAIL_RE.test(storedEmail)) {
    // a stored guest token is a leftover of the removed guest mode —
    // it is NOT a linked account
    throw notLinked()
  }
  try {
    const session = await resolveSession(user.zaiToken)
    // resolveSession may refresh the token — persist the latest
    if (session.token !== user.zaiToken) await persist(userId, session)
    return { token: session.token, zaiUserId: session.userId, role: session.role, refreshed: false }
  } catch (e) {
    // stored real JWT died — KEEP it on the row (it marks account ownership
    // and blocks the silent-downgrade overwrite) and surface a typed error
    if (e instanceof ChatWebError) throw e
    throw new ChatWebError(
      'Сессия chat.z.ai истекла — аккаунт подключён, но токен устарел. Перелогинься (кнопка «Аккаунт Z.ai»).',
      'zai_session_expired',
    )
  }
}
