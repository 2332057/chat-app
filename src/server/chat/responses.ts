import SYSTEM_INSTRUCTIONS from '../../instructions.md?raw'

import { buildToolPayload, responseTools, runAppToolCalls, toResponsesInputItems } from './toolCalls'
import type { AppToolCall } from './toolCalls'
import { EmptyReplyError } from './types'
import type { ChatProviderContext, ChatProviderResult } from './types'
import { stripHtmlComments } from './sanitize'

// Responses API の履歴の渡し方をハードコードで切り替える。
// - 'previous_response_id': サーバ側に状態を持たせ、直前の response_id だけ渡す（既定）
// - 'input_history': previous_response_id を使わず、DBの履歴から input を毎回組み立てて渡す
const RESPONSES_HISTORY_MODE: 'previous_response_id' | 'input_history' = 'previous_response_id'

const MAX_TOOL_ROUNDS = 3

// DBの messages 履歴を Responses の input items 配列へ変換する。
// ツールターン行は function_call + function_call_output に展開する。
async function buildResponsesInputHistory(
  db: ChatProviderContext['db'],
  threadId: ChatProviderContext['threadId'],
): Promise<any[]> {
  const { results: history } = await db
    .prepare('SELECT role, content, tool_payload FROM messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC')
    .bind(threadId)
    .all<{ role: 'user' | 'assistant'; content: string; tool_payload: string | null }>()

  const input: any[] = []
  for (const m of history) {
    const toolItems = toResponsesInputItems(m.tool_payload)
    if (toolItems) {
      input.push(...toolItems)
    } else {
      input.push({ role: m.role, content: m.content })
    }
  }
  return input
}

export async function runResponsesChat(ctx: ChatProviderContext): Promise<ChatProviderResult> {
  const { client, db, threadId, content, model, previousResponseId, reasoningEffort } = ctx
  if (!client) {
    throw new Error('OpenAI client is required for responses provider.')
  }

  const reasoningParam = reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}

  const result: ChatProviderResult = {
    messages: [],
    notes: [],
  }

  const useInputHistory = RESPONSES_HISTORY_MODE === 'input_history'

  // input_history モードでは今回のユーザー発言もハンドラ側で挿入済みなので履歴に含まれる。
  // previous_response_id モードでは今回の発言だけを input に渡す。
  const initialInput = useInputHistory ? await buildResponsesInputHistory(db, threadId) : content

  // input_history モードでは、ツール往復のたびに function_call と実行結果を積み増していく
  const inputItems: any[] = useInputHistory ? (Array.isArray(initialInput) ? [...initialInput] : [{ role: 'user', content: initialInput }]) : []

  let response = await (client as any).responses.create({
    model: model,
    instructions: SYSTEM_INSTRUCTIONS,
    input: initialInput,
    previous_response_id: useInputHistory ? undefined : previousResponseId ?? undefined,
    tools: responseTools,
    tool_choice: 'auto',
    ...reasoningParam,
  })

  // Function Callingの処理ループ
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const functionCalls = response.output?.filter((o: any) => o.type === 'function_call') || []
    if (functionCalls.length === 0) {
      break
    }

    const appCalls: AppToolCall[] = functionCalls.map((call: any) => ({
      id: call.call_id || call.id,
      name: call.name,
      arguments: call.arguments,
    }))
    const { outputs, logs, notes } = await runAppToolCalls(db, threadId, appCalls)
    result.notes.push(...notes)

    if (outputs.length === 0) {
      break
    }

    // ツールの実行結果をAPIに渡し、最終的な返答を生成させる
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

    const outputItems = outputs.map((o) => ({
      type: 'function_call_output',
      call_id: o.callId,
      output: o.output,
    }))

    const toolChoice = round === MAX_TOOL_ROUNDS - 1 ? 'none' : 'auto'
    const previousId = response.id

    if (useInputHistory) {
      inputItems.push(...functionCalls, ...outputItems)
      response = await (client as any).responses.create({
        model: model,
        instructions: SYSTEM_INSTRUCTIONS,
        input: inputItems,
        tools: responseTools,
        tool_choice: toolChoice,
        ...reasoningParam,
      })
    } else {
      response = await (client as any).responses.create({
        model: model,
        instructions: SYSTEM_INSTRUCTIONS,
        input: outputItems,
        previous_response_id: previousId,
        tools: responseTools,
        tool_choice: toolChoice,
        ...reasoningParam,
      })
    }
  }

  // テキストを安全に抽出（配列で返ってきた場合にも対応）
  let reply = response.output_text || ''
  if (!reply && Array.isArray(response.output)) {
    const msg = response.output.find((o: any) => o.type === 'message')
    if (msg && Array.isArray(msg.content)) {
      reply = msg.content.map((c: any) => c.text || c.output_text || '').join('')
    }
  }
  reply = stripHtmlComments(reply)

  if (!reply) {
    throw new EmptyReplyError()
  }

  await db
    .prepare('INSERT INTO messages (thread_id, role, content, response_id, model, raw_response) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(threadId, 'assistant', reply, response.id, response.model ?? model, JSON.stringify(response))
    .run()

  result.messages.push({
    id: response.id || '',
    role: 'assistant',
    content: reply,
    createdAt: Date.now(),
    model: response.model ?? model,
  })

  // input_history モードでは previous_response_id に依存しないので last_response_id は更新しない
  if (!useInputHistory && response.id) {
    result.lastResponseId = response.id
  }

  return result
}
