export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Local full-server testing (next start + real DB) can skip the in-process
    // worker entirely: set AGENT_WORKER_DISABLED=1 (keeps the DB pool free).
    if (process.env.AGENT_WORKER_DISABLED === '1') return
    // On Vercel this is a no-op (serverless has no persistent timers);
    // the worker there is driven by /api/agent/tick via cron + state polls.
    const { startAgentWorker } = await import('@/lib/agent/worker')
    startAgentWorker()
  }
}
