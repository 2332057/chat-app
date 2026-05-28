/** @jsxImportSource react */

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header>
        <h1>学習支援システム</h1>
      </header>
      <main>
        {children}
      </main>
      <footer>
        <p>&copy; 2026 学習支援システム</p>
      </footer>
    </>
  )
}
