// assistant の本文は「推論(HTMLコメント)」と学習者向けテキストが混ざっている。
// コメントはサーバー側で削らずに保存しているので、表示時にここで切り分ける。

export type MessageSegmentType = {
  type: 'reasoning' | 'text'
  value: string
}

const HTML_COMMENT = /<!--([\s\S]*?)-->/g
const COMMENT_OPEN = '<!--'

export function splitReasoning(content: string): MessageSegmentType[] {
  const segments: MessageSegmentType[] = []
  let cursor = 0

  for (const match of content.matchAll(HTML_COMMENT)) {
    const index = match.index ?? 0
    pushSegment(segments, 'text', content.slice(cursor, index))
    pushSegment(segments, 'reasoning', match[1])
    cursor = index + match[0].length
  }

  // 出力が途中で打ち切られると閉じられていない <!-- が残る。以降はすべて推論として扱う
  const tail = content.slice(cursor)
  const unclosed = tail.indexOf(COMMENT_OPEN)
  if (unclosed === -1) {
    pushSegment(segments, 'text', tail)
  } else {
    pushSegment(segments, 'text', tail.slice(0, unclosed))
    pushSegment(segments, 'reasoning', tail.slice(unclosed + COMMENT_OPEN.length))
  }

  return segments
}

function pushSegment(segments: MessageSegmentType[], type: MessageSegmentType['type'], raw: string): void {
  const value = raw.trim()
  if (value) {
    segments.push({ type, value })
  }
}
