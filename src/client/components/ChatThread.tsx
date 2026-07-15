/** @jsxImportSource react */

import './ChatThread.css'
import { ChatThreadType } from '../../types/chat'
import { MDView } from './MDView'

export default function ChatThread({ messages }: ChatThreadType) {
  return (
    <div className="chat-thread">
      {messages.map((m) => {
        const dateLabel = new Date(m.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
        const labelTitle = m.role === 'assistant' && m.model ? `${m.model}\n${dateLabel}` : dateLabel
        return (
        <div key={m.id} className={`message message-${m.role}`}>
          <span className="message-label" title={labelTitle}>
            {m.role === 'user' ? 'You' : 'Assistant'}
          </span>
          {m.role === 'user' && (
            <p className="message-text" style={{ whiteSpace: 'pre-wrap' }}>
              {m.content}
            </p>
          )}
          {m.role === 'assistant' && <MDView content={m.content} />}
        </div>
        )
      })}
    </div>
  )
}
