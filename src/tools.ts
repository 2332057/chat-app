import type { D1Database } from '@cloudflare/workers-types'
import type { NoteType } from './types/chat'
import toolDefinitions from './tools.json'

type ToolError = { error: string }

// スレッド内のノートの総数 = 最新バージョン番号（UIの v${i+1} と一致）。
// ノートは編集のたびに新しい行として追記されるため、行数がそのままバージョン数になる。
export async function countNoteVersions(db: D1Database, threadId: string | number): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM notes WHERE thread_id = ?').bind(threadId).first<{ c: number }>()
  return row?.c ?? 0
}

export async function readNote(db: D1Database, threadId: string | number): Promise<NoteType[] | ToolError> {
  const { results } = await db.prepare('SELECT id, thread_id, title, content FROM notes WHERE thread_id = ? ORDER BY created_at ASC, id ASC').bind(threadId).all()
  return results.length > 0 ? (results as NoteType[]) : { error: 'ノートはまだありません。' }
}

export async function createNote(db: D1Database, threadId: string | number, title: string, content: string): Promise<NoteType | ToolError> {
  const { results } = await db.prepare('INSERT INTO notes (thread_id, title, content) VALUES (?, ?, ?) RETURNING id, thread_id, title, content').bind(threadId, title, content).all()
  return results.length > 0 ? (results[0] as NoteType) : { error: 'ノートの作成に失敗しました。' }
}

export type NoteEdit = { old_str: string; new_str: string }

export async function editNote(db: D1Database, threadId: string | number, edits: NoteEdit[]): Promise<NoteType | ToolError> {
  if (edits.length === 0) {
    return { error: 'edits が空です。' }
  }
  const { results } = await db.prepare('SELECT id, thread_id, title, content FROM notes WHERE thread_id = ? ORDER BY id DESC LIMIT 1').bind(threadId).all()
  if (results.length === 0) {
    return { error: 'ノートがまだありません。まず create_note で作成してください。' }
  }
  const latest = results[0] as NoteType
  let content = latest.content
  for (let i = 0; i < edits.length; i++) {
    const { old_str, new_str } = edits[i]
    if (old_str === '') {
      return { error: `edits[${i}] の old_str を空にはできません。` }
    }
    const count = content.split(old_str).length - 1
    if (count === 0) {
      return { error: `edits[${i}] の old_str がノート内に見つかりません。read_note で現在の内容を確認してください。` }
    }
    if (count > 1) {
      return { error: `edits[${i}] の old_str がノート内に ${count} 箇所あります。前後の文脈を含めて一意に特定できる文字列を指定してください。` }
    }
    content = content.replace(old_str, new_str)
  }
  const inserted = await db.prepare('INSERT INTO notes (thread_id, title, content) VALUES (?, ?, ?) RETURNING id, thread_id, title, content').bind(threadId, latest.title, content).all()
  return inserted.results.length > 0 ? (inserted.results[0] as NoteType) : { error: 'ノートの更新に失敗しました。' }
}

// 教え子はノートに書かれたことしか知らない、というペルソナの前提を壊すため、
// web_search などノート外の知識を取り込むツールは持たせない。
export const tools = toolDefinitions
