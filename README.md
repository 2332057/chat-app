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

### Claude OAuth プロバイダ

Anthropic の API キーを使わず、Claude サブスクリプションの認証でシート単位の
PoC を動かすための実験的なプロバイダ。Cloudflare Worker 内で完結し、UI・D1 の
ノート保存・バージョニング・ツール呼び出しの監査ペイロードはそのまま使える。

#### 事前準備

```sh
npx wrangler login          # Worker を置くアカウントにログイン
npx wrangler d1 create chat-app   # chat-app D1 が無い場合のみ
```

D1 を新規作成した場合は、返ってきた `database_id` を `wrangler.jsonc` の `DB`
バインディングに書く。既存の Worker / D1 構成がある場合は、目的のリモート D1 を
指しているかぎり既存のバインディングのままでよい（マイグレーションはヘルパーが
適用する）。ユーザーは Google ログイン時に作られるのでシードは不要。ローカルで
Cloudflare Tunnel を試す場合の `cloudflared` は
https://developers.cloudflare.com/tunnel/downloads/ から入れる。

#### セットアップ

Claude Code と Wrangler がインストール済みで、Claude Code にログインしている
マシンで実行する:

```sh
node scripts/claude-oauth-cloudflare.mjs --apply --env a
```

`--env` は `wrangler.jsonc` の環境名。Claude 側は `a`（`chat-app-a`）。省略すると
トップレベルの Worker が対象になる。

このヘルパーが正式なセットアップ手段で、次を一括で行う:

- ローカルの `claude -p` の Messages API リクエストをそのまま捕捉して再送し、
  `src/instructions.md` と `src/tools.json` から組み立てたアプリ形式の
  リクエストを検証
- 捕捉したエンベロープ（秘密情報なし）をリモート D1 の
  `claude_oauth_template` テーブルに保存
- `CLAUDE_OAUTH_TEMPLATE_SOURCE=d1` で Worker をデプロイし、bearer トークンを
  `ANTHROPIC_OAUTH_TOKEN` シークレットとして登録
- リモート D1 のマイグレーション適用

`/api/chat` は Google ログインの内側にあるため、ヘルパーは疎通確認まではしない。
デプロイ後にブラウザでログインしてメッセージを送り、動作を確認すること。

macOS / Linux / Windows（PowerShell・`cmd` 可、Git Bash 不要）で動作する。
リクエスト捕捉に `openssl` が必要で、Windows で `PATH` に無い場合は Git for
Windows 同梱のものにフォールバックする。

Claude OAuth 構成では `npm run deploy` ではなくこのヘルパーを使うこと。素の
Wrangler デプロイは Claude OAuth 用の Worker 変数を含まず、Worker が既定の
OpenAI プロバイダのままになることがある。

#### オプション

既定のモデルはレイテンシ重視で `claude-haiku-4-5`。変更するにはヘルパーに
`--model` を渡すか、Worker 環境で `ANTHROPIC_MODEL` を設定する。

Cloudflare を変更せずに認証とヘッダ捕捉だけ確認する場合:

```sh
node scripts/claude-oauth-cloudflare.mjs
```

#### ローカル開発

`npm run dev` 用のローカル環境は `--local-setup` で一括構築できる。Cloudflare は
変更しないので `--apply` は不要:

```sh
node scripts/claude-oauth-cloudflare.mjs --local-setup
```

これはローカル D1 にマイグレーションを適用し、捕捉した
リクエストテンプレートをローカル D1 の `claude_oauth_template` に入れ、デプロイ時に
`--var` で渡しているのと同じ変数（`CHAT_API_PROVIDER`、`ANTHROPIC_OAUTH_TOKEN`、
`ANTHROPIC_MODEL`、`ANTHROPIC_BETA`、`CLAUDE_CODE_USER_AGENT`、`CLAUDE_CODE_X_APP`、
`CLAUDE_OAUTH_TEMPLATE_SOURCE=d1` など）を `.dev.vars` に書き込む。既存の行は
キー単位で上書きし、無関係な行は残す。書き込み後は dev サーバを再起動する。

この一括設定が必要なのは、テンプレートとヘッダが揃っていないと Worker が
`buildDefaultOAuthBody` の既定形状で送ってしまうため。既定形状には捕捉した
Claude Code の system ブロックも `anthropic-beta` / `x-app` ヘッダも無く、モデルに
よっては Anthropic に 429 で弾かれる（`claude-haiku-4-5` は通るのに
`claude-opus-5` が通らない、という症状になる）。

トークンだけ入れ替えたい場合（失効して `/api/chat` が 401 を返したときなど）:

```sh
node scripts/claude-oauth-cloudflare.mjs --write-dev-vars
```

どちらも `--write-dev-vars=path/to/file` / `--local-setup=path/to/file` で書き込み先を
変えられる。捕捉した bearer トークンは短命なので、ローカルで長く使いたい場合は
`claude setup-token` の値に差し替える方が持ちがよい。

#### テスト

Claude OAuth 周りを変更したら、CI で回る次のチェックを通すこと:

```sh
npx tsc --noEmit
node --test tests/*.mjs
npm run build
```

これらに Claude Code は不要。一方、上記のヘルパー実行には `claude` バイナリ、
有効な Claude サブスクリプションのログイン、Anthropic への通信、（`--apply`
時は）実際の Cloudflare アカウントが要るため、CI ジョブではなくローカルの
リリースゲートとして扱う。GitLab CI はリクエスト形状の不変条件・TypeScript・
ビルドのみを検証し、Cloudflare へのデプロイも認証情報も行わない。

Create db:

```sh
npx wrangler d1 migrations apply chat-app --local
```

Create dummy data:

```sh
npx wrangler d1 execute chat-app --local --command="INSERT INTO users (id, name) VALUES (1, 'Test User');"
```
