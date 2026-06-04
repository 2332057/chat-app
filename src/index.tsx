/** @jsxImportSource hono/jsx */

import { Hono } from 'hono'
import { Link, Script, ViteClient } from 'vite-ssr-components/hono'
import OpenAI from 'openai'
import { SimpleChatMessageType } from './types/chat'
import type { D1Database } from '@cloudflare/workers-types'

type Bindings = {
  OPENAI_API_KEY: string
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

const MODEL = 'gpt-5-nano-2025-08-07'
const SYSTEM_INSTRUCTIONS = 'You are a concise, helpful chat assistant.'

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

    const { results } = await c.env.DB.prepare(
      'INSERT INTO threads (user_id, title) VALUES (?, ?) RETURNING *'
    ).bind(userId, title).all()

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

    const { results } = await c.env.DB.prepare(
      'UPDATE threads SET title = ? WHERE id = ? RETURNING *'
    ).bind(title, threadId).all()

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

  const thread = await c.env.DB.prepare('SELECT id, last_response_id FROM threads WHERE id = ?').bind(threadId).first<{ id: string | number, last_response_id: string | null }>()
  if (!thread) {
    return c.json({ error: 'thread not found' }, 404)
  }

  const previousResponseId = thread.last_response_id

  await c.env.DB.prepare(
    'INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)'
  ).bind(threadId, 'user', content).run()

  const client = new OpenAI({ apiKey })
  const response = await (client as any).responses.create({
    model: MODEL,
    instructions: SYSTEM_INSTRUCTIONS,
    input: content,
    previous_response_id: previousResponseId ?? undefined,
  })

  const reply = response.output_text
  const responseId = response.id || null

  if (!response) {
    return c.json({ error: 'OpenAI returned an empty reply.' }, 502)
  }

  await c.env.DB.prepare(
    'INSERT INTO messages (thread_id, role, content, response_id, model, raw_response) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(threadId, 'assistant', reply, responseId, MODEL, JSON.stringify(response)).run()

  if (responseId) {
    await c.env.DB.prepare(
      'UPDATE threads SET last_response_id = ? WHERE id = ?'
    ).bind(responseId, threadId).run()
  }

  return c.json({ reply })
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
    </html>
  )
})

export default app
