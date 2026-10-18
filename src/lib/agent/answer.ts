/**
 * T16 (owner request 2026-10-18): the AI itself decides what the user sees.
 *
 * Output protocol — <answer>…</answer> is the ONLY text delivered to the
 * user; <file>name</file> tags pick which workspace files are delivered.
 * Everything else the model writes (plans, reasoning, commands, step logs)
 * is internal work and must never reach the chat on any surface
 * (site stream, GitHub Actions agent results, Telegram fast-chat).
 *
 * Single shared implementation so all surfaces behave identically.
 */

const RE_ANSWER = /<answer>([\s\S]*?)<\/answer>/gi
const RE_FILE = /<file>([\s\S]*?)<\/file>/gi

/** truly internal blocks — dropped even from fallback text */
const RE_INTERNAL =
  /<think>[\s\S]*?<\/think>|<thought>[\s\S]*?<\/thought>|<cmd[^>]*>[\s\S]*?<\/cmd>|<search>[\s\S]*?<\/search>|<read>[\s\S]*?<\/read>|<send\b[^>]*>[\s\S]*?<\/send>/gi

export interface ParsedAnswer {
  /** the text the user is allowed to see */
  text: string
  /** file names (basenames or workspace-relative paths) chosen by the AI */
  files: string[]
  /** true when the raw output actually contained <answer>…</answer> */
  tagged: boolean
}

/** no <answer> wrapper: unwrap the safe tags, drop the internal ones */
function cleanFallback(raw: string): string {
  return raw
    .replace(RE_INTERNAL, '')
    .replace(/<\/?(?:answer|file|final)>/gi, '')
    .trim()
}

export function parseAiAnswer(raw: string): ParsedAnswer {
  const src = String(raw || '')
  const answers: string[] = []
  for (const m of src.matchAll(RE_ANSWER)) {
    const t = (m[1] || '').trim()
    if (t) answers.push(t)
  }
  const files: string[] = []
  const seen = new Set<string>()
  for (const m of src.matchAll(RE_FILE)) {
    for (const line of (m[1] || '').split(/[\n,;]+/)) {
      const name = line
        .trim()
        .replace(/^\/tmp\/ws\//i, '')
        .replace(/^\.\//, '')
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase())
        files.push(name)
      }
    }
  }
  if (answers.length > 0)
    return { text: answers.join('\n\n'), files, tagged: true }
  return { text: cleanFallback(src), files, tagged: false }
}

/**
 * Does a collected workspace file match one of the requested names?
 * Accepts exact relative path or basename match, case-insensitive.
 */
export function fileWants(wanted: string[], path: string): boolean {
  const p = String(path || '').replace(/\\/g, '/')
  const base = (p.split('/').pop() || '').toLowerCase()
  return wanted.some((w) => {
    const ww = String(w || '').toLowerCase().replace(/^\.\//, '')
    if (!ww) return false
    return (
      ww === p.toLowerCase() ||
      ww === base ||
      p.toLowerCase().endsWith(`/${ww}`) ||
      (base !== '' && ww.endsWith(`/${base}`))
    )
  })
}

/**
 * Incremental filter for the site SSE bridge: passes through ONLY the text
 * between <answer> and </answer> (and swallows <file>…</file> blocks that the
 * model might place inside). Feed every content delta into push() and forward
 * what it returns to the client. flush() at stream end:
 *  - remainder of an unclosed <answer> is emitted;
 *  - if the model never produced a visible answer, the cleaned full text is
 *    returned (fallback: simple Q&A keeps working even without tags).
 * Tags split across deltas are handled via a hold-back buffer.
 */
export function createAnswerStreamFilter() {
  let full = ''
  let buf = ''
  let mode: 'wait' | 'answer' | 'skipfile' = 'wait'
  let emitted = false
  const HOLD = 10 // longest tag prefix we must not miss ('</answer>' = 9)

  return {
    push(delta: string): string {
      const d = String(delta || '')
      if (!d) return ''
      full += d
      buf += d
      let out = ''
      for (;;) {
        if (mode === 'wait') {
          const m = /<answer>/i.exec(buf)
          if (!m) {
            // everything before <answer> is invisible; keep a possible
            // partial tag tail for the next delta
            if (buf.length > HOLD) buf = buf.slice(buf.length - HOLD)
            break
          }
          buf = buf.slice(m.index + 8)
          mode = 'answer'
        } else if (mode === 'answer') {
          const mClose = /<\/answer>/i.exec(buf)
          const mFile = /<file>/i.exec(buf)
          if (mFile && (!mClose || mFile.index < mClose.index)) {
            if (mFile.index > 0) {
              out += buf.slice(0, mFile.index)
              emitted = true
            }
            buf = buf.slice(mFile.index + 6)
            mode = 'skipfile'
            continue
          }
          if (mClose) {
            if (mClose.index > 0) {
              out += buf.slice(0, mClose.index)
              emitted = true
            }
            buf = buf.slice(mClose.index + 9)
            mode = 'wait'
            continue
          }
          // no terminator yet: emit everything except the hold-back tail
          const safe = buf.length - HOLD
          if (safe > 0) {
            out += buf.slice(0, safe)
            buf = buf.slice(safe)
            emitted = true
          }
          break
        } else {
          // skipfile: swallow until </file>
          const mEnd = /<\/file>/i.exec(buf)
          if (mEnd) {
            buf = buf.slice(mEnd.index + 7)
            mode = 'answer'
            continue
          }
          if (buf.length > HOLD) buf = buf.slice(buf.length - HOLD)
          break
        }
      }
      return out
    },

    flush(): string {
      if (mode === 'answer') {
        const rest = buf.trim()
        buf = ''
        mode = 'wait'
        if (rest) {
          emitted = true
          return rest
        }
      }
      if (!emitted) return cleanFallback(full)
      return ''
    },
  }
}
