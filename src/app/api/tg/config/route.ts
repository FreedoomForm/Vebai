/**
 * T26: POST /api/tg/config — update the agent rules / master switch.
 * Body: { systemPrompt?, active?, examples? } (all optional).
 * `active: true` is only allowed on a connected account (honest state).
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { getOwnedAccount, parseExamples } from '@/lib/tguser'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const account = await db.tgAccount.findFirst({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
    include: { config: true },
  })

  const data: { systemPrompt?: string; examples?: string; active?: boolean; updatedAt?: Date } = {}
  if (typeof body.systemPrompt === 'string') {
    const prompt = body.systemPrompt.trim()
    if (prompt.length > 8000) return NextResponse.json({ error: 'правила слишком длинные (макс 8000 знаков)' }, { status: 400 })
    data.systemPrompt = prompt
  }
  if (Array.isArray(body.examples)) {
    const cleaned = body.examples
      .filter((e: unknown) => e && typeof (e as { incoming?: unknown }).incoming === 'string' && typeof (e as { reply?: unknown }).reply === 'string')
      .slice(-12)
    data.examples = JSON.stringify(cleaned)
  }
  if (typeof body.active === 'boolean') {
    if (!account || account.status !== 'connected')
      return NextResponse.json({ error: 'агента можно включить только после успешного подключения' }, { status: 400 })
    data.active = body.active
  }
  if (!Object.keys(data).length) return NextResponse.json({ error: 'нечего обновлять' }, { status: 400 })
  data.updatedAt = new Date()

  if (!account) {
    // rules draft (no Telegram account yet) - migrated into TgAgentConfig at /verify
    const { writeRulesDraft } = await import('@/lib/tguser')
    const patch: Record<string, unknown> = {}
    if (data.systemPrompt !== undefined) patch.systemPrompt = data.systemPrompt
    if (data.examples !== undefined) patch.examples = JSON.parse(data.examples)
    const draft = await writeRulesDraft(user.id, patch)
    return NextResponse.json({ ok: true, storedAs: 'draft', systemPrompt: draft.systemPrompt ?? '', examples: (draft.examples || []) })
  }

  const config = await db.tgAgentConfig.upsert({
    where: { accountId: account.id },
    update: data,
    create: { accountId: account.id, systemPrompt: data.systemPrompt ?? '', examples: data.examples ?? '[]' },
  })
  return NextResponse.json({
    ok: true,
    systemPrompt: config.systemPrompt,
    examples: parseExamples(config.examples),
    active: body.active ?? account.active,
  })
}
