import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import type { Element, Root, RootContent } from 'hast'
import type { NoteDiffResult } from '../utils/noteDiff'
import './MDView.css'

import 'highlight.js/styles/github-dark.css'

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'table', 'hr'])

type DiffTarget = {
  node: Element
  start: number
  end: number
  // ステータス判定に使う行範囲（li はネストしたリストの範囲を除外）
  ownRanges: [number, number][]
}

const isList = (node: Element) => node.tagName === 'ul' || node.tagName === 'ol'

function collectTargets(nodes: RootContent[], out: DiffTarget[]) {
  for (const node of nodes) {
    if (node.type !== 'element') continue

    if (isList(node)) {
      collectTargets(node.children, out)
    } else if (node.tagName === 'li') {
      if (!node.position) continue
      const start = node.position.start.line
      const end = node.position.end.line

      // ネストしたリストの範囲は親 li 自身のステータス判定から除外する
      const nestedLists = node.children.filter((c): c is Element => c.type === 'element' && isList(c) && !!c.position)
      const ownRanges: [number, number][] = []
      let cursor = start
      for (const nested of nestedLists) {
        const ns = nested.position!.start.line
        if (cursor <= ns - 1) ownRanges.push([cursor, ns - 1])
        cursor = nested.position!.end.line + 1
      }
      if (cursor <= end) ownRanges.push([cursor, end])

      out.push({ node, start, end, ownRanges })
      for (const nested of nestedLists) {
        collectTargets(nested.children, out)
      }
    } else if (BLOCK_TAGS.has(node.tagName) && node.position) {
      const start = node.position.start.line
      const end = node.position.end.line
      out.push({ node, start, end, ownRanges: [[start, end]] })
    }
  }
}

function statusClass(diff: NoteDiffResult, ranges: [number, number][]): string | null {
  let hasAdded = false
  for (const [start, end] of ranges) {
    for (let line = start; line <= end; line++) {
      const status = diff.lineStatuses[line - 1]
      if (status === 'modified') return 'diff-modified'
      if (status === 'added') hasAdded = true
    }
  }
  return hasAdded ? 'diff-added' : null
}

function appendClass(node: Element, className: string) {
  const props = (node.properties ??= {})
  const current = props.className
  if (Array.isArray(current)) {
    current.push(className)
  } else if (typeof current === 'string') {
    props.className = `${current} ${className}`
  } else {
    props.className = className
  }
}

function rehypeNoteDiff(diff: NoteDiffResult = { lineStatuses: [], deletionMarkers: new Set() }) {
  return (tree: Root) => {
    const targets: DiffTarget[] = []
    collectTargets(tree.children, targets)
    targets.sort((a, b) => a.start - b.start || a.end - b.end)

    for (const target of targets) {
      const cls = statusClass(diff, target.ownRanges)
      if (cls) appendClass(target.node, cls)
    }

    // 削除マーカー: 「行 n の直前で削除」を、n を末尾までに含む最初のブロックに付ける
    for (const line of diff.deletionMarkers) {
      const target = targets.find((t) => t.end >= line) ?? targets[targets.length - 1]
      if (target) appendClass(target.node, 'diff-deleted-marker')
    }
  }
}

export function MDView({ content, diff }: { content: string; diff?: NoteDiffResult }) {
  const rehypePlugins: any[] = [[rehypeHighlight, { detect: true }]]
  if (diff) {
    rehypePlugins.push([rehypeNoteDiff, diff])
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={rehypePlugins}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
