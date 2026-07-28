import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ts from 'typescript'

import {
  buildAppBodyFromCapturedEnvelope,
  capturedRequestHeaders,
  exactReplayHeaders,
} from '../scripts/claude-oauth-cloudflare.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const shapeModulePromise = loadShapeModule()

test('script and Worker shape builders produce the same captured-envelope app body', async () => {
  const shape = await shapeModulePromise
  const captured = capturedBodyFixture()
  const prompt = 'Explain binary search in one sentence.'
  const model = 'claude-fable-5'
  const maxTokens = 4096
  const systemInstructions = await readFile(path.join(repoRoot, 'src', 'instructions.md'), 'utf8')
  const toolDefinitions = JSON.parse(await readFile(path.join(repoRoot, 'src', 'tools.json'), 'utf8'))

  const scriptBody = buildAppBodyFromCapturedEnvelope(JSON.stringify(captured), model, maxTokens, prompt)
  const workerBody = shape.buildCapturedOAuthBody({
    templateBody: captured,
    model,
    maxTokens,
    messages: [{ role: 'user', content: prompt }],
    allowTools: true,
    systemInstructions,
    tools: toolDefinitions,
  })

  assert.deepEqual(scriptBody, workerBody)
  assert.deepEqual(scriptBody.system, captured.system)
  assert.equal(scriptBody.stream, false)
  assert.equal('thinking' in scriptBody, false)
  assert.equal(scriptBody.messages.at(-1).role, 'system')
  assert.equal(scriptBody.messages.at(-1).content[0].text, systemInstructions)
  assert.equal(scriptBody.tools[0].input_schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
})

test('captured-envelope builder keeps only the Claude Code context reminder from the template messages', async () => {
  const shape = await shapeModulePromise
  const captured = capturedBodyFixture()
  const body = shape.buildCapturedOAuthBody({
    templateBody: captured,
    model: 'claude-fable-5',
    maxTokens: 1024,
    messages: [{ role: 'user', content: 'new app message' }],
    allowTools: true,
    systemInstructions: 'app instructions',
    tools: [{ type: 'function', name: 'tool_one', description: 'A test tool.', parameters: { type: 'object', properties: {} } }],
  })

  assert.equal(body.messages.length, 3)
  assert.equal(body.messages[0].role, 'user')
  assert.match(JSON.stringify(body.messages[0].content), /<system-reminder>/)
  assert.deepEqual(body.messages[1], { role: 'user', content: 'new app message' })
  assert.equal(body.messages[2].role, 'system')
})

test('captured-envelope builder removes tools when the next tool round is not allowed', async () => {
  const shape = await shapeModulePromise
  const body = shape.buildCapturedOAuthBody({
    templateBody: capturedBodyFixture(),
    model: 'claude-fable-5',
    maxTokens: 1024,
    messages: [{ role: 'user', content: 'new app message' }],
    allowTools: false,
    systemInstructions: 'app instructions',
    tools: [{ type: 'function', name: 'tool_one', description: 'A test tool.', parameters: { type: 'object', properties: {} } }],
  })

  assert.equal(body.tools, undefined)
  assert.equal(body.tool_choice, undefined)
})

test('captured headers forward Claude request identity but never auth or hop-by-hop headers', () => {
  const captured = {
    authorization: 'Bearer <redacted>',
    host: 'api.anthropic.com',
    connection: 'keep-alive',
    'content-length': '123',
    'accept-encoding': 'gzip',
    cookie: 'no',
    'user-agent': 'claude-code/2.1.75',
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
    'x-stainless-lang': 'js',
    'claude-code-feature': 'oauth',
  }

  assert.deepEqual(capturedRequestHeaders(captured), {
    'user-agent': 'claude-code/2.1.75',
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
    'x-stainless-lang': 'js',
    'claude-code-feature': 'oauth',
  })
  assert.equal(exactReplayHeaders(captured).authorization, undefined)
  assert.equal(exactReplayHeaders(captured).host, undefined)
  assert.equal(exactReplayHeaders(captured)['content-length'], undefined)
})

async function loadShapeModule() {
  const sourcePath = path.join(repoRoot, 'src', 'server', 'chat', 'claudeOAuthShape.ts')
  const source = await readFile(sourcePath, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    fileName: sourcePath,
  })
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'chat-claude-oauth-shape-test-'))
  const outputPath = path.join(tempDir, 'claudeOAuthShape.mjs')
  await writeFile(outputPath, output.outputText)
  return import(pathToFileURL(outputPath).href)
}

function capturedBodyFixture() {
  return {
    model: 'claude-fable-5',
    max_tokens: 20000,
    stream: true,
    thinking: { type: 'enabled', budget_tokens: 16000 },
    system: [{ type: 'text', text: 'Claude Code top-level system envelope' }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>Claude Code context.</system-reminder>' }],
      },
      {
        role: 'system',
        content: [{ type: 'text', text: 'Previous message-level system text' }],
      },
      {
        role: 'user',
        content: 'Original captured prompt',
      },
    ],
    tools: [{ name: 'old_tool', description: 'old', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto' },
    metadata: { source: 'fixture' },
  }
}
