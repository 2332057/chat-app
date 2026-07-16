import type { D1Database } from '@cloudflare/workers-types'
import type { NoteType } from './types/chat'

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
export const tools = [
  {
    type: 'function' as const,
    name: 'read_note',
    description: '現在のスレッドに保存されているノート（LLMが学んだ内容の記録）を読み取ります。ユーザーが以前の学習内容やノートについて言及した際に使用してください。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function' as const,
    name: 'create_note',
    description: '新しいノートを作成して、ユーザーの学習内容や重要な情報を記録します。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'ノートのタイトル' },
        content: { type: 'string', description: 'ノートに保存する内容（マークダウン形式）' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function' as const,
    name: 'edit_note',
    description:
      '最新のノートを文字列置換で部分的に修正します。誤りの修正や重複の統合に使用してください。複数箇所を直す場合は edits に複数指定します（先頭から順に適用され、すべて成功したときだけ1つの新バージョンとして保存されます）。old_str はノート内で一意に特定できる文字列を指定してください（0件または複数件マッチするとエラーになります）。削除は new_str に空文字を指定します。全面的な書き直しには create_note を使ってください。',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: '適用する置換のリスト（順に適用）',
          items: {
            type: 'object',
            properties: {
              old_str: { type: 'string', description: '置き換えたい既存テキスト（ノート内で一意に特定できるもの）' },
              new_str: { type: 'string', description: '置き換え後のテキスト（削除する場合は空文字）' },
            },
            required: ['old_str', 'new_str'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
    strict: true,
  },
]
