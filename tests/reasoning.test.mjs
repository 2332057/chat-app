import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ts from 'typescript'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

test('splitReasoning separates planning comments from the visible reply', async () => {
  const { splitReasoning } = await loadReasoningModule()

  assert.deepEqual(splitReasoning('<!--\nStep 1: 焦点を定める\n-->\nノートを記録しました。'), [
    { type: 'reasoning', value: 'Step 1: 焦点を定める' },
    { type: 'text', value: 'ノートを記録しました。' },
  ])
})

test('splitReasoning keeps the tool log that follows a preface', async () => {
  const { splitReasoning } = await loadReasoningModule()

  assert.deepEqual(splitReasoning('<!-- Step 1: 記録する -->\nまとめますね。\n\nツール実行: v3を作成しました'), [
    { type: 'reasoning', value: 'Step 1: 記録する' },
    { type: 'text', value: 'まとめますね。\n\nツール実行: v3を作成しました' },
  ])
})

test('splitReasoning treats an unclosed comment as reasoning', async () => {
  const { splitReasoning } = await loadReasoningModule()

  assert.deepEqual(splitReasoning('本文です。\n<!-- Step 1: 打ち切られた'), [
    { type: 'text', value: '本文です。' },
    { type: 'reasoning', value: 'Step 1: 打ち切られた' },
  ])
})

test('splitReasoning returns a single text segment when there is no comment', async () => {
  const { splitReasoning } = await loadReasoningModule()

  assert.deepEqual(splitReasoning('ノートを記録しました。'), [{ type: 'text', value: 'ノートを記録しました。' }])
})

async function loadReasoningModule() {
  const sourcePath = path.join(repoRoot, 'src', 'client', 'utils', 'reasoning.ts')
  const source = await readFile(sourcePath, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    fileName: sourcePath,
  })
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'chat-reasoning-test-'))
  const outputPath = path.join(tempDir, 'reasoning.mjs')
  await writeFile(outputPath, output.outputText)
  return import(pathToFileURL(outputPath).href)
}
