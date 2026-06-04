import { Hono } from 'hono'
import OpenAI from 'openai'
import { SimpleChatMessageType } from './types/chat'
import type { D1Database } from '@cloudflare/workers-types'

type Bindings = {
  OPENAI_API_KEY: string
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

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

app.get('*', (c) => {
  return c.html(`
    <!doctype html>
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>学習支援システム</title>
        <link rel="stylesheet" href="/src/style.css" />
      </head>
      <body>
        <div id="root"></div>
        <script type="module" src="/src/client/main.tsx"></script>
      </body>
    </html>
  `);
})

app.post('/api/chat', async (c) => {
  const apiKey = c.env.OPENAI_API_KEY

  if (!apiKey) {
    return c.json({ error: 'OPENAI_API_KEY is not set.' }, 500)
  }

  const body = await c.req.json<{ messages?: SimpleChatMessageType[] }>().catch(() => null)

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: 'messages is required.' }, 400)
  }

  const messages = body.messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0)
    .slice(-20)

  if (messages.length === 0) {
    return c.json({ error: 'messages is empty.' }, 400)
  }

  const client = new OpenAI({ apiKey })
  const completion = await client.chat.completions.create({
    model: 'gpt-5-nano-2025-08-07',
    messages: [
      { role: 'system', content: 'You are a concise, helpful chat assistant.' },
      ...messages,
    ],
  })

  const reply = completion.choices[0]?.message?.content?.trim()

  if (!reply) {
    return c.json({ error: 'OpenAI returned an empty reply.' }, 502)
  }

  return c.json({ reply })
})

export default app
