import { runResponsesChat } from './responses'
import { runChatCompletionsChat } from './chatCompletions'
import type { OpenAIChatProvider } from './config'
import type { ChatProviderContext, ChatProviderResult } from './types'

const providers: Record<OpenAIChatProvider, (ctx: ChatProviderContext) => Promise<ChatProviderResult>> = {
  responses: runResponsesChat,
  'chat-completions': runChatCompletionsChat,
}

export function runChat(provider: OpenAIChatProvider, ctx: ChatProviderContext): Promise<ChatProviderResult> {
  return providers[provider](ctx)
}

export { resolveChatProvider, resolveChatClientConfig } from './config'
export type { OpenAIChatProvider, ChatClientConfig } from './config'
export { EmptyReplyError } from './types'
export type { ChatRequestBody, ChatProviderContext, ChatProviderResult, ChatThreadRecord } from './types'
