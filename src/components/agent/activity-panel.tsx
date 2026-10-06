'use client'

import {
  ImageIcon, Film, Loader2, CheckCircle2, XCircle, Clock3, Activity,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentTaskDTO } from '@/lib/agent/types'

const STATUS_META: Record<
  AgentTaskDTO['status'],
  { label: string; cls: string; icon: typeof Clock3 }
> = {
  queued: { label: 'В очереди', cls: 'text-amber-400 bg-amber-950/40 border-amber-900/50', icon: Clock3 },
  running: { label: 'Выполняется', cls: 'text-emerald-400 bg-emerald-950/40 border-emerald-900/50', icon: Loader2 },
  completed: { label: 'Готово', cls: 'text-zinc-400 bg-zinc-900 border-zinc-800', icon: CheckCircle2 },
  failed: { label: 'Ошибка', cls: 'text-red-400 bg-red-950/40 border-red-900/50', icon: XCircle },
}

function TaskCard({ task }: { task: AgentTaskDTO }) {
  const meta = STATUS_META[task.status] || STATUS_META.queued
  const Icon = meta.icon
  const artifacts = task.result?.artifacts || []
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 space-y-2">
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-800">
          {task.type === 'image' ? (
            <ImageIcon className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <Film className="h-3.5 w-3.5 text-emerald-400" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-200 leading-snug break-words">
            {task.title}
          </p>
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]', meta.cls)}>
              <Icon className={cn('h-3 w-3', task.status === 'running' && 'animate-spin')} />
              {meta.label}
            </span>
            {task.status === 'running' && task.progress && (
              <span className="text-[11px] text-zinc-500 truncate max-w-full">{task.progress}</span>
            )}
          </div>
        </div>
      </div>
      {artifacts.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {artifacts.slice(0, 6).map((a, i) =>
            a.kind === 'image' ? (
              <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className="block">
                <img
                  src={a.url}
                  alt={a.title || 'артефакт'}
                  className="h-10 w-14 rounded object-cover border border-zinc-800"
                />
              </a>
            ) : (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[10px] text-zinc-400"
              >
                <Film className="h-3 w-3 text-emerald-500" />
                клип {i + 1}
              </span>
            ),
          )}
          {artifacts.length > 6 && (
            <span className="text-[10px] text-zinc-500 self-center">+{artifacts.length - 6}</span>
          )}
        </div>
      )}
      {task.status === 'failed' && task.error && (
        <p className="text-[11px] leading-snug text-red-400/80 break-words">{task.error}</p>
      )}
    </div>
  )
}

export function ActivityPanel({
  tasks,
  worker,
}: {
  tasks: AgentTaskDTO[]
  worker: { activeTasks: number; queued: number; running: number }
}) {
  const sorted = [...tasks].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-4 py-3.5">
        <Activity className="h-4 w-4 text-emerald-400" />
        <h2 className="text-sm font-semibold text-zinc-200">Активность агента</h2>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-900/50 bg-emerald-950/30 px-2 py-0.5 text-[11px] text-emerald-400">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </span>
          24/7
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {worker.activeTasks > 0 && (
          <p className="px-1 pb-1 text-xs text-zinc-500">
            Агент сейчас выполняет {worker.activeTasks} задач(у) в фоне — можешь закрыть браузер, всё продолжит работать.
          </p>
        )}
        {sorted.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-4 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900">
              <Activity className="h-5 w-5 text-zinc-600" />
            </div>
            <p className="text-sm text-zinc-500">Фоновых задач пока нет</p>
            <p className="text-xs leading-relaxed text-zinc-600">
              Попроси агента создать изображение или видео — здесь появится живой прогресс, даже если ты уйдёшь со страницы.
            </p>
          </div>
        ) : (
          sorted.map((t) => <TaskCard key={t.id} task={t} />)
        )}
      </div>
    </div>
  )
}

export { TaskCard }
