import SYSTEM_INSTRUCTIONS from '../../instructions.md?raw'

import { buildToolPayload, buildToolTurnContent, chatCompletionTools, runAppToolCalls, toChatCompletionMessages } from './toolCalls'
import type { AppToolCall } from './toolCalls'
import { EmptyReplyError } from './types'
import type { ChatProviderContext, ChatProviderResult } from './types'
import { stripHtmlComments } from './sanitize'

const MAX_TOOL_ROUNDS = 3

export async function runChatCompletionsChat(ctx: ChatProviderContext): Promise<ChatProviderResult> {
  const { client, db, threadId, model, maxTokens, reasoningEffort } = ctx
  if (!client) {
    throw new Error('OpenAI client is required for chat-completions provider.')
  }

  const extraParams: Record<string, unknown> = {}
  if (maxTokens !== undefined) extraParams.max_tokens = maxTokens
  if (reasoningEffort) extraParams.reasoning_effort = reasoningEffort

  const result: ChatProviderResult = {
    messages: [],
    notes: [],
  }

  // 今回のユーザー発言はハンドラ側で挿入済みなので、履歴に含まれる
  const { results: history } = await db
    .prepare('SELECT role, content, tool_payload FROM messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC')
    .bind(threadId)
    .all<{ role: 'user' | 'assistant'; content: string; tool_payload: string | null }>()

  const conversation: any[] = [{ role: 'system', content: SYSTEM_INSTRUCTIONS }]
  for (const m of history) {
    // ツールターン行は assistant(tool_calls) + tool(output) に展開して復元する
    const toolMessages = toChatCompletionMessages(m.tool_payload)
    if (toolMessages) {
      conversation.push(...toolMessages)
    } else {
      conversation.push({ role: m.role, content: m.content })
    }
  }

  let completion = await client.chat.completions.create({
    model: model,
    messages: conversation,
    tools: chatCompletionTools as any,
    tool_choice: 'auto',
    ...extraParams,
  } as any)
  let message = completion.choices[0]?.message

  // Function Callingの処理ループ
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const toolCalls = (message?.tool_calls || []).filter((tc: any) => tc.type === 'function')
    if (toolCalls.length === 0) {
      break
    }

    const appCalls: AppToolCall[] = toolCalls.map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }))
    const { outputs, logs, notes } = await runAppToolCalls(db, threadId, appCalls)
    result.notes.push(...notes)

    if (outputs.length === 0) {
      break
    }

    // ツールの実行結果をAPIに渡し、最終的な返答を生成させる
    // tool_calls と content が同時に返ることがあるので、その content も残して表示する
    const preface = stripHtmlComments(message?.content || '')
    const functionLog = buildToolTurnContent(preface, logs)
    const toolPayload = buildToolPayload(appCalls, outputs, preface)
    await db
      .prepare('INSERT INTO messages (thread_id, role, content, response_id, model, raw_response, tool_payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(threadId, 'assistant', functionLog, completion.id || null, completion.model ?? model, JSON.stringify(completion), toolPayload)
      .run()
    result.messages.push({
      id: completion.id || '',
      role: 'assistant',
      content: functionLog,
      createdAt: Date.now(),
      model: completion.model ?? model,
    })

    conversation.push({
      role: 'assistant',
      // 次ターンに履歴を再構築したときと同じ内容にそろえる
      content: preface,
      tool_calls: toolCalls.map((tc: any) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    })
    for (const o of outputs) {
      conversation.push({
        role: 'tool',
        tool_call_id: o.callId,
        content: o.output,
      })
    }

    const toolChoice = round === MAX_TOOL_ROUNDS - 1 ? 'none' : 'auto'

    completion = await client.chat.completions.create({
      model: model,
      messages: conversation,
      tools: chatCompletionTools as any,
      tool_choice: toolChoice,
      ...extraParams,
    } as any)
    message = completion.choices[0]?.message
  }

  const reply = stripHtmlComments(message?.content || '')
  if (!reply) {
    if (completion.choices[0]?.finish_reason === 'length') {
      throw new Error('モデルの出力がトークン上限で打ち切られました（OPENAI_MAX_TOKENS の引き上げ、または reasoning_effort を下げてください）')
    }
    throw new EmptyReplyError()
  }

  await db
    .prepare('INSERT INTO messages (thread_id, role, content, response_id, model, raw_response) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(threadId, 'assistant', reply, completion.id, completion.model ?? model, JSON.stringify(completion))
    .run()

  result.messages.push({
    id: completion.id || '',
    role: 'assistant',
    content: reply,
    createdAt: Date.now(),
    model: completion.model ?? model,
  })

  return result
}
