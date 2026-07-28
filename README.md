# 学習者が他人に教えることで学習効果を高めるシステムの構築

Keywords: LBT, TA

## System

db scheme:

![scheme](./assets/scheme.png)

## Set Up

Set `OPENAI_API_KEY` as an environment binding before running the chat.

For local development, create a `.dev.vars` file with:

```txt
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://your.gateway.here/compat
OPENAI_MODEL=your-model-here
CHAT_API_PROVIDER=responses / chat-completions
OPENAI_MAX_TOKENS=30000
OPENAI_REASONING_EFFORT=high
```

### Claude OAuth provider

For a seat-based PoC with Claude subscription auth and no Anthropic API key,
use the experimental Claude OAuth provider. It runs entirely inside the
Cloudflare Worker, keeps the same UI, D1 note storage, note versioning, and
tool-call audit payloads.

Run the setup helper on a machine where Claude Code and Wrangler are installed
and Claude Code is logged in:

```sh
node scripts/claude-oauth-cloudflare.mjs --apply --worker-url https://your-worker.example
```

The helper is the authoritative setup path. It captures the local `claude -p`
OAuth request headers, verifies that the captured header shape works against the
Messages API, uploads `ANTHROPIC_OAUTH_TOKEN` as a Worker secret, deploys the
Worker with the captured Claude Code identity settings, applies remote D1
migrations, seeds user `1`, and verifies a real note tool call through
`/api/chat`.

To validate auth and header capture without changing Cloudflare:

```sh
node scripts/claude-oauth-cloudflare.mjs
```

Create db:

```sh
npx wrangler d1 migrations apply chat-app --local
```

Create dummy data:

```sh
npx wrangler d1 execute chat-app --local --command="INSERT INTO users (id, name) VALUES (1, 'Test User');"
```
