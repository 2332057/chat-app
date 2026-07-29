import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { D1Database } from '@cloudflare/workers-types'

export type AuthBindings = {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  ALLOWED_GOOGLE_DOMAIN: string
}

export type AuthUser = {
  id: number
  name: string
  email: string
}

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14
export const STATE_TTL_SECONDS = 60 * 10

/**
 * __Host- プレフィックスは Domain 属性を禁止し host-only を強制する。
 * *.workers.dev では同一アカウント配下の別 Worker と eTLD+1 を共有するため、
 * これがないと兄弟 Worker から Cookie を上書き(セッション固定)されうる。
 * ただし __Host- は Secure 必須なので、http のローカル開発時のみ素の名前にフォールバックする。
 */
export function resolveCookieConfig(requestUrl: string) {
  const secure = new URL(requestUrl).protocol === 'https:'
  return {
    secure,
    sessionName: secure ? '__Host-session' : 'session',
    stateName: secure ? '__Host-oauth_state' : 'oauth_state',
  }
}

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

// createRemoteJWKSet は取得した鍵をキャッシュするので、モジュールスコープで1度だけ作る。
const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL))

export class AuthError extends Error {}

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

const randomToken = () => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const hashToken = async (token: string) => toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))

export const createStateToken = () => randomToken()

/**
 * タイミング攻撃を避けるための定数時間比較。
 * state は攻撃者が繰り返し試行できるため、素朴な === は避ける。
 */
export const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export const buildRedirectUri = (requestUrl: string) => new URL('/auth/callback', requestUrl).toString()

export function buildGoogleAuthUrl(env: AuthBindings, state: string, redirectUri: string) {
  const url = new URL(GOOGLE_AUTH_ENDPOINT)
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  // hd はアカウント選択画面を絞り込むための UI ヒントにすぎず、強制力はない。
  // 実際の制限は verifyGoogleIdToken 側の hd クレーム検証で行う。
  url.searchParams.set('hd', env.ALLOWED_GOOGLE_DOMAIN)
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

export async function exchangeCodeForIdToken(env: AuthBindings, code: string, redirectUri: string): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })

  if (!res.ok) {
    // レスポンス本文にはクライアントシークレット関連の情報が含まれうるのでログのみに留める
    console.error('Google token exchange failed', res.status, await res.text().catch(() => ''))
    throw new AuthError('token exchange failed')
  }

  const data = (await res.json()) as { id_token?: string }
  if (!data.id_token) {
    throw new AuthError('id_token missing')
  }
  return data.id_token
}

export type GoogleIdentity = {
  googleSub: string
  email: string
  name: string
}

export async function verifyGoogleIdToken(idToken: string, env: AuthBindings): Promise<GoogleIdentity> {
  let payload
  try {
    // 署名・iss・aud・exp は jwtVerify が検証する。
    // デコードしただけの値は攻撃者が自由に作れるため、必ずここを通す。
    ;({ payload } = await jwtVerify(idToken, jwks, {
      issuer: GOOGLE_ISSUERS,
      audience: env.GOOGLE_CLIENT_ID,
    }))
  } catch (error) {
    console.error('id_token verification failed', error)
    throw new AuthError('invalid id_token')
  }

  const { sub, email, email_verified: emailVerified, hd, name } = payload as {
    sub?: string
    email?: string
    email_verified?: boolean
    hd?: string
    name?: string
  }

  if (!sub || !email) {
    throw new AuthError('id_token is missing sub or email')
  }
  if (emailVerified !== true) {
    throw new AuthError('email is not verified')
  }
  // 個人 Google アカウントには hd クレーム自体が存在しない。
  // 厳密比較にすることで undefined も確実に弾く。
  if (hd !== env.ALLOWED_GOOGLE_DOMAIN) {
    throw new AuthError('domain not allowed')
  }

  return { googleSub: sub, email, name: name || email }
}

export async function findOrCreateUser(db: D1Database, identity: GoogleIdentity): Promise<AuthUser> {
  const existing = await db
    .prepare('SELECT id FROM users WHERE google_sub = ?')
    .bind(identity.googleSub)
    .first<{ id: number }>()

  if (existing) {
    // メールも表示名も Google 側で変わりうるので毎回追従する
    await db
      .prepare('UPDATE users SET email = ?, name = ? WHERE id = ?')
      .bind(identity.email, identity.name, existing.id)
      .run()
    return { id: existing.id, name: identity.name, email: identity.email }
  }

  const created = await db
    .prepare('INSERT INTO users (google_sub, email, name) VALUES (?, ?, ?) RETURNING id')
    .bind(identity.googleSub, identity.email, identity.name)
    .first<{ id: number }>()

  if (!created) {
    throw new AuthError('failed to create user')
  }
  return { id: created.id, name: identity.name, email: identity.email }
}

/** セッションを発行し、Cookie に入れる生トークンを返す。DB にはハッシュのみ保存する。 */
export async function createSession(db: D1Database, userId: number): Promise<string> {
  const token = randomToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString()

  await db
    .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await hashToken(token), userId, expiresAt)
    .run()

  return token
}

export async function getUserBySessionToken(db: D1Database, token: string): Promise<AuthUser | null> {
  const id = await hashToken(token)

  const row = await db
    .prepare(
      `SELECT users.id AS id, users.name AS name, users.email AS email, sessions.expires_at AS expires_at
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.id = ?`,
    )
    .bind(id)
    .first<{ id: number; name: string; email: string; expires_at: string }>()

  if (!row) return null

  // Cookie の Max-Age はクライアント任せなので、期限はサーバー側で必ず確認する
  if (Date.parse(row.expires_at) <= Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run()
    return null
  }

  return { id: row.id, name: row.name, email: row.email }
}

export async function deleteSession(db: D1Database, token: string) {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await hashToken(token)).run()
}
