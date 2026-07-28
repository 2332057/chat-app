#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

const DEFAULT_MODEL = 'claude-sonnet-4-5'
const DEFAULT_MAX_TOKENS = '4096'
const DEFAULT_MAX_TURNS = '3'
const DIRECT_TEST_PROMPT = 'Reply exactly OK'
const FINAL_TEST_NOTE_MARKER = `claude-oauth-cloudflare-test:${Date.now()}`

const args = parseArgs(process.argv.slice(2))

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})

async function main() {
  const claudePath = which('claude')
  if (!claudePath) {
    fail('Claude Code is not installed or is not on PATH.')
  }

  const wranglerPath = which('wrangler') || null
  const claudeVersion = getClaudeVersion()
  const model = getArg('model', DEFAULT_MODEL)
  const maxTokens = getArg('max-tokens', DEFAULT_MAX_TOKENS)
  const maxTurns = getArg('max-turns', DEFAULT_MAX_TURNS)

  log(`Claude Code: ${claudeVersion}`)
  await ensureClaudeLogin()

  let capturedHeaders = defaultCapturedHeaders(claudeVersion)
  if (!args['skip-header-probe']) {
    const captured = await captureClaudeHeaders(claudePath)
    validateCapturedHeaders(captured, claudeVersion)
    capturedHeaders = captured
    log('Claude CLI header probe passed.')
  }

  const token = await resolveOAuthToken()
  await directAnthropicProbe(token, capturedHeaders, model)
  log('Direct OAuth Messages probe passed.')

  if (!args.apply) {
    log('Dry run complete. Re-run with --apply to upload the secret, deploy, and test the Worker.')
    return
  }

  if (!wranglerPath && !hasLocalWrangler()) {
    fail('Wrangler is not installed and local node_modules wrangler was not found.')
  }

  await runWrangler(['secret', 'put', 'ANTHROPIC_OAUTH_TOKEN'], {
    input: `${token}\n`,
    redact: [token],
  })
  log('Uploaded ANTHROPIC_OAUTH_TOKEN secret.')

  if (!args['skip-db']) {
    await runWrangler(['d1', 'migrations', 'apply', 'chat-app', '--remote'])
    await runWrangler(['d1', 'execute', 'chat-app', '--remote', '--command', "INSERT OR IGNORE INTO users (id, name) VALUES (1, 'Test User');"])
    log('Remote D1 migrations/user seed checked.')
  }

  const deployOutput = args['skip-deploy']
    ? ''
    : await deployWorker({
        model,
        maxTokens,
        maxTurns,
        claudeVersion,
        capturedHeaders,
      })
  const workerUrl = normalizeWorkerUrl(getArg('worker-url') || findWorkerUrl(deployOutput))

  if (!workerUrl) {
    fail('Worker URL was not found. Pass --worker-url https://your-worker.example to run the final test.')
  }

  await finalWorkerProbe(workerUrl)
  log(`Worker OAuth chat test passed: ${workerUrl}`)
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]
    if (!raw.startsWith('--')) {
      fail(`Unexpected argument: ${raw}`)
    }
    const [name, inlineValue] = raw.slice(2).split('=', 2)
    if (inlineValue !== undefined) {
      parsed[name] = inlineValue
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      parsed[name] = next
      index++
    } else {
      parsed[name] = true
    }
  }
  return parsed
}

function getArg(name, fallback = undefined) {
  const value = args[name]
  return typeof value === 'string' && value ? value : fallback
}

function log(message) {
  console.error(`[claude-oauth] ${message}`)
}

function fail(message) {
  console.error(`[claude-oauth] ${message}`)
  process.exit(1)
}

function which(command) {
  const result = spawnSync('sh', ['-lc', `command -v ${quoteShell(command)}`], {
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function getClaudeVersion() {
  const result = spawnSync('claude', ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  if (result.status !== 0) {
    fail('Could not run `claude --version`.')
  }
  const version = result.stdout.trim().split(/\s+/, 1)[0]
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`Could not parse Claude Code version from: ${result.stdout.trim()}`)
  }
  return version
}

async function ensureClaudeLogin() {
  if (args['skip-login']) {
    return
  }

  const status = spawnSync('claude', ['auth', 'status'], {
    encoding: 'utf8',
    timeout: 10000,
  })
  if (status.status === 0) {
    return
  }

  log('Claude auth status is not OK. Starting `claude auth login --claudeai`.')
  const login = spawnSync('claude', ['auth', 'login', '--claudeai'], {
    stdio: 'inherit',
  })
  if (login.status !== 0) {
    fail('Claude login failed.')
  }
}

async function resolveOAuthToken() {
  const source = getArg('auth-source', 'auto')
  if (!['auto', 'env', 'setup-token', 'credentials'].includes(source)) {
    fail('--auth-source must be one of: auto, env, setup-token, credentials')
  }

  if ((source === 'auto' || source === 'env') && (process.env.ANTHROPIC_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN)) {
    log('Using OAuth token from environment.')
    return process.env.ANTHROPIC_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN
  }

  const canPromptForSetupToken = source === 'setup-token' || process.stdin.isTTY
  if ((source === 'auto' && canPromptForSetupToken) || source === 'setup-token') {
    const token = await runSetupToken()
    if (token) {
      log('Using OAuth token from `claude setup-token`.')
      return token
    }
    if (source === 'setup-token') {
      fail('`claude setup-token` did not return a token.')
    }
    log('`claude setup-token` did not return a token; falling back to local Claude credentials.')
  } else if (source === 'auto') {
    log('Skipping `claude setup-token` because stdin is not interactive.')
  }

  const token = readLocalClaudeAccessToken()
  if (token) {
    log('Using OAuth access token from local Claude credentials.')
    return token
  }

  fail('No OAuth token found. Run `claude setup-token`, export CLAUDE_CODE_OAUTH_TOKEN, or log in with `claude auth login --claudeai`.')
}

async function runSetupToken() {
  const timeoutMs = Number(getArg('setup-timeout-ms', '180000'))
  const child = spawn('claude', ['setup-token'], {
    stdio: ['inherit', 'pipe', 'inherit'],
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    stdout += text
    const redacted = text.replace(/(CLAUDE_CODE_OAUTH_TOKEN=)\S+/g, '$1<redacted>')
    if (redacted.trim()) {
      process.stderr.write(redacted)
    }
  })

  const code = await waitForProcess(child, timeoutMs)
  if (code !== 0) {
    return null
  }
  return parseTokenFromText(stdout)
}

function parseTokenFromText(text) {
  const assignment = text.match(/CLAUDE_CODE_OAUTH_TOKEN=([^\s]+)/)
  if (assignment) {
    return assignment[1]
  }
  return text
    .trim()
    .split(/\s+/)
    .find((part) => part.length > 40 && /^[A-Za-z0-9._-]+$/.test(part))
}

function readLocalClaudeAccessToken() {
  const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json')
  if (!fs.existsSync(credentialsPath)) {
    return null
  }
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
  const token = credentials?.claudeAiOauth?.accessToken
  return typeof token === 'string' && token ? token : null
}

function waitForProcess(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve(null)
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

function defaultCapturedHeaders(claudeVersion) {
  return {
    authorization: 'Bearer <redacted>',
    'user-agent': `claude-code/${claudeVersion}`,
    'x-app': '',
    'anthropic-beta': '',
    'anthropic-dangerous-direct-browser-access': '',
  }
}

function buildOAuthHeaders(token, capturedHeaders, extra = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'User-Agent': capturedHeaders['user-agent'],
    ...extra,
  }
  if (capturedHeaders['anthropic-beta']) {
    headers['anthropic-beta'] = capturedHeaders['anthropic-beta']
  }
  if (capturedHeaders['anthropic-dangerous-direct-browser-access']) {
    headers['anthropic-dangerous-direct-browser-access'] = capturedHeaders['anthropic-dangerous-direct-browser-access']
  }
  if (capturedHeaders['x-app']) {
    headers['x-app'] = capturedHeaders['x-app']
  }
  return headers
}

async function directAnthropicProbe(token, capturedHeaders, model) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildOAuthHeaders(token, capturedHeaders),
    body: JSON.stringify({
      model,
      max_tokens: 32,
      system: [
        {
          type: 'text',
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
      ],
      messages: [{ role: 'user', content: DIRECT_TEST_PROMPT }],
    }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok && payload?.error?.type !== 'rate_limit_error') {
    fail(`Direct OAuth Messages probe failed: HTTP ${response.status}: ${payload?.error?.message || JSON.stringify(payload)}`)
  }
  if (payload?.error?.type === 'rate_limit_error') {
    log('Direct OAuth Messages probe reached Anthropic but was rate-limited; treating this as auth/header success.')
    return
  }
  const text = (payload.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('')
    .trim()
  if (!text) {
    fail('Direct OAuth Messages probe returned no text.')
  }
}

async function captureClaudeHeaders(claudePath) {
  const openssl = which('openssl')
  if (!openssl) {
    fail('openssl is required for local Claude header capture.')
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chat-claude-oauth-'))
  try {
    const { caCert, secureContext } = generateCaptureCertificates(tempDir, openssl)
    const capture = await startCaptureProxy(secureContext)
    try {
      const env = {
        ...process.env,
        HTTPS_PROXY: `http://127.0.0.1:${capture.port}`,
        https_proxy: `http://127.0.0.1:${capture.port}`,
        NO_PROXY: '',
        no_proxy: '',
        NODE_EXTRA_CA_CERTS: caCert,
        NODE_USE_SYSTEM_CA: '1',
      }
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
      delete env.ANTHROPIC_BASE_URL

      const child = spawn(claudePath, ['-p', DIRECT_TEST_PROMPT, '--no-session-persistence'], {
        cwd: tempDir,
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      child.stderr.resume()
      const headers = await Promise.race([
        capture.nextHeaders,
        sleep(25000).then(() => null),
      ])
      child.kill('SIGTERM')
      await waitForProcess(child, 3000)

      if (!headers) {
        fail(`Claude did not send a capturable request. Proxy events: ${capture.events.join('; ')}`)
      }
      return headers
    } finally {
      await capture.close()
    }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true })
  }
}

function generateCaptureCertificates(tempDir, openssl) {
  const caKey = path.join(tempDir, 'ca.key')
  const caCert = path.join(tempDir, 'ca.pem')
  const leafKey = path.join(tempDir, 'leaf.key')
  const leafCsr = path.join(tempDir, 'leaf.csr')
  const leafCert = path.join(tempDir, 'leaf.pem')
  const extensions = path.join(tempDir, 'leaf.ext')
  fs.writeFileSync(
    extensions,
    [
      'subjectAltName=DNS:api.anthropic.com',
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      '',
    ].join('\n'),
  )

  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCert, '-days', '1', '-subj', '/CN=Chat Claude Header Capture CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
  run(openssl, ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', leafKey, '-out', leafCsr, '-subj', '/CN=api.anthropic.com'])
  run(openssl, ['x509', '-req', '-in', leafCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', leafCert, '-days', '1', '-extfile', extensions])

  return {
    caCert,
    secureContext: tls.createSecureContext({
      key: fs.readFileSync(leafKey),
      cert: fs.readFileSync(leafCert),
    }),
  }
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    encoding: 'utf8',
    ...options,
  })
  if (result.status !== 0) {
    fail(`${command} ${argv.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout || ''
}

function startCaptureProxy(secureContext) {
  const events = []
  let resolveHeaders
  const nextHeaders = new Promise((resolve) => {
    resolveHeaders = resolve
  })

  const server = net.createServer(async (socket) => {
    socket.setTimeout(8000)
    try {
      const connectHead = await readHeaders(socket)
      const firstLine = connectHead.split('\r\n', 1)[0]
      events.push(firstLine)
      if (firstLine !== 'CONNECT api.anthropic.com:443 HTTP/1.1') {
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        return
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

      const tlsSocket = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext,
      })
      const requestHead = await readHeaders(tlsSocket)
      events.push(requestHead.split('\r\n', 1)[0])
      const headers = parseHttpHeaders(requestHead)
      resolveHeaders({
        authorization: headers.authorization?.startsWith('Bearer ') ? 'Bearer <redacted>' : '<missing>',
        'user-agent': headers['user-agent'] || '',
        'x-app': headers['x-app'] || '',
        'anthropic-beta': headers['anthropic-beta'] || '',
        'anthropic-dangerous-direct-browser-access': headers['anthropic-dangerous-direct-browser-access'] || '',
      })
      const body = JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'captured',
        },
      })
      tlsSocket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
    } catch (error) {
      events.push(`${error.name || 'Error'}: ${error.message || error}`)
      socket.destroy()
    }
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        events,
        nextHeaders,
        close: () =>
          new Promise((done) => {
            server.close(done)
          }),
      })
    })
  })
}

function readHeaders(socket) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0)
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
    }
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk])
      if (data.includes('\r\n\r\n')) {
        cleanup()
        resolve(data.toString('latin1').split('\r\n\r\n', 1)[0])
      }
      if (data.length > 128 * 1024) {
        cleanup()
        reject(new Error('request headers exceeded capture limit'))
      }
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onTimeout = () => {
      cleanup()
      reject(new Error('socket timed out'))
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('timeout', onTimeout)
  })
}

function parseHttpHeaders(head) {
  const headers = {}
  for (const line of head.split('\r\n').slice(1)) {
    const index = line.indexOf(':')
    if (index === -1) {
      continue
    }
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }
  return headers
}

function validateCapturedHeaders(headers, claudeVersion) {
  const problems = []
  if (headers.authorization !== 'Bearer <redacted>') {
    problems.push('Authorization was not bearer auth')
  }
  if (!headers['user-agent']) {
    problems.push('User-Agent was missing')
  } else if (!headers['user-agent'].includes(claudeVersion)) {
    problems.push(`User-Agent did not include Claude Code version ${claudeVersion}: ${headers['user-agent']}`)
  }
  if (problems.length) {
    fail(`Claude CLI header contract changed:\n- ${problems.join('\n- ')}`)
  }
}

function hasLocalWrangler() {
  return fs.existsSync(path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'))
}

async function runWrangler(argv, options = {}) {
  const command = which('wrangler') ? 'wrangler' : 'npx'
  const fullArgv = command === 'npx' ? ['wrangler', ...argv] : argv
  const result = await runProcess(command, fullArgv, options)
  return result.stdout
}

function runProcess(command, argv, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    if (options.input) {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }
    child.on('exit', (code) => {
      const redactedStdout = redact(stdout, options.redact)
      const redactedStderr = redact(stderr, options.redact)
      if (code !== 0) {
        fail(`${command} ${argv.join(' ')} failed:\n${redactedStdout}${redactedStderr}`)
      }
      if (redactedStdout.trim()) {
        process.stderr.write(redactedStdout)
      }
      if (redactedStderr.trim()) {
        process.stderr.write(redactedStderr)
      }
      resolvePromise({ stdout: redactedStdout, stderr: redactedStderr })
    })
  })
}

function redact(text, values = []) {
  let result = text
  for (const value of values || []) {
    if (value) {
      result = result.split(value).join('<redacted>')
    }
  }
  return result
}

async function deployWorker({ model, maxTokens, maxTurns, claudeVersion, capturedHeaders }) {
  await runProcess('npm', ['run', 'build'])
  const argv = [
    'deploy',
    '--keep-vars',
    '--var',
    'CHAT_API_PROVIDER:claude-oauth',
    '--var',
    `ANTHROPIC_MODEL:${model}`,
    '--var',
    `ANTHROPIC_MAX_TOKENS:${maxTokens}`,
    '--var',
    `CLAUDE_CODE_VERSION:${claudeVersion}`,
    '--var',
    `CLAUDE_CODE_USER_AGENT:${capturedHeaders['user-agent']}`,
    '--var',
    `CLAUDE_MAX_TURNS:${maxTurns}`,
  ]
  const beta = getArg('anthropic-beta') || capturedHeaders['anthropic-beta']
  if (beta) {
    argv.push('--var', `ANTHROPIC_BETA:${beta}`)
  }
  if (capturedHeaders['anthropic-dangerous-direct-browser-access']) {
    argv.push('--var', `ANTHROPIC_DANGEROUS_DIRECT_BROWSER_ACCESS:${capturedHeaders['anthropic-dangerous-direct-browser-access']}`)
  }
  if (capturedHeaders['x-app']) {
    argv.push('--var', `CLAUDE_CODE_X_APP:${capturedHeaders['x-app']}`)
  }
  const output = await runWrangler(argv)
  log('Worker deployed with Claude OAuth vars.')
  return output
}

function findWorkerUrl(output) {
  const urls = output.match(/https:\/\/[^\s]+/g) || []
  return urls.find((url) => url.includes('workers.dev')) || urls[0] || ''
}

function normalizeWorkerUrl(url) {
  if (!url) {
    return ''
  }
  return url.replace(/\/+$/, '')
}

async function finalWorkerProbe(workerUrl) {
  const threadResponse = await fetch(`${workerUrl}/api/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Claude OAuth Cloudflare smoke' }),
  })
  const threadPayload = await threadResponse.json().catch(() => ({}))
  if (!threadResponse.ok || !threadPayload?.thread?.id) {
    fail(`Worker thread creation failed: HTTP ${threadResponse.status}: ${JSON.stringify(threadPayload)}`)
  }

  const threadId = threadPayload.thread.id
  const chatResponse = await fetch(`${workerUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId,
      content: `Cloudflare OAuth integration test. Please call create_note exactly once with title "Claude OAuth Cloudflare" and content "${FINAL_TEST_NOTE_MARKER}". Then reply briefly that the note was recorded.`,
    }),
  })
  const chatPayload = await chatResponse.json().catch(() => ({}))
  if (!chatResponse.ok || chatPayload.error) {
    fail(`Worker chat failed: HTTP ${chatResponse.status}: ${JSON.stringify(chatPayload)}`)
  }
  const note = (chatPayload.notes || []).find((candidate) => candidate.content === FINAL_TEST_NOTE_MARKER)
  const toolMessage = (chatPayload.messages || []).find((message) => typeof message.content === 'string' && message.content.includes('ツール実行'))
  if (!note || !toolMessage) {
    fail(`Worker chat did not produce the expected note/tool turn: ${JSON.stringify(chatPayload)}`)
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
