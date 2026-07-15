export const MODEL = 'gpt-5.5'

export type OpenAIChatProvider = 'responses' | 'chat-completions'

export function resolveChatProvider(value?: string | null): OpenAIChatProvider {
  return value === 'chat-completions' ? 'chat-completions' : 'responses'
}

export type ChatClientConfig = {
  apiKey?: string
  baseURL?: string
  model: string
  maxTokens?: number
  reasoningEffort?: string
}

export function resolveChatClientConfig(env: {
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  OPENAI_MODEL?: string
  OPENAI_MAX_TOKENS?: string
  OPENAI_REASONING_EFFORT?: string
}): ChatClientConfig {
  return {
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL ?? MODEL,
    maxTokens: env.OPENAI_MAX_TOKENS ? Number(env.OPENAI_MAX_TOKENS) : undefined,
    reasoningEffort: env.OPENAI_REASONING_EFFORT || undefined,
  }
}
