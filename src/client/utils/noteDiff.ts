import { diffLines } from 'diff'

export type LineStatus = 'added' | 'modified' | 'unchanged'

export type NoteDiffResult = {
  // 新バージョンの各行のステータス（index 0 = 1行目）
  lineStatuses: LineStatus[]
  // 「この行の直前で削除があった」新バージョンの行番号（1-indexed）。
  // 末尾での削除は 最終行+1 が入る。
  deletionMarkers: Set<number>
}

export function computeNoteDiff(oldContent: string | null, newContent: string): NoteDiffResult {
  const totalLines = newContent === '' ? 0 : newContent.split('\n').length
  const lineStatuses: LineStatus[] = new Array(totalLines).fill('unchanged')
  const deletionMarkers = new Set<number>()

  if (oldContent === null) {
    return { lineStatuses, deletionMarkers }
  }

  // 末尾改行の有無で最終行のマッチングがずれないよう、改行終端に正規化して比較する
  const normalize = (value: string) => (value.endsWith('\n') ? value : `${value}\n`)
  const chunks = diffLines(normalize(oldContent), normalize(newContent))
  // 新バージョン側の現在行（1-indexed）
  let newLine = 1

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const lines = chunk.count ?? 0

    if (chunk.removed) {
      const next = chunks[i + 1]
      if (next?.added) {
        // 削除+追加の隣接ペア → 追加行のうち削除行数分は「変更」、超過分は「追加」
        const addedLines = next.count ?? 0
        for (let j = 0; j < addedLines; j++) {
          const index = newLine + j - 1
          if (index < totalLines) {
            lineStatuses[index] = j < lines ? 'modified' : 'added'
          }
        }
        newLine += addedLines
        i++ // added チャンクは処理済み
      } else {
        // 純粋な削除 → 次に現れる新バージョン行にマーカー
        deletionMarkers.add(newLine)
      }
    } else if (chunk.added) {
      for (let j = 0; j < lines; j++) {
        const index = newLine + j - 1
        if (index < totalLines) {
          lineStatuses[index] = 'added'
        }
      }
      newLine += lines
    } else {
      newLine += lines
    }
  }

  return { lineStatuses, deletionMarkers }
}
