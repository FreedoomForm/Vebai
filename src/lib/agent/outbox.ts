/**
 * T31 (owner request 2026-10-20): the site agent can ACT through the owner's
 * connected Telegram account, not only talk. The model emits a ```run-tg```
 * fenced block (to/message/file) after </answer>; this module:
 *   1. parses the block(s) and queues AgentTask rows (type 'tg_outbox');
 *   2. waits for the referenced file to appear in the chat (a run-agent
 *      task in the same conversation usually produces it — files land as
 *      TerminalFile rows via /api/terminal/gh/result);
 *   3. hands ready jobs to the resident Telegram worker (.github/tg_userbot.js)
 *      through /api/tg/work (payload includes the decrypted MTProto session);
 *   4. the worker sends the message/file from the OWNER'S OWN account and
 *      reports to /api/tg/outbox-result -> task_result message in the chat.
 *
 * T32 (owner request 2026-10-20): the agent can also READ the owner's
 * Telegram correspondence — ```run-tg-read``` (chat/limit/search) blocks are
 * queued as type 'tg_read', handed to the worker through /api/tg/work, and
 * the transcript comes back through /api/tg/outbox-result (kind=read); the
 * agent then auto-continues the order (see continue.ts). Reads allow DMs and
 * groups; broadcast channels and bots are refused by the worker.
 *
 * Safety: sending only from a CONNECTED account of the task owner; only
 * person-to-person chats are allowed (the worker refuses channels/bots);
 * file size capped at the TerminalFile inline limit; retries are bounded and
 * every failure lands in the chat as an honest task_result.
 */
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/tguser'

export interface TgSendSpec {
  peer: string
  message: string
  file: string
}

/** T32: the agent can also READ the owner's Telegram messages (```run-tg-read```) */
export interface TgReadSpec {
  chat: string
  limit: number
  search: string
}

const MAX_FILE_BYTES = 3_500_000 // keep in sync with gh/result inline limit
const FILE_WAIT_MS = 45 * 60_000 // how long a task waits for its file
const RUNNING_STALE_MS = 10 * 60_000 // worker picked it up but never reported
const MAX_ATTEMPTS = 3

/* ----------------------------------------------------------- read limits */
// Owner request (T32): the agent may read "as many messages from as many
// chats as the order needs" — generous by design, bounded for sanity.
const MAX_READ_LIMIT = 200 // per block (Telegram pages of 100 — safe)
const MAX_READ_BLOCKS = 10 // per model answer
const DEFAULT_READ_LIMIT = 50

/* ----------------------------------------------------------------- parsing */

/** one-line value of a key (`to:` / `file:` …) — first line only, unquoted */
function keyValue(body: string, keys: string[]): string {
  const re = new RegExp(`^\\s*(?:${keys.join('|')})\\s*[:=]\\s*(.+)$`, 'im')
  const m = body.match(re)
  if (!m) return ''
  return m[1].trim().split('\n')[0].trim().replace(/^["']|["']$/g, '')
}

/** multiline value (message: …) — everything until the next known key line */
function multilineValue(body: string, keys: string[]): string {
  // NB: no `$` in the lookahead — the regex carries the `m` flag, where `$`
  // would match the END OF THE FIRST LINE and truncate multiline captions.
  // `(?![\s\S])` is the real end of the block instead.
  const re = new RegExp(
    `^\\s*(?:${keys.join('|')})\\s*[:=]\\s*([\\s\\S]*?)(?=\\n\\s*(?:to|file|кому|получатель|файл)\\s*[:=]|(?![\\s\\S]))`,
    'im',
  )
  const m = body.match(re)
  return m ? m[1].trim() : ''
}

/**
 * Parse ```run-tg-read``` fenced blocks from a model answer (T32):
 * ```run-tg-read
 * chat: @username | +998... | "Имя Фамилия"
 * limit: 50 (optional; last-N messages, capped at 200)
 * search: текст (optional; Telegram server-side search)
 * ```
 * NB: the ```run-tg``` regex cannot match this block ("-read" breaks its
 * `\s*\n` lookahead) and vice versa — the two parsers are disjoint.
 */
export function parseTgReadBlocks(text: string): TgReadSpec[] {
  const out: TgReadSpec[] = []
  const re = /```run-tg-read\s*\n([\s\S]*?)```/g
  for (let m = re.exec(text); m && out.length < MAX_READ_BLOCKS; m = re.exec(text)) {
    const body = m[1]
    const chat = keyValue(body, ['chat', 'чат', 'dialog', 'диалог'])
    if (!chat) continue
    const limRaw = keyValue(body, ['limit', 'сколько', 'лимит']).replace(/\D/g, '')
    const limNum = parseInt(limRaw, 10)
    const limit = Math.min(
      Math.max(Number.isFinite(limNum) && limNum > 0 ? limNum : DEFAULT_READ_LIMIT, 1),
      MAX_READ_LIMIT,
    )
    const search = keyValue(body, ['search', 'поиск'])
    out.push({ chat: chat.slice(0, 200), limit, search: search.slice(0, 200) })
  }
  return out
}

/**
 * Parse ```run-tg``` fenced blocks from a model answer:
 * ```run-tg
 * to: @username | +998... | "Имя Фамилия"
 * message: подпись/текст (optional, multiline)
 * file: имя_файла.pdf (optional; exact basename produced by run-agent)
 * ```
 */
export function parseTgBlocks(text: string): TgSendSpec[] {
  const out: TgSendSpec[] = []
  const re = /```run-tg\s*\n([\s\S]*?)```/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const body = m[1]
    const peer = keyValue(body, ['to', 'кому', 'получатель'])
    const file = keyValue(body, ['file', 'файл'])
    const message = multilineValue(body, ['message', 'msg', 'текст', 'сообщение'])
    if (!peer || (!message && !file)) continue
    out.push({
      peer: peer.slice(0, 200),
      message: message.slice(0, 3500),
      file: file ? basename(file).slice(0, 200) : '',
    })
    if (out.length >= 3) break
  }
  return out
}

export function basename(p: string): string {
  return String(p || '').replace(/\\/g, '/').split('/').pop() || p
}

function payloadOf(t: { payload: string | null }): {
  peer?: string
  message?: string
  file?: string | null
  accountId?: string
  fileId?: string | null
  attempts?: number
} {
  try {
    return JSON.parse(t.payload || '{}')
  } catch {
    return {}
  }
}

/* ---------------------------------------------------------- chat reporting */

async function postResult(conversationId: string, content: string, taskId?: string): Promise<void> {
  await db.message
    .create({
      data: {
        conversationId,
        role: 'assistant',
        kind: 'task_result',
        content,
        meta: JSON.stringify(taskId ? { taskId } : {}),
      },
    })
    .catch(() => {})
  await db.conversation
    .update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
    .catch(() => {})
}

/** mark a task failed + post the honest reason into the chat (send AND read) */
export async function failOutbox(taskId: string, error: string): Promise<void> {
  const t = await db.agentTask.findUnique({ where: { id: taskId } })
  if (!t || t.status === 'completed' || t.status === 'failed') return
  await db.agentTask
    .update({ where: { id: taskId }, data: { status: 'failed', progress: null, error: error.slice(0, 300) } })
    .catch(() => {})
  const prefix = t.type === 'tg_read' ? '📖 Чтение Telegram не удалось' : '📤 Отправка через Telegram не удалась'
  await postResult(t.conversationId, `${prefix}: ${error.slice(0, 250)}`, t.id)
}

/* ------------------------------------------------------------ task creation */

/**
 * Queue ```run-tg``` blocks from a model answer. Returns:
 *   0            — no blocks;
 *   -1           — blocks exist but the user has no connected account;
 *   n (>0)       — tasks created.
 */
export async function createOutboxTasks(
  text: string,
  conversationId: string,
  userId: string,
): Promise<number> {
  const specs = parseTgBlocks(text)
  if (specs.length === 0) return 0
  const acc = await db.tgAccount.findFirst({
    where: { userId, status: 'connected' },
    orderBy: { updatedAt: 'desc' },
  })
  if (!acc) return -1
  for (const s of specs) {
    await db.agentTask.create({
      data: {
        conversationId,
        type: 'tg_outbox',
        title: `📤 Telegram: ${s.file ? basename(s.file) : 'сообщение'} → ${s.peer}`.slice(0, 140),
        status: 'queued',
        progress: s.file ? `Жду файл «${basename(s.file)}»…` : 'В очереди отправки…',
        payload: JSON.stringify({
          peer: s.peer,
          message: s.message,
          file: s.file || null,
          accountId: acc.id,
          attempts: 0,
        }),
      },
    })
  }
  await db.conversation
    .update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
    .catch(() => {})
  return specs.length
}

/**
 * Queue ```run-tg-read``` blocks from a model answer (T32). Returns:
 *   0            — no blocks;
 *   -1           — blocks exist but the user has no connected account;
 *   n (>0)       — tasks created.
 * `chain` = auto-continuation depth (continueAfterRead increments it).
 */
export async function createTgReadTasks(
  text: string,
  conversationId: string,
  userId: string,
  chain = 0,
): Promise<number> {
  const specs = parseTgReadBlocks(text)
  if (specs.length === 0) return 0
  const acc = await db.tgAccount.findFirst({
    where: { userId, status: 'connected' },
    orderBy: { updatedAt: 'desc' },
  })
  if (!acc) return -1
  for (const s of specs) {
    await db.agentTask.create({
      data: {
        conversationId,
        type: 'tg_read',
        title: `📖 Telegram: прочитать ${s.limit} сообщений — ${s.chat}`.slice(0, 140),
        status: 'queued',
        progress: 'В очереди чтения…',
        payload: JSON.stringify({
          kind: 'read',
          chat: s.chat,
          limit: s.limit,
          search: s.search || null,
          accountId: acc.id,
          attempts: 0,
          chain,
        }),
      },
    })
  }
  await db.conversation
    .update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
    .catch(() => {})
  return specs.length
}

/* --------------------------------------------------------------- file wait */

async function findReadyFile(
  conversationId: string,
  fileName: string,
  since: Date,
): Promise<{ id: string; path: string; size: number; mime: string | null; data: Uint8Array | null } | null> {
  if (!fileName) return null
  const rows = await db.terminalFile.findMany({
    where: {
      conversationId,
      OR: [{ path: fileName }, { path: { endsWith: '/' + fileName } }],
      createdAt: { gte: new Date(since.getTime() - FILE_WAIT_MS) },
    },
    orderBy: { createdAt: 'desc' },
    take: 1,
  })
  return rows[0] || null
}

/* ------------------------------------------------------------------- sync  */

/** site-side maintenance: honest failures, stale-worker retries, file waits */
export async function syncOutboxTasks(): Promise<void> {
  const now = Date.now()

  // running tasks whose worker never reported back -> bounded retries
  const running = await db.agentTask.findMany({
    where: { type: 'tg_outbox', status: 'running' },
    orderBy: { updatedAt: 'asc' },
    take: 20,
  })
  for (const t of running) {
    if (now - t.updatedAt.getTime() < RUNNING_STALE_MS) continue
    const p = payloadOf(t)
    const attempts = (p.attempts || 1) + 1
    if (attempts > MAX_ATTEMPTS) {
      await failOutbox(t.id, `воркер Telegram не отчитался после ${MAX_ATTEMPTS} попыток — чтобы избежать дублей, задача снята`)
      continue
    }
    await db.agentTask.update({
      where: { id: t.id },
      data: {
        status: 'queued',
        progress: `Повтор ${attempts}/${MAX_ATTEMPTS}: воркер не отчитался — вернул в очередь…`,
        payload: JSON.stringify({ ...p, attempts }),
        updatedAt: new Date(),
      },
    }).catch(() => {})
  }

  // queued tasks: validate account, wait for files, surface readiness
  const queued = await db.agentTask.findMany({
    where: { type: 'tg_outbox', status: 'queued' },
    orderBy: { createdAt: 'asc' },
    take: 10,
  })
  for (const t of queued) {
    const p = payloadOf(t)
    const acc = p.accountId
      ? await db.tgAccount.findFirst({ where: { id: p.accountId, status: 'connected' } })
      : null
    if (!acc) {
      await failOutbox(t.id, 'Telegram-аккаунт не подключён (или отключён) — подключи его на /tgagent и попроси повторить')
      continue
    }
    if (p.file) {
      const f = await findReadyFile(t.conversationId, String(p.file), t.createdAt)
      if (!f) {
        if (now - t.createdAt.getTime() > FILE_WAIT_MS) {
          await failOutbox(t.id, `файл «${p.file}» так и не появился в чате за 45 минут — агент его не создал`)
        } else {
          const progress = `Жду файл «${p.file}» от агента…`
          if (progress !== t.progress) {
            await db.agentTask.update({ where: { id: t.id }, data: { progress } }).catch(() => {})
          }
        }
        continue
      }
      if (f.size > MAX_FILE_BYTES) {
        await failOutbox(t.id, `файл «${p.file}» (${Math.round(f.size / 1024)} КБ) больше лимита 3.4 МБ — попроси агента сжать или разделить его`)
        continue
      }
      if (!f.data) {
        await failOutbox(t.id, `файл «${p.file}» не сохранился на сайте — попроси повторить задачу`)
        continue
      }
      const progress = 'Файл готов: жду воркера Telegram…'
      if (progress !== t.progress) {
        await db.agentTask.update({ where: { id: t.id }, data: { progress } }).catch(() => {})
      }
    } else {
      const progress = 'Готово к отправке: жду воркера Telegram…'
      if (progress !== t.progress) {
        await db.agentTask.update({ where: { id: t.id }, data: { progress } }).catch(() => {})
      }
    }
  }
}

/* ------------------------------------------------------- read task sync */

/** site-side maintenance for read tasks (T32): stale-worker retries only —
 * reads have no file-wait stage. Runs on every agent tick. */
export async function syncTgReadTasks(): Promise<void> {
  const running = await db.agentTask.findMany({
    where: { type: 'tg_read', status: 'running' },
    orderBy: { updatedAt: 'asc' },
    take: 20,
  })
  for (const t of running) {
    if (Date.now() - t.updatedAt.getTime() < RUNNING_STALE_MS) continue
    const p = payloadOf(t) as { attempts?: number }
    const attempts = (p.attempts || 1) + 1
    if (attempts > MAX_ATTEMPTS) {
      await failOutbox(t.id, `воркер Telegram не отчитался после ${MAX_ATTEMPTS} попыток — задача чтения снята`)
      continue
    }
    await db.agentTask
      .update({
        where: { id: t.id },
        data: {
          status: 'queued',
          progress: `Повтор ${attempts}/${MAX_ATTEMPTS}: воркер не отчитался — вернул в очередь…`,
          payload: JSON.stringify({ ...p, attempts }),
          updatedAt: new Date(),
        },
      })
      .catch(() => {})
  }
}

/* ----------------------------------------------------------- worker pickup */

export interface OutboxJob {
  kind: 'send'
  id: string
  accountId: string
  session: string
  apiId: number
  apiHash: string
  peer: string
  message: string
  file: { name: string; mime: string; b64: string; fileId: string } | null
}

/** T32 worker contract for one read job (messages FROM the owner's account) */
export interface TgReadJob {
  kind: 'read'
  id: string
  accountId: string
  session: string
  apiId: number
  apiHash: string
  chat: string
  limit: number
  search: string
  chain: number
}

/**
 * Called by /api/tg/work: claim queued tasks (queued -> running, atomically)
 * and return them with the decrypted MTProto session + inlined file payload.
 * Tasks whose file has not arrived yet stay queued (worker picks them later).
 */
export async function readyOutboxForWorker(take = 5): Promise<OutboxJob[]> {
  const rows = await db.agentTask.findMany({
    where: { type: 'tg_outbox', status: 'queued' },
    orderBy: { createdAt: 'asc' },
    take,
  })
  const out: OutboxJob[] = []
  for (const t of rows) {
    const p = payloadOf(t)
    if (!p.peer || (!p.message && !p.file)) {
      await failOutbox(t.id, 'повреждённая задача отправки (нет получателя или содержимого)')
      continue
    }
    const acc = p.accountId
      ? await db.tgAccount.findFirst({ where: { id: p.accountId, status: 'connected' } })
      : null
    if (!acc) {
      await failOutbox(t.id, 'Telegram-аккаунт не подключён (или отключён) — подключи его на /tgagent')
      continue
    }
    let session: string
    let apiHash: string
    try {
      session = decryptSecret(String(acc.sessionEnc || ''))
      apiHash = decryptSecret(String(acc.apiHashEnc || ''))
    } catch {
      await db.tgAccount
        .update({
          where: { id: acc.id },
          data: { status: 'error', statusText: 'не удалось расшифровать сессию — переподключи аккаунт', active: false },
        })
        .catch(() => {})
      await failOutbox(t.id, 'не удалось расшифровать сессию аккаунта — переподключи аккаунт на /tgagent')
      continue
    }
    let file: OutboxJob['file'] = null
    if (p.file) {
      const f = await findReadyFile(t.conversationId, String(p.file), t.createdAt)
      if (!f || !f.data) continue // file-wait: try again on the next poll
      if (f.size > MAX_FILE_BYTES) {
        await failOutbox(t.id, `файл «${p.file}» (${Math.round(f.size / 1024)} КБ) больше лимита 3.4 МБ`)
        continue
      }
      file = {
        name: basename(f.path),
        mime: f.mime || 'application/octet-stream',
        b64: Buffer.from(f.data).toString('base64'),
        fileId: f.id,
      }
    }
    const claim = await db.agentTask
      .updateMany({
        where: { id: t.id, status: 'queued' },
        data: {
          status: 'running',
          progress: 'Отправляю через твой Telegram…',
          payload: JSON.stringify({ ...p, fileId: file?.fileId || null }),
        },
      })
      .catch(() => ({ count: 0 }))
    if (claim.count !== 1) continue // another worker/tick won the race
    out.push({
      kind: 'send',
      id: t.id,
      accountId: acc.id,
      session,
      apiId: acc.apiId,
      apiHash,
      peer: String(p.peer),
      message: String(p.message || ''),
      file,
    })
  }
  return out
}

/**
 * T32: called by /api/tg/work — claim queued read tasks (queued -> running,
 * atomically) with the decrypted MTProto session. The worker fetches the last
 * N messages of the requested chat and reports the transcript to
 * /api/tg/outbox-result (kind=read), which feeds continueAfterRead.
 */
export async function readyTgReadForWorker(take = 5): Promise<TgReadJob[]> {
  const rows = await db.agentTask.findMany({
    where: { type: 'tg_read', status: 'queued' },
    orderBy: { createdAt: 'asc' },
    take,
  })
  const out: TgReadJob[] = []
  for (const t of rows) {
    const p = payloadOf(t) as { chat?: string; limit?: number; search?: string; accountId?: string; chain?: number }
    if (!p.chat) {
      await failOutbox(t.id, 'повреждённая задача чтения (не указан чат)')
      continue
    }
    const acc = p.accountId
      ? await db.tgAccount.findFirst({ where: { id: p.accountId, status: 'connected' } })
      : null
    if (!acc) {
      await failOutbox(t.id, 'Telegram-аккаунт не подключён (или отключён) — подключи его на /tgagent')
      continue
    }
    let session: string
    let apiHash: string
    try {
      session = decryptSecret(String(acc.sessionEnc || ''))
      apiHash = decryptSecret(String(acc.apiHashEnc || ''))
    } catch {
      await db.tgAccount
        .update({
          where: { id: acc.id },
          data: { status: 'error', statusText: 'не удалось расшифровать сессию — переподключи аккаунт', active: false },
        })
        .catch(() => {})
      await failOutbox(t.id, 'не удалось расшифровать сессию аккаунта — переподключи аккаунт на /tgagent')
      continue
    }
    const claim = await db.agentTask
      .updateMany({
        where: { id: t.id, status: 'queued' },
        data: { status: 'running', progress: 'Читаю сообщения через твой Telegram…' },
      })
      .catch(() => ({ count: 0 }))
    if (claim.count !== 1) continue // another worker/tick won the race
    out.push({
      kind: 'read',
      id: t.id,
      accountId: acc.id,
      session,
      apiId: acc.apiId,
      apiHash,
      chat: String(p.chat),
      limit: Math.min(Math.max(Number(p.limit) || 50, 1), MAX_READ_LIMIT),
      search: String(p.search || ''),
      chain: Math.max(Number(p.chain) || 0, 0),
    })
  }
  return out
}
