import type { D1Database } from '@cloudflare/workers-types'

export async function readNote(db: D1Database, threadId: string | number) {
  const { results } = await db.prepare('SELECT id, title, content FROM notes WHERE thread_id = ? ORDER BY created_at ASC').bind(threadId).all()
  return results.length > 0 ? results : [{ message: 'ノートはまだありません。' }]
}

export async function createNote(db: D1Database, threadId: string | number, title: string, content: string) {
  const { results } = await db.prepare('INSERT INTO notes (thread_id, title, content) VALUES (?, ?, ?) RETURNING id, title, content').bind(threadId, title, content).all()
  return results[0] || { error: 'ノートの作成に失敗しました。' }
}

export async function editNote(db: D1Database, threadId: string | number, noteId: number, title: string, content: string) {
  const { results } = await db.prepare('UPDATE notes SET title = ?, content = ? WHERE id = ? AND thread_id = ? RETURNING id, title, content').bind(title, content, noteId, threadId).all()
  return results.length > 0 ? results[0] : { error: 'ノートが見つからないか、更新に失敗しました。' }
}

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
    description: '既存のノートの内容を更新します。ユーザーから指示があった場合や、情報が古くなった場合に使用します。',
    parameters: {
      type: 'object',
      properties: {
        note_id: { type: 'integer', description: '更新するノートのID' },
        title: { type: 'string', description: 'ノートの新しいタイトル' },
        content: { type: 'string', description: 'ノートの新しい内容（マークダウン形式）' },
      },
      required: ['note_id', 'title', 'content'],
      additionalProperties: false,
    },
    strict: true,
  },
]
