import SYSTEM_INSTRUCTIONS from '../../instructions.md?raw'

import { buildToolPayload, chatCompletionTools, runAppToolCalls, toChatCompletionMessages } from './toolCalls'
import type { AppToolCall } from './toolCalls'
import { EmptyReplyError } from './types'
import type { ChatProviderContext, ChatProviderResult } from './types'

export async function runChatCompletionsChat(ctx: ChatProviderContext): Promise<ChatProviderResult> {
  const { client, db, threadId, model, maxTokens, reasoningEffort } = ctx

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
  const toolCalls = (message?.tool_calls || []).filter((tc: any) => tc.type === 'function')

  if (toolCalls.length > 0) {
    const appCalls: AppToolCall[] = toolCalls.map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }))
    const { outputs, logs, notes } = await runAppToolCalls(db, threadId, appCalls)
    result.notes.push(...notes)

    // ツールの実行結果をAPIに渡し、最終的な返答を生成させる
    if (outputs.length > 0) {
      const functionLog = 'ツール実行: ' + logs.join('\n')
      const toolPayload = buildToolPayload(appCalls, outputs)
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

      // モデルの応答をそのまま送り返すと、reasoning_content など互換仕様外の
      // フィールドが混ざり400になるプロバイダーがある（Workers AIのqwen3等）ため、
      // 必要なフィールドだけに整形する
      conversation.push({
        role: 'assistant',
        content: message?.content ?? '',
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

      completion = await client.chat.completions.create({
        model: model,
        messages: conversation,
        tools: chatCompletionTools as any,
        tool_choice: 'auto',
        ...extraParams,
      } as any)
      message = completion.choices[0]?.message
    }
  }

  const reply = message?.content || ''
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
