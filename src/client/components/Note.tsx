/** @jsxImportSource react */

import { useEffect, useMemo, useState } from 'react'
import styles from './Note.module.css'
import { NoteType } from '../../types/chat'
import { MDView } from './MDView'
import { computeNoteDiff } from '../utils/noteDiff'

export default function Note({ versions }: { versions: NoteType[] }) {
  // id が小さいほど古いバージョンとして扱う
  const sorted = useMemo(() => [...versions].sort((a, b) => Number(a.id) - Number(b.id)), [versions])

  const [selectedIndex, setSelectedIndex] = useState(sorted.length - 1)
  const [showDiff, setShowDiff] = useState(true)

  // 新しいバージョンが追加されたら最新に追従する
  useEffect(() => {
    setSelectedIndex(sorted.length - 1)
  }, [sorted.length])

  const index = Math.min(Math.max(selectedIndex, 0), sorted.length - 1)
  const selected = sorted[index]
  const previous = index > 0 ? sorted[index - 1] : null

  const diff = useMemo(() => computeNoteDiff(previous ? previous.content : null, selected?.content ?? ''), [previous, selected])

  if (!selected) return null

  return (
    <div className={styles.note}>
      <span>{selected.title}</span>
      <span>id: {selected.id}</span>
      <label htmlFor="note-version">バージョン</label>
      <select id="note-version" value={index} onChange={(e) => setSelectedIndex(Number(e.target.value))}>
        {sorted.map((v, i) => (
          <option key={v.id} value={i}>
            {i === sorted.length - 1 ? `v${i + 1} (最新)` : `v${i + 1}`}
          </option>
        ))}
      </select>
      <label htmlFor="note-show-diff">
        <input id="note-show-diff" type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} />
        差分
      </label>
      <hr />
      <MDView content={selected.content} diff={showDiff ? diff : undefined} />
    </div>
  )
}
