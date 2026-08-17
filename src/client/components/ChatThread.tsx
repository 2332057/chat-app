/** @jsxImportSource react */

import './ChatThread.css'
import { ChatThreadType } from '../../types/chat'
import { splitReasoning } from '../utils/reasoning'
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
          {m.role === 'assistant' &&
            splitReasoning(m.content).map((segment, index) =>
              segment.type === 'reasoning' ? (
                <details key={index} className="message-reasoning">
                  <summary>推論</summary>
                  <p className="message-reasoning-text">{segment.value}</p>
                </details>
              ) : (
                <MDView key={index} content={segment.value} />
              ),
            )}
        </div>
        )
      })}
    </div>
  )
}
