```txt
npm install
npm run dev
```

```txt
npm run deploy
```
## OpenAI Key

Set `OPENAI_API_KEY` as an environment binding before running the chat.

For local development, create a `.dev.vars` file with:

```txt
OPENAI_API_KEY=your_api_key_here
```

For deployment, store the same value as a Wrangler secret:

```txt
wrangler secret put OPENAI_API_KEY
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

# create dummy data

```sh
npx wrangler d1 execute chat-app --local --command="INSERT INTO users (id, name) VALUES (1, 'Test User');"
```
