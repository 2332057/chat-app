/** @jsxImportSource react */

import { createContext, useContext, useEffect, useState } from 'react'
import styles from './Layout.module.css'

type AuthUser = { id: number; name: string; email: string }

/**
 * ヘッダー中央の差し込み口。ページ固有のコントロール(Home のスレッド選択など)を
 * createPortal でここに流し込むことで、state をページ側に置いたまま
 * ヘッダーを1つに統一できる。
 */
const HeaderSlotContext = createContext<HTMLElement | null>(null)

export const useHeaderSlot = () => useContext(HeaderSlotContext)

export default function Layout({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [checking, setChecking] = useState(true)
  const [slot, setSlot] = useState<HTMLElement | null>(null)

  useEffect(() => {
    let ignore = false

    const fetchMe = async () => {
      try {
        const res = await fetch('/api/me')
        if (ignore) return
        if (res.ok) {
          const data = await res.json()
          setUser(data.user)
        }
      } catch (e) {
        console.error('Failed to fetch current user', e)
      } finally {
        if (!ignore) setChecking(false)
      }
    }

    fetchMe()
    return () => {
      ignore = true
    }
  }, [])

  const logout = async () => {
    // Origin ヘッダを付けるため fetch で POST する(サーバー側で同一オリジンを検証)
    await fetch('/auth/logout', { method: 'POST' }).catch(() => undefined)
    location.href = '/'
  }

  if (checking) {
    return null
  }

  if (!user) {
    return (
      <div className={styles.gate}>
        <h1 className={styles.title}>学習支援システム</h1>
        <button type="button" className={styles.loginButton} onClick={() => (location.href = '/auth/login')}>
          Google でログイン
        </button>
        <p className={styles.note}>許可された組織の Google アカウントのみ利用できます。</p>
      </div>
    )
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.heading}>学習支援システム</h1>
        {/* ref callback で slot が確定すると再レンダリングされ、ページ側の portal が入る */}
        <div ref={setSlot} className={styles.slot} />
        <span className={styles.name}>{user.name}</span>
        <button type="button" className={styles.logoutButton} onClick={logout}>
          ログアウト
        </button>
      </header>
      <HeaderSlotContext.Provider value={slot}>{children}</HeaderSlotContext.Provider>
    </div>
  )
}
