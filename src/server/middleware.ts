import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { D1Database } from '@cloudflare/workers-types'
import { getUserBySessionToken, resolveCookieConfig } from './auth'
import type { AuthUser } from './auth'

type Env = {
  Bindings: { DB: D1Database }
  Variables: { user: AuthUser }
}

/**
 * 状態変更系リクエストの Origin を検証する。
 * *.workers.dev では同一アカウント配下の別 Worker が same-site 扱いになり
 * SameSite=Lax が CSRF を防いでくれないため、ここが実質的な防御線になる。
 */
export const requireSameOrigin = createMiddleware<Env>(async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    return next()
  }

  const origin = c.req.header('Origin')
  if (!origin || origin !== new URL(c.req.url).origin) {
    return c.json({ error: 'invalid origin' }, 403)
  }

  return next()
})

export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const { sessionName } = resolveCookieConfig(c.req.url)
  const token = getCookie(c, sessionName)

  if (!token) {
    return c.json({ error: 'ログインが必要です。' }, 401)
  }

  const user = await getUserBySessionToken(c.env.DB, token)
  if (!user) {
    return c.json({ error: 'ログインが必要です。' }, 401)
  }

  c.set('user', user)
  return next()
})
