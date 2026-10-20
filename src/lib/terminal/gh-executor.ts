/**
 * GitHub Actions as the headless terminal executor (owner rule: Kaggle is
 * for video generation ONLY). The site dispatches the terminal-executor
 * workflow; the runner claims queued TerminalCommands via
 * /api/terminal/gh/claim and posts results to /api/terminal/gh/result.
 * Fire-and-forget: dispatch failure leaves the command pending and the
 * worker loop retries on later ticks.
 */

export const GH_REPO = process.env.GH_REPO || 'FreedoomForm/Vebai'
export const GH_WORKFLOW = 'terminal-executor.yml'

export async function ghDispatch(sessionId: string, cmdId?: string): Promise<boolean> {
  const token = process.env.GH_PAT || ''
  if (!token) return false
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'vebai-site',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: { session: sessionId, cmd: cmdId || '', timeout: '15' },
        }),
        signal: AbortSignal.timeout(12_000),
      },
    )
    return res.status === 204
  } catch {
    return false
  }
}

/** the session a LIVE runner is actually attached to: freshest heartbeat
 * first, sessions that never heartbeated (synthetic E2E rows, brand-new)
 * last. Ordering by createdAt alone is unsafe — an E2E once left an active
 * gh session with lastSeenAt = null and every new task got queued into that
 * dead session while the resident kept polling the real one (outage
 * 2026-10-18, "бот не работает"). */
export async function mostAliveGhSession() {
  const { db } = await import('@/lib/db')
  return db.terminalSession.findFirst({
    where: { kind: 'gh', status: 'active' },
    orderBy: [
      { lastSeenAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
    ],
  })
}

/** find (or lazily create) the shared headless TerminalSession */
export async function ghTerminalSession() {
  const { db } = await import('@/lib/db')
  const existing = await mostAliveGhSession()
  if (existing) return existing
  return db.terminalSession.create({
    data: {
      kind: 'gh',
      title: 'GitHub Actions (Ubuntu)',
      secret:
        crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''),
    },
  })
}
