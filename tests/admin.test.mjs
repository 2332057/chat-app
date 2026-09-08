import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ts from 'typescript'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

test('parseAdminEmails trims, lowercases and drops empty entries', async () => {
  const { parseAdminEmails } = await loadAdminModule()

  assert.deepEqual(parseAdminEmails(' Admin@example.com , , other@example.com '), ['admin@example.com', 'other@example.com'])
  assert.deepEqual(parseAdminEmails(''), [])
  assert.deepEqual(parseAdminEmails(undefined), [])
})

test('isAdminEmail ignores case and surrounding spaces', async () => {
  const { isAdminEmail } = await loadAdminModule()

  assert.equal(isAdminEmail('ADMIN@example.com', 'admin@example.com'), true)
  assert.equal(isAdminEmail(' admin@example.com ', 'admin@example.com'), true)
  assert.equal(isAdminEmail('member@example.com', 'admin@example.com'), false)
})

// ADMIN_EMAILS 未設定なら管理者は0人。ここが true に転ぶと全員が
// 他人のチャットを読めてしまうので、既定値は必ず落ちる側であること。
test('isAdminEmail is false for everyone when ADMIN_EMAILS is unset or blank', async () => {
  const { isAdminEmail } = await loadAdminModule()

  assert.equal(isAdminEmail('admin@example.com', undefined), false)
  assert.equal(isAdminEmail('admin@example.com', ''), false)
  assert.equal(isAdminEmail('admin@example.com', ' , '), false)
})

// 部分一致で通ってしまわないこと(メールの一部を名乗る攻撃を防ぐ)。
test('isAdminEmail does not match on substrings', async () => {
  const { isAdminEmail } = await loadAdminModule()

  assert.equal(isAdminEmail('admin@example.com.evil.test', 'admin@example.com'), false)
  assert.equal(isAdminEmail('example.com', 'admin@example.com'), false)
})

async function loadAdminModule() {
  const sourcePath = path.join(repoRoot, 'src', 'server', 'admin.ts')
  const source = await readFile(sourcePath, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    fileName: sourcePath,
  })

  const dir = await mkdtemp(path.join(os.tmpdir(), 'admin-test-'))
  const modulePath = path.join(dir, 'admin.mjs')
  await writeFile(modulePath, output.outputText, 'utf8')
  return import(pathToFileURL(modulePath).href)
}
