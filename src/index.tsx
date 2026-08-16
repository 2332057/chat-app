/** @jsxImportSource hono/jsx */

import { Hono } from 'hono'
import { Link, Script, ViteClient } from 'vite-ssr-components/hono'
import OpenAI from 'openai'
import type { D1Database } from '@cloudflare/workers-types'
import { runChat, resolveChatProvider, resolveChatClientConfig, EmptyReplyError, AnthropicOAuthError } from './server/chat'
import type { ChatRequestBody, ChatThreadRecord } from './server/chat'
import authRoutes from './server/authRoutes'
import { requireAuth, requireSameOrigin } from './server/middleware'
import type { AuthUser } from './server/auth'

type Bindings = {
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  OPENAI_MODEL?: string
  OPENAI_MAX_TOKENS?: string
  OPENAI_REASONING_EFFORT?: string
  CHAT_API_PROVIDER?: string
  ANTHROPIC_OAUTH_TOKEN?: string
  CLAUDE_CODE_OAUTH_TOKEN?: string
  ANTHROPIC_BASE_URL?: string
  ANTHROPIC_MODEL?: string
  ANTHROPIC_MAX_TOKENS?: string
  ANTHROPIC_VERSION?: string
  ANTHROPIC_BETA?: string
  CLAUDE_CODE_USER_AGENT?: string
  ANTHROPIC_DANGEROUS_DIRECT_BROWSER_ACCESS?: string
  CLAUDE_CODE_X_APP?: string
  CLAUDE_CODE_VERSION?: string
  CLAUDE_MAX_TURNS?: string
  CLAUDE_OAUTH_TEMPLATE_SOURCE?: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  ALLOWED_GOOGLE_DOMAIN: string
  DB: D1Database
}

type Variables = {
  user: AuthUser
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.route('/auth', authRoutes)

// /api/* は全て認証必須。ミドルウェアの順序が認可の要なので、
// 個別ルートより先に登録すること。
app.use('/api/*', requireSameOrigin)
app.use('/api/*', requireAuth)

app.get('/api/me', (c) => c.json({ user: c.get('user') }))

app.get('/api/threads', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT id, title FROM threads WHERE user_id = ? ORDER BY updated_at DESC')
      .bind(c.get('user').id)
      .all()
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

    const userId = c.get('user').id

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
      // user_id で必ず絞る。ここを thread_id だけにすると他人のスレッドを ID 推測で読める。
      c.env.DB.prepare('SELECT * FROM threads WHERE id = ? AND user_id = ?').bind(threadId, c.get('user').id),
      c.env.DB.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC').bind(threadId),
      c.env.DB.prepare('SELECT * FROM notes WHERE thread_id = ? ORDER BY created_at ASC, id ASC').bind(threadId),
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

    const { results } = await c.env.DB.prepare('UPDATE threads SET title = ? WHERE id = ? AND user_id = ? RETURNING *')
      .bind(title, threadId, c.get('user').id)
      .all()

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

  if (provider !== 'claude-oauth' && !clientConfig.apiKey) {
    return c.json({ error: 'OPENAI_API_KEY is not set.' }, 500)
  }

  if (!threadId) {
    return c.json({ error: 'threadId is required.' }, 400)
  }
  if (!content) {
    return c.json({ error: 'content is required.' }, 400)
  }

  const thread = await c.env.DB.prepare('SELECT id, last_response_id FROM threads WHERE id = ? AND user_id = ?')
    .bind(threadId, c.get('user').id)
    .first<ChatThreadRecord>()
  if (!thread) {
    return c.json({ error: 'thread not found' }, 404)
  }

  await c.env.DB.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').bind(threadId, 'user', content).run()
  const previousResponseId = provider === 'responses' && !thread.last_response_id?.includes(':') ? (thread.last_response_id ?? undefined) : undefined

  const client =
    provider === 'claude-oauth'
      ? undefined
      : new OpenAI({
          apiKey: clientConfig.apiKey,
          baseURL: clientConfig.baseURL,
        })

  try {
    const { lastResponseId, ...responses } = await runChat(provider, {
      client,
      db: c.env.DB,
      threadId,
      content,
      model: provider === 'claude-oauth' ? (clientConfig.anthropic.model ?? clientConfig.model) : clientConfig.model,
      maxTokens: provider === 'claude-oauth' ? (clientConfig.anthropic.maxTokens ?? clientConfig.maxTokens) : clientConfig.maxTokens,
      reasoningEffort: clientConfig.reasoningEffort,
      previousResponseId,
      anthropic: clientConfig.anthropic,
    })

    if (lastResponseId) {
      await c.env.DB.prepare('UPDATE threads SET last_response_id = ? WHERE id = ?').bind(lastResponseId, threadId).run()
    }

    return c.json(responses)
  } catch (error) {
    if (error instanceof EmptyReplyError) {
      return c.json({ error: 'OpenAI returned an empty reply.' }, 502)
    }
    if (error instanceof AnthropicOAuthError) {
      console.error(error)
      if (error.type === 'rate_limit_error' || error.status === 429) {
        return c.json({ error: 'Claude OAuth is currently rate-limited. Please try again later.' }, 429)
      }
      if (error.status === 401 || error.status === 403 || error.type === 'authentication_error') {
        return c.json({ error: 'Claude OAuth authentication failed. Refresh the Worker OAuth token and try again.' }, 502)
      }
      return c.json({ error: 'Claude OAuth request failed.' }, 502)
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
