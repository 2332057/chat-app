import { runResponsesChat } from './responses'
import { runChatCompletionsChat } from './chatCompletions'
import { runClaudeOAuthChat } from './claudeOAuth'
import type { ChatApiProvider } from './config'
import type { ChatProviderContext, ChatProviderResult } from './types'

const providers: Record<ChatApiProvider, (ctx: ChatProviderContext) => Promise<ChatProviderResult>> = {
  responses: runResponsesChat,
  'chat-completions': runChatCompletionsChat,
  'claude-oauth': runClaudeOAuthChat,
}

export function runChat(provider: ChatApiProvider, ctx: ChatProviderContext): Promise<ChatProviderResult> {
  return providers[provider](ctx)
}

export { resolveChatProvider, resolveChatClientConfig } from './config'
export type { OpenAIChatProvider, ChatApiProvider, ChatClientConfig } from './config'
export { EmptyReplyError } from './types'
export type { ChatRequestBody, ChatProviderContext, ChatProviderResult, ChatThreadRecord } from './types'
