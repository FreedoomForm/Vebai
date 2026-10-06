'use client'

import { useState } from 'react'
import Image from 'next/image'
import {
  Search, Globe, ImageIcon, Film, ListChecks,
  Loader2, Check, X, ChevronDown, Bot,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MessageDTO, ArtifactDTO, ToolCallDTO } from '@/lib/agent/types'
import ReactMarkdown from 'react-markdown'

/* ------------------------------------------------------------ tool icons */

const TOOL_META: Record<string, { label: string; icon: typeof Search }> = {
  generate_plan: { label: 'Составляет план', icon: ListChecks },
  web_search: { label: 'Ищет в интернете', icon: Search },
  read_page: { label: 'Читает страницу', icon: Globe },
  generate_image: { label: 'Генерирует изображение', icon: ImageIcon },
  generate_video: { label: 'Ставит видео на генерацию', icon: Film },
}

function ToolCard({ call }: { call: ToolCallDTO }) {
  const [open, setOpen] = useState(false)
  const meta = TOOL_META[call.name] || { label: call.name, icon: Bot }
  const Icon = meta.icon
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-zinc-800/40 transition-colors"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-800">
          <Icon className="h-3.5 w-3.5 text-emerald-400" />
        </span>
        <span className="text-sm text-zinc-200 flex-1 min-w-0">
          {meta.label}
          {call.name === 'web_search' && typeof call.args.query === 'string' && (
            <span className="text-zinc-500"> «{String(call.args.query).slice(0, 48)}»</span>
          )}
          {call.name === 'generate_image' && typeof call.args.title === 'string' && (
            <span className="text-zinc-500"> «{String(call.args.title).slice(0, 40)}»</span>
          )}
        </span>
        {call.status === 'running' ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-400" />
        ) : call.status === 'error' ? (
          <X className="h-4 w-4 shrink-0 text-red-400" />
        ) : (
          <Check className="h-4 w-4 shrink-0 text-emerald-400" />
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0 space-y-1.5">
          {call.summary && (
            <p className="text-xs leading-relaxed text-zinc-400 whitespace-pre-wrap break-words">
              {call.summary}
            </p>
          )}
          <pre className="max-h-32 overflow-auto rounded bg-zinc-950 p-2 text-[11px] leading-snug text-zinc-500">
            {JSON.stringify(call.args, null, 1)}
          </pre>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- plan card */

function PlanCard({ plan }: { plan: NonNullable<MessageDTO['meta']>['plan'] }) {
  if (!plan) return null
  return (
    <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/20 p-4">
      <div className="flex items-center gap-2 mb-3">
        <ListChecks className="h-4 w-4 text-emerald-400" />
        <span className="text-sm font-medium text-emerald-300">
          {plan.title || 'План действий'}
        </span>
      </div>
      <ol className="space-y-2">
        {plan.steps.map((step, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-emerald-800/60 bg-emerald-900/30 text-[11px] font-medium text-emerald-300">
              {i + 1}
            </span>
            <span className="text-zinc-300 leading-snug">{step.title}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/* ---------------------------------------------------------- artifacts */

function ArtifactGrid({ artifacts }: { artifacts: ArtifactDTO[] }) {
  const videos = artifacts.filter((a) => a.kind === 'video')
  const images = artifacts.filter((a) => a.kind === 'image')
  return (
    <div className="space-y-3">
      {videos.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {videos.map((a, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
              <video
                src={a.url}
                controls
                playsInline
                preload="metadata"
                className="w-full aspect-video bg-black"
              />
              {a.title && (
                <div className="px-3 py-2 text-xs text-zinc-400 truncate">{a.title}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className={cn('grid gap-3', images.length > 1 ? 'sm:grid-cols-2' : '')}>
          {images.map((a, i) => (
            <a
              key={i}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 group"
            >
              <span className="relative block aspect-video">
                <Image
                  src={a.url}
                  alt={a.title || 'Сгенерированное изображение'}
                  fill
                  sizes="(max-width: 640px) 100vw, 480px"
                  className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                  unoptimized
                />
              </span>
              {a.title && (
                <span className="block px-3 py-2 text-xs text-zinc-400 truncate">{a.title}</span>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------- message item */

export function MessageItem({
  message,
  showAvatar = true,
}: {
  message: MessageDTO
  showAvatar?: boolean
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] sm:max-w-[70%] rounded-2xl rounded-br-md bg-zinc-800 px-4 py-2.5">
          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-zinc-100">
            {message.content}
          </p>
        </div>
      </div>
    )
  }

  const tools = message.meta?.tools || []
  const plan = message.meta?.plan
  const artifacts = message.meta?.artifacts || []

  return (
    <div className="flex gap-3">
      {showAvatar ? (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-800/50 bg-emerald-950/40">
          <Bot className="h-4 w-4 text-emerald-400" />
        </div>
      ) : (
        <div className="w-8 shrink-0" />
      )}
      <div className="min-w-0 flex-1 space-y-3 pt-0.5">
        {plan && <PlanCard plan={plan} />}
        {tools.map((call, i) => (
          <ToolCard key={i} call={call} />
        ))}
        {message.content && (
          <div className="text-sm leading-relaxed text-zinc-300 max-w-none break-words [&_p]:my-1.5 [&_strong]:text-zinc-100 [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] [&_code]:text-emerald-300 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:ml-4 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}
        {artifacts.length > 0 && <ArtifactGrid artifacts={artifacts} />}
      </div>
    </div>
  )
}
