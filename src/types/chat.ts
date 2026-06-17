export type ChatRoleType = 'user' | 'assistant'

export type SimpleChatMessageType = {
  role: ChatRoleType
  content: string
}

export type ChatMessageType = {
  id: string
  role: ChatRoleType
  content: string
  createdAt: number
}

export type ChatThreadType = {
  id: string
  title: string
  messages: ChatMessageType[]
}

export type PersistedStateV1Type = {
  version: 1
  activeThreadId: string
  threads: ChatThreadType[]
}

export type NoteType = {
  id: string
  thread_id: number
  title: string
  content: string
}

export type ChatReturnType = {
  messages: ChatMessageType[]
  notes: NoteType[]
}
