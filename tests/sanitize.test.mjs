import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ts from 'typescript'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

test('stripHtmlComments removes planning comments and trims the visible reply', async () => {
  const { stripHtmlComments } = await loadSanitizeModule()

  assert.equal(
    stripHtmlComments('<!-- Step 1: hidden\nStep 2: hidden -->\nノートを記録しました。'),
    'ノートを記録しました。',
  )
})

async function loadSanitizeModule() {
  const sourcePath = path.join(repoRoot, 'src', 'server', 'chat', 'sanitize.ts')
  const source = await readFile(sourcePath, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    fileName: sourcePath,
  })
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'chat-sanitize-test-'))
  const outputPath = path.join(tempDir, 'sanitize.mjs')
  await writeFile(outputPath, output.outputText)
  return import(pathToFileURL(outputPath).href)
}
