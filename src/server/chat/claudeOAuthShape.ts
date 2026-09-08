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

// output_config.effort が受け付ける段階。範囲外を送ると Anthropic が 400 を返すので、
// 打ち間違いは undefined 扱いにしてキーごと落とす（= API 既定の high）。
export const REASONING_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

export function resolveReasoningEffort(value?: string | null): string | undefined {
  const normalized = (value ?? '').trim().toLowerCase()
  return REASONING_EFFORT_LEVELS.includes(normalized) ? normalized : undefined
}

type BodyOptions = {
  model: string
  messages: AnthropicMessage[]
  allowTools: boolean
  systemInstructions: string
  tools: ToolDefinition[]
  effort?: string
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
  effort,
}: CapturedBodyOptions): Record<string, unknown> {
  const body = deepClone(templateBody)
  body.model = model
  body.stream = false
  // thinking と max_tokens は捕捉したものを使う（出力上限を環境変数で二重管理しない）。
  // effort は ANTHROPIC_REASONING_EFFORT があればそれを送り、無ければキーごと落として
  // API 既定 (high) に任せる。捕捉テンプレートには Claude Code 自身の effort が
  // 入っているので、残すと捕捉時の設定に引きずられる。
  const outputConfig: Record<string, unknown> = {
    ...(typeof body.output_config === 'object' && body.output_config ? body.output_config : {}),
  }
  const resolvedEffort = resolveReasoningEffort(effort)
  if (resolvedEffort) {
    outputConfig.effort = resolvedEffort
  } else {
    delete outputConfig.effort
  }
  if (Object.keys(outputConfig).length) {
    body.output_config = outputConfig
  } else {
    delete body.output_config
  }
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
