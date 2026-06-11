/** @jsxImportSource react */

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
        ref={textareaRef}
        rows={4}
        placeholder="メッセージを入力"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
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
