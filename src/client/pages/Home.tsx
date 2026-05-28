/** @jsxImportSource react */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChatMessageType, ChatThreadType, PersistedStateV1Type } from '../../types/chat'
import ChatThread from '../components/ChatThread'
import ChatForm from '../components/ChatForm'
import './Home.css'

const STORAGE_KEY = 'minimal-chat:v1'

const createId = () => {
  try {
    return crypto.randomUUID()
  } catch {
    // ignore
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const createInitialThread = (): ChatThreadType => {
  return {
    id: createId(),
    title: 'Chat 1',
    messages: [
      {
        id: createId(),
        role: 'assistant',
        content: 'こんにちは。メッセージを送ってください。',
        createdAt: Date.now(),
      },
    ],
  }
}

const loadState = (): PersistedStateV1Type | null => {
  if (typeof window === 'undefined') return null

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as PersistedStateV1Type
    if (!parsed || parsed.version !== 1) return null
    if (!Array.isArray(parsed.threads) || typeof parsed.activeThreadId !== 'string') return null

    const threads = parsed.threads
      .filter((thread) => thread && typeof thread.id === 'string' && typeof thread.title === 'string' && Array.isArray(thread.messages))
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        messages: thread.messages
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map((m) => ({
            id: typeof m.id === 'string' ? m.id : createId(),
            role: m.role,
            content: m.content,
            createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now(),
          })),
      }))

    if (threads.length === 0) return null

    const activeThreadId = threads.some((t) => t.id === parsed.activeThreadId) ? parsed.activeThreadId : threads[0].id

    return { version: 1, activeThreadId, threads }
  } catch {
    return null
  }
}

const saveState = (state: PersistedStateV1Type) => {
  if (typeof window === 'undefined') return

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore write failures (private mode / quota)
  }
}

export default function Home() {
  const hydrated = useMemo(() => loadState(), [])

  const [threads, setThreads] = useState<ChatThreadType[]>(() => hydrated?.threads ?? [createInitialThread()])
  const [activeThreadId, setActiveThreadId] = useState<string>(() => hydrated?.activeThreadId ?? (hydrated?.threads?.[0]?.id ?? threads[0]!.id))
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const messagesRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const activeThread = useMemo(() => threads.find((t) => t.id === activeThreadId) ?? threads[0]!, [threads, activeThreadId])

  useEffect(() => {
    if (!threads.some((t) => t.id === activeThreadId)) {
      setActiveThreadId(threads[0]!.id)
    }
  }, [threads, activeThreadId])

  useEffect(() => {
    saveState({ version: 1, activeThreadId, threads })
  }, [threads, activeThreadId])

  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [activeThreadId, activeThread.messages.length])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const createThread = () => {
    setThreads((prev) => {
      const nextIndex = prev.length + 1
      const thread: ChatThreadType = {
        id: createId(),
        title: `Chat ${nextIndex}`,
        messages: [
          {
            id: createId(),
            role: 'assistant',
            content: 'こんにちは。メッセージを送ってください。',
            createdAt: Date.now(),
          },
        ],
      }
      const next = [...prev, thread]
      setActiveThreadId(thread.id)
      return next
    })
  }

  const appendToThread = (threadId: string, message: ChatMessageType) => {
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, messages: [...t.messages, message] } : t))
    )
  }

  const send = async () => {
    if (busy) return

    const value = draft.trim()
    if (!value) return

    const threadId = activeThreadId
    const userMessage: ChatMessageType = {
      id: createId(),
      role: 'user',
      content: value,
      createdAt: Date.now(),
    }

    appendToThread(threadId, userMessage)
    setDraft('')
    setBusy(true)

    try {
      const thread = threads.find((t) => t.id === threadId) ?? activeThread
      const payloadMessages = [...thread.messages, userMessage]
        .map((m) => ({ role: m.role, content: m.content }))
        .slice(-20)

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: payloadMessages }),
      })

      const data = (await response.json()) as { reply?: string; error?: string }

      if (!response.ok) {
        throw new Error(data.error ?? 'チャットに失敗しました。')
      }

      appendToThread(threadId, {
        id: createId(),
        role: 'assistant',
        content: data.reply ?? '返答がありませんでした。',
        createdAt: Date.now(),
      })
    } catch (error) {
      appendToThread(threadId, {
        id: createId(),
        role: 'assistant',
        content: error instanceof Error ? error.message : '予期しないエラーが発生しました。',
        createdAt: Date.now(),
      })
    } finally {
      setBusy(false)
      textareaRef.current?.focus()
    }
  }

  return (
    <div className="home">
      <div className="selecter">
        <label className="sr-only" htmlFor="thread">チャット選択</label>
        <select
          id="thread"
          value={activeThreadId}
          onChange={(e) => setActiveThreadId(e.target.value)}
          disabled={busy}
        >
          {threads.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        <button type="button" onClick={createThread} disabled={busy}>新規</button>
      </div>

      <div className="split">
        <div className="note">
          <h2>ノート</h2>
          <p>LLMが学んだ内容をノートに記述します。</p>
        </div>

        <div ref={messagesRef} className="chat">
          <ChatThread {...activeThread} />
          <ChatForm
            value={draft}
            onChange={setDraft}
            onSend={() => void send()}
            busy={busy}
            textareaRef={textareaRef}
          />
        </div>
      </div>
    </div>
  )
}
