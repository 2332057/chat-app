#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { pathToFileURL } from 'node:url'

const DEFAULT_MAX_TOKENS = '4096'
const DEFAULT_MAX_TURNS = '3'
const DEFAULT_MODEL = 'claude-haiku-4-5'
const DEV_VARS_TOKEN_KEY = 'ANTHROPIC_OAUTH_TOKEN'
const APP_PROBE_PROMPT =
  'これはClaude OAuth接続確認です。学習内容ではありません。短く接続確認だけ返してください。'

const isWindows = process.platform === 'win32'

const isCli = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
const args = isCli ? parseArgs(process.argv.slice(2)) : {}

if (isCli) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error))
  })
}

async function main() {
  const claudePath = which('claude')
  if (!claudePath) {
    fail('Claude Code is not installed or is not on PATH.')
  }

  const claudeVersion = getClaudeVersion(claudePath)
  const maxTokens = getArg('max-tokens', DEFAULT_MAX_TOKENS)
  const maxTurns = getArg('max-turns', DEFAULT_MAX_TURNS)

  log(`Claude Code: ${claudeVersion}`)
  await ensureClaudeLogin(claudePath)

  const captured = await captureClaudeRequest(claudePath)
  validateCapturedRequest(captured, claudeVersion)

  const token = captured.oauthToken
  let model = getArg('model', DEFAULT_MODEL)
  if (!model) {
    fail('Could not determine a Claude model from the captured request. Pass --model explicitly.')
  }

  log(
    `Captured Claude request envelope. Captured model: ${captured.body?.model || '<missing>'}. App model: ${model}. Headers: ${Object.keys(captured.headers)
      .sort()
      .join(', ')}. Body: ${formatCapturedBodySummary(captured.body)}.`,
  )

  if (!args['skip-captured-replay']) {
    await replayCapturedClaudeRequest(token, captured.headers, captured.bodyText)
    log('Exact captured Claude CLI request replay passed.')
  }

  if (!args['skip-app-probe']) {
    await localAppShapeProbe(token, captured.headers, model, Number(maxTokens), captured.bodyText)
    log('Local app-shaped OAuth probe passed.')
  }

  if (args['local-setup']) {
    requireWrangler()
    await runWrangler(withWorkerEnv(['d1', 'migrations', 'apply', 'chat-app', '--local']))
    log('Local D1 migrations checked.')
    await uploadCapturedTemplate(captured.headers, captured.bodyText, '--local')
    log('Seeded the captured request template into local D1.')
    const devVarsPath = writeLocalSetupDevVars({
      token,
      model,
      maxTokens,
      maxTurns,
      claudeVersion,
      capturedHeaders: captured.headers,
    })
    log(`Wrote Claude OAuth vars to ${devVarsPath}. Restart the dev server to pick them up.`)
  } else if (args['write-dev-vars']) {
    const devVarsPath = writeDevVarsToken(token)
    log(`Wrote ${DEV_VARS_TOKEN_KEY} to ${devVarsPath}. Restart the dev server to pick it up.`)
  }

  if (!args.apply) {
    log('Dry run complete. Re-run with --apply to upload the D1 template, deploy, and upload the secret.')
    return
  }

  requireWrangler()

  if (!args['skip-template-upload']) {
    await uploadCapturedTemplate(captured.headers, captured.bodyText)
    log('Uploaded captured request template to remote D1.')
  }

  const deployOutput = args['skip-deploy']
    ? ''
    : await deployWorker({
        model,
        maxTokens,
        maxTurns,
        claudeVersion,
        capturedHeaders: captured.headers,
      })

  await runWrangler(withWorkerEnv(['secret', 'put', 'ANTHROPIC_OAUTH_TOKEN']), {
    input: `${token}\n`,
    redact: [token],
  })
  log('Uploaded ANTHROPIC_OAUTH_TOKEN secret.')

  if (!args['skip-db']) {
    await runWrangler(withWorkerEnv(['d1', 'migrations', 'apply', 'chat-app', '--remote']))
    log('Remote D1 migrations checked.')
  }

  // /api/chat sits behind Google sign-in, so the deployment cannot be smoke tested
  // without a browser session. Verify by hand.
  const workerUrl = findWorkerUrl(deployOutput)
  log(workerUrl ? `Deployed. Sign in and send a message to verify: ${workerUrl}` : 'Deployed. Sign in and send a message to verify.')
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
  const resolved = resolveExecutable(command)
  if (resolved) {
    return resolved
  }
  if (isWindows) {
    return resolveWindowsFallback(command)
  }
  const result = spawnSync('sh', ['-lc', `command -v ${quoteShell(command)}`], {
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

function resolveExecutable(command) {
  const raw = String(command)
  if (raw.includes('/') || raw.includes('\\')) {
    return isExecutableFile(raw) ? path.resolve(raw) : ''
  }
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) {
      continue
    }
    const base = path.join(directory.replace(/^"|"$/g, ''), raw)
    for (const extension of executableExtensions(raw)) {
      if (isExecutableFile(base + extension)) {
        return base + extension
      }
    }
  }
  return ''
}

function executableExtensions(command) {
  if (!isWindows) {
    return ['']
  }
  const pathExtensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const hasKnownExtension = pathExtensions.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()))
  return hasKnownExtension ? [''] : pathExtensions
}

function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) {
      return false
    }
    if (!isWindows) {
      fs.accessSync(candidate, fs.constants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

// Git for Windows ships openssl, but its usr/bin is not on PATH outside Git Bash.
function resolveWindowsFallback(command) {
  if (command !== 'openssl') {
    return ''
  }
  const roots = []
  const git = resolveExecutable('git')
  if (git) {
    roots.push(path.dirname(path.dirname(git)))
  }
  for (const base of [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) {
      roots.push(path.join(base, 'Git'))
    }
  }
  for (const root of roots) {
    const candidate = path.join(root, 'usr', 'bin', 'openssl.exe')
    if (isExecutableFile(candidate)) {
      return candidate
    }
  }
  return ''
}

// Windows cannot spawn .cmd/.bat shims directly, so route them through cmd.exe.
function toSpawnable(command, argv = []) {
  const resolved = resolveExecutable(command) || command
  if (isWindows && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [escapeWindowsCommand(resolved), ...argv.map(escapeWindowsArgument)].join(' ')
    return {
      command: process.env.ComSpec || 'cmd.exe',
      argv: ['/d', '/s', '/c', `"${line}"`],
      options: { windowsVerbatimArguments: true },
    }
  }
  return { command: resolved, argv, options: {} }
}

const WINDOWS_META_CHARACTERS = /([()[\]{}^=;!'+,`~ \t%&|<>"?*])/g

function escapeWindowsCommand(value) {
  return String(value).replace(WINDOWS_META_CHARACTERS, '^$1')
}

function escapeWindowsArgument(value) {
  const quoted = `"${String(value)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')}"`
  return quoted.replace(WINDOWS_META_CHARACTERS, '^$1')
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function getClaudeVersion(claudePath) {
  const spawnable = toSpawnable(claudePath, ['--version'])
  const result = spawnSync(spawnable.command, spawnable.argv, {
    ...spawnable.options,
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

async function ensureClaudeLogin(claudePath) {
  if (args['skip-login']) {
    return
  }

  const statusSpawnable = toSpawnable(claudePath, ['auth', 'status'])
  const status = spawnSync(statusSpawnable.command, statusSpawnable.argv, {
    ...statusSpawnable.options,
    encoding: 'utf8',
    timeout: 10000,
  })
  if (status.status === 0) {
    return
  }

  log('Claude auth status is not OK. Starting `claude auth login --claudeai`.')
  const loginSpawnable = toSpawnable(claudePath, ['auth', 'login', '--claudeai'])
  const login = spawnSync(loginSpawnable.command, loginSpawnable.argv, {
    ...loginSpawnable.options,
    stdio: 'inherit',
  })
  if (login.status !== 0) {
    fail('Claude login failed.')
  }
}

// The captured bearer token is short-lived, so this is a local-dev convenience only.
// Deployed Workers get the token through `wrangler secret put` instead.
function writeDevVarsToken(token, target = getArg('write-dev-vars', '.dev.vars')) {
  return writeDevVars({ [DEV_VARS_TOKEN_KEY]: token }, target, { warnOnMismatch: true })
}

// Local dev has no `wrangler deploy --var` step, so the vars deployWorker() passes
// have to be mirrored into .dev.vars or the Worker falls back to the default
// request shape, which Anthropic does not accept for every model.
function writeLocalSetupDevVars({ token, model, maxTokens, maxTurns, claudeVersion, capturedHeaders }) {
  const entries = {
    CHAT_API_PROVIDER: 'claude-oauth',
    [DEV_VARS_TOKEN_KEY]: token,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_MAX_TOKENS: maxTokens,
    CLAUDE_MAX_TURNS: maxTurns,
    CLAUDE_CODE_VERSION: claudeVersion,
    CLAUDE_CODE_USER_AGENT: capturedHeaders['user-agent'],
    ANTHROPIC_BETA: capturedHeaders['anthropic-beta'],
    ANTHROPIC_DANGEROUS_DIRECT_BROWSER_ACCESS: capturedHeaders['anthropic-dangerous-direct-browser-access'],
    CLAUDE_CODE_X_APP: capturedHeaders['x-app'],
    CLAUDE_OAUTH_TEMPLATE_SOURCE: 'd1',
  }
  return writeDevVars(entries, getArg('local-setup', '.dev.vars'))
}

function writeDevVars(entries, target, { warnOnMismatch = false } = {}) {
  const devVarsPath = path.resolve(process.cwd(), target)
  let existing = ''
  try {
    existing = fs.readFileSync(devVarsPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      fail(`Could not read ${devVarsPath}: ${error.message}`)
    }
  }

  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const lines = existing.split(/\r?\n/)
  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop()
  }

  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === '') {
      continue
    }
    const line = `${key}=${value}`
    const index = lines.findIndex((entry) => entry.startsWith(`${key}=`))
    if (index === -1) {
      lines.push(line)
    } else {
      lines[index] = line
    }
  }

  fs.writeFileSync(devVarsPath, `${lines.join(eol)}${eol}`, { encoding: 'utf8', mode: 0o600 })
  if (warnOnMismatch) {
    warnDevVarsMismatch(lines)
  }
  return devVarsPath
}

function warnDevVarsMismatch(lines) {
  if (readDevVarsValue(lines, 'CHAT_API_PROVIDER') !== 'claude-oauth') {
    log('Warning: CHAT_API_PROVIDER is not claude-oauth in this file, so local dev will not use the Claude OAuth provider.')
  }
  if (readDevVarsValue(lines, 'CLAUDE_OAUTH_TEMPLATE_SOURCE') === 'd1') {
    log('Warning: CLAUDE_OAUTH_TEMPLATE_SOURCE=d1 needs a seeded claude_oauth_template row in local D1. Re-run with --local-setup to seed it.')
  }
}

function readDevVarsValue(lines, key) {
  const line = lines.find((entry) => entry.startsWith(`${key}=`))
  return line === undefined ? undefined : line.slice(key.length + 1).trim()
}

function validateOAuthTokenShape(token, source) {
  if (!token) {
    fail(`${source} did not contain an OAuth bearer token.`)
  }
  if (token.startsWith('sk-ant-oat01--')) {
    fail(`${source} contains a Claude setup-token value. This helper needs the bearer token from an actual Claude Code request.`)
  }
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

async function captureClaudeRequest(claudePath) {
  const openssl = which('openssl')
  if (!openssl) {
    fail('openssl is required for local Claude request capture.')
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

      const spawnable = toSpawnable(claudePath, ['-p', APP_PROBE_PROMPT, '--no-session-persistence'])
      const child = spawn(spawnable.command, spawnable.argv, {
        ...spawnable.options,
        cwd: tempDir,
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      child.stderr.resume()
      const captured = await Promise.race([capture.nextRequest, sleep(25000).then(() => null)])
      child.kill('SIGTERM')
      await waitForProcess(child, 3000)

      if (!captured) {
        fail(`Claude did not send a capturable request. Proxy events: ${capture.events.join('; ')}`)
      }
      return captured
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

  run(openssl, [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    caKey,
    '-out',
    caCert,
    '-days',
    '1',
    '-subj',
    '/CN=Chat Claude Request Capture CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ])
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
  const spawnable = toSpawnable(command, argv)
  const result = spawnSync(spawnable.command, spawnable.argv, {
    encoding: 'utf8',
    ...spawnable.options,
    ...options,
  })
  if (result.status !== 0) {
    fail(`${command} ${argv.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout || ''
}

function startCaptureProxy(secureContext) {
  const events = []
  let resolveRequest
  const nextRequest = new Promise((resolve) => {
    resolveRequest = resolve
  })

  const server = net.createServer(async (socket) => {
    socket.setTimeout(8000)
    try {
      const { head: connectHead } = await readHeaderBlock(socket)
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
      const { head: requestHead, rest } = await readHeaderBlock(tlsSocket)
      const requestLine = requestHead.split('\r\n', 1)[0]
      events.push(requestLine)
      const requestPath = requestLine.split(' ')[1]?.split('?', 1)[0]
      if (requestPath !== '/v1/messages') {
        respondToCapturedRequest(tlsSocket)
        return
      }
      const headers = parseHttpHeaders(requestHead)
      const bodyText = await readRequestBody(tlsSocket, Number(headers['content-length'] || 0), rest)
      const body = summarizeCapturedBody(bodyText)
      // Claude Code fires background side requests (session title, topic detection) that
      // race the agent request on separate connections. Only the agent request carries the
      // tool definitions, and capturing a side request bakes its instructions - "generate a
      // title for this session" - into the template every app reply is then built from.
      if (!body?.toolCount) {
        events.push(`skipped side request: model=${body?.model || '<unparsed>'} tools=0 bytes=${body?.bodyBytes ?? 0}`)
        respondToSkippedRequest(tlsSocket)
        return
      }
      resolveRequest({
        headers: redactCapturedHeaders(headers),
        oauthToken: parseBearerToken(headers.authorization),
        bodyText,
        body,
      })
      respondToCapturedRequest(tlsSocket)
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
        nextRequest,
        close: () =>
          new Promise((done) => {
            server.close(done)
          }),
      })
    })
  })
}

function parseBearerToken(value) {
  if (!value?.startsWith('Bearer ')) {
    return null
  }
  return value.slice('Bearer '.length).trim() || null
}

function redactCapturedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name, value]) => value && (!shouldSkipCapturedHeader(name) || name === 'authorization'))
      .map(([name, value]) => [name, name === 'authorization' ? (value?.startsWith('Bearer ') ? 'Bearer <redacted>' : '<missing>') : value]),
  )
}

function respondToCapturedRequest(socket) {
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: 'authentication_error',
      message: 'captured',
    },
  })
  socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
}

// Side requests get a retryable error rather than the 401 used for the captured request:
// an auth failure on a background task can make the CLI give up before it sends the agent
// request we are actually waiting for.
function respondToSkippedRequest(socket) {
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: 'skipped by capture proxy',
    },
  })
  socket.end(`HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
}

function readHeaderBlock(socket) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0)
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
    }
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk])
      const boundary = data.indexOf('\r\n\r\n')
      if (boundary !== -1) {
        cleanup()
        resolve({
          head: data.subarray(0, boundary).toString('latin1'),
          rest: data.subarray(boundary + 4),
        })
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

function readRequestBody(socket, contentLength, initial) {
  if (!contentLength) {
    return Promise.resolve('')
  }
  if (initial.length >= contentLength) {
    return Promise.resolve(initial.subarray(0, contentLength).toString('utf8'))
  }
  return new Promise((resolve, reject) => {
    let data = initial
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
    }
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk])
      if (data.length >= contentLength) {
        cleanup()
        resolve(data.subarray(0, contentLength).toString('utf8'))
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

function shouldSkipCapturedHeader(name) {
  return ['authorization', 'content-length', 'host', 'connection', 'accept-encoding'].includes(name.toLowerCase())
}

function validateCapturedRequest(captured, claudeVersion) {
  const problems = []
  validateOAuthTokenShape(captured.oauthToken, 'captured Claude CLI request')
  if (captured.headers.authorization !== 'Bearer <redacted>') {
    problems.push('Authorization was not bearer auth')
  }
  if (!captured.headers['user-agent']) {
    problems.push('User-Agent was missing')
  } else if (!captured.headers['user-agent'].includes(claudeVersion)) {
    problems.push(`User-Agent did not include Claude Code version ${claudeVersion}: ${captured.headers['user-agent']}`)
  }
  if (!captured.bodyText || !captured.body) {
    problems.push('Request body was missing or could not be parsed')
  }
  if (!captured.body?.hasSystem) {
    problems.push('Captured request did not include the Claude Code top-level system envelope')
  }
  if (!captured.body?.toolCount) {
    problems.push('Captured request carried no tool definitions, so it is a Claude Code side request (session title/topic detection) rather than the agent request')
  }
  if (!captured.body?.hasMessageSystem) {
    // Claude Code moved its system prefix to the top-level `system` field, which is
    // the slot the app builder uses too, so this is informational rather than fatal.
    log('Captured request had no message-level system slot; using the top-level system envelope only.')
  }
  if (problems.length) {
    fail(`Claude CLI request contract changed:\n- ${problems.join('\n- ')}`)
  }
}

function summarizeCapturedBody(bodyText) {
  try {
    const parsed = JSON.parse(bodyText)
    return {
      keys: Object.keys(parsed).sort(),
      model: typeof parsed.model === 'string' ? parsed.model : '',
      maxTokens: typeof parsed.max_tokens === 'number' ? parsed.max_tokens : undefined,
      hasSystem: Boolean(parsed.system),
      hasMessageSystem: Array.isArray(parsed.messages) && parsed.messages.some((message) => message?.role === 'system'),
      messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
      toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      stream: parsed.stream === true,
      bodyBytes: Buffer.byteLength(bodyText),
    }
  } catch {
    return null
  }
}

function formatCapturedBodySummary(body) {
  if (!body) {
    return '<unparsed>'
  }
  return `keys=${body.keys.join(',')} max_tokens=${body.maxTokens ?? '<missing>'} messages=${body.messageCount} tools=${body.toolCount} system=${body.hasSystem ? 'yes' : 'no'} message_system=${body.hasMessageSystem ? 'yes' : 'no'} stream=${body.stream ? 'yes' : 'no'} bytes=${body.bodyBytes}`
}

async function replayCapturedClaudeRequest(token, capturedHeaders, bodyText) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      ...exactReplayHeaders(capturedHeaders),
      Authorization: `Bearer ${token}`,
    },
    body: bodyText,
  })
  await assertAnthropicOk(response, 'Exact captured Claude CLI request replay')
}

function exactReplayHeaders(headers) {
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value && !shouldSkipCapturedHeader(name)) {
      result[name] = value
    }
  }
  return result
}

async function localAppShapeProbe(token, capturedHeaders, model, maxTokens, capturedBodyText) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: buildOAuthHeaders(token, capturedHeaders),
    body: JSON.stringify(buildAppBodyFromCapturedEnvelope(capturedBodyText, model, maxTokens, APP_PROBE_PROMPT)),
  })
  const payload = await assertAnthropicOk(response, 'Local app-shaped OAuth probe')
  const content = Array.isArray(payload.content) ? payload.content : []
  const hasText = content.some((block) => block.type === 'text' && String(block.text || '').trim())
  const hasToolUse = content.some((block) => block.type === 'tool_use')
  if (!hasText && !hasToolUse) {
    fail(`Local app-shaped OAuth probe returned neither text nor tool use. Content: ${JSON.stringify(content.map((block) => ({ type: block.type, name: block.name })))}`)
  }
}

function buildOAuthHeaders(token, capturedHeaders) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...capturedRequestHeaders(capturedHeaders),
    Authorization: `Bearer ${token}`,
  }
}

function capturedRequestHeaders(headers) {
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (shouldForwardCapturedHeader(name, value)) {
      result[name] = value
    }
  }
  return result
}

function shouldForwardCapturedHeader(name, value) {
  if (!value) {
    return false
  }
  const lower = name.toLowerCase()
  return (
    lower === 'accept' ||
    lower === 'content-type' ||
    lower === 'user-agent' ||
    lower === 'x-app' ||
    lower === 'anthropic-beta' ||
    lower === 'anthropic-dangerous-direct-browser-access' ||
    lower === 'anthropic-version' ||
    lower.startsWith('x-stainless-') ||
    lower.startsWith('anthropic-client-') ||
    lower.startsWith('claude-code-')
  )
}

function buildAppBodyFromCapturedEnvelope(capturedBodyText, model, maxTokens, prompt) {
  const body = parseJson(capturedBodyText)
  if (!body) {
    fail('Cannot build an app-shaped request without a captured Claude request body.')
  }
  body.model = model
  body.max_tokens = maxTokens
  body.stream = false
  delete body.thinking
  delete body.output_config
  delete body.fallbacks
  delete body.context_management
  appendTopLevelSystem(body, readAppInstructions())
  body.messages = [...capturedContextMessages(body), { role: 'user', content: prompt }]
  body.tools = appToolDefinitions()
  body.tool_choice = { type: 'auto' }
  return body
}

function capturedContextMessages(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages
    .map((message) => {
      if (message?.role !== 'user') {
        return null
      }
      const content = systemReminderContent(message.content)
      return content ? { role: 'user', content } : null
    })
    .filter(Boolean)
    .slice(0, 1)
}

function systemReminderContent(content) {
  if (Array.isArray(content)) {
    const reminderBlocks = content.filter((block) => JSON.stringify(block).includes('<system-reminder>'))
    return reminderBlocks.length > 0 ? reminderBlocks : null
  }
  if (typeof content === 'string') {
    const match = content.match(/<system-reminder>[\s\S]*?<\/system-reminder>/)
    return match ? match[0] : null
  }
  return null
}

function appSystemMessage() {
  return {
    role: 'system',
    content: [
      {
        type: 'text',
        text: readAppInstructions(),
        cache_control: {
          type: 'ephemeral',
          ttl: '1h',
        },
      },
    ],
  }
}

function readAppInstructions() {
  return fs.readFileSync(path.join(process.cwd(), 'src', 'instructions.md'), 'utf8')
}

function appToolDefinitions() {
  const tools = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src', 'tools.json'), 'utf8'))
    .filter((tool) => tool.type === 'function')
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        ...tool.parameters,
      },
    }))
  if (tools.length) {
    tools[tools.length - 1].cache_control = {
      type: 'ephemeral',
      ttl: '1h',
    }
  }
  return tools
}

function appendTopLevelSystem(body, systemInstructions) {
  const system = Array.isArray(body.system) ? body.system : []
  system.push({
    type: 'text',
    text: systemInstructions,
    cache_control: {
      type: 'ephemeral',
      ttl: '1h',
    },
  })
  body.system = system
}

async function assertAnthropicOk(response, label) {
  const responseText = await response.text()
  const payload = parseJson(responseText) || {}
  if (!response.ok) {
    fail(`${label} failed: HTTP ${response.status}: ${payload?.error?.message || responseText}`)
  }
  return payload
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

async function uploadCapturedTemplate(headers, bodyText, target = '--remote') {
  const sqlPath = path.join(os.tmpdir(), `chat-claude-oauth-template-${process.pid}.sql`)
  const statements = [
    'CREATE TABLE IF NOT EXISTS claude_oauth_template (id INTEGER PRIMARY KEY CHECK (id = 1), headers TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);',
    `INSERT INTO claude_oauth_template (id, headers, body, updated_at) VALUES (1, ${sqlString(JSON.stringify(headers))}, ${sqlString(bodyText)}, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET headers = excluded.headers, body = excluded.body, updated_at = CURRENT_TIMESTAMP;`,
  ]
  fs.writeFileSync(sqlPath, `${statements.join('\n')}\n`)
  try {
    await runWrangler(withWorkerEnv(['d1', 'execute', 'chat-app', target, '--file', sqlPath]))
  } finally {
    await fsp.rm(sqlPath, { force: true })
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function localWranglerPath() {
  const candidate = path.join(process.cwd(), 'node_modules', '.bin', isWindows ? 'wrangler.cmd' : 'wrangler')
  return fs.existsSync(candidate) ? candidate : ''
}

function hasLocalWrangler() {
  return Boolean(localWranglerPath())
}

function requireWrangler() {
  if (!which('wrangler') && !hasLocalWrangler()) {
    fail('Wrangler is not installed and local node_modules wrangler was not found.')
  }
}

// Every wrangler call has to name the environment, or it targets the top-level Worker
// instead of the one this helper is configuring.
function workerEnv() {
  return getArg('env', '')
}

function withWorkerEnv(argv) {
  const env = workerEnv()
  return env ? [...argv, '--env', env] : argv
}

async function runWrangler(argv, options = {}) {
  const command = which('wrangler') || localWranglerPath() || 'npx'
  const fullArgv = command === 'npx' ? ['wrangler', ...argv] : argv
  const result = await runProcess(command, fullArgv, options)
  return result.stdout
}

function runProcess(command, argv, options = {}) {
  return new Promise((resolvePromise) => {
    const spawnable = toSpawnable(command, argv)
    const child = spawn(spawnable.command, spawnable.argv, {
      ...spawnable.options,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
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
  // The Vite plugin flattens wrangler.jsonc to one environment at build time, so the
  // environment has to be picked here rather than with --env on the deploy alone.
  await runProcess('npm', ['run', 'build'], { env: workerEnv() ? { CLOUDFLARE_ENV: workerEnv() } : {} })
  const argv = [
    'deploy',
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
    '--var',
    'CLAUDE_OAUTH_TEMPLATE_SOURCE:d1',
  ]
  if (capturedHeaders['anthropic-beta']) {
    argv.push('--var', `ANTHROPIC_BETA:${capturedHeaders['anthropic-beta']}`)
  }
  if (capturedHeaders['anthropic-dangerous-direct-browser-access']) {
    argv.push('--var', `ANTHROPIC_DANGEROUS_DIRECT_BROWSER_ACCESS:${capturedHeaders['anthropic-dangerous-direct-browser-access']}`)
  }
  if (capturedHeaders['x-app']) {
    argv.push('--var', `CLAUDE_CODE_X_APP:${capturedHeaders['x-app']}`)
  }
  const output = await runWrangler(withWorkerEnv(argv))
  log('Worker deployed with Claude OAuth vars.')
  return output
}

function findWorkerUrl(output) {
  const urls = output.match(/https:\/\/[^\s]+/g) || []
  return urls.find((url) => url.includes('workers.dev')) || urls[0] || ''
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export {
  buildAppBodyFromCapturedEnvelope,
  capturedRequestHeaders,
  exactReplayHeaders,
  shouldForwardCapturedHeader,
  toSpawnable,
  which,
  writeDevVars,
  writeDevVarsToken,
}
