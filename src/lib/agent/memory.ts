import { db } from '@/lib/db'

/**
 * T52 (owner request 2026-10-23): shared helpers over the SHARED agent
 * memory — one plain-text store (StudioState key 'agentMemory') that the
 * agent fills through <memory>…</memory> and <end> recap tags, the owner
 * reads/edits on the site's memory page, and every agent context includes
 * (runner task header, incoming-DM tasks, site chat requests).
 */

const KEY = 'agentMemory'
const CAP_CHARS = 24_000

type MemData = { text?: string; updatedAt?: string }

export async function readMemText(): Promise<string> {
  const row = await db.studioState.findUnique({ where: { key: KEY } }).catch(() => null)
  if (!row) return ''
  try {
    const d = JSON.parse(row.data) as MemData
    return String(d.text || '')
  } catch {
    return ''
  }
}

export async function writeMemText(text: string): Promise<void> {
  const data = JSON.stringify({ text, updatedAt: new Date().toISOString() } satisfies MemData)
  await db.studioState.upsert({
    where: { key: KEY },
    create: { key: KEY, data },
    update: { data },
  })
}

/** append a note with an honest source marker; hard-capped to the last 24k chars */
export async function appendMemText(text: string, source = 'memory'): Promise<string> {
  const t = String(text || '').trim().slice(0, 1500)
  const src = String(source || 'memory').replace(/[^\w-]/g, '').slice(0, 10) || 'memory'
  if (!t) return readMemText()
  const stamp = new Date().toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  })
  const prev = await readMemText()
  const merged = ((prev ? prev.trimEnd() + '\n' : '') + `[${stamp} · ${src}] ${t}`).slice(-CAP_CHARS)
  await writeMemText(merged)
  return merged
}
