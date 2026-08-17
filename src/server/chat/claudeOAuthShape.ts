export type AnthropicMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string | Array<Record<string, unknown>>
}

export type ToolDefinition = {
  type: string
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type ClaudeOAuthTemplate = {
  headers: Record<string, string>
  body: Record<string, unknown>
}

// OPENAI_REASONING_EFFORT と揃える。片方だけ変えると条件が揃わなくなるので定数で持つ。
export const REASONING_EFFORT = 'high'

type BodyOptions = {
  model: string
  messages: AnthropicMessage[]
  allowTools: boolean
  systemInstructions: string
  tools: ToolDefinition[]
}

type CapturedBodyOptions = BodyOptions & {
  templateBody: Record<string, unknown>
}

export function buildCapturedOAuthBody({
  templateBody,
  model,
  messages,
  allowTools,
  systemInstructions,
  tools,
}: CapturedBodyOptions): Record<string, unknown> {
  const body = deepClone(templateBody)
  body.model = model
  body.stream = false
  // thinking と output_config は捕捉したものを使う。OpenAI 側の reasoning effort と
  // 揃えるため effort だけ上書きする。max_tokens も捕捉値のままにして、
  // 出力上限を環境変数で二重管理しない。
  body.output_config = { ...(typeof body.output_config === 'object' && body.output_config ? body.output_config : {}), effort: REASONING_EFFORT }
  delete body.fallbacks
  delete body.context_management
  appendTopLevelSystem(body, systemInstructions)
  body.messages = [...capturedContextMessages(templateBody), ...messages]
  if (allowTools) {
    body.tools = toAnthropicTools(tools)
    body.tool_choice = { type: 'auto' }
  } else {
    delete body.tools
    delete body.tool_choice
  }
  return body
}

export function toAnthropicTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  const anthropicTools: Array<Record<string, unknown>> = tools
    .filter((tool) => tool.type === 'function')
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        ...tool.parameters,
      },
    }))
  if (anthropicTools.length) {
    anthropicTools[anthropicTools.length - 1].cache_control = {
      type: 'ephemeral',
      ttl: '1h',
    }
  }
  return anthropicTools
}

export function capturedContextMessages(body: Record<string, unknown>): AnthropicMessage[] {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages
    .map((message): AnthropicMessage | null => {
      if (!message || typeof message !== 'object') {
        return null
      }
      const candidate = message as AnthropicMessage
      if (candidate.role !== 'user') {
        return null
      }

      const content = systemReminderContent(candidate.content)
      return content ? { role: 'user', content } : null
    })
    .filter((message): message is AnthropicMessage => Boolean(message))
    .slice(0, 1)
}

export function appSystemMessage(systemInstructions: string): AnthropicMessage {
  return {
    role: 'system',
    content: [
      {
        type: 'text',
        text: systemInstructions,
        cache_control: {
          type: 'ephemeral',
          ttl: '1h',
        },
      },
    ],
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function systemReminderContent(content: AnthropicMessage['content']): AnthropicMessage['content'] | null {
  if (Array.isArray(content)) {
    const reminderBlocks = content.filter((block) => JSON.stringify(block).includes('<system-reminder>'))
    return reminderBlocks.length > 0 ? reminderBlocks : null
  }

  const match = content.match(/<system-reminder>[\s\S]*?<\/system-reminder>/)
  return match ? match[0] : null
}

function appendTopLevelSystem(body: Record<string, unknown>, systemInstructions: string): void {
  const system = Array.isArray(body.system) ? body.system : []
  system.push({
    type: 'text',
    text: systemInstructions,
    cache_control: {
      type: 'ephemeral',
      ttl: '1h',
    },
  })
  body.system = system
}
