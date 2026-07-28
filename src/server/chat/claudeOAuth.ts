import SYSTEM_INSTRUCTIONS from '../../instructions.md?raw'

import { buildToolPayload, runAppToolCalls, toAnthropicMessages } from './toolCalls'
import type { AppToolCall } from './toolCalls'
import { EmptyReplyError } from './types'
import type { ChatProviderContext, ChatProviderResult } from './types'
import { tools } from '../../tools'

const CLAUDE_OAUTH_RESPONSE_PREFIX = 'claude-oauth:'
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_MAX_TOOL_ROUNDS = 3
const DEFAULT_CLAUDE_CODE_VERSION = '2.1.75'

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | Array<Record<string, unknown>>
}

type AnthropicContentBlock = Record<string, unknown> & {
  type?: string
}

type AnthropicMessageResponse = {
  id?: string
  model?: string
  content?: AnthropicContentBlock[]
  error?: {
    type?: string
    message?: string
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function buildOAuthHeaders(ctx: ChatProviderContext): Record<string, string> {
  const token = ctx.anthropic?.oauthToken
  if (!token) {
    throw new Error('ANTHROPIC_OAUTH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN is required when CHAT_API_PROVIDER=claude-oauth.')
  }

  const claudeVersion = ctx.anthropic?.claudeCodeVersion || DEFAULT_CLAUDE_CODE_VERSION
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'anthropic-version': ctx.anthropic?.version || DEFAULT_ANTHROPIC_VERSION,
    'User-Agent': ctx.anthropic?.userAgent || `claude-code/${claudeVersion}`,
  }
  if (ctx.anthropic?.beta) {
    headers['anthropic-beta'] = ctx.anthropic.beta
  }
  if (ctx.anthropic?.dangerousDirectBrowserAccess) {
    headers['anthropic-dangerous-direct-browser-access'] = ctx.anthropic.dangerousDirectBrowserAccess
  }
  if (ctx.anthropic?.xApp) {
    headers['x-app'] = ctx.anthropic.xApp
  }
  return headers
}

function toAnthropicTools(): Array<Record<string, unknown>> {
  return tools
    .filter((tool) => tool.type === 'function')
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
}

async function buildMessageHistory(db: ChatProviderContext['db'], threadId: ChatProviderContext['threadId']): Promise<AnthropicMessage[]> {
  const { results: history } = await db
    .prepare('SELECT role, content, tool_payload FROM messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC')
    .bind(threadId)
    .all<{ role: 'user' | 'assistant'; content: string; tool_payload: string | null }>()

  const messages: AnthropicMessage[] = []
  for (const message of history) {
    const toolMessages = toAnthropicMessages(message.tool_payload)
    if (toolMessages) {
      messages.push(...toolMessages)
    } else {
      messages.push({ role: message.role, content: message.content })
    }
  }
  return messages
}

function extractToolCalls(response: AnthropicMessageResponse): AppToolCall[] {
  return (response.content ?? [])
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: String(block.id || ''),
      name: String(block.name || ''),
      arguments: block.input ?? {},
    }))
    .filter((call) => call.id && call.name)
}

function extractReply(response: AnthropicMessageResponse): string {
  return (response.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('')
    .trim()
}

async function createAnthropicMessage(ctx: ChatProviderContext, messages: AnthropicMessage[], allowTools: boolean): Promise<AnthropicMessageResponse> {
  const baseURL = ctx.anthropic?.baseURL || DEFAULT_ANTHROPIC_BASE_URL
  const body: Record<string, unknown> = {
    model: ctx.model,
    max_tokens: ctx.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: [
      {
        type: 'text',
        text: SYSTEM_INSTRUCTIONS,
      },
    ],
    messages,
  }

  if (allowTools) {
    body.tools = toAnthropicTools()
    body.tool_choice = { type: 'auto' }
  }

  const response = await fetch(joinUrl(baseURL, '/v1/messages'), {
    method: 'POST',
    headers: buildOAuthHeaders(ctx),
    body: JSON.stringify(body),
  })

  const responseText = await response.text()
  let payload: AnthropicMessageResponse
  try {
    payload = responseText ? (JSON.parse(responseText) as AnthropicMessageResponse) : {}
  } catch {
    payload = { error: { message: responseText } }
  }
  if (!response.ok) {
    const detail = payload.error?.message || JSON.stringify(payload)
    throw new Error(`Anthropic OAuth request returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  return payload
}

export async function runClaudeOAuthChat(ctx: ChatProviderContext): Promise<ChatProviderResult> {
  const { db, threadId, model } = ctx
  const maxToolRounds = ctx.anthropic?.maxTurns ?? DEFAULT_MAX_TOOL_ROUNDS
  const result: ChatProviderResult = {
    messages: [],
    notes: [],
  }

  const messages = await buildMessageHistory(db, threadId)
  let response = await createAnthropicMessage(ctx, messages, true)

  for (let round = 0; round < maxToolRounds; round++) {
    const appCalls = extractToolCalls(response)
    if (appCalls.length === 0) {
      break
    }

    const { outputs, logs, notes } = await runAppToolCalls(db, threadId, appCalls)
    result.notes.push(...notes)

    const functionLog = 'ツール実行: ' + logs.join('\n')
    const toolPayload = buildToolPayload(appCalls, outputs)
    await db
      .prepare('INSERT INTO messages (thread_id, role, content, response_id, model, raw_response, tool_payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(threadId, 'assistant', functionLog, response.id || null, response.model ?? model, JSON.stringify(response), toolPayload)
      .run()
    result.messages.push({
      id: response.id || '',
      role: 'assistant',
      content: functionLog,
      createdAt: Date.now(),
      model: response.model ?? model,
    })

    messages.push({
      role: 'assistant',
      content: response.content ?? [],
    })
    messages.push({
      role: 'user',
      content: outputs.map((output) => ({
        type: 'tool_result',
        tool_use_id: output.callId,
        content: output.output,
      })),
    })

    response = await createAnthropicMessage(ctx, messages, round < maxToolRounds - 1)
  }

  const reply = extractReply(response)
  if (!reply) {
    throw new EmptyReplyError()
  }

  await db
    .prepare('INSERT INTO messages (thread_id, role, content, response_id, model, raw_response) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(threadId, 'assistant', reply, response.id || null, response.model ?? model, JSON.stringify(response))
    .run()

  result.messages.push({
    id: response.id || '',
    role: 'assistant',
    content: reply,
    createdAt: Date.now(),
    model: response.model ?? model,
  })

  if (response.id) {
    result.lastResponseId = `${CLAUDE_OAUTH_RESPONSE_PREFIX}${response.id}`
  }

  return result
}
