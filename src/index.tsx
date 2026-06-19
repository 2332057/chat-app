/** @jsxImportSource hono/jsx */

import { Hono } from 'hono'
import { Link, Script, ViteClient } from 'vite-ssr-components/hono'
import OpenAI from 'openai'
import { ChatReturnType } from './types/chat'
import type { D1Database } from '@cloudflare/workers-types'
import { readNote, createNote, editNote, tools } from './tools'
import SYSTEM_INSTRUCTIONS from './instructions.md?raw'

type Bindings = {
  OPENAI_API_KEY: string
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

const MODEL = 'gpt-5.5-2026-04-23'

app.get('/api/threads', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT id, title FROM threads ORDER BY updated_at DESC').all()
    return c.json({ threads: results })
  } catch (error) {
    console.error(error)
    return c.json({ error: 'スレッドの取得に失敗しました。' }, 500)
  }
})

app.post('/api/threads', async (c) => {
  try {
    const body = await c.req.json<{ title?: string }>().catch(() => null)
    const title = body?.title?.trim() || '新規チャット'

    // FIXME: use user_id(1), later implement authentication and get user_id from auth context
    const userId = 1

    const { results } = await c.env.DB.prepare('INSERT INTO threads (user_id, title) VALUES (?, ?) RETURNING *').bind(userId, title).all()

    return c.json({ thread: results[0] }, 201)
  } catch (error) {
    console.error(error)
    return c.json({ error: 'スレッドの作成に失敗しました。' }, 500)
  }
})

app.get('/api/threads/:id', async (c) => {
  try {
    const threadId = c.req.param('id')

    const [threadResult, messagesResult, notesResult] = await c.env.DB.batch([
      c.env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(threadId),
      c.env.DB.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC').bind(threadId),
      c.env.DB.prepare('SELECT * FROM notes WHERE thread_id = ? ORDER BY created_at ASC').bind(threadId),
    ])

    const thread = threadResult.results[0]
    if (!thread) {
      return c.json({ error: 'スレッドが見つかりません。' }, 404)
    }

    return c.json({
      thread,
      messages: messagesResult.results,
      notes: notesResult.results,
    })
  } catch (error) {
    console.error(error)
    return c.json({ error: 'スレッド詳細の取得に失敗しました。' }, 500)
  }
})

app.patch('/api/threads/:id', async (c) => {
  try {
    const threadId = c.req.param('id')
    const body = await c.req.json<{ title?: string }>().catch(() => null)
    const title = body?.title?.trim()

    if (!title) {
      return c.json({ error: 'title is required.' }, 400)
    }

    const { results } = await c.env.DB.prepare('UPDATE threads SET title = ? WHERE id = ? RETURNING *').bind(title, threadId).all()

    if (results.length === 0) {
      return c.json({ error: 'スレッドが見つかりません。' }, 404)
    }

    return c.json({ thread: results[0] })
  } catch (error) {
    console.error(error)
    return c.json({ error: 'タイトルの更新に失敗しました。' }, 500)
  }
})

app.post('/api/chat', async (c) => {
  const apiKey = c.env.OPENAI_API_KEY

  if (!apiKey) {
    return c.json({ error: 'OPENAI_API_KEY is not set.' }, 500)
  }

  const body = await c.req.json<{ threadId?: string | number; content?: string }>().catch(() => null)
  const threadId = body?.threadId
  const content = body?.content?.trim()

  if (!threadId) {
    return c.json({ error: 'threadId is required.' }, 400)
  }
  if (!content) {
    return c.json({ error: 'content is required.' }, 400)
  }

  const thread = await c.env.DB.prepare('SELECT id, last_response_id FROM threads WHERE id = ?').bind(threadId).first<{ id: string | number; last_response_id: string | null }>()
  if (!thread) {
    return c.json({ error: 'thread not found' }, 404)
  }

  let responses: ChatReturnType = {
    messages: [],
    notes: [],
  }
  const previousResponseId = thread.last_response_id

  await c.env.DB.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').bind(threadId, 'user', content).run()

  const client = new OpenAI({ apiKey })
  let response = await (client as any).responses.create({
    model: MODEL,
    instructions: SYSTEM_INSTRUCTIONS,
    input: content,
    previous_response_id: previousResponseId ?? undefined,
    tools,
    tool_choice: 'auto',
  })

  // Function Callingの処理ループ
  const functionCalls = response.output?.filter((o: any) => o.type === 'function_call') || []

  if (functionCalls.length > 0) {
    const functionOutputs = []
    const functionLogs = []

    for (const call of functionCalls) {
      if (call.name === 'read_note') {
        const notes = await readNote(c.env.DB, threadId)
        functionOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id || call.id,
          output: JSON.stringify(notes),
        })
        if (!('error' in notes)) {
          functionLogs.push('ノートを読みました')
        } else {
          functionLogs.push('ノートの読み取りに失敗しました（またはノートがありません）')
        }
      } else if (call.name === 'create_note') {
        const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments || {}
        const note = await createNote(c.env.DB, threadId, args.title || '', args.content || '')
        functionOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id || call.id,
          output: JSON.stringify(note),
        })
        if (!('error' in note)) {
          responses.notes.push({
            id: note.id,
            title: note.title,
            content: note.content,
            thread_id: note.thread_id,
          })
          functionLogs.push('ノートを作成しました')
        } else {
          functionLogs.push('ノートの作成に失敗しました')
        }
      } else if (call.name === 'edit_note') {
        const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments || {}
        const note = await editNote(c.env.DB, threadId, args.note_id, args.title || '', args.content || '')
        functionOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id || call.id,
          output: JSON.stringify(note),
        })
        if (!('error' in note)) {
          responses.notes.push({
            id: note.id,
            title: note.title,
            content: note.content,
            thread_id: note.thread_id,
          })
          functionLogs.push('ノートを編集しました')
        } else {
          functionLogs.push('ノートの編集に失敗しました')
        }
      }
    }

    // ツールの実行結果をAPIに渡し、最終的な返答を生成させる
    if (functionOutputs.length > 0) {
      const functionLog = functionLogs.join('\n')
      await c.env.DB.prepare('INSERT INTO messages (thread_id, role, content, response_id, model, raw_response) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(threadId, 'assistant', 'ツール実行: ' + functionLog, response.id || null, MODEL, JSON.stringify(response))
        .run()
      responses.messages.push({
        id: response.id || '',
        role: 'assistant',
        content: 'ツール実行: ' + functionLog,
        createdAt: Date.now(),
      })
      response = await (client as any).responses.create({
        model: MODEL,
        input: functionOutputs,
        previous_response_id: response.id,
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

  if (!reply) {
    return c.json({ error: 'OpenAI returned an empty reply.' }, 502)
  }

  await c.env.DB.prepare('INSERT INTO messages (thread_id, role, content, response_id, model, raw_response) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(threadId, 'assistant', reply, response.id, MODEL, JSON.stringify(response))
    .run()

  responses.messages.push({
    id: response.id || '',
    role: 'assistant',
    content: reply,
    createdAt: Date.now(),
  })

  if (response.id) {
    await c.env.DB.prepare('UPDATE threads SET last_response_id = ? WHERE id = ?').bind(response.id, threadId).run()
  }

  return c.json(responses)
})

app.get('*', (c) => {
  if (c.req.path.startsWith('/api')) {
    return c.notFound()
  }

  return c.html(
    <html lang="ja">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>学習支援システム</title>
        <ViteClient />
        <Script src="/src/client/main.tsx" />
        <Link href="/src/style.css" rel="stylesheet" />
      </head>
      <body>
        <div id="root"></div>
      </body>
    </html>,
  )
})

export default app
