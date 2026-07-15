import type OpenAI from 'openai'
import type { D1Database } from '@cloudflare/workers-types'
import type { ChatReturnType } from '../../types/chat'
import type { OpenAIChatProvider } from './config'

export type ChatRequestBody = {
  threadId?: string | number
  content?: string
  provider?: OpenAIChatProvider
  apiProvider?: OpenAIChatProvider
}

export type ChatThreadRecord = {
  id: string | number
  last_response_id: string | null
}

export type ChatProviderContext = {
  client: OpenAI
  db: D1Database
  threadId: string | number
  content: string
  model: string
  maxTokens?: number
  reasoningEffort?: string
  previousResponseId?: string
}

export type ChatProviderResult = ChatReturnType & {
  lastResponseId?: string
}

export class EmptyReplyError extends Error {
  constructor() {
    super('OpenAI returned an empty reply.')
    this.name = 'EmptyReplyError'
  }
}
