export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // On Vercel this is a no-op (serverless has no persistent timers);
    // the worker there is driven by /api/agent/tick via cron + state polls.
    const { startAgentWorker } = await import('@/lib/agent/worker')
    startAgentWorker()
  }
}
