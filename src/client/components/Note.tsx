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
      <header className={styles.header}>
        <h2 className={styles.title} title={`${selected.title} (id: ${selected.id})`}>
          {selected.title}
        </h2>
        <div className={styles.tools}>
          <select
            className={styles.version}
            aria-label="バージョン"
            value={index}
            onChange={(e) => setSelectedIndex(Number(e.target.value))}
          >
            {sorted.map((v, i) => (
              <option key={v.id} value={i}>
                {i === sorted.length - 1 ? `v${i + 1} (最新)` : `v${i + 1}`}
              </option>
            ))}
          </select>
          <label className={styles.toggle}>
            <input
              className={styles.toggleInput}
              type="checkbox"
              checked={showDiff}
              onChange={(e) => setShowDiff(e.target.checked)}
            />
            <span className={styles.track} aria-hidden="true">
              <span className={styles.thumb} />
            </span>
            差分
          </label>
        </div>
      </header>
      {/* 前バージョンが無い(v1)ときは差分の色が付かないので凡例も出さない */}
      {showDiff && previous && (
        <div className={styles.legend}>
          <span className={`${styles.legendItem} ${styles.legendAdded}`}>追加</span>
          <span className={`${styles.legendItem} ${styles.legendModified}`}>変更</span>
          <span className={`${styles.legendItem} ${styles.legendDeleted}`}>削除</span>
        </div>
      )}
      <MDView content={selected.content} diff={showDiff ? diff : undefined} />
    </div>
  )
}
