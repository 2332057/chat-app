import type { D1Database } from '@cloudflare/workers-types'
import type { NoteType } from '../../types/chat'
import { countNoteVersions, createNote, editNote, readNote, tools } from '../../tools'

export type AppToolCall = {
  id: string
  name: string
  arguments?: unknown
}

export type AppToolResult = {
  callId: string
  output: string
}

export type AppToolExecutionResult = {
  outputs: AppToolResult[]
  logs: string[]
  notes: NoteType[]
}

function parseToolArguments(args: unknown): Record<string, unknown> {
  if (typeof args === 'string') {
    return args ? JSON.parse(args) : {}
  }
  if (args && typeof args === 'object') {
    return args as Record<string, unknown>
  }
  return {}
}

export async function runAppToolCalls(db: D1Database, threadId: string | number, calls: AppToolCall[]): Promise<AppToolExecutionResult> {
  const outputs: AppToolResult[] = []
  const logs: string[] = []
  const notes: NoteType[] = []

  for (const call of calls) {
    if (call.name === 'read_note') {
      const result = await readNote(db, threadId)
      outputs.push({ callId: call.id, output: JSON.stringify(result) })
      // 成功時は全バージョンが返るので、その件数が最新バージョン番号になる
      if (Array.isArray(result)) {
        logs.push(`最新のv${result.length}を読みました`)
      } else {
        logs.push('ノートがまだないため読み取れませんでした')
      }
    } else if (call.name === 'create_note') {
      const args = parseToolArguments(call.arguments)
      const result = await createNote(db, threadId, String(args.title || ''), String(args.content || ''))
      outputs.push({ callId: call.id, output: JSON.stringify(result) })
      if (!('error' in result)) {
        notes.push(result)
        const version = await countNoteVersions(db, threadId)
        logs.push(`v${version}を作成しました`)
      } else {
        logs.push('create_note の実行に失敗しました')
      }
    } else if (call.name === 'edit_note') {
      const args = parseToolArguments(call.arguments)
      const rawEdits = Array.isArray(args.edits) ? args.edits : []
      const edits = rawEdits.map((e) => ({
        old_str: String((e as Record<string, unknown> | null)?.old_str ?? ''),
        new_str: String((e as Record<string, unknown> | null)?.new_str ?? ''),
      }))
      const result = await editNote(db, threadId, edits)
      outputs.push({ callId: call.id, output: JSON.stringify(result) })
      if (!('error' in result)) {
        notes.push(result)
        const version = await countNoteVersions(db, threadId)
        logs.push(`v${version}に更新しました`)
      } else {
        logs.push('edit_note の実行に失敗しました')
      }
    }
  }

  return { outputs, logs, notes }
}

// プロバイダ中立なツールターンのペイロード。messages.tool_payload に JSON で保存し、
// 次ターンの履歴再構築時に各API形式へ復元する
export type ToolPayload = {
  calls: AppToolCall[]
  outputs: AppToolResult[]
}

// 実行したツール呼び出しと結果を1つのJSON文字列にまとめる
export function buildToolPayload(calls: AppToolCall[], outputs: AppToolResult[]): string {
  const payload: ToolPayload = { calls, outputs }
  return JSON.stringify(payload)
}

function parseToolPayload(raw: string | null | undefined): ToolPayload | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as ToolPayload
    if (Array.isArray(parsed?.calls) && Array.isArray(parsed?.outputs)) {
      return parsed
    }
  } catch {
    // 壊れたペイロードは無視して履歴から落とす
  }
  return null
}

function parseToolInput(args: unknown): unknown {
  if (typeof args === 'string') {
    try {
      return args ? JSON.parse(args) : {}
    } catch {
      return {}
    }
  }
  return args ?? {}
}

// Chat Completions 形式へ復元: assistant(tool_calls) の後に tool(output) を並べる
export function toChatCompletionMessages(raw: string | null | undefined, assistantContent = ''): any[] | null {
  const payload = parseToolPayload(raw)
  if (!payload) {
    return null
  }
  const messages: any[] = [
    {
      role: 'assistant',
      content: assistantContent,
      tool_calls: payload.calls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: {
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        },
      })),
    },
  ]
  for (const output of payload.outputs) {
    messages.push({
      role: 'tool',
      tool_call_id: output.callId,
      content: output.output,
    })
  }
  return messages
}

// Responses 形式へ復元: function_call の後に function_call_output を並べる
export function toResponsesInputItems(raw: string | null | undefined): any[] | null {
  const payload = parseToolPayload(raw)
  if (!payload) {
    return null
  }
  const items: any[] = payload.calls.map((call) => ({
    type: 'function_call' as const,
    call_id: call.id,
    name: call.name,
    arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
  }))
  for (const output of payload.outputs) {
    items.push({
      type: 'function_call_output' as const,
      call_id: output.callId,
      output: output.output,
    })
  }
  return items
}

// Anthropic Messages 形式へ復元: assistant(tool_use) の後に user(tool_result) を並べる
export function toAnthropicMessages(raw: string | null | undefined): any[] | null {
  const payload = parseToolPayload(raw)
  if (!payload) {
    return null
  }
  return [
    {
      role: 'assistant',
      content: payload.calls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: parseToolInput(call.arguments),
      })),
    },
    {
      role: 'user',
      content: payload.outputs.map((output) => ({
        type: 'tool_result',
        tool_use_id: output.callId,
        content: output.output,
      })),
    },
  ]
}

export const responseTools = tools

export const chatCompletionTools = tools
  .filter((tool) => tool.type === 'function')
  .map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    },
  }))
