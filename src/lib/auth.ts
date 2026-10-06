/**
 * Minimal auth for Vebai: local users + HMAC-signed session cookies.
 *
 * - Passwords: scrypt (node:crypto) with per-user salt.
 * - Sessions: base64url(JSON payload) + '.' + HMAC-SHA256(APP_SECRET).
 *   No extra dependencies; works on Vercel Node runtime.
 * - AUTH_REQUIRED=false disables the gate (sandbox/self-host mode).
 */

import crypto from 'node:crypto'
import { db } from '@/lib/db'

export const AUTH_REQUIRED = process.env.AUTH_REQUIRED !== 'false'
export const SESSION_COOKIE = 'vb_session'
const SESSION_TTL_SEC = 60 * 60 * 24 * 30 // 30 days

function appSecret(): string {
  return (
    process.env.APP_SECRET ||
    crypto.createHash('sha256').update(process.env.DATABASE_URL || 'vebai-dev-secret').digest('hex')
  )
}

/* ------------------------------------------------------------- passwords */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `s2$${salt}$${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [, salt, hash] = stored.split('$')
    if (!salt || !hash) return false
    const test = crypto.scryptSync(password, salt, 64)
    const ref = Buffer.from(hash, 'hex')
    return test.length === ref.length && crypto.timingSafeEqual(test, ref)
  } catch {
    return false
  }
}

/* -------------------------------------------------------------- sessions */

interface SessionPayload {
  uid: string
  exp: number
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

function sign(data: string): string {
  return crypto.createHmac('sha256', appSecret()).update(data).digest('base64url')
}

export function createSessionToken(userId: string): string {
  const payload: SessionPayload = { uid: userId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC }
  const data = b64url(JSON.stringify(payload))
  return `${data}.${sign(data)}`
}

export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const data = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = sign(data)
  if (sig.length !== expected.length) return null
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as SessionPayload
    if (!payload.uid || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export interface SessionUser {
  id: string
  email: string
  name: string
  zaiToken: string | null
}

export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const cookieHeader = req.headers.get('cookie') || ''
  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  const token = match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : null
  const payload = verifySessionToken(token)
  if (!payload) return null
  const user = await db.user.findUnique({
    where: { id: payload.uid },
    select: { id: true, email: true, name: true, zaiToken: true },
  })
  return user
}

export interface AuthResult {
  user: SessionUser | null // always null when AUTH_REQUIRED=false
  unauthorized: Response | null
}

/** Gate for API routes. When AUTH_REQUIRED=false everything passes open. */
export async function requireAuth(req: Request): Promise<AuthResult> {
  if (!AUTH_REQUIRED) return { user: null, unauthorized: null }
  const user = await getSessionUser(req)
  if (!user) {
    return {
      user: null,
      unauthorized: new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    }
  }
  return { user, unauthorized: null }
}

export function sessionCookieHeader(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SEC}`,
  ]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookieHeader(): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  return parts.join('; ')
}
