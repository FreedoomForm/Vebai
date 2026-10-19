/**
 * T26: POST /api/tg/coach — the owner explains agent rules in plain words
 * ("общайся с Мирсаидом официально", "создавай файлы, которые он попросит");
 * the AI updates the full rules text and answers briefly. Honest errors only.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { coachPrompt, readRulesDraft, writeRulesDraft } from '@/lib/tguser'

export const runtime = 'nodejs'
export const maxDuration = 45

export async function POST(req: Request) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const message = String(body.message || '').trim()
  if (message.length < 3) return NextResponse.json({ error: 'опиши правило словами (мин 3 символа)' }, { status: 400 })
  if (message.length > 2000) return NextResponse.json({ error: 'сообщение слишком длинное' }, { status: 400 })

  const account = await db.tgAccount.findFirst({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
    include: { config: true },
  })
  const draft = await readRulesDraft(user.id)
  const current = account?.config?.systemPrompt ?? draft.systemPrompt ?? ''

  try {
    const result = await coachPrompt(current, message)
    if (account) {
      await db.tgAgentConfig.upsert({
        where: { accountId: account.id },
        update: { systemPrompt: result.prompt },
        create: { accountId: account.id, systemPrompt: result.prompt, examples: '[]' },
      })
    } else {
      await writeRulesDraft(user.id, { systemPrompt: result.prompt })
    }
    return NextResponse.json({ ok: true, reply: result.reply, systemPrompt: result.prompt, storedAs: account ? 'account' : 'draft' })
  } catch (e) {
    return NextResponse.json({ error: `ИИ не смог обновить правила: ${e instanceof Error ? e.message.slice(0, 200) : 'ошибка'}` }, { status: 502 })
  }
}
