import SYSTEM_INSTRUCTIONS from '../../instructions.md?raw'

import { buildToolPayload, runAppToolCalls, toAnthropicMessages } from './toolCalls'
import type { AppToolCall } from './toolCalls'
import { EmptyReplyError } from './types'
import type { ChatProviderContext, ChatProviderResult } from './types'
import { tools } from '../../tools'
import { buildCapturedOAuthBody } from './claudeOAuthShape'
import type { AnthropicMessage, ClaudeOAuthTemplate } from './claudeOAuthShape'
import { stripHtmlComments } from './sanitize'

const CLAUDE_OAUTH_RESPONSE_PREFIX = 'claude-oauth:'
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_MAX_TOOL_ROUNDS = 3

type AnthropicContentBlock = Record<string, unknown> & {
  type?: string
}

type AnthropicMessageResponse = {
  id?: string
  model?: string
  content?: AnthropicContentBlock[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  error?: {
    type?: string
    message?: string
  }
}

type ClaudeOAuthTemplateRow = {
  headers: string
  body: string
}

let cachedTemplate: ClaudeOAuthTemplate | null = null

export class AnthropicOAuthError extends Error {
  status: number
  type?: string

  constructor(status: number, type: string | undefined, message: string) {
    super(`Anthropic OAuth request returned HTTP ${status}${message ? `: ${message}` : ''}`)
    this.name = 'AnthropicOAuthError'
    this.status = status
    this.type = type
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * 捕捉したヘッダー (user-agent, anthropic-beta, x-app, anthropic-version など) が
 * Claude Code としての身元になる。環境変数で組み立て直す必要はない。
 * 認証だけは捕捉時の値ではなく、現在のトークンを使う。
 */
function buildOAuthHeaders(ctx: ChatProviderContext, template: ClaudeOAuthTemplate): Record<string, string> {
  const token = ctx.anthropic?.oauthToken
  if (!token) {
    throw new Error('ANTHROPIC_OAUTH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN is required when CHAT_API_PROVIDER=claude-oauth.')
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  for (const [name, value] of Object.entries(template.headers)) {
    if (!value || shouldSkipCapturedHeader(name)) {
      continue
    }
    headers[name] = value
  }
  headers.Authorization = `Bearer ${token}`
  headers['Content-Type'] = 'application/json'
  return headers
}

function shouldSkipCapturedHeader(name: string): boolean {
  return ['authorization', 'content-length', 'host', 'connection', 'accept-encoding'].includes(name.toLowerCase())
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
  const template = await loadClaudeOAuthTemplate(ctx)
  const body = buildCapturedOAuthBody({
    templateBody: template.body,
    model: ctx.model,
    messages,
    allowTools,
    systemInstructions: SYSTEM_INSTRUCTIONS,
    tools,
  })

  const requestBody = JSON.stringify(body)
  const fetchStart = performance.now()
  const response = await fetch(joinUrl(baseURL, '/v1/messages'), {
    method: 'POST',
    headers: buildOAuthHeaders(ctx, template),
    body: requestBody,
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
    throw new AnthropicOAuthError(response.status, payload.error?.type, detail)
  }
  logTiming('anthropic_fetch', {
    ms: elapsed(fetchStart),
    status: response.status,
    model: ctx.model,
    allowTools,
    requestBytes: requestBody.length,
    responseBytes: responseText.length,
    inputTokens: payload.usage?.input_tokens,
    outputTokens: payload.usage?.output_tokens,
    cacheCreationInputTokens: payload.usage?.cache_creation_input_tokens,
    cacheReadInputTokens: payload.usage?.cache_read_input_tokens,
  })
  return payload
}

/**
 * リクエストの雛形は必ず D1 から読む。手組みの形では Claude Code として通らず、
 * モデルによっては Anthropic に弾かれるため、行が無ければ黙って劣化させずに落とす。
 */
async function loadClaudeOAuthTemplate(ctx: ChatProviderContext): Promise<ClaudeOAuthTemplate> {
  if (cachedTemplate) {
    logTiming('claude_oauth_template', { source: 'memory' })
    return cachedTemplate
  }
  const startedAt = performance.now()
  const row = await ctx.db.prepare('SELECT headers, body FROM claude_oauth_template WHERE id = 1').first<ClaudeOAuthTemplateRow>()
  if (!row) {
    throw new Error('claude_oauth_template id=1 was not found. Run scripts/claude-oauth-cloudflare.mjs to capture and store it.')
  }
  cachedTemplate = {
    headers: JSON.parse(row.headers) as Record<string, string>,
    body: JSON.parse(row.body) as Record<string, unknown>,
  }
  logTiming('claude_oauth_template', { source: 'd1', ms: elapsed(startedAt) })
  return cachedTemplate
}

export async function runClaudeOAuthChat(ctx: ChatProviderContext): Promise<ChatProviderResult> {
  const { db, threadId, model } = ctx
  const maxToolRounds = ctx.anthropic?.maxTurns ?? DEFAULT_MAX_TOOL_ROUNDS
  const result: ChatProviderResult = {
    messages: [],
    notes: [],
  }

  const historyStart = performance.now()
  const messages = await buildMessageHistory(db, threadId)
  logTiming('d1_message_history', { ms: elapsed(historyStart), messages: messages.length })
  let response = await createAnthropicMessage(ctx, messages, true)

  for (let round = 0; round < maxToolRounds; round++) {
    const appCalls = extractToolCalls(response)
    if (appCalls.length === 0) {
      break
    }

    const toolStart = performance.now()
    const { outputs, logs, notes } = await runAppToolCalls(db, threadId, appCalls)
    logTiming('app_tool_calls', { ms: elapsed(toolStart), round, calls: appCalls.length, notes: notes.length })
    result.notes.push(...notes)

    const functionLog = 'ツール実行: ' + logs.join('\n')
    const toolPayload = buildToolPayload(appCalls, outputs)
    const toolAuditStart = performance.now()
    await db
      .prepare('INSERT INTO messages (thread_id, role, content, response_id, model, raw_response, tool_payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(threadId, 'assistant', functionLog, response.id || null, response.model ?? model, JSON.stringify(response), toolPayload)
      .run()
    logTiming('d1_tool_audit_insert', { ms: elapsed(toolAuditStart), round })
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

  const reply = stripHtmlComments(extractReply(response))
  if (!reply) {
    throw new EmptyReplyError()
  }

  const assistantInsertStart = performance.now()
  await db
    .prepare('INSERT INTO messages (thread_id, role, content, response_id, model, raw_response) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(threadId, 'assistant', reply, response.id || null, response.model ?? model, JSON.stringify(response))
    .run()
  logTiming('d1_assistant_message_insert', { ms: elapsed(assistantInsertStart) })

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

function logTiming(name: string, fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      event: 'claude_oauth_timing',
      name,
      ...fields,
    }),
  )
}

function elapsed(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10
}
