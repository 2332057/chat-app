/** @jsxImportSource react */

import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import './ChatForm.css'

type Props = {
  value: string
  onChange: (nextValue: string) => void
  onSend: () => void
  busy: boolean
  textareaRef?: RefObject<HTMLTextAreaElement | null>
}

export default function ChatForm({ value, onChange, onSend, busy, textareaRef }: Props) {
  const trimmed = value.trim()
  const innerRef = useRef<HTMLTextAreaElement | null>(null)

  // 親から渡された ref にも同じ要素を入れる(フォーカス制御用)
  const attachRef = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el
    if (textareaRef) textareaRef.current = el
  }

  // 入力の行数に応じて高さを変える。scrollHeight は縮む方向に効かないので、
  // 一度 auto に戻してから測り直す。上限は CSS の max-height に任せる。
  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  return (
    <form
      className="chat-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSend()
      }}
    >
      <textarea
        id="prompt"
        ref={attachRef}
        rows={1}
        placeholder="メッセージを入力(Ctrl+Enter で送信)"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // 返答待ちでも入力自体は続けられるようにし、送信だけを止める
          if (busy) return
          // Enter は改行。送信は Ctrl(Mac は Cmd)+Enter のみ
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            onSend()
          }
        }}
      />
      <button type="submit" disabled={busy || trimmed.length === 0}>
        ↑
      </button>
    </form>
  )
}
