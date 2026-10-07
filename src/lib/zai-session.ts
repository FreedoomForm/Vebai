/**
 * Per-user Z.ai sessions (v12) — personal quota, ZERO navigation.
 *
 * Every site user automatically owns a DEDICATED chat.z.ai session, minted
 * server-side at registration (GET /api/v1/auths/ without auth → a fresh
 * anonymous session whose free quota belongs to THIS user alone). The token
 * lives on the User row and all AI traffic consumes that personal quota —
 * the user never leaves our site.
 *
 * Session kinds:
 *   - `personal` — auto-minted dedicated session (default for everyone).
 *     Dead/expired personal tokens are transparently re-minted: a personal
 *     session is ours, replacing it costs nothing but a fresh quota bucket.
 *   - `real` — an actual chat.z.ai account session the user attached later
 *     (token bridge / paste). Silent-downgrade guard: a real token is NEVER
 *     overwritten by a personal one, and a dead real token surfaces
 *     `zai_session_expired` instead of being silently swapped.
 */

import { db } from '@/lib/db'
import { ChatWebError, peekZaiJwtEmail, resolveSession, type ChatWebSession } from '@/lib/chatweb'

const GUEST_EMAIL_RE = /^guest-\d+@guest\.com$/i

export type ZaiSessionKind = 'personal' | 'real'

export interface UserZaiSession {
  token: string
  zaiUserId: string
  email: string
  kind: ZaiSessionKind
}

function isGuestEmail(email: string): boolean {
  return !email || GUEST_EMAIL_RE.test(email)
}

async function persist(userId: string, session: ChatWebSession): Promise<void> {
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

/** Server cannot reach chat.z.ai right now (WAF / outage / rate limit). */
export function zaiUnavailable(detail = ''): ChatWebError {
  return new ChatWebError(
    `Z.ai сейчас недоступен для подключения личной сессии${detail ? ` (${detail})` : ''}. Попробуй ещё раз через минуту — диалоги сохранены.`,
    'zai_unavailable',
  )
}

/**
 * Resolve (and if needed mint) the chat.z.ai session for a site user.
 * Never falls back to a shared pool: the returned session belongs to this
 * user only. Throws ChatWebError with typed codes:
 *   zai_session_expired (dead REAL account) | zai_unavailable (z.ai unreachable)
 */
export async function ensureUserZaiSession(
  userId: string | null | undefined,
): Promise<UserZaiSession> {
  if (!userId) throw zaiUnavailable('нет пользователя')

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { zaiToken: true },
  })
  const stored = user?.zaiToken || ''
  const storedEmail = stored ? peekZaiJwtEmail(stored) : ''
  const storedIsReal = Boolean(stored) && !isGuestEmail(storedEmail)

  // ---- REAL linked account: use it, never silently downgrade
  if (storedIsReal) {
    try {
      const session = await resolveSession(stored)
      if (isGuestEmail(session.email))
        throw new ChatWebError(
          'Сессия chat.z.ai истекла — аккаунт подключён, но токен устарел. Перелогинься (кнопка «Аккаунт Z.ai»).',
          'zai_session_expired',
        )
      if (session.token !== stored) await persist(userId, session)
      return { token: session.token, zaiUserId: session.userId, email: session.email, kind: 'real' }
    } catch (e) {
      if (e instanceof ChatWebError) throw e
      throw new ChatWebError(
        'Сессия chat.z.ai истекла — аккаунт подключён, но токен устарел. Перелогинься (кнопка «Аккаунт Z.ai»).',
        'zai_session_expired',
      )
    }
  }

  // ---- PERSONAL dedicated session: refresh the live one or mint a fresh one
  if (stored) {
    try {
      const session = await resolveSession(stored)
      if (session.token !== stored) await persist(userId, session)
      return {
        token: session.token,
        zaiUserId: session.userId,
        email: session.email,
        kind: 'personal',
      }
    } catch {
      // dead personal token — fall through and mint a new one
    }
  }

  let fresh: ChatWebSession
  try {
    fresh = await resolveSession(null) // no auth -> dedicated anonymous session
  } catch (e) {
    if (e instanceof ChatWebError) throw zaiUnavailable(e.code)
    throw zaiUnavailable()
  }
  if (!isGuestEmail(fresh.email)) {
    // sanity: an unauthenticated mint must be guest-class; a non-guest
    // answer would mean their API changed — do not persist it
    throw zaiUnavailable('неожиданный ответ auths/')
  }
  await persist(userId, fresh)
  return { token: fresh.token, zaiUserId: fresh.userId, email: fresh.email, kind: 'personal' }
}
