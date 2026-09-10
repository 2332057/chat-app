/** @jsxImportSource react */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatMessageType, ChatReturnType, ChatThreadType, NoteType } from '../../types/chat'
import ChatThread from '../components/ChatThread'
import ChatForm from '../components/ChatForm'
import Note from '../components/Note'
import { useAuthUser, useHeaderSlot } from '../Layout'
import styles from './Home.module.css'

const createId = () => {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

const parseSqliteUtc = (raw?: string): number => {
  if (!raw) return Date.now()
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`
  const t = new Date(withZone).getTime()
  return Number.isNaN(t) ? Date.now() : t
}

const ACTIVE_THREAD_STORAGE_KEY = 'chat.activeThreadId'
const VIEW_USER_STORAGE_KEY = 'chat.viewUserId'

type ThreadListItem = { id: string | number; title: string; deleted_at?: string | null }
type UserListItem = { id: number; name: string; email: string }

// 閲覧対象ユーザーごとに選択スレッドを覚える。自分の分は従来のキーのまま
// 使い続けるので、既にタブで開いている状態が壊れない。
const activeThreadStorageKey = (viewUserId: number | null, selfId: number | null) =>
  viewUserId === null || viewUserId === selfId ? ACTIVE_THREAD_STORAGE_KEY : `${ACTIVE_THREAD_STORAGE_KEY}:${viewUserId}`

export default function Home() {
  const authUser = useAuthUser()
  const selfId = authUser?.id ?? null
  const isAdmin = authUser?.isAdmin ?? false

  const [threadList, setThreadList] = useState<ThreadListItem[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | number | null>(null)
  const [messages, setMessages] = useState<ChatMessageType[]>([])
  const [notes, setNotes] = useState<NoteType[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // /api/users が返るまでの間も選択欄が空にならないよう、自分1人で埋めておく
  const [users, setUsers] = useState<UserListItem[]>(() =>
    authUser ? [{ id: authUser.id, name: authUser.name, email: authUser.email }] : [],
  )

  // 管理者は常にユーザー選択欄を使っている扱いにして、自分を選んでいるときも
  // 削除済みを表示する。管理者以外は null 固定で、userId をサーバーへ送らない。
  const [viewUserId, setViewUserId] = useState<number | null>(() => {
    if (!isAdmin || selfId === null) return null
    const stored = Number(sessionStorage.getItem(VIEW_USER_STORAGE_KEY))
    return Number.isInteger(stored) && stored > 0 ? stored : selfId
  })

  // 他ユーザーのチャットは閲覧のみ。送信・作成・編集・削除を全て塞ぐ
  // (サーバー側も自分の user_id でしか書き込めないようになっている)。
  const viewingOtherUser = viewUserId !== null && selfId !== null && viewUserId !== selfId
  // 管理者が自分の削除済みスレッドを開いた場合。サーバーは deleted_at IS NULL の
  // 行しか更新しないため、送信・編集・削除はどれも 404 になる。先に UI で塞ぐ。
  const activeThreadDeleted = threadList.some((t) => String(t.id) === String(activeThreadId) && Boolean(t.deleted_at))
  const readOnly = viewingOtherUser || activeThreadDeleted
  const userQuery = viewUserId === null ? '' : `?userId=${viewUserId}`

  const messagesRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const headerSlot = useHeaderSlot()

  const selectThread = (threadId: string | number) => {
    sessionStorage.setItem(activeThreadStorageKey(viewUserId, selfId), String(threadId))
    setActiveThreadId(threadId)
  }

  const selectUser = (nextUserId: number) => {
    sessionStorage.setItem(VIEW_USER_STORAGE_KEY, String(nextUserId))
    // スレッド一覧の再取得までの間、前のユーザーの内容が残らないよう空にする
    setThreadList([])
    setActiveThreadId(null)
    setMessages([])
    setNotes([])
    setViewUserId(nextUserId)
  }

  useEffect(() => {
    document.title = 'チャット | 学習支援システム'
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    let ignore = false

    const fetchUsers = async () => {
      try {
        const res = await fetch('/api/users')
        if (!res.ok) return
        const data = await res.json()
        if (ignore) return

        const list: UserListItem[] = Array.isArray(data.users) ? data.users : []
        setUsers(list)

        // sessionStorage に残っていた ID のユーザーが消えている場合、
        // 選択欄が空のまま何も出ない状態になるので自分に戻す。
        if (selfId !== null && viewUserId !== null && !list.some((u) => u.id === viewUserId)) {
          selectUser(selfId)
        }
      } catch (e) {
        console.error('Failed to fetch users', e)
      }
    }
    fetchUsers()
    return () => {
      ignore = true
    }
  }, [isAdmin])

  useEffect(() => {
    let ignore = false
    const fetchThreads = async () => {
      try {
        const res = await fetch(`/api/threads${userQuery}`)
        if (!res.ok) return
        const data = await res.json()
        if (ignore) return

        const existingThreads: ThreadListItem[] = Array.isArray(data.threads) ? data.threads : []
        setThreadList(existingThreads)

        const storedThreadId = sessionStorage.getItem(activeThreadStorageKey(viewUserId, selfId))
        const storedThread = existingThreads.find((thread) => String(thread.id) === storedThreadId)
        if (storedThread) {
          selectThread(storedThread.id)
          return
        }

        // 選択の記憶は sessionStorage なので、新しいタブで開くたびに空になる。
        // ここで作ってしまうと開くたびに空のスレッドが増えるため、
        // 既存があれば最終更新が新しいものを開き、本当に無いときだけ作る。
        if (existingThreads.length > 0) {
          selectThread(existingThreads[0].id)
          return
        }

        // 他ユーザーを閲覧中に空スレッドを作ってしまわないよう、
        // 自動作成は自分のチャットを見ているときだけ。
        if (viewingOtherUser) {
          setActiveThreadId(null)
          setMessages([])
          setNotes([])
          return
        }

        await createThread(existingThreads)
      } catch (e) {
        console.error('Failed to fetch threads', e)
      }
    }
    fetchThreads()
    return () => {
      ignore = true
    }
  }, [viewUserId])

  useEffect(() => {
    if (!activeThreadId) return
    let ignore = false

    const fetchMessages = async () => {
      try {
        const res = await fetch(`/api/threads/${activeThreadId}${userQuery}`)
        if (!res.ok) return
        const data = await res.json()
        if (ignore) return

        const loadedMessages = (data.messages || []).map((m: any) => ({
          id: String(m.id),
          role: m.role,
          content: m.content,
          createdAt: parseSqliteUtc(m.created_at),
          model: m.model ?? undefined,
        }))
        setMessages(loadedMessages)

        const loadedNotes = (data.notes || []).map((n: any) => ({
          id: String(n.id),
          title: n.title,
          content: n.content,
        }))
        setNotes(loadedNotes)
      } catch (e) {
        console.error('Failed to fetch messages', e)
      }
    }
    fetchMessages()
    return () => {
      ignore = true
    }
  }, [activeThreadId])

  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [activeThreadId, messages.length])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const createThread = async (existingThreads?: ThreadListItem[]) => {
    if (viewingOtherUser) return
    setBusy(true)
    try {
      const res = await fetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新規チャット' }),
      })
      if (!res.ok) return
      const data = await res.json()
      if (data.thread) {
        setThreadList((prev) => [data.thread, ...(existingThreads ?? prev)])
        selectThread(data.thread.id)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setBusy(false)
    }
  }

  const editThreadTitle = async () => {
    if (!activeThreadId || readOnly) return
    const currentTitle = threadList.find((t) => String(t.id) === String(activeThreadId))?.title
    const newTitle = prompt('新しいタイトルを入力してください', currentTitle || '')

    if (!newTitle || newTitle === currentTitle) return

    setBusy(true)
    try {
      const res = await fetch(`/api/threads/${activeThreadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      })
      if (!res.ok) throw new Error('タイトルの更新に失敗しました')
      const data = await res.json()
      if (data.thread) {
        setThreadList((prev) => prev.map((t) => (String(t.id) === String(activeThreadId) ? { ...t, title: data.thread.title } : t)))
      }
    } catch (e) {
      console.error(e)
      alert('タイトルの更新に失敗しました。')
    } finally {
      setBusy(false)
    }
  }

  const deleteThread = async () => {
    if (!activeThreadId || readOnly) return
    const current = threadList.find((t) => String(t.id) === String(activeThreadId))
    if (!confirm(`「${current?.title || 'このチャット'}」を削除しますか？`)) return

    setBusy(true)
    try {
      const res = await fetch(`/api/threads/${activeThreadId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('チャットの削除に失敗しました')

      // 管理者は削除済みも一覧に出すので、行を消さず deleted_at を立てるだけにする
      const nextList =
        viewUserId === null
          ? threadList.filter((t) => String(t.id) !== String(activeThreadId))
          : threadList.map((t) => (String(t.id) === String(activeThreadId) ? { ...t, deleted_at: new Date().toISOString() } : t))
      setThreadList(nextList)

      // 削除したのは表示中のスレッドなので、必ず別のスレッドへ移す。
      // 管理者の一覧には削除済みも並ぶので、移動先は生きているものだけから選ぶ。
      const remaining = threadList.filter((t) => String(t.id) !== String(activeThreadId) && !t.deleted_at)
      if (remaining.length > 0) {
        selectThread(remaining[0].id)
        return
      }

      // 1つも残らなければ空の画面にせず新規作成する。
      sessionStorage.removeItem(activeThreadStorageKey(viewUserId, selfId))
      setMessages([])
      setNotes([])
      await createThread(nextList)
    } catch (e) {
      console.error(e)
      alert('チャットの削除に失敗しました。')
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    if (busy || !activeThreadId || readOnly) return

    const value = draft.trim()
    if (!value) return

    setMessages((prev) => [
      ...prev,
      {
        id: createId(),
        role: 'user',
        content: value,
        createdAt: Date.now(),
      },
    ])
    setDraft('')
    setBusy(true)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ threadId: activeThreadId, content: value }),
      })

      const data = (await response.json()) as ChatReturnType

      if (!response.ok) {
        throw new Error('チャットに失敗しました。')
      }

      if (data.messages && data.messages.length > 0) {
        setMessages((prev) => [...prev, ...data.messages])
      }

      if (data.notes && data.notes.length > 0) {
        setNotes((prev) => {
          const next = [...prev]
          data.notes!.forEach((newNote) => {
            const index = next.findIndex((n) => String(n.id) === String(newNote.id))
            if (index !== -1) {
              next[index] = newNote
            } else {
              next.push(newNote)
            }
          })
          return next
        })
      }
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: createId(),
          role: 'assistant',
          content: error instanceof Error ? error.message : '予期しないエラーが発生しました。',
          createdAt: Date.now(),
        },
      ])
    } finally {
      setBusy(false)
      textareaRef.current?.focus()
    }
  }

  const activeThreadData: ChatThreadType = {
    id: String(activeThreadId || ''),
    title: threadList.find((t) => String(t.id) === String(activeThreadId))?.title || '',
    messages,
  }

  // スレッド選択は Layout のヘッダーへ差し込む。state は Home に置いたまま、
  // DOM 上の位置だけヘッダー内に移す。
  const threadSelector = (
    <div className={styles.chat_selector}>
      {/* ユーザー選択は管理者にだけ出す。管理者以外には DOM ごと存在しない。 */}
      {isAdmin && (
        <>
          <label htmlFor="view-user">ユーザー</label>
          <select id="view-user" value={String(viewUserId ?? '')} onChange={(e) => selectUser(Number(e.target.value))} disabled={busy}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.id === selfId ? `${u.name}（自分）` : `${u.name}（${u.email}）`}
              </option>
            ))}
          </select>
        </>
      )}
      <label htmlFor="thread">チャット</label>
      <select id="thread" value={String(activeThreadId || '')} onChange={(e) => selectThread(e.target.value)} disabled={busy}>
        {threadList.length === 0 && <option value="">（チャットなし）</option>}
        {threadList.map((t) => (
          <option key={t.id} value={t.id}>
            {t.deleted_at ? `${t.title}（削除済み）` : t.title}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => void createThread()} disabled={busy || viewingOtherUser}>
        新規
      </button>
      <button type="button" onClick={editThreadTitle} disabled={busy || readOnly || !activeThreadId}>
        編集
      </button>
      <button type="button" onClick={() => void deleteThread()} disabled={busy || readOnly || !activeThreadId}>
        削除
      </button>
    </div>
  )

  return (
    <>
      {headerSlot && createPortal(threadSelector, headerSlot)}
      <main className={styles.main}>
        <div className={styles.split}>
          <div className={styles.note}>{notes.length > 0 && <Note versions={notes} />}</div>
          <div ref={messagesRef} className={styles.chat}>
            <ChatThread {...activeThreadData} showReasoning={isAdmin} />
          </div>
        </div>
        {/* チャット・ノートを横断して画面下部に置く入力欄 */}
        <div className={styles.composer}>
          {readOnly ? (
            <p className={styles.read_only}>
              {viewingOtherUser ? '他ユーザーのチャットを閲覧中です（読み取り専用）。' : '削除済みのチャットを閲覧中です（読み取り専用）。'}
            </p>
          ) : (
            <ChatForm value={draft} onChange={setDraft} onSend={() => void send()} busy={busy} textareaRef={textareaRef} />
          )}
        </div>
      </main>
    </>
  )
}
