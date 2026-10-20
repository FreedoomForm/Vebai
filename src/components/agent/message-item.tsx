'use client'

import Image from 'next/image'
import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MessageDTO, ArtifactDTO } from '@/lib/agent/types'
import ReactMarkdown from 'react-markdown'

/* T16 (owner request 2026-10-18): the user sees ONLY what the AI wants to
 * show — its <answer> text and the artifacts it chose to deliver. Plans,
 * tool cards and step logs are internal work and are no longer rendered. */

/* ---------------------------------------------------------- artifacts */

function ArtifactGrid({ artifacts }: { artifacts: ArtifactDTO[] }) {
  const videos = artifacts.filter((a) => a.kind === 'video')
  const images = artifacts.filter((a) => a.kind === 'image')
  return (
    <div className="space-y-3">
      {videos.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {videos.map((a, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-stone-200 bg-stone-50">
              <video
                src={a.url}
                controls
                playsInline
                preload="metadata"
                className="w-full aspect-video bg-black"
              />
              {a.title && (
                <div className="px-3 py-2 text-xs text-stone-500 truncate">{a.title}</div>
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
              className="block overflow-hidden rounded-xl border border-stone-200 bg-stone-50 group"
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
                <span className="block px-3 py-2 text-xs text-stone-500 truncate">{a.title}</span>
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
        <div className="max-w-[85%] sm:max-w-[70%] rounded-2xl rounded-br-md bg-stone-800 px-4 py-2.5">
          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-white">
            {message.content}
          </p>
        </div>
      </div>
    )
  }

  const artifacts = message.meta?.artifacts || []

  return (
    <div className="flex gap-3">
      {showAvatar ? (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-900 border border-stone-200">
          <Bot className="h-4 w-4 text-white" />
        </div>
      ) : (
        <div className="w-8 shrink-0" />
      )}
      <div className="min-w-0 flex-1 space-y-3 pt-0.5">
        {message.content && (
          <div className="text-[15px] leading-relaxed text-stone-800 max-w-none break-words [&_p]:my-1.5 [&_strong]:text-stone-900 [&_code]:rounded [&_code]:bg-stone-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] [&_code]:text-emerald-700 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:ml-4 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}
        {artifacts.length > 0 && <ArtifactGrid artifacts={artifacts} />}
      </div>
    </div>
  )
}
