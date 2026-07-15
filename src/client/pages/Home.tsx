/** @jsxImportSource react */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChatMessageType, ChatReturnType, ChatThreadType, NoteType } from '../../types/chat'
import ChatThread from '../components/ChatThread'
import ChatForm from '../components/ChatForm'
import Note from '../components/Note'
import './Home.css'

const createId = () => {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

export default function Home() {
  const [threadList, setThreadList] = useState<{ id: string | number; title: string }[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | number | null>(null)
  const [messages, setMessages] = useState<ChatMessageType[]>([])
  const [notes, setNotes] = useState<NoteType[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const messagesRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

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

        if (data.threads && data.threads.length > 0) {
          setThreadList(data.threads)
          setActiveThreadId(data.threads[0].id)
        } else {
          createThread()
        }
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
          createdAt: new Date(m.created_at || Date.now()).getTime(),
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

  const createThread = async () => {
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
        setThreadList((prev) => [data.thread, ...prev])
        setActiveThreadId(data.thread.id)
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
        setMessages((prev) => [
          ...prev,
          ...data.messages,
        ])
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

  return (
    <div className="home">
      <div className="split">
        <div className="note">
          <div className="selecter">
            <label className="sr-only" htmlFor="thread">
              チャット選択
            </label>
            <select id="thread" value={String(activeThreadId || '')} onChange={(e) => setActiveThreadId(e.target.value)} disabled={busy}>
              {threadList.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <button type="button" onClick={createThread} disabled={busy}>
              新規
            </button>
            <button type="button" onClick={editThreadTitle} disabled={busy || !activeThreadId}>
              編集
            </button>
          </div>

          <h2>ノート</h2>
          <p>LLMが学んだ内容をノートに記述します。</p>

          {notes.length > 0 && <Note versions={notes} />}
        </div>

        <div ref={messagesRef} className="chat">
          <ChatThread {...activeThreadData} />
          <ChatForm value={draft} onChange={setDraft} onSend={() => void send()} busy={busy} textareaRef={textareaRef} />
        </div>
      </div>
    </div>
  )
}
