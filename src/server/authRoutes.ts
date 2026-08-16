import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { D1Database } from '@cloudflare/workers-types'
import {
  AuthError,
  SESSION_TTL_SECONDS,
  STATE_TTL_SECONDS,
  buildGoogleAuthUrl,
  buildRedirectUri,
  createSession,
  createStateToken,
  deleteSession,
  exchangeCodeForIdToken,
  findOrCreateUser,
  resolveCookieConfig,
  timingSafeEqual,
  verifyGoogleIdToken,
} from './auth'
import type { AuthBindings } from './auth'

type Env = { Bindings: AuthBindings & { DB: D1Database } }

const authRoutes = new Hono<Env>()

authRoutes.get('/login', async (c) => {
  const { secure, stateName } = resolveCookieConfig(c.req.url)
  const state = createStateToken()

  setCookie(c, stateName, state, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: STATE_TTL_SECONDS,
  })

  return c.redirect(buildGoogleAuthUrl(c.env, state, buildRedirectUri(c.req.url)))
})

authRoutes.get('/callback', async (c) => {
  const { secure, sessionName, stateName } = resolveCookieConfig(c.req.url)
  const expectedState = getCookie(c, stateName)

  // state は使い捨て。検証の成否によらずここで落とす。
  deleteCookie(c, stateName, { path: '/', secure })

  const state = c.req.query('state')
  const code = c.req.query('code')

  if (!expectedState || !state || !timingSafeEqual(state, expectedState)) {
    return c.text('認証に失敗しました。もう一度ログインしてください。', 400)
  }
  if (!code) {
    return c.text('認証がキャンセルされました。', 400)
  }

  try {
    const idToken = await exchangeCodeForIdToken(c.env, code, buildRedirectUri(c.req.url))
    const identity = await verifyGoogleIdToken(idToken, c.env)
    const user = await findOrCreateUser(c.env.DB, identity)
    const token = await createSession(c.env.DB, user.id)

    setCookie(c, sessionName, token, {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    })

    return c.redirect('/')
  } catch (error) {
    if (error instanceof AuthError) {
      console.warn('login rejected:', error.message)
      return c.text('このアカウントではログインできません。許可された組織のアカウントを使用してください。', 403)
    }
    console.error(error)
    return c.text('ログイン処理に失敗しました。', 500)
  }
})

authRoutes.post('/logout', async (c) => {
  const { secure, sessionName } = resolveCookieConfig(c.req.url)
  const token = getCookie(c, sessionName)

  // Cookie を消すだけだとトークンは再利用可能なので、DB 側も必ず失効させる
  if (token) {
    await deleteSession(c.env.DB, token)
  }
  deleteCookie(c, sessionName, { path: '/', secure })

  return c.json({ ok: true })
})

export default authRoutes
