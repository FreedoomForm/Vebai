'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { AgentEvent } from '@/lib/agent/types'

export interface AgentStatePayload {
  worker: { activeTasks: number; queued: number; running: number }
  conversation?: { id: string; title: string; createdAt: string; updatedAt: string }
  messages?: import('@/lib/agent/types').MessageDTO[]
  tasks?: import('@/lib/agent/types').AgentTaskDTO[]
  missing?: boolean
}

interface Handlers {
  onEvent: (evt: AgentEvent) => void
  onState: (state: AgentStatePayload) => void
}

/**
 * Transport-agnostic agent connection.
 *
 * - HTTP polling (default, Vercel-ready): /api/agent/state every 4s drives
 *   onState; chat goes through the POST /api/chat SSE fallback in agent-app.
 * - socket.io (optional): enable with NEXT_PUBLIC_ENABLE_SOCKET=1 when a
 *   relay service is available (e.g. self-hosted behind Caddy).
 */
export function useAgentSocket(handlers: Handlers) {
  const [connected, setConnected] = useState(false)
  const socketRef = useRef<{ connected: boolean; emit: (ev: string, payload: unknown) => void } | null>(null)
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  const useSocket = process.env.NEXT_PUBLIC_ENABLE_SOCKET === '1'

  useEffect(() => {
    if (!useSocket) {
      setConnected(true) // HTTP transport is always "connected"
      const poll = async () => {
        try {
          const res = await fetch('/api/agent/state', { cache: 'no-store' })
          if (res.ok) {
            setConnected(true)
            handlersRef.current.onState(await res.json())
          }
        } catch {
          setConnected(false)
        }
      }
      void poll()
      const t = setInterval(poll, 4_000)
      return () => clearInterval(t)
    }

    // optional socket mode
    let socket: import('socket.io-client').Socket | null = null
    let cancelled = false
    void (async () => {
      const { io } = await import('socket.io-client')
      if (cancelled) return
      socket = io('/?XTransformPort=3003', {
        path: '/',
        transports: ['websocket', 'polling'],
        reconnectionDelayMax: 5_000,
      }) as import('socket.io-client').Socket
      socketRef.current = socket as unknown as { connected: boolean; emit: (ev: string, payload: unknown) => void }
      socket.on('connect', () => setConnected(true))
      socket.on('disconnect', () => setConnected(false))
      socket.on('connect_error', () => setConnected(false))
      socket.on('chat:event', (evt: AgentEvent) => handlersRef.current.onEvent(evt))
      socket.on('state:update', (state: AgentStatePayload) => handlersRef.current.onState(state))
    })()
    return () => {
      cancelled = true
      if (socket) {
        socket.removeAllListeners()
        socket.disconnect()
      }
      socketRef.current = null
    }
  }, [useSocket])

  const send = useCallback(
    (
      conversationId: string | null,
      content: string,
      opts?: { captchaVerifyParam?: string; resume?: boolean },
    ) => {
      const socket = socketRef.current
      if (useSocket && socket?.connected) {
        socket.emit('chat:send', {
          conversationId: conversationId || undefined,
          content,
          captchaVerifyParam: opts?.captchaVerifyParam,
          resume: opts?.resume,
        })
        return true
      }
      return false // agent-app falls back to POST /api/chat (SSE)
    },
    [useSocket],
  )

  const subscribe = useCallback((conversationId: string | null) => {
    const socket = socketRef.current
    if (useSocket && socket?.connected && conversationId) {
      socket.emit('state:subscribe', { conversationId })
    }
  }, [useSocket])

  const unsubscribe = useCallback((conversationId: string | null) => {
    const socket = socketRef.current
    if (useSocket && socket?.connected && conversationId) {
      socket.emit('state:unsubscribe', { conversationId })
    }
  }, [useSocket])

  return { connected, send, subscribe, unsubscribe }
}
