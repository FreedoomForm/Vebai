/** DTOs and event types shared by the agent loop, API routes and the UI. */

export interface ArtifactDTO {
  kind: 'image' | 'video'
  url: string
  title?: string
}

export interface ToolCallDTO {
  name: string
  args: Record<string, unknown>
  status: 'running' | 'ok' | 'error'
  summary?: string
}

export interface PlanStepDTO {
  title: string
  status: 'pending' | 'active' | 'done'
}

export interface MessageDTO {
  id: string
  role: 'user' | 'assistant'
  kind: 'text' | 'task_result'
  content: string
  meta?: {
    tools?: ToolCallDTO[]
    plan?: { title?: string; steps: PlanStepDTO[] }
    artifacts?: ArtifactDTO[]
    taskId?: string
  }
  createdAt: string
}

export interface AgentTaskDTO {
  id: string
  conversationId: string
  type: 'image' | 'video'
  title: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress?: string | null
  result?: {
    artifacts?: ArtifactDTO[]
    summary?: string
  } | null
  error?: string | null
  createdAt: string
}

export interface ConversationDTO {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

/** Events streamed from POST /api/chat through the socket relay to the browser */
export type AgentEvent =
  | { type: 'start'; conversationId: string; userMessage: MessageDTO }
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; call: ToolCallDTO }
  | { type: 'tool_result'; id: string; status: 'ok' | 'error'; summary: string; taskId?: string; plan?: { title?: string; steps: PlanStepDTO[] } }
  | { type: 'task'; task: AgentTaskDTO }
  | { type: 'message'; message: MessageDTO }
  | { type: 'title'; conversationId: string; title: string }
  | { type: 'conversation'; conversationId: string }
  | { type: 'captcha_required' }
  | { type: 'done' }
  | { type: 'error'; message: string; code?: string }
