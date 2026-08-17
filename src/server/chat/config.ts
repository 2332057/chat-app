export const MODEL = 'gpt-5.5'
export const ANTHROPIC_MODEL = 'claude-haiku-4-5'

export type OpenAIChatProvider = 'responses' | 'chat-completions'
export type ChatApiProvider = OpenAIChatProvider | 'claude-oauth'

export function resolveChatProvider(value?: string | null): ChatApiProvider {
  if (value === 'claude-oauth') return 'claude-oauth'
  return value === 'chat-completions' ? 'chat-completions' : 'responses'
}

export type ChatClientConfig = {
  apiKey?: string
  baseURL?: string
  model: string
  maxTokens?: number
  reasoningEffort?: string
  anthropic: {
    oauthToken?: string
    baseURL?: string
    model?: string
    maxTokens?: number
    maxTurns?: number
  }
}

export function resolveChatClientConfig(env: {
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  OPENAI_MODEL?: string
  OPENAI_MAX_TOKENS?: string
  OPENAI_REASONING_EFFORT?: string
  ANTHROPIC_OAUTH_TOKEN?: string
  CLAUDE_CODE_OAUTH_TOKEN?: string
  ANTHROPIC_BASE_URL?: string
  ANTHROPIC_MODEL?: string
  ANTHROPIC_MAX_TOKENS?: string
  CLAUDE_MAX_TURNS?: string
}): ChatClientConfig {
  return {
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL ?? MODEL,
    maxTokens: env.OPENAI_MAX_TOKENS ? Number(env.OPENAI_MAX_TOKENS) : undefined,
    reasoningEffort: env.OPENAI_REASONING_EFFORT || undefined,
    anthropic: {
      oauthToken: env.ANTHROPIC_OAUTH_TOKEN ?? env.CLAUDE_CODE_OAUTH_TOKEN,
      baseURL: env.ANTHROPIC_BASE_URL,
      model: env.ANTHROPIC_MODEL ?? ANTHROPIC_MODEL,
      maxTokens: env.ANTHROPIC_MAX_TOKENS ? Number(env.ANTHROPIC_MAX_TOKENS) : undefined,
      maxTurns: env.CLAUDE_MAX_TURNS ? Number(env.CLAUDE_MAX_TURNS) : undefined,
    },
  }
}
