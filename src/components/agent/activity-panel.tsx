'use client'

import { useEffect, useState } from 'react'
import {
  ImageIcon, Film, Loader2, CheckCircle2, XCircle, Clock3, Activity, FileText, Download,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentTaskDTO } from '@/lib/agent/types'

interface MyFile {
  id: string
  name: string
  size: number
  tgOk: boolean
  updatedAt: string
  url: string
}

/** Files produced by this user's tasks (Telegram bot + site agent). Fetched
 * from /api/my/files (cookie-auth scoped to the session user). */
function MyFiles() {
  const [files, setFiles] = useState<MyFile[] | null>(null)
  useEffect(() => {
    let alive = true
    fetch('/api/my/files?limit=30')
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((j: { files?: MyFile[] }) => {
        if (alive) setFiles(j.files || [])
      })
      .catch(() => alive && setFiles([]))
    const t = setInterval(() => {
      fetch('/api/my/files?limit=30')
        .then((r) => (r.ok ? r.json() : { files: [] }))
        .then((j: { files?: MyFile[] }) => alive && setFiles(j.files || []))
        .catch(() => null)
    }, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  if (files === null) return null
  return (
    <div className="border-t border-stone-200 pt-2 mt-2 px-1">
      <p className="flex items-center gap-1.5 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500">
        <FileText className="h-3.5 w-3.5" /> Мои файлы ({files.length})
      </p>
      {files.length === 0 ? (
        <p className="px-1 pb-1 text-[11px] text-stone-400">
          Файлы из задач в Telegram и на сайте появятся здесь — можно скачать в любой момент.
        </p>
      ) : (
        <div className="space-y-1">
          {files.slice(0, 30).map((f) => (
            <a
              key={f.id}
              href={f.url}
              className="flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-700 hover:border-emerald-300 hover:bg-emerald-50/40"
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
              <span className="truncate flex-1">{f.name}</span>
              <span className="shrink-0 text-[10px] text-stone-400">
                {f.size >= 1024 ? `${(f.size / 1024).toFixed(0)} КБ` : `${f.size} Б`}
              </span>
              <Download className="h-3 w-3 shrink-0 text-stone-400" />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

const STATUS_META: Record<
  AgentTaskDTO['status'],
  { label: string; cls: string; icon: typeof Clock3 }
> = {
  queued: { label: 'В очереди', cls: 'text-amber-700 bg-amber-50 border-amber-200', icon: Clock3 },
  running: { label: 'Выполняется', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: Loader2 },
  completed: { label: 'Готово', cls: 'text-stone-600 bg-stone-100 border-stone-200', icon: CheckCircle2 },
  failed: { label: 'Ошибка', cls: 'text-red-600 bg-red-50 border-red-200', icon: XCircle },
}

function TaskCard({ task }: { task: AgentTaskDTO }) {
  const meta = STATUS_META[task.status] || STATUS_META.queued
  const Icon = meta.icon
  const artifacts = task.result?.artifacts || []
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-3 space-y-2">
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-stone-100 border border-stone-200">
          {task.type === 'image' ? (
            <ImageIcon className="h-3.5 w-3.5 text-emerald-600" />
          ) : (
            <Film className="h-3.5 w-3.5 text-emerald-600" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-stone-800 leading-snug break-words">
            {task.title}
          </p>
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]', meta.cls)}>
              <Icon className={cn('h-3 w-3', task.status === 'running' && 'animate-spin')} />
              {meta.label}
            </span>
            {task.status === 'running' && task.progress && (
              <span className="text-[11px] text-stone-500 truncate max-w-full">{task.progress}</span>
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
                  className="h-10 w-14 rounded object-cover border border-stone-200"
                />
              </a>
            ) : (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded border border-stone-200 bg-stone-50 px-1.5 py-1 text-[10px] text-stone-600"
              >
                <Film className="h-3 w-3 text-emerald-600" />
                клип {i + 1}
              </span>
            ),
          )}
          {artifacts.length > 6 && (
            <span className="text-[10px] text-stone-500 self-center">+{artifacts.length - 6}</span>
          )}
        </div>
      )}
      {task.status === 'failed' && task.error && (
        <p className="text-[11px] leading-snug text-red-500/90 break-words">{task.error}</p>
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
      <div className="flex items-center gap-2 border-b border-stone-200 px-4 py-3.5">
        <Activity className="h-4 w-4 text-emerald-600" />
        <h2 className="text-sm font-semibold text-stone-800">Активность агента</h2>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
          24/7
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {worker.activeTasks > 0 && (
          <p className="px-1 pb-1 text-xs text-stone-500">
            Агент сейчас выполняет {worker.activeTasks} задач(у) в фоне — можешь закрыть браузер, всё продолжит работать.
          </p>
        )}
        {sorted.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-4 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full border border-stone-200 bg-stone-50">
              <Activity className="h-5 w-5 text-stone-400" />
            </div>
            <p className="text-sm text-stone-600">Фоновых задач пока нет</p>
            <p className="text-xs leading-relaxed text-stone-400">
              Попроси агента создать изображение или видео — здесь появится живой прогресс, даже если ты уйдёшь со страницы.
            </p>
          </div>
        ) : (
          sorted.map((t) => <TaskCard key={t.id} task={t} />)
        )}
        <MyFiles />
      </div>
    </div>
  )
}

export { TaskCard }
