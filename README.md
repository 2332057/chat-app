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

Before running the helper, make sure Wrangler is logged into the Cloudflare
account that should own the Worker:

```sh
npx wrangler login
```

If `cloudflared` is needed for local Cloudflare Tunnel testing, install it from
Cloudflare's platform-specific instructions:
https://developers.cloudflare.com/tunnel/downloads/

If this account does not already have the `chat-app` D1 database, create it and
copy the returned `database_id` into `wrangler.jsonc` under the `DB` binding:

```sh
npx wrangler d1 create chat-app
```

If the account already has a Worker/D1 setup, keep the existing
`wrangler.jsonc` binding as long as it points at the intended remote D1
database. The helper applies migrations and seeds user `1` for that database.

Run the setup helper on a machine where Claude Code and Wrangler are installed
and Claude Code is logged in:

```sh
node scripts/claude-oauth-cloudflare.mjs --apply
```

The helper is the authoritative setup path. It captures the full local
`claude -p` Messages API request envelope, replays that exact envelope, verifies
the app-shaped request built from `src/instructions.md` and `src/tools.json`,
stores the non-secret captured envelope in remote D1 table
`claude_oauth_template`, deploys the Worker with
`CLAUDE_OAUTH_TEMPLATE_SOURCE=d1`, uploads the captured bearer token as the
`ANTHROPIC_OAUTH_TOKEN` Worker secret, applies remote D1 migrations, seeds user
`1`, and verifies `/api/chat`.

When the helper deploys the Worker, it usually detects the new `workers.dev`
URL from Wrangler output. If deploying was skipped or the URL cannot be
detected, pass it explicitly:

```sh
node scripts/claude-oauth-cloudflare.mjs --apply --worker-url https://your-worker.example
```

To validate auth and header capture without changing Cloudflare:

```sh
node scripts/claude-oauth-cloudflare.mjs
```

Future changes to the Claude OAuth path should pass the CI-safe checks:

```sh
npx tsc --noEmit
node --test tests/*.mjs
npm run build
```

The CI-safe tests do not require Claude Code. The local helper test above does
require the `claude` binary, an active Claude subscription login, network access
to Anthropic, and a real Cloudflare account when `--apply` is used; keep it as a
local release gate rather than a CI job.

The GitLab CI pipeline only checks request-shape invariants, TypeScript, and the
build. It does not deploy to Cloudflare and does not need Cloudflare credentials
or a Claude subscription token.

Create db:

```sh
npx wrangler d1 migrations apply chat-app --local
```

Create dummy data:

```sh
npx wrangler d1 execute chat-app --local --command="INSERT INTO users (id, name) VALUES (1, 'Test User');"
```
