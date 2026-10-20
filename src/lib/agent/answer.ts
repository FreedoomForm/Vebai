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
 * T35 (owner request 2026-10-20): the model used to obey the <answer>/<file>
 * protocol, then started writing "whatever it wants" (untagged replies, empty
 * <answer> fields) — and every surface silently fell back to showing the raw
 * text or "(пустой ответ модели)". From now on every surface checks the
 * protocol MECHANICALLY and auto-repeats the request with a corrective note
 * when the model breaks it.
 *
 * ok=true  — protocol satisfied (a non-empty <answer> exists, or an unclosed
 *            <answer> carries a non-empty tail: a cut stream still delivered).
 * reason:
 *   'empty'         — the model answered with an EMPTY field (nothing at all);
 *   'empty_answer'  — <answer> tag(s) present but every one of them is empty;
 *   'no_answer_tag' — non-empty text, but never wrapped in <answer>…</answer>.
 */
export type AnswerVerdictReason = 'empty' | 'empty_answer' | 'no_answer_tag'

export interface AnswerVerdict {
  ok: boolean
  reason?: AnswerVerdictReason
}

export function checkAnswerProtocol(raw: string): AnswerVerdict {
  const src = String(raw || '')
  if (!src.trim()) return { ok: false, reason: 'empty' }
  let sawTag = false
  for (const m of src.matchAll(RE_ANSWER)) {
    sawTag = true
    if ((m[1] || '').trim()) return { ok: true }
  }
  if (sawTag) return { ok: false, reason: 'empty_answer' }
  // unclosed <answer> (stream cut / truncated generation): the opened block
  // is what the user was meant to see — accept it when it carries text
  const mOpen = /<answer\s*>/i.exec(src)
  if (mOpen && !/<\/answer\s*>/i.test(src.slice(mOpen.index))) {
    const tail = src
      .slice(mOpen.index + mOpen[0].length)
      .replace(RE_INTERNAL, '')
      .replace(/<\/?(?:answer|file|final)>/gi, '')
      .trim()
    if (tail) return { ok: true }
  }
  return { ok: false, reason: 'no_answer_tag' }
}

/** corrective user-turn sent back to the model when the protocol is broken */
export function formatRetryNote(reason?: AnswerVerdictReason): string {
  const what =
    reason === 'empty'
      ? 'Твой предыдущий ответ был ПУСТЫМ (пустое поле)'
      : reason === 'empty_answer'
        ? 'В твоём предыдущем ответе тег <answer> был ПУСТЫМ'
        : 'Твой предыдущий ответ был БЕЗ обёртки <answer>…</answer>, поэтому пользователю НЕ показался никакой текст'
  return (
    `[СИСТЕМА] ${what}. ПОВТОРИ ответ строго по формату: весь текст для пользователя — ТОЛЬКО внутри ` +
    '<answer> и </answer>; файлы для передачи — отдельными тегами <file>имя_файла</file> сразу после ' +
    'закрывающего </answer>; служебный текст (план, рассуждения) — вне <answer>. Другой формат не будет показан пользователю.'
  )
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
