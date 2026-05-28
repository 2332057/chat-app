import { Hono } from 'hono'
import OpenAI from 'openai'
import { Script } from 'vite-ssr-components/hono'
import { renderer } from './renderer'
import { SimpleChatMessageType } from './types/chat'

type Bindings = {
  OPENAI_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use(renderer)

app.get('*', (c) => {
  return c.render(
    <>
      <div id="root"></div>
      <Script src="/src/client/main.tsx" />
    </>
  )
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
