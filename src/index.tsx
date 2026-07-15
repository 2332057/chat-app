/** @jsxImportSource hono/jsx */

import { Hono } from 'hono'
import { Link, Script, ViteClient } from 'vite-ssr-components/hono'
import OpenAI from 'openai'
import type { D1Database } from '@cloudflare/workers-types'
import { runChat, resolveChatProvider, resolveChatClientConfig, EmptyReplyError } from './server/chat'
import type { ChatRequestBody, ChatThreadRecord } from './server/chat'

type Bindings = {
  OPENAI_API_KEY: string
  OPENAI_BASE_URL?: string
  OPENAI_MODEL?: string
  OPENAI_MAX_TOKENS?: string
  OPENAI_REASONING_EFFORT?: string
  CHAT_API_PROVIDER?: string
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
  const body = await c.req.json<ChatRequestBody>().catch(() => null)
  const threadId = body?.threadId
  const content = body?.content?.trim()
  const provider = resolveChatProvider(c.env.CHAT_API_PROVIDER)
  const clientConfig = resolveChatClientConfig(c.env)

  if (!clientConfig.apiKey) {
    return c.json({ error: 'OPENAI_API_KEY is not set.' }, 500)
  }

  if (!threadId) {
    return c.json({ error: 'threadId is required.' }, 400)
  }
  if (!content) {
    return c.json({ error: 'content is required.' }, 400)
  }

  const thread = await c.env.DB.prepare('SELECT id, last_response_id FROM threads WHERE id = ?').bind(threadId).first<ChatThreadRecord>()
  if (!thread) {
    return c.json({ error: 'thread not found' }, 404)
  }

  await c.env.DB.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').bind(threadId, 'user', content).run()

  const client = new OpenAI({
    apiKey: clientConfig.apiKey,
    baseURL: clientConfig.baseURL,
  })

  try {
    const { lastResponseId, ...responses } = await runChat(provider, {
      client,
      db: c.env.DB,
      threadId,
      content,
      model: clientConfig.model,
      maxTokens: clientConfig.maxTokens,
      reasoningEffort: clientConfig.reasoningEffort,
      previousResponseId: thread.last_response_id ?? undefined,
    })

    if (lastResponseId) {
      await c.env.DB.prepare('UPDATE threads SET last_response_id = ? WHERE id = ?').bind(lastResponseId, threadId).run()
    }

    return c.json(responses)
  } catch (error) {
    if (error instanceof EmptyReplyError) {
      return c.json({ error: 'OpenAI returned an empty reply.' }, 502)
    }
    console.error(error)
    return c.json({ error: 'チャットの生成に失敗しました。' }, 500)
  }
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
