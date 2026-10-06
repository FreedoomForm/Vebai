/**
 * Vercel-safe Z.ai client.
 *
 * The stock `z-ai-web-dev-sdk` loads credentials from a `.z-ai-config` file,
 * which does not exist on Vercel. This wrapper keeps the same surface used by
 * the agent (chat.completions.create / images.generations.create /
 * functions.invoke) but builds config from env vars first:
 *
 *   ZAI_BASE_URL   e.g. https://api.z.ai/api/paas/v4   (OpenAI-compatible root)
 *   ZAI_API_KEY    the bearer key
 *   ZAI_TOKEN      optional X-Token session header
 *   ZAI_CHAT_ID    optional X-Chat-Id header
 *   ZAI_USER_ID    optional X-User-Id header
 *
 * Falls back to the .z-ai-config file (cwd -> home -> /etc) so the same code
 * runs inside the Z.ai sandbox unchanged.
 */

export interface ZaiConfig {
  baseUrl: string
  apiKey: string
  token?: string
  chatId?: string
  userId?: string
}

function fromEnv(): ZaiConfig | null {
  const baseUrl = process.env.ZAI_BASE_URL
  const apiKey = process.env.ZAI_API_KEY
  if (!baseUrl || !apiKey) return null
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    token: process.env.ZAI_TOKEN || undefined,
    chatId: process.env.ZAI_CHAT_ID || undefined,
    userId: process.env.ZAI_USER_ID || undefined,
  }
}

async function fromConfigFile(): Promise<ZaiConfig | null> {
  const fs = await import('fs/promises')
  const os = await import('os')
  const path = await import('path')
  const candidates = [
    path.join(process.cwd(), '.z-ai-config'),
    path.join(os.homedir(), '.z-ai-config'),
    '/etc/.z-ai-config',
  ]
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, 'utf8')
      const cfg = JSON.parse(raw) as ZaiConfig
      if (cfg.baseUrl && cfg.apiKey) return cfg
    } catch {
      /* try next */
    }
  }
  return null
}

async function loadConfig(): Promise<ZaiConfig> {
  const cfg = fromEnv() || (await fromConfigFile())
  if (!cfg)
    throw new Error(
      'Z.ai credentials not found: set ZAI_BASE_URL + ZAI_API_KEY env vars (Vercel) or provide .z-ai-config',
    )
  return cfg
}

function buildHeaders(cfg: ZaiConfig): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
    'X-Z-AI-From': 'Z',
  }
  if (cfg.chatId) h['X-Chat-Id'] = cfg.chatId
  if (cfg.userId) h['X-User-Id'] = cfg.userId
  if (cfg.token) h['X-Token'] = cfg.token
  return h
}

async function post(cfg: ZaiConfig, urlPath: string, body: unknown): Promise<Response> {
  const res = await fetch(`${cfg.baseUrl}${urlPath}`, {
    method: 'POST',
    headers: buildHeaders(cfg),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Z.ai ${urlPath} ${res.status}: ${txt.slice(0, 300)}`)
  }
  return res
}

/* ------------------------------------------------------------------ types */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatBody {
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  thinking?: { type: 'disabled' | 'enabled' }
  [k: string]: unknown
}

/* ---------------------------------------------------------------- public */

export const zai = {
  chat: {
    /** non-streaming chat completion (streaming lives in streamChat) */
    async completions(body: ChatBody): Promise<{ choices: { message: { content: string } }[] }> {
      const cfg = await loadConfig()
      const res = await post(cfg, '/chat/completions', {
        ...body,
        stream: false,
        thinking: body.thinking || { type: 'disabled' },
      })
      return (await res.json()) as { choices: { message: { content: string } }[] }
    },
  },
  /** streaming chat: returns an SSE ReadableStream of OpenAI-style chunks */
  async streamChat(body: ChatBody): Promise<ReadableStream<Uint8Array>> {
    const cfg = await loadConfig()
    const res = await post(cfg, '/chat/completions', {
      ...body,
      stream: true,
      thinking: body.thinking || { type: 'disabled' },
    })
    return res.body as ReadableStream<Uint8Array>
  },

  images: {
    generations: {
      /** returns base64 PNG data like the stock SDK */
      async create(body: { prompt: string; size?: string }): Promise<{ data: { base64: string; format: string }[] }> {
        const cfg = await loadConfig()
        const res = await post(cfg, '/images/generations', body)
        const result = (await res.json()) as {
          data: ({ base64?: string; url?: string; format?: string })[]
        }
        const data = await Promise.all(
          (result.data || []).map(async (item) => {
            if (item.base64) return { base64: item.base64, format: item.format || 'png' }
            if (item.url) {
              const img = await fetch(item.url)
              const buf = Buffer.from(await img.arrayBuffer())
              return { base64: buf.toString('base64'), format: 'png' }
            }
            throw new Error('generator returned neither base64 nor url')
          }),
        )
        return { data }
      },
    },
  },

  functions: {
    async invoke(name: string, args: Record<string, unknown>): Promise<{ data?: unknown } & Record<string, unknown>> {
      const cfg = await loadConfig()
      const res = await post(cfg, '/functions/invoke', { name, args })
      const json = (await res.json()) as { data?: unknown } & Record<string, unknown>
      return json
    },
  },
}

export default zai
