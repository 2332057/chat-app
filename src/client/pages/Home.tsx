/** @jsxImportSource react */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatMessageType, ChatReturnType, ChatThreadType, NoteType } from '../../types/chat'
import ChatThread from '../components/ChatThread'
import ChatForm from '../components/ChatForm'
import Note from '../components/Note'
import { useHeaderSlot } from '../Layout'
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

export default function Home() {
  const [threadList, setThreadList] = useState<{ id: string | number; title: string }[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | number | null>(null)
  const [messages, setMessages] = useState<ChatMessageType[]>([])
  const [notes, setNotes] = useState<NoteType[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const messagesRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const headerSlot = useHeaderSlot()

  const selectThread = (threadId: string | number) => {
    sessionStorage.setItem(ACTIVE_THREAD_STORAGE_KEY, String(threadId))
    setActiveThreadId(threadId)
  }

  useEffect(() => {
    document.title = 'チャット | 学習支援システム'
  }, [])

  useEffect(() => {
    let ignore = false
    const fetchThreads = async () => {
      try {
        const res = await fetch('/api/threads')
        if (!res.ok) return
        const data = await res.json()
        if (ignore) return

        const existingThreads: { id: string | number; title: string }[] = Array.isArray(data.threads) ? data.threads : []
        setThreadList(existingThreads)

        const storedThreadId = sessionStorage.getItem(ACTIVE_THREAD_STORAGE_KEY)
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

        await createThread(existingThreads)
      } catch (e) {
        console.error('Failed to fetch threads', e)
      }
    }
    fetchThreads()
    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    if (!activeThreadId) return
    let ignore = false

    const fetchMessages = async () => {
      try {
        const res = await fetch(`/api/threads/${activeThreadId}`)
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

  const createThread = async (existingThreads?: { id: string | number; title: string }[]) => {
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
    if (!activeThreadId) return
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
    if (!activeThreadId) return
    const current = threadList.find((t) => String(t.id) === String(activeThreadId))
    if (!confirm(`「${current?.title || 'このチャット'}」を削除しますか？`)) return

    setBusy(true)
    try {
      const res = await fetch(`/api/threads/${activeThreadId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('チャットの削除に失敗しました')

      const remaining = threadList.filter((t) => String(t.id) !== String(activeThreadId))
      setThreadList(remaining)

      // 削除したのは表示中のスレッドなので、必ず別のスレッドへ移す。
      // 1つも残らなければ空の画面にせず新規作成する。
      if (remaining.length > 0) {
        selectThread(remaining[0].id)
        return
      }
      sessionStorage.removeItem(ACTIVE_THREAD_STORAGE_KEY)
      setMessages([])
      setNotes([])
      await createThread([])
    } catch (e) {
      console.error(e)
      alert('チャットの削除に失敗しました。')
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    if (busy || !activeThreadId) return

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
      <label htmlFor="thread">チャット</label>
      <select id="thread" value={String(activeThreadId || '')} onChange={(e) => selectThread(e.target.value)} disabled={busy}>
        {threadList.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => void createThread()} disabled={busy}>
        新規
      </button>
      <button type="button" onClick={editThreadTitle} disabled={busy || !activeThreadId}>
        編集
      </button>
      <button type="button" onClick={() => void deleteThread()} disabled={busy || !activeThreadId}>
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
            <ChatThread {...activeThreadData} />
            <ChatForm value={draft} onChange={setDraft} onSend={() => void send()} busy={busy} textareaRef={textareaRef} />
          </div>
        </div>
      </main>
    </>
  )
}
