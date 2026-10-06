import { zai } from '@/lib/zai'
import { db } from '@/lib/db'
import type { AgentTaskDTO, ArtifactDTO, MessageDTO, PlanStepDTO } from './types'

export interface ToolExecResult {
  summary: string
  data?: Record<string, unknown>
  taskId?: string
  plan?: { title?: string; steps: PlanStepDTO[] }
}

export interface ToolContext {
  conversationId: string
}

export const TOOL_NAMES = [
  'generate_plan',
  'web_search',
  'read_page',
  'generate_image',
  'generate_video',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name)
}

/* ---------------------------------------------------------------- DTO maps */

export function taskToDTO(t: {
  id: string
  conversationId: string
  type: string
  title: string
  status: string
  progress: string | null
  result: string | null
  error: string | null
  createdAt: Date
}): AgentTaskDTO {
  let result: AgentTaskDTO['result'] = null
  if (t.result) {
    try { result = JSON.parse(t.result) } catch { /* ignore */ }
  }
  return {
    id: t.id,
    conversationId: t.conversationId,
    type: t.type as AgentTaskDTO['type'],
    title: t.title,
    status: t.status as AgentTaskDTO['status'],
    progress: t.progress,
    result,
    error: t.error,
    createdAt: t.createdAt.toISOString(),
  }
}

export function messageToDTO(m: {
  id: string
  role: string
  kind: string
  content: string
  meta: string | null
  createdAt: Date
}): MessageDTO {
  let meta: MessageDTO['meta'] = undefined
  if (m.meta) {
    try { meta = JSON.parse(m.meta) } catch { /* ignore */ }
  }
  return {
    id: m.id,
    role: m.role as MessageDTO['role'],
    kind: m.kind as MessageDTO['kind'],
    content: m.content,
    meta,
    createdAt: m.createdAt.toISOString(),
  }
}

/* ------------------------------------------------------------ plan + search */

function execPlan(args: Record<string, unknown>): ToolExecResult {
  const rawSteps = Array.isArray(args.steps) ? args.steps : []
  const steps: PlanStepDTO[] = rawSteps
    .map((s): PlanStepDTO | null => {
      const title = typeof s === 'string' ? s : String((s as { title?: unknown })?.title ?? '')
      return title.trim() ? { title: title.trim().slice(0, 200), status: 'pending' } : null
    })
    .filter((s): s is PlanStepDTO => s !== null)
    .slice(0, 9)
  return {
    summary: `План из ${steps.length} шагов составлен`,
    plan: { title: typeof args.title === 'string' ? args.title : undefined, steps },
  }
}

async function execWebSearch(args: Record<string, unknown>): Promise<ToolExecResult> {
  const query = String(args.query || '').trim()
  if (!query) throw new Error('web_search: пустой query')
  const res = (await zai.functions.invoke('web_search', {
    query,
    num: Math.min(Math.max(Number(args.num) || 5, 1), 10),
  })) as unknown as {
    url?: string; name?: string; snippet?: string; host_name?: string; date?: string
  }[]
  const items = (Array.isArray(res) ? res : []).slice(0, 8).map((r) => ({
    url: r.url,
    name: r.name,
    snippet: (r.snippet || '').slice(0, 400),
    host: r.host_name,
    date: r.date,
  }))
  const lines = items
    .map((it, i: number) =>
      `${i + 1}. ${it.name || '(без названия)'} — ${it.host || it.url || ''}`)
    .join('\n')
  return { summary: `Найдено ${items.length} результатов: ${lines}`, data: { items } }
}

async function execReadPage(args: Record<string, unknown>): Promise<ToolExecResult> {
  const url = String(args.url || '').trim()
  if (!/^https?:\/\//.test(url)) throw new Error('read_page: нужен http(s) URL')
  const res = (await zai.functions.invoke('page_reader', { url })) as {
    data?: { html?: string; title?: string }
  }
  const html = res?.data?.html || ''
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4500)
  const title = res?.data?.title || ''
  return { summary: `Страница «${title}» прочитана (${text.length} симв. передано модели)`, data: { title, text } }
}

/* ------------------------------------------------------------------ image */

async function execGenerateImage(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecResult> {
  const prompt = String(args.prompt || '').trim()
  if (!prompt) throw new Error('generate_image: пустой prompt')
  const size = String(args.size || '1344x768')
  const title = String(args.title || prompt.slice(0, 60))
  const task = await db.agentTask.create({
    data: {
      conversationId: ctx.conversationId,
      type: 'image',
      title: title.slice(0, 120),
      status: 'queued',
      progress: 'В очереди генерации',
      payload: JSON.stringify({ prompt, size }),
    },
  })
  await db.conversation.update({
    where: { id: ctx.conversationId },
    data: { updatedAt: new Date() },
  })
  return {
    summary: `Изображение «${title}» поставлено в фоновую генерацию`,
    taskId: task.id,
    data: { taskId: task.id, title, size },
  }
}

/* ------------------------------------------------------------------ video */

async function execGenerateVideo(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecResult> {
  const title = String(args.title || '').trim() || 'Видео'
  const rawShots = Array.isArray(args.shots) ? args.shots : []
  const shots = rawShots
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>
      const h3 = String(o.h3_prompt || o.prompt || '').trim()
      if (!h3) return null
      return {
        title: String(o.title || 'Кадр').slice(0, 120),
        h3_prompt: h3,
        seconds: [5, 10].includes(Number(o.seconds)) ? Number(o.seconds) : 5,
        first_frame_task_id: typeof o.first_frame_task_id === 'string' ? o.first_frame_task_id : null,
      }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .slice(0, 8)
  if (shots.length === 0) throw new Error('generate_video: нужен хотя бы один кадр с h3_prompt')

  const testMode = args.test_mode === true
  const task = await db.agentTask.create({
    data: {
      conversationId: ctx.conversationId,
      type: 'video',
      title: title.slice(0, 140),
      status: 'queued',
      progress: shots.length > 1
        ? `В очереди: ${shots.length} кадров`
        : 'В очереди: 1 кадр',
      payload: JSON.stringify({ title, shots, testMode }),
    },
  })
  await db.conversation.update({
    where: { id: ctx.conversationId },
    data: { updatedAt: new Date() },
  })
  return {
    summary: `Видео «${title}» (${shots.length} кадр(ов), ${testMode ? 'тест-режим' : 'реальная генерация H3'}) поставлено в фоновую очередь`,
    taskId: task.id,
    data: { taskId: task.id, shots: shots.length, testMode },
  }
}

/* --------------------------------------------------------------- dispatch */

export async function executeTool(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecResult> {
  switch (name) {
    case 'generate_plan':
      return execPlan(args)
    case 'web_search':
      return await execWebSearch(args)
    case 'read_page':
      return await execReadPage(args)
    case 'generate_image':
      return await execGenerateImage(args, ctx)
    case 'generate_video':
      return await execGenerateVideo(args, ctx)
  }
}

/** fetch a completed image task's artifact bytes (for first frames) */
export async function imageArtifactData(taskId: string): Promise<Buffer | null> {
  const t = await db.agentTask.findUnique({ where: { id: taskId } })
  if (!t || t.status !== 'completed' || !t.imageData) return null
  return Buffer.from(t.imageData)
}
