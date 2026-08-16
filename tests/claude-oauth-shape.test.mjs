import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  toSpawnable,
  which,
  writeDevVars,
  writeDevVarsToken,
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
  assert.equal(scriptBody.system.at(-2).text, captured.system.at(-1).text)
  assert.equal(scriptBody.system.at(-1).text, systemInstructions)
  assert.equal(scriptBody.stream, false)
  assert.equal('thinking' in scriptBody, false)
  assert.equal('output_config' in scriptBody, false)
  assert.equal('fallbacks' in scriptBody, false)
  assert.equal('context_management' in scriptBody, false)
  assert.equal(scriptBody.system.at(-1).text, systemInstructions)
  assert.equal(scriptBody.system.at(-1).cache_control.type, 'ephemeral')
  assert.equal(scriptBody.messages.some((message) => message.role === 'system'), false)
  assert.deepEqual(scriptBody.messages.at(-1), { role: 'user', content: prompt })
  assert.equal(scriptBody.tools[0].input_schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(scriptBody.tools.at(-1).cache_control.type, 'ephemeral')
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

  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].role, 'user')
  assert.match(JSON.stringify(body.messages[0].content), /<system-reminder>/)
  assert.doesNotMatch(JSON.stringify(body.messages[0].content), /Original captured prompt/)
  assert.deepEqual(body.messages[1], { role: 'user', content: 'new app message' })
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

test('app shape uses top-level app system instead of message-level system', async () => {
  const shape = await shapeModulePromise
  const captured = capturedBodyFixture()
  const body = shape.buildCapturedOAuthBody({
    templateBody: captured,
    model: 'claude-haiku-4-5',
    maxTokens: 1024,
    messages: [{ role: 'user', content: 'new app message' }],
    allowTools: true,
    systemInstructions: 'app instructions',
    tools: [{ type: 'function', name: 'tool_one', description: 'A test tool.', parameters: { type: 'object', properties: {} } }],
  })

  assert.equal(body.system.at(-1).text, 'app instructions')
  assert.equal(body.system.at(-1).cache_control.type, 'ephemeral')
  assert.equal(body.messages.some((message) => message.role === 'system'), false)
})

test('--write-dev-vars replaces only the token line and keeps the rest of the file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-oauth-dev-vars-'))
  const devVarsPath = path.join(directory, '.dev.vars')
  await writeFile(
    devVarsPath,
    ['CHAT_API_PROVIDER=claude-oauth', 'ANTHROPIC_OAUTH_TOKEN=old-token', 'ANTHROPIC_MODEL=claude-haiku-4-5', ''].join('\n'),
    'utf8',
  )

  writeDevVarsToken('new-token', devVarsPath)

  assert.equal(
    await readFile(devVarsPath, 'utf8'),
    ['CHAT_API_PROVIDER=claude-oauth', 'ANTHROPIC_OAUTH_TOKEN=new-token', 'ANTHROPIC_MODEL=claude-haiku-4-5', ''].join('\n'),
  )
})

test('--write-dev-vars appends the token when the file has no token line', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-oauth-dev-vars-'))
  const devVarsPath = path.join(directory, '.dev.vars')
  await writeFile(devVarsPath, 'CHAT_API_PROVIDER=claude-oauth\n', 'utf8')

  writeDevVarsToken('new-token', devVarsPath)

  assert.equal(await readFile(devVarsPath, 'utf8'), 'CHAT_API_PROVIDER=claude-oauth\nANTHROPIC_OAUTH_TOKEN=new-token\n')
})

test('--write-dev-vars creates the file when it does not exist', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-oauth-dev-vars-'))
  const devVarsPath = path.join(directory, '.dev.vars')

  writeDevVarsToken('new-token', devVarsPath)

  assert.equal(await readFile(devVarsPath, 'utf8'), 'ANTHROPIC_OAUTH_TOKEN=new-token\n')
})

test('writeDevVars updates several keys at once and skips missing captured headers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-oauth-dev-vars-'))
  const devVarsPath = path.join(directory, '.dev.vars')
  await writeFile(devVarsPath, 'OPENAI_API_KEY=keep-me\nANTHROPIC_MODEL=claude-haiku-4-5\n', 'utf8')

  writeDevVars(
    {
      ANTHROPIC_MODEL: 'claude-opus-5',
      ANTHROPIC_BETA: 'oauth-2025-04-20',
      CLAUDE_CODE_X_APP: undefined,
      CLAUDE_OAUTH_TEMPLATE_SOURCE: 'd1',
    },
    devVarsPath,
  )

  assert.equal(
    await readFile(devVarsPath, 'utf8'),
    [
      'OPENAI_API_KEY=keep-me',
      'ANTHROPIC_MODEL=claude-opus-5',
      'ANTHROPIC_BETA=oauth-2025-04-20',
      'CLAUDE_OAUTH_TEMPLATE_SOURCE=d1',
      '',
    ].join('\n'),
  )
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

test('executable lookup finds the running node without a POSIX shell', () => {
  const resolved = which('node')
  assert.ok(resolved, 'node should be resolvable from PATH')
  assert.equal(path.basename(resolved).toLowerCase().startsWith('node'), true)
  assert.equal(which('claude-oauth-definitely-not-installed'), '')
})

test('spawn arguments survive the Windows cmd shim round trip', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chat-claude-oauth-spawn-'))
  const args = ['run', 'a b', '%PATH%', "title LIKE '__probe__:%';", 'a&b|c^d', '(paren)[bracket]', 'quote"inside', 'back\\slash\\']

  if (process.platform !== 'win32') {
    // Non-Windows keeps the direct argv path, so nothing is re-quoted.
    assert.deepEqual(toSpawnable('node', args).argv, args)
    return
  }

  const shim = path.join(dir, 'argdump.cmd')
  await writeFile(shim, '@echo off\r\nnode -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n')
  const spawnable = toSpawnable(shim, args)
  assert.equal(path.basename(spawnable.command).toLowerCase(), 'cmd.exe')
  const result = spawnSync(spawnable.command, spawnable.argv, { ...spawnable.options, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), args)
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
    output_config: { effort: 'high' },
    fallbacks: [{ model: 'claude-fable-5' }],
    context_management: { edits: [{ type: 'clear_thinking_20251015' }] },
    system: [{ type: 'text', text: 'Claude Code top-level system envelope' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>Claude Code context.</system-reminder>' },
          { type: 'text', text: 'Original captured prompt' },
        ],
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
