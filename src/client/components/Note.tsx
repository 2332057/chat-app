/** @jsxImportSource react */

import './Note.css'
import { NoteType } from '../../types/chat'
import { MDView } from './MDView'

export default function Note({ note }: { note: NoteType }) {
  return (
    <div className="note">
      <span className="note-title">{note.title}</span>
      <span className="note-id">id: {note.id}</span>
      <hr />
      <MDView content={note.content} />
    </div>
  )
}
