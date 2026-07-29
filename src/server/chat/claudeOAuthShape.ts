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

type BodyOptions = {
  model: string
  maxTokens: number
  messages: AnthropicMessage[]
  allowTools: boolean
  systemInstructions: string
  tools: ToolDefinition[]
}

type CapturedBodyOptions = BodyOptions & {
  templateBody: Record<string, unknown>
}

export function buildDefaultOAuthBody({ model, maxTokens, messages, allowTools, systemInstructions, tools }: BodyOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system: [
      {
        type: 'text',
        text: systemInstructions,
      },
    ],
    messages,
  }

  if (allowTools) {
    body.tools = toAnthropicTools(tools)
    body.tool_choice = { type: 'auto' }
  }
  return body
}

export function buildCapturedOAuthBody({
  templateBody,
  model,
  maxTokens,
  messages,
  allowTools,
  systemInstructions,
  tools,
}: CapturedBodyOptions): Record<string, unknown> {
  const body = deepClone(templateBody)
  body.model = model
  body.max_tokens = maxTokens
  body.stream = false
  delete body.thinking
  delete body.output_config
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
