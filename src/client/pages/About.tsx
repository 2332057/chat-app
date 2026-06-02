/** @jsxImportSource react */

import { useEffect } from 'react'

export default function About() {
  useEffect(() => {
    document.title = 'About | 学習支援システム'
  }, [])

  return <h1>Aboutページ</h1>
}
