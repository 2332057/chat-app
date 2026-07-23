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

Create db:

```sh
npx wrangler d1 migrations apply chat-app --local
```

Create dummy data:

```sh
npx wrangler d1 execute chat-app --local --command="INSERT INTO users (id, name) VALUES (1, 'Test User');"
```
