/**
 * Self-hosted SVG captcha for the registration form.
 *
 * Product decision: site users NEVER provide a chat.z.ai JWT — registration
 * is gated by this local captcha instead. Challenges live in Postgres
 * (serverless-safe), are single-use and expire after 10 minutes.
 */

import crypto from 'node:crypto'
import { db } from '@/lib/db'

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // no 0/O/1/I/L confusables
const CHARS = 5
const TTL_MS = 10 * 60 * 1000

/** inclusive integer range */
const rnd = (min: number, max: number) => min + crypto.randomInt(0, max - min + 1)

export interface CaptchaChallenge {
  id: string
  svg: string
  /** epoch ms, informational for the client */
  expiresAt: number
}

export async function createCaptcha(): Promise<CaptchaChallenge> {
  // opportunistic cleanup of expired rows (cheap, indexed)
  await db.captcha.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined)

  let text = ''
  for (let i = 0; i < CHARS; i++) text += ALPHABET[crypto.randomInt(0, ALPHABET.length)]
  const expiresAt = new Date(Date.now() + TTL_MS)
  const row = await db.captcha.create({ data: { answer: text, expiresAt } })
  return { id: row.id, svg: renderSvg(text), expiresAt: expiresAt.getTime() }
}

/** Verifies and consumes the challenge (single-use regardless of outcome). */
export async function verifyCaptcha(id: string, answer: string): Promise<boolean> {
  if (!id || !answer) return false
  const row = await db.captcha.findUnique({ where: { id } }).catch(() => null)
  if (!row) return false
  await db.captcha.delete({ where: { id } }).catch(() => undefined)
  if (row.expiresAt.getTime() < Date.now()) return false
  return row.answer.toUpperCase() === answer.trim().toUpperCase()
}

/* --------------------------------------------------------------- renderer */

const PALETTE = ['#6ee7b7', '#34d399', '#a7f3d0', '#fcd34d', '#93c5fd', '#e2e8f0']

function renderSvg(text: string): string {
  const W = 172
  const H = 56
  const color = () => PALETTE[rnd(0, PALETTE.length - 1)]

  let shapes = ''
  for (let i = 0; i < 5; i++) {
    shapes += `<line x1="${rnd(0, W)}" y1="${rnd(0, H)}" x2="${rnd(0, W)}" y2="${rnd(0, H)}" stroke="${color()}" stroke-width="1" opacity="0.25"/>`
  }
  for (let i = 0; i < 3; i++) {
    shapes += `<circle cx="${rnd(0, W)}" cy="${rnd(0, H)}" r="${rnd(16, 42)}" fill="none" stroke="${color()}" stroke-width="1" opacity="0.2"/>`
  }
  for (let i = 0; i < 40; i++) {
    shapes += `<circle cx="${rnd(0, W)}" cy="${rnd(0, H)}" r="1" fill="${color()}" opacity="0.35"/>`
  }

  let glyphs = ''
  const step = (W - 36) / CHARS
  for (let i = 0; i < CHARS; i++) {
    const x = 22 + step * i + rnd(-3, 3)
    const y = 38 + rnd(-4, 4)
    const rot = rnd(-24, 24)
    const size = rnd(26, 33)
    const fam = i % 2 === 0 ? 'monospace' : 'Georgia,serif'
    glyphs += `<text x="${x}" y="${y}" font-family="${fam}" font-size="${size}" font-weight="700" fill="${color()}" transform="rotate(${rot} ${x} ${y})">${text[i]}</text>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" rx="8" fill="#0b0e0d"/>${shapes}${glyphs}</svg>`
}
