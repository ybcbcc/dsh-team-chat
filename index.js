/**
 * Host half of `@local/dsh-codex-chat`: a chat channel between the user and a
 * real Codex CLI session, driven by slash commands instead of by the model.
 *
 * The user types `/codex <message>`. The handler forwards that text to one
 * long-lived `codex app-server` process (official JSON-RPC over stdio), waits
 * for the thread's `turn/completed`, and returns the answer as the command's
 * result text, which the DSH conversation renders under the command row. The
 * Codex process and its thread stay alive between invocations, so every later
 * `/codex` continues the same conversation with no replayed history.
 *
 * Sub-commands:
 *   `/codex`            — show the channel's state
 *   `/codex new`        — start a fresh thread (same process is replaced)
 *   `/codex <message>`  — send a message and show the answer
 *
 * This is NOT a subagent: the model never sees these messages, no delegation
 * tool is registered, and the answer is addressed to the user.
 */

import { readFileSync, readdirSync, appendFileSync, existsSync, writeFileSync, mkdirSync, statSync, accessSync, constants, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { dirname, extname, join, delimiter } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { CHAT_PAGE } from './page.js'
import { createWorkbenchHost } from './workbench-host.js'

/** Command name without the leading slash. */
const COMMAND = 'codex'

/** Diagnostic log shared with the user's troubleshooting. */
const LOG_PATH = join(tmpdir(), 'dsh-codex-chat.log')

/** Idle lifetime of a live Codex process before it is reclaimed. */
const IDLE_MS = 30 * 60 * 1000

/** Startup handshake deadline, so a silent child surfaces as a fast error. */
const START_TIMEOUT_MS = 30000

/**
 * Loopback ports tried for the independent chat page. DSH's right-Sidebar
 * browser refuses any address whose origin equals the application origin, so the
 * page is served from its own port instead; 0 asks the OS for a free one.
 */
const STANDALONE_PORTS = [18401, 18402, 18403, 18404, 0]

/**
 * Append one diagnostic line.
 * @param text - what happened.
 */
function log(text) {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${text}\n`, 'utf8')
  } catch {
    // Diagnostics must never break the channel.
  }
}

/**
 * Pick a real Node executable: the Host binary is Electron and only behaves as
 * Node with an environment flag, so a genuine interpreter is preferred.
 * @returns the executable path and whether it is the Electron binary.
 */
function executableOnPath(name) {
  const directories = (process.env.PATH || process.env.Path || '').split(delimiter).filter(Boolean)
  if (process.platform !== 'win32') directories.push('/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'))
  for (const directory of directories) {
    const executable = join(directory, process.platform === 'win32' ? `${name}.exe` : name)
    try {
      if (!statSync(executable).isFile()) continue
      accessSync(executable, constants.X_OK)
      return executable
    } catch { /* Continue through the current machine's installation paths. */ }
  }
  return undefined
}

function nodeExecutable() {
  const explicit = process.env.DSH_CODEX_NODE
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) return { path: explicit, electron: false }
  const candidates = [
    process.env.ProgramFiles === undefined ? undefined : join(process.env.ProgramFiles, 'nodejs', 'node.exe'),
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'),
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) return { path: candidate, electron: false }
  }
  const systemNode = executableOnPath('node')
  if (systemNode) return { path: systemNode, electron: false }
  return { path: process.execPath, electron: true }
}

/**
 * Locate Codex, in order of preference. The Host process may run without
 * `DSH_PROFILE_DIR`, so the profile is also searched under the usual home
 * location, and the installed Codex app's own CLI is the last resort.
 * @param override - explicit executable from the environment.
 * @returns `{ argv, env }` for the app-server child.
 */
function resolveLauncher(override) {
  if (typeof override === 'string' && override !== '') {
    log(`launcher explicit ${override}`)
    return { argv: [override, 'app-server', '--stdio'], env: process.env, source: `env:${override}` }
  }
  const node = nodeExecutable()
  const profiles = []
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') profiles.push(process.env.DSH_PROFILE_DIR)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') profiles.push(join(process.env.DSH_HOME, 'profiles', 'desktop'))
  profiles.push(join(homedir(), '.dsh', 'profiles', 'desktop'))
  for (const profile of profiles) {
    const manifestPath = join(profile, 'node_modules', '@openai', 'codex', 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin === undefined ? undefined : manifest.bin.codex
      if (typeof bin !== 'string') continue
      const wrapper = join(dirname(manifestPath), bin)
      if (!existsSync(wrapper)) continue
      log(`launcher npm wrapper ${wrapper} (node=${node.path})`)
      return {
        argv: [node.path, wrapper, 'app-server', '--stdio'],
        env: node.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
        source: `npm:${wrapper}`,
      }
    } catch (error) {
      log(`launcher npm wrapper failed: ${messageOf(error)}`)
    }
  }
  const local = process.env.LOCALAPPDATA
  if (typeof local === 'string' && local !== '') {
    const binRoot = join(local, 'OpenAI', 'Codex', 'bin')
    if (existsSync(binRoot)) {
      try {
        for (const entry of readdirSync(binRoot)) {
          const exe = join(binRoot, entry, 'codex.exe')
          if (!existsSync(exe)) continue
          log(`launcher app cli ${exe}`)
          return { argv: [exe, 'app-server', '--stdio'], env: process.env, source: `app:${exe}` }
        }
      } catch (error) {
        log(`launcher app cli failed: ${messageOf(error)}`)
      }
    }
  }
  const systemCodex = executableOnPath('codex')
  if (systemCodex) {
    const target = realpathSync(systemCodex)
    const wrapper = ['.js', '.mjs', '.cjs'].includes(extname(target))
    return { argv: wrapper ? [node.path, target, 'app-server', '--stdio'] : [systemCodex, 'app-server', '--stdio'],
      env: wrapper && node.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
      source: `path:${target}` }
  }
  throw new Error('找不到 Codex（已查 profile 内的 @openai/codex 与已安装的 Codex 应用）；可设置环境变量 DSH_CODEX_BIN 指向 codex 可执行文件')
}

/** Hard cap on one turn so a stalled call fails instead of hanging the chat. */
const TURN_TIMEOUT_MS = 15 * 60 * 1000

/** Longest answer text returned to the conversation. */
const MAX_ANSWER_CHARS = 12000

/** Last readable message from an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Join the text blocks of one content list.
 * @param blocks - content blocks.
 * @returns the joined text.
 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Fail instead of waiting forever on a silent child.
 * @param promise - the pending handshake.
 * @param ms - deadline.
 * @param label - stage name for the error.
 * @returns the promise's value or a timeout rejection.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => { rejectPromise(new Error(`${label} 超时（${Math.round(ms / 1000)} 秒无响应）`)) }, ms)
    timer.unref?.()
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (error) => { clearTimeout(timer); rejectPromise(error) },
    )
  })
}

/**
 * Turn what the server offers into an unattended approval decision.
 * @param params - approval request parameters.
 * @returns the decision value.
 */
function unattendedDecision(params) {
  const available = params === null || params === undefined ? undefined : params.availableDecisions
  if (Array.isArray(available)) {
    for (const candidate of ['accept', 'approved', 'cancel', 'decline']) {
      if (available.includes(candidate)) return candidate
    }
  }
  return 'decline'
}

/**
 * Newline-delimited JSON-RPC over one child process's stdio.
 * @param child - the spawned app-server.
 * @returns request/notify plus handler setters.
 */
function createLineWire(child) {
  const pending = new Map()
  let buffer = ''
  let nextId = 1
  let onNotification = () => {}
  let onRequest = async () => ({})
  let wireClosed = false
  const rejectPending = (error) => {
    wireClosed = true
    for (const callback of pending.values()) callback.reject(error)
    pending.clear()
  }
  child.on('error', rejectPending)
  child.on('close', () => rejectPending(new Error('Codex 连接已关闭')))
  child.stdin.on('error', rejectPending)
  const write = (message) => {
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      // A dead child is reported by its close handler.
    }
  }
  const settle = (message) => {
    if (message === null || typeof message !== 'object') return
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        Promise.resolve(onRequest(message)).then(
          (result) => { write({ jsonrpc: '2.0', id: message.id, result }) },
          () => { write({ jsonrpc: '2.0', id: message.id, result: {} }) },
        )
      } else {
        onNotification(message)
      }
      return
    }
    if (message.id === undefined) return
    const callbacks = pending.get(message.id)
    if (callbacks === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined && message.error !== null) {
      callbacks.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'app-server error'))
    } else {
      callbacks.resolve(message.result)
    }
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line === '') continue
      try {
        settle(JSON.parse(line))
      } catch {
        // Ignore a malformed frame rather than dropping the whole channel.
      }
    }
  })
  return {
    request(method, params, signal) {
      if (wireClosed) return Promise.reject(new Error('Codex 连接已关闭'))
      const id = nextId
      nextId += 1
      return new Promise((resolvePromise, rejectPromise) => {
        let onAbort
        const cleanup = () => { if (onAbort) signal.removeEventListener('abort', onAbort) }
        pending.set(id, {
          resolve: value => { cleanup(); resolvePromise(value) },
          reject: error => { cleanup(); rejectPromise(error) },
        })
        if (signal !== undefined) {
          onAbort = () => {
            const callback = pending.get(id)
            pending.delete(id)
            callback?.reject(new Error('已取消'))
          }
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }
        write({ jsonrpc: '2.0', id, method, params })
      })
    },
    notify(method) { write({ jsonrpc: '2.0', method }) },
    setNotificationHandler(handler) { onNotification = handler },
    setRequestHandler(handler) { onRequest = handler },
  }
}

/**
 * One live Codex conversation: a process, a thread, and the turns on it.
 * @param argv - app-server command.
 * @param cwd - working directory.
 * @param model - optional model override.
 * @returns a channel with `send()`, `turnCount`, and `close()`.
 */
function createChannel(spec, cwd, model, hooks, threadOptions) {
  const options = threadOptions === undefined ? {} : threadOptions
  const argv = spec.argv
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    shell: false,
    windowsHide: true,
    env: spec.env,
  })
  log(`spawn ${argv.join(' ')} (cwd=${cwd}, source=${spec.source})`)
  const wire = createLineWire(child)
  let stderr = ''
  let closed = false
  let closeReason = ''
  let threadId
  let queue = Promise.resolve()
  let idleTimer
  let collect
  let lastFinal = ''
  let lastPartial = ''
  let lastUnphased = ''
  const channel = {
    threadId: undefined,
    turnCount: 0,
    model: model === undefined ? undefined : model,
    cwd,
    lastError: '',
  }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 4000) stderr += chunk
    log(`stderr ${chunk.trim().slice(0, 300)}`)
  })
  child.on('error', (error) => {
    closed = true
    closeReason = `无法启动 Codex：${error.message}`
    channel.lastError = closeReason
    log(`child error ${error.message}`)
    if (collect !== undefined) collect.reject(new Error(closeReason))
    collect = undefined
  })
  child.on('close', (code, signal) => {
    closed = true
    closeReason = `Codex 进程已退出（code ${String(code)}${signal === null ? '' : `, ${String(signal)}`}）${stderr.trim() === '' ? '' : `：${stderr.trim().slice(0, 500)}`}`
    channel.lastError = closeReason
    log(`child close code=${String(code)} signal=${String(signal)} stderr=${stderr.trim().slice(0, 300)}`)
    if (collect !== undefined) collect.reject(new Error(closeReason))
    collect = undefined
  })
  wire.setRequestHandler(async (message) => {
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      return { decision: unattendedDecision(message.params) }
    }
    if (message.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
    if (message.method === 'item/tool/requestUserInput') {
      return hooks?.onQuestion ? hooks.onQuestion(message.params) : { answers: {} }
    }
    if (message.method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null }
    return {}
  })
  wire.setNotificationHandler((message) => {
    hooks?.onEvent?.(message.method, message.params || {})
    if (message.method === 'item/agentMessage/delta') {
      const params = message.params
      if (params !== undefined && params !== null && typeof params.delta === 'string' && hooks !== undefined && typeof hooks.onDelta === 'function') {
        hooks.onDelta(params.delta)
      }
      return
    }
    if (message.method === 'item/completed') {
      const item = message.params === undefined ? undefined : message.params.item
      if (item !== null && item !== undefined && item.type === 'agentMessage' && typeof item.text === 'string') {
        if (item.phase === 'final_answer') lastFinal = item.text
        else if (item.phase === 'partial_answer') lastPartial = item.text
        else if (item.phase === null || item.phase === undefined) lastUnphased = item.text
      }
      return
    }
    if (message.method !== 'turn/completed') return
    const turn = message.params === undefined ? undefined : message.params.turn
    if (hooks !== undefined && typeof hooks.onTurn === 'function') hooks.onTurn(turn)
    if (collect !== undefined) collect.resolve(turn)
  })
  const resetIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { close() }, IDLE_MS)
    idleTimer.unref?.()
  }
  function close() {
    if (closed) return
    closed = true
    if (collect !== undefined) collect.reject(new Error('Codex 会话已关闭'))
    collect = undefined
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    try { child.kill() } catch { /* already gone */ }
  }
  async function initialize(signal) {
    log('stage initialize')
    await withTimeout(wire.request('initialize', {
      clientInfo: { name: 'dsh-codex-chat', title: 'DSH Codex chat', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, signal), START_TIMEOUT_MS, 'initialize')
    wire.notify('initialized')
  }
  async function start(signal) {
    await initialize(signal)
    // Model selection uses thread/start.model. Reasoning effort uses config.
    const config = {}
    if (typeof options.effort === 'string' && options.effort !== '') config.model_reasoning_effort = options.effort
    if (typeof options.fast === 'boolean') config.service_tier = options.fast ? 'priority' : 'default'
    log('stage thread/start')
    const response = await withTimeout(wire.request('thread/start', {
      cwd,
      ephemeral: true,
      ...(model === undefined ? {} : { model }),
      ...(Object.keys(config).length === 0 ? {} : { config }),
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: options.readOnly === true ? 'read-only' : 'workspace-write',
    }, signal), START_TIMEOUT_MS, 'thread/start')
    const thread = response === undefined || response === null ? undefined : response.thread
    if (thread === undefined || thread === null || typeof thread.id !== 'string') {
      throw new Error('thread/start 没有返回线程 id')
    }
    threadId = thread.id
    channel.threadId = thread.id
    if (typeof response.model === 'string') channel.model = response.model
    channel.effort = response.reasoningEffort || options.effort
    log(`thread ready ${thread.id}`)
    resetIdle()
  }
  async function runTurn(text, signal, attachments) {
    if (closed) throw new Error(closeReason === '' ? 'Codex 会话已关闭' : closeReason)
    lastFinal = ''
    lastPartial = ''
    lastUnphased = ''
    const input = [{ type: 'text', text, text_elements: [] }]
    for (const attachment of attachments === undefined ? [] : attachments) {
      if (attachment === null || typeof attachment !== 'object' || typeof attachment.path !== 'string') continue
      if (attachment.kind === 'image') input.push({ type: 'localImage', path: attachment.path })
      else input.push({ type: 'mention', name: typeof attachment.name === 'string' ? attachment.name : 'file', path: attachment.path })
    }
    const completion = new Promise((resolvePromise, rejectPromise) => { collect = { resolve: resolvePromise, reject: rejectPromise } })
    const deadline = new Promise((_resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => { rejectPromise(new Error(`这一轮超过 ${Math.round(TURN_TIMEOUT_MS / 60000)} 分钟没有完成`)) },
        TURN_TIMEOUT_MS,
      )
      timer.unref?.()
      completion.then(() => { clearTimeout(timer) }, () => { clearTimeout(timer) })
    })
    try {
      await wire.request('turn/start', { threadId, input }, signal)
      const turn = await Promise.race([completion, deadline])
      const status = turn === undefined || turn === null ? undefined : turn.status
      const answer = lastFinal !== '' ? lastFinal : lastPartial !== '' ? lastPartial : lastUnphased
      channel.turnCount += 1
      resetIdle()
      return {
        answer: answer === '' ? `（这一轮没有文本回答，状态 ${String(status)}）` : answer,
        status: status === 'completed' ? 'completed' : String(status),
      }
    } catch (error) {
      close()
      throw error
    } finally {
      collect = undefined
    }
  }
  channel.send = (text, signal, attachments) => {
    const next = queue.then(() => runTurn(text, signal, attachments), () => runTurn(text, signal, attachments))
    queue = next.then(() => undefined, () => undefined)
    return next
  }
  channel.close = close
  channel.start = start
  channel.initialize = initialize
  channel.request = (method, params) => wire.request(method, params)
  channel.isClosed = () => closed
  channel.closeReason = () => closeReason
  return channel
}

/**
 * Start the chat page on its own loopback port.
 * @param handler - the request handler shared with the Host route.
 * @returns `{ server, port }`, or undefined when no port could be bound.
 */
function startStandalone(handler) {
  return new Promise((resolvePromise) => {
    let index = 0
    const attempt = () => {
      if (index >= STANDALONE_PORTS.length) {
        resolvePromise(undefined)
        return
      }
      const port = STANDALONE_PORTS[index]
      index += 1
      const server = createServer((req, res) => { void handler(req, res) })
      server.once('error', () => {
        try { server.close() } catch { /* never listened */ }
        attempt()
      })
      server.listen({ host: '127.0.0.1', port }, () => {
        const address = server.address()
        const bound = address !== null && typeof address === 'object' ? address.port : port
        resolvePromise({ server, port: bound })
      })
    }
    attempt()
  })
}

/** Required Host services: the human-command registry, the working directory owner, and the HTTP carrier. */
/** Required Host services: commands, the working directory owner, the HTTP carrier, and delegation. */
export const inject = ['commands', 'workingDirectory', 'webServer', 'subagents', 'agents']

/**
 * Host plugin body: one live Codex channel per conversation, driven by `/codex`.
 * @param ctx - Host context carrying the command registry and working directories.
 */
export function apply(ctx) {
  const profileDir = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR : ''
  const explicitBin = typeof process.env.DSH_CODEX_BIN === 'string' ? process.env.DSH_CODEX_BIN : undefined
  const explicitModel = typeof process.env.DSH_CODEX_MODEL === 'string' ? process.env.DSH_CODEX_MODEL : undefined
  log(`apply execPath=${process.execPath} profile=${profileDir === '' ? '(empty)' : profileDir} node=${nodeExecutable().path} log=${LOG_PATH}`)
  /** Live channels keyed by the DSH session that owns them. */
  const channels = new Map()
  ctx.effect(() => () => {
    for (const channel of channels.values()) channel.close()
    channels.clear()
  }, 'codex-chat: channels')

  /** Browser sessions that own a chat page: id → live state. */
  /** The independent-port server, when one could be bound. */  let standalone
  /** Conversations kept on disk, newest first. */
  const MAX_CONVERSATIONS = 50
  /** Messages kept per conversation. */
  const MAX_MESSAGES = 200

  /**
   * Where the conversation history lives.
   * @returns the absolute JSON path.
   */
  function historyPath() {
    return join(homedir(), '.dsh', 'codex-chat', 'conversations.json')
  }

  /**
   * Load persisted conversations into live records.
   * @returns the conversation map.
   */
  function loadConversations() {
    const map = new Map()
    try {
      const parsed = JSON.parse(readFileSync(historyPath(), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.conversations)) return map
      for (const entry of parsed.conversations) {
        if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue
        map.set(entry.id, {
          id: entry.id,
          title: typeof entry.title === 'string' ? entry.title : '未命名对话',
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
          messages: Array.isArray(entry.messages)
            ? entry.messages.filter(message => message !== null && typeof message === 'object' && typeof message.text === 'string')
              .map(message => ({ ...message, role: message.role === 'user' ? 'user' : 'codex', text: message.text, at: typeof message.at === 'string' ? message.at : '' }))
              .slice(-MAX_MESSAGES)
            : [],
          channel: undefined,
          listeners: new Set(),
          busy: false,
          options: entry.options !== null && typeof entry.options === 'object' ? entry.options : {},
          ...(typeof entry.dshSessionId === 'string' ? { dshSessionId: entry.dshSessionId } : {}),
        })
      }
    } catch {
      // First run, or an unreadable file: start empty.
    }
    return map
  }

  /** Conversations by id; transcripts survive restarts. */
  let conversations = loadConversations()

  const workbench = createWorkbenchHost({ ctx, createChannel, resolveLauncher, defaultCwd: webCwd,
    readJsonBody, writeJson, availableModels, storeUpload, log })
  ctx.effect(() => () => workbench.dispose(), 'codex-chat: scene workbench')

  /** Write the newest conversations back to disk. */
  function saveConversations() {
    try {
      mkdirSync(dirname(historyPath()), { recursive: true })
      const list = [...conversations.values()]
        .filter(record => record.messages.length > 0)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAX_CONVERSATIONS)
        .map(record => ({
          id: record.id,
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          options: record.options ?? {},
          ...(typeof record.dshSessionId === 'string' ? { dshSessionId: record.dshSessionId } : {}),
          messages: record.messages.slice(-MAX_MESSAGES),
        }))
      writeFileSync(historyPath(), `${JSON.stringify({ conversations: list }, null, 2)}\n`, 'utf8')
    } catch (error) {
      log(`history save failed: ${messageOf(error)}`)
    }
  }

  /**
   * Get or create the record for one conversation id.
   * @param id - conversation token.
   * @returns the record.
   */
  function conversationFor(id) {
    const existing = conversations.get(id)
    if (existing !== undefined) return existing
    // Bound memory: drop the oldest idle conversation when over the cap.
    if (conversations.size >= MAX_CONVERSATIONS) {
      const candidates = [...conversations.values()]
        .filter(record => record.busy !== true)
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      const victim = candidates[0]
      if (victim !== undefined) {
        victim.channel?.close()
        conversations.delete(victim.id)
      }
    }
    const now = new Date().toISOString()
    const record = { id, title: '新对话', createdAt: now, updatedAt: now, messages: [], channel: undefined, listeners: new Set(), busy: false, options: {} }
    conversations.set(id, record)
    return record
  }

  /**
   * The origin the local chat page is served from.
   * @returns the URL base, or undefined before the server binds.
   */
  function chatOrigin() {
    try {
      return ctx.webServer.getOrigin()
    } catch {
      return undefined
    }
  }

  /**
   * Working directory for a browser-started Codex session.
   * @returns the deployment default directory.
   */
  function webCwd() {
    try {
      const directory = ctx.workingDirectory.defaultDirectory
      if (typeof directory === 'string' && directory !== '') return directory
    } catch {
      // Fall through.
    }
    return process.cwd()
  }

  /**
   * Send one event to every open page for a session.
   * @param record - browser session.
   * @param payload - serializable event.
   */
  function broadcast(record, payload) {
    for (const listener of [...record.listeners]) {
      try {
        listener(payload)
      } catch {
        record.listeners.delete(listener)
      }
    }
  }

  /**
   * A compact transcript used when an older conversation is continued on a new thread.
   * @param record - conversation record.
   * @returns the preamble text.
   */
  function transcriptPreamble(record) {
    const recent = record.messages.slice(-12)
    const lines = ['这是我们此前对话的记录（这个会话的进程已经重启，请据此接续上下文）：']
    for (const message of recent) {
      const text = message.text.length > 800 ? `${message.text.slice(0, 800)}…` : message.text
      lines.push(`${message.role === 'user' ? '我' : '你'}：${text}`)
    }
    return lines.join('\n')
  }

  /**
   * Ensure the browser session has a live Codex channel.
   * @param record - browser session.
   * @returns the channel.
   */
  async function webChannelFor(record) {
    if (record.channel !== undefined && record.channel.isClosed() !== true) return record.channel
    record.channel?.close()
    const options = record.options === undefined ? {} : record.options
    const model = typeof options.model === 'string' && options.model !== '' ? options.model : explicitModel
    const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : webCwd()
    const channel = createChannel(resolveLauncher(explicitBin), cwd, model, {
      onDelta: (text) => { broadcast(record, { type: 'delta', agent: 'Codex', text }) },
    }, { effort: options.effort, fast: options.fast })
    record.channel = channel
    log(`web channel starting session=${record.id} cwd=${cwd} model=${model ?? 'native'} effort=${options.effort ?? 'native'} fast=${String(options.fast)}`)
    await channel.start()
    log(`web channel ready session=${record.id} thread=${String(channel.threadId)}`)
    return channel
  }

  /** Models from the app-server, cached for a few minutes. */
  let modelCache
  /** How long a model list stays fresh. */
  const MODEL_CACHE_MS = 5 * 60 * 1000

  /**
   * Ask the app-server for its model catalog.
   * @returns the model rows, each with `id`, `displayName`, and supported efforts.
   */
  async function availableModels() {
    if (modelCache !== undefined && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.value
    const channel = createChannel(resolveLauncher(explicitBin), webCwd(), undefined, undefined, undefined)
    try {
      await channel.initialize()
      const result = await withTimeout(channel.request('model/list', {}), START_TIMEOUT_MS, 'model/list')
      const rows = Array.isArray(result === undefined || result === null ? undefined : result.data) ? result.data : []
      const value = rows
        .filter(row => row !== null && typeof row === 'object' && typeof row.id === 'string')
        .map(row => ({
          id: row.id,
          label: typeof row.displayName === 'string' && row.displayName !== '' ? row.displayName : row.id,
          isDefault: row.isDefault === true,
          efforts: Array.isArray(row.supportedReasoningEfforts)
            ? row.supportedReasoningEfforts.map(effort => effort !== null && typeof effort === 'object' ? effort.reasoningEffort : undefined).filter(effort => typeof effort === 'string')
            : [],
        }))
      modelCache = { at: Date.now(), value }
      return value
    } finally {
      channel.close()
    }
  }

  /**
   * Write one JSON response.
   * @param res - server response.
   * @param value - payload.
   * @param status - HTTP status.
   */
  function writeJson(res, value, status = 200) {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /**
   * Read a bounded JSON request body.
   * @param req - incoming request.
   * @param limit - largest accepted body in bytes.
   * @returns the parsed value, or an empty object.
   */
  async function readJsonBody(req, limit = 1024 * 1024) {
    const chunks = []
    let size = 0
    await new Promise((resolvePromise, rejectPromise) => {
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          rejectPromise(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', resolvePromise)
      req.on('error', rejectPromise)
    })
    const text = Buffer.concat(chunks).toString('utf8')
    return text === '' ? {} : JSON.parse(text)
  }

  /** Largest decoded upload accepted by the panel. */
  const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
  /** Extensions treated as images, so they ride `localImage` instead of `mention`. */
  const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

  /**
   * Store one uploaded file inside the conversation's workspace.
   * @param cwd - that workspace.
   * @param name - the client's file name.
   * @param data - base64 payload.
   * @returns `{ path, name, kind, bytes }`.
   */
  async function storeUpload(cwd, name, data) {
    const cleaned = String(name === undefined || name === null ? '' : name).replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').slice(-120)
    const safeName = cleaned === '' ? `upload-${Date.now()}` : cleaned
    const buffer = Buffer.from(String(data === undefined || data === null ? '' : data), 'base64')
    if (buffer.length === 0) throw new Error('上传内容为空')
    if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('文件超过 15 MB 上限')
    const directory = join(cwd, '.dsh-codex-uploads')
    await mkdir(directory, { recursive: true })
    const target = join(directory, `${Date.now()}-${safeName}`)
    await writeFile(target, buffer)
    const extension = extname(safeName).toLowerCase()
    return {
      path: target,
      name: safeName,
      kind: IMAGE_EXTENSIONS.has(extension) ? 'image' : 'file',
      bytes: buffer.length,
    }
  }

  /**
   * Answer one chat-page request. A raw handler is used because the route table
   * only admits GET/HEAD to `resource` routes, and sending a message is a POST.
   * @param req - incoming request.
   * @param res - server response.
   */
  async function handleChat(req, res) {
    const url = new URL(req.url === undefined ? '/' : req.url, 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '')
    log(`http ${String(req.method)} ${url.pathname}${url.search} ua=${String(req.headers['user-agent'] ?? '-').slice(0, 80)}`)
    try {
      if (await workbench.handle(req, res, url)) return
      if (path === '/codex-chat/ping' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end('<!doctype html><meta charset="utf-8"><title>ping</title><body style="font:28px sans-serif;padding:40px">PONG — 面板能渲染本机页面</body>')
        return
      }
      if (path === '/codex-chat' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self' 'unsafe-inline' data:; frame-ancestors *",
          'x-frame-options': 'ALLOWALL',
        })
        res.end(CHAT_PAGE)
        return
      }
      if (path === '/codex-chat/events' && req.method === 'GET') {
        const id = url.searchParams.get('session') ?? ''
        if (id === '') {
          writeJson(res, { ok: false, error: 'session 不能为空' }, 400)
          return
        }
        const record = conversationFor(id)
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.flushHeaders()
        let open = true
        const push = (payload) => {
          if (!open) return
          try {
            res.write(`data: ${JSON.stringify(payload)}\n\n`)
          } catch {
            open = false
            record.listeners.delete(push)
          }
        }
        record.listeners.add(push)
        push({ type: 'ready', busy: record.busy })
        const heartbeat = setInterval(() => { push({ type: 'ping' }) }, 25000)
        heartbeat.unref?.()
        req.on('close', () => {
          open = false
          clearInterval(heartbeat)
          record.listeners.delete(push)
          try { res.end() } catch { /* already ended */ }
        })
        return
      }
      if (path === '/codex-chat/log' && req.method === 'POST') {
        const chunks = []
        let size = 0
        await new Promise((resolvePromise) => {
          req.on('data', (chunk) => {
            size += chunk.length
            if (size > 8000) return
            chunks.push(chunk)
          })
          req.on('end', resolvePromise)
          req.on('error', resolvePromise)
        })
        log(`client: ${Buffer.concat(chunks).toString('utf8').slice(0, 4000)}`)
        writeJson(res, { ok: true })
        return
      }
      if (path === '/codex-chat/options' && req.method === 'GET') {
        const id = url.searchParams.get('session') ?? ''
        const record = id === '' ? undefined : conversationFor(id)
        // `models=0` skips the app-server round trip so state changes are instant;
        // the panel loads the catalog lazily when the menu opens.
        const wantsModels = url.searchParams.get('models') !== '0'
        let models = []
        if (wantsModels) {
          try {
            models = await availableModels()
          } catch (error) {
            log(`model list failed: ${messageOf(error)}`)
          }
        }
        writeJson(res, { ok: true, models, current: record === undefined ? {} : (record.options ?? {}), defaultCwd: webCwd() })
        return
      }
      if (path === '/codex-chat/options' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const id = typeof body.session === 'string' ? body.session : ''
        if (id === '') {
          writeJson(res, { ok: false, error: 'session 不能为空' }, 400)
          return
        }
        const record = conversationFor(id)
        const next = { ...(record.options ?? {}) }
        if (typeof body.model === 'string') next.model = body.model
        if (typeof body.effort === 'string') next.effort = body.effort
        if (typeof body.fast === 'boolean') next.fast = body.fast
        if (typeof body.collab === 'boolean') next.collab = body.collab
        if (typeof body.cwd === 'string') {
          const cwd = body.cwd.trim()
          if (cwd !== '') {
            let usable = false
            try {
              usable = existsSync(cwd) && statSync(cwd).isDirectory()
            } catch {
              usable = false
            }
            if (!usable) {
              writeJson(res, { ok: false, error: `目录不存在：${cwd}` }, 400)
              return
            }
          }
          next.cwd = cwd
        }
        record.options = next
        // These are thread-creation settings, so the next message must start a
        // new thread for them to take effect.
        record.channel?.close()
        record.channel = undefined
        saveConversations()
        log(`options session=${id} model=${next.model ?? 'native'} effort=${next.effort ?? 'native'} fast=${String(next.fast)} cwd=${next.cwd === undefined || next.cwd === '' ? 'default' : next.cwd}`)
        writeJson(res, { ok: true, current: next })
        return
      }
      if (path === '/codex-chat/upload' && req.method === 'POST') {
        const body = await readJsonBody(req, MAX_UPLOAD_BYTES * 2).catch(() => undefined)
        if (body === undefined) {
          writeJson(res, { ok: false, error: '上传内容过大' }, 413)
          return
        }
        const id = typeof body.session === 'string' ? body.session : ''
        if (id === '') {
          writeJson(res, { ok: false, error: 'session 不能为空' }, 400)
          return
        }
        const record = conversationFor(id)
        const cwd = record.options !== undefined && typeof record.options.cwd === 'string' && record.options.cwd !== '' ? record.options.cwd : webCwd()
        try {
          const stored = await storeUpload(cwd, body.name, body.data)
          log(`upload session=${id} name=${stored.name} bytes=${stored.bytes} kind=${stored.kind}`)
          writeJson(res, { ok: true, ...stored })
        } catch (error) {
          writeJson(res, { ok: false, error: messageOf(error) }, 400)
        }
        return
      }
      if (path === '/codex-chat/sessions' && req.method === 'GET') {
        const list = [...conversations.values()]
          .filter(record => record.messages.length > 0)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .map(record => ({ id: record.id, title: record.title, updatedAt: record.updatedAt, count: record.messages.length }))
        writeJson(res, { ok: true, sessions: list })
        return
      }
      if (path === '/codex-chat/state' && req.method === 'GET') {
        const id = url.searchParams.get('session') ?? ''
        if (id === '') {
          writeJson(res, { ok: false, error: 'session 不能为空' }, 400)
          return
        }
        const record = conversationFor(id)
        writeJson(res, { ok: true, session: id, title: record.title, busy: record.busy, live: record.channel !== undefined && record.channel.isClosed() !== true, messages: record.messages })
        return
      }
      if (path === '/codex-chat/new' && req.method === 'POST') {
        const body = await readJsonBody(req).catch(() => ({}))
        const id = randomUUID()
        const record = conversationFor(id)
        if (typeof body.engine === 'string' && (body.engine === 'codex' || body.engine === 'dsh')) {
          record.options = { ...(record.options ?? {}), engine: body.engine }
        }
        if (typeof body.collab === 'boolean') {
          record.options = { ...(record.options ?? {}), collab: body.collab }
        }
        // The panel reports its session workspace; that, not the deployment
        // default, is where a new Codex thread should run.
        if (typeof body.cwd === 'string' && body.cwd.trim() !== '') {
          const cwd = body.cwd.trim()
          let usable = false
          try {
            usable = existsSync(cwd) && statSync(cwd).isDirectory()
          } catch {
            usable = false
          }
          if (usable) {
            record.options = { ...(record.options ?? {}), cwd }
            saveConversations()
          }
        }
        writeJson(res, { ok: true, session: id, title: record.title, cwd: record.options?.cwd ?? webCwd() })
        return
      }
      if (path === '/codex-chat/send' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const id = typeof body.session === 'string' ? body.session : ''
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (id === '' || text === '') {
          writeJson(res, { ok: false, error: 'session 和 text 不能为空' }, 400)
          return
        }
        const record = conversationFor(id)
        if (record.busy === true) {
          writeJson(res, { ok: false, error: '上一轮还没结束' }, 409)
          return
        }
        // The DSH session owning the panel: the DeepSeek engine needs its live Agent.
        if (typeof body.dshSessionId === 'string' && body.dshSessionId !== '') record.dshSessionId = body.dshSessionId
        record.busy = true
        // A reopened conversation has no live thread: replay a compact transcript
        // so Codex continues with the same context instead of starting blind.
        const continuing = record.messages.length > 0 && (record.channel === undefined || record.channel.isClosed() === true)
        const prompt = continuing ? `${transcriptPreamble(record)}\n\n--- 我的新消息 ---\n${text}` : text
        // Attachments the panel uploaded: absolute paths that must still exist.
        const attachments = Array.isArray(body.attachments)
          ? body.attachments
            .filter(item => item !== null && typeof item === 'object' && typeof item.path === 'string' && existsSync(item.path))
            .slice(0, 10)
            .map(item => ({
              path: item.path,
              name: typeof item.name === 'string' && item.name !== '' ? item.name : String(item.path).split(/[\\/]/).pop(),
              kind: item.kind === 'image' ? 'image' : 'file',
            }))
          : []
        const at = new Date().toISOString()
        record.messages.push({ role: 'user', text, at, ...(attachments.length === 0 ? {} : { attachments: attachments.map(item => item.name) }) })
        if (record.title === '新对话' || record.messages.length === 1) {
          record.title = text.replace(/\s+/g, ' ').trim().slice(0, 40) || '新对话'
        }
        record.updatedAt = at
        saveConversations()
        // Collaboration asks both participants in parallel; each answer is its own
        // labelled message and its own completion event.
        const collab = record.options !== undefined && record.options.collab === true
        if (collab) {
          broadcast(record, { type: 'start', agent: 'Codex' })
          broadcast(record, { type: 'start', agent: 'DeepSeek' })
        } else {
          broadcast(record, { type: 'start' })
        }
        void (async () => {
          try {
            const outcomes = collab
              ? await runCollab(record, prompt, record.dshSessionId, attachments)
              : [{ agent: undefined, ...(await runTurn(record, prompt, record.dshSessionId, attachments)) }]
            record.busy = false
            for (const outcome of outcomes) {
              record.messages.push({
                role: 'codex',
                text: outcome.answer,
                at: new Date().toISOString(),
                ...(outcome.agent === undefined ? {} : { agent: outcome.agent }),
              })
              broadcast(record, {
                type: 'done',
                answer: outcome.answer,
                status: outcome.status,
                ...(outcome.agent === undefined ? {} : { agent: outcome.agent }),
              })
            }
            record.updatedAt = new Date().toISOString()
            saveConversations()
          } catch (error) {
            record.busy = false
            record.messages.push({ role: 'codex', text: `⚠️ 调用失败：${messageOf(error)}`, at: new Date().toISOString() })
            record.updatedAt = new Date().toISOString()
            saveConversations()
            log(`web send failed session=${id}: ${messageOf(error)}`)
            broadcast(record, { type: 'error', message: messageOf(error) })
          }
        })()
        writeJson(res, { ok: true })
        return
      }
      writeJson(res, { ok: false, error: 'not found' }, 404)
    } catch (error) {
      log(`chat request failed ${path}: ${messageOf(error)}`)
      try {
        writeJson(res, { ok: false, error: messageOf(error) }, 500)
      } catch {
        // Headers were already sent; the client sees the stream close.
      }
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/codex-chat',
    handler: (req, res) => { void handleChat(req, res) },
  }), 'codex-chat: chat page route')
  log(`chat page at ${String(chatOrigin())}/codex-chat`)

  // The Host origin is refused by DSH's right-Sidebar browser, so the same page
  // is also served from an independent loopback port (a different origin).
  ctx.effect(() => {
    let disposed = false
    void startStandalone(handleChat).then((started) => {
      if (started === undefined) {
        log('standalone page: no free loopback port')
        return
      }
      if (disposed) {
        try { started.server.close() } catch { /* already gone */ }
        return
      }
      standalone = started
      log(`standalone chat page at http://127.0.0.1:${started.port}/codex-chat`)
    })
    return () => {
      disposed = true
      if (standalone !== undefined) {
        try { standalone.server.close() } catch { /* already gone */ }
        standalone = undefined
      }
    }
  }, 'codex-chat: standalone page')

  /**
   * Get or create the channel for one DSH session.
   * @param agent - the agent whose conversation issued the command.
   * @param fresh - whether to replace an existing channel.
   * @returns the started channel.
   */
  async function channelFor(agent, fresh) {
    const key = String(agent.session.id)
    const existing = channels.get(key)
    if (existing !== undefined && fresh !== true && existing.isClosed() !== true) return existing
    if (existing !== undefined) {
      existing.close()
      channels.delete(key)
    }
    let cwd
    try {
      cwd = ctx.workingDirectory.get(agent.session)
    } catch {
      cwd = process.cwd()
    }
    const channel = createChannel(resolveLauncher(explicitBin), cwd, explicitModel)
    channels.set(key, channel)
    try {
      log(`starting channel for session=${key} cwd=${cwd}`)
      await channel.start()
      log(`channel ready for session=${key}`)
    } catch (error) {
      log(`channel failed for session=${key}: ${messageOf(error)}`)
      channel.close()
      channels.delete(key)
      throw error
    }
    return channel
  }

  /**
   * The chat page address, preferring the independent port: DSH's browser panel
   * refuses any address on the application origin, so the same origin is not
   * usable there.
   * @returns the address, or undefined before either server is ready.
   */
  function chatPageUrl() {
    if (standalone !== undefined) return `http://127.0.0.1:${standalone.port}/codex-chat`
    const origin = chatOrigin()
    return origin === undefined ? undefined : `${origin}/codex-chat`
  }

  /**
   * One line telling the user where the chat page lives.
   * @returns the address line, or a note that no server is bound yet.
   */
  function chatPageLine() {
    const url = chatPageUrl()
    return url === undefined
      ? '聊天页：本地服务尚未就绪，稍后再看一次状态。'
      : `聊天页：${url} （发 /codex open 可直接在系统浏览器打开）`
  }

  /**
   * Open one URL in the user's default browser.
   * @param url - the address.
   * @returns whether a launcher was started.
   */
  function openInBrowser(url) {
    try {
      const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
      spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      return true
    } catch (error) {
      log(`open browser failed: ${messageOf(error)}`)
      return false
    }
  }

  /**
   * Run one turn on the DeepSeek participant (a DSH local subagent).
   */
  async function runDshTurn(record, prompt, sessionId, attachments) {
    if (Array.isArray(attachments) && attachments.length > 0) throw new Error('DeepSeek 引擎暂不支持附件；请切到 Codex 引擎再发')
    // Live Agent ids carry the `session-` prefix; the panel may send either form.
    const candidates = [sessionId, `session-${sessionId}`, String(sessionId).startsWith('session-') ? String(sessionId).slice('session-'.length) : undefined]
    let agent
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === '') continue
      agent = ctx.agents.get(candidate)
      if (agent !== undefined) break
    }
    if (agent === undefined) {
      const live = ctx.agents.list().map(candidate => String(candidate.id))
      log(`dsh engine: no agent for session=${String(sessionId)} live=${live.join('|')}`)
      throw new Error(`这个会话目前没有活跃的 Agent，DeepSeek 引擎不可用（活着的有：${live.join('、') || '无'}）`)
    }
    log(`dsh turn start session=${record.id}`)
    const activation = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: `panel-${record.id}`,
      prompt: [{ type: 'text', text: prompt }],
      parent: agent,
      signal: new AbortController().signal,
      delivery: 'caller',
    })
    const result = await activation.result
    const answer = textOf(result.output)
    log(`dsh turn done session=${record.id} stop=${String(result.stopReason)} chars=${answer.length}`)
    return {
      answer: answer === '' ? `（没有输出，停止原因 ${String(result.stopReason)}）` : answer,
      status: result.stopReason,
    }
  }

  /**
   * Run one turn on the Codex participant.
   */
  async function runCodexTurn(record, prompt, attachments) {
    const channel = await webChannelFor(record)
    // Non-image attachments travel as `mention` items, but the model only sees
    // files it is told about: state their absolute paths in the prompt as well.
    const files = (attachments === undefined ? [] : attachments).filter(item => item !== null && typeof item === 'object' && item.kind !== 'image')
    const finalPrompt = files.length === 0
      ? prompt
      : `${prompt}\n\n--- 附件（已存放在工作区，可直接读取） ---\n${files.map(item => `- ${item.name}：${item.path}`).join('\n')}`
    return channel.send(finalPrompt, new AbortController().signal, attachments)
  }

  /**
   * Run one turn on the conversation's engine.
   * @param record - conversation.
   * @param prompt - composed prompt.
   * @param sessionId - the DSH session that owns the panel.
   * @param attachments - uploaded files, when any.
   * @returns `{ answer, status }`.
   */
  async function runTurn(record, prompt, sessionId, attachments) {
    const engine = record.options !== undefined && record.options.engine === 'dsh' ? 'dsh' : 'codex'
    return engine === 'dsh'
      ? runDshTurn(record, prompt, sessionId, attachments)
      : runCodexTurn(record, prompt, attachments)
  }

  /**
   * Collaboration: ask both participants in parallel and label each answer.
   * @param record - conversation.
   * @param prompt - composed prompt.
   * @param sessionId - the DSH session that owns the panel.
   * @param attachments - uploaded files, when any.
   * @returns one outcome per participant.
   */
  async function runCollab(record, prompt, sessionId, attachments) {
    const codex = runCodexTurn(record, prompt, attachments).then(
      value => ({ agent: 'Codex', answer: value.answer, status: value.status }),
      error => ({ agent: 'Codex', answer: `⚠️ ${messageOf(error)}`, status: 'error' }),
    )
    const deepseek = runDshTurn(record, prompt, sessionId, attachments).then(
      value => ({ agent: 'DeepSeek', answer: value.answer, status: value.status }),
      error => ({ agent: 'DeepSeek', answer: `⚠️ ${messageOf(error)}`, status: 'error' }),
    )
    return Promise.all([codex, deepseek])
  }

  ctx.effect(() => ctx.commands.register({
    name: COMMAND,
    description: '和 Codex 对话：/codex <消息> 发一条，/codex open 在浏览器打开聊天页，/codex new 开新会话，/codex 看状态。',
    input: { hint: '<消息> | open | new | 留空看状态' },
    async handler(invocation) {
      const text = invocation.rawInput.trim()
      const key = String(invocation.agent.session.id)
      log(`handler entered session=${key} textChars=${text.length}`)
      if (text === '') {
        const channel = channels.get(key)
        if (channel === undefined || channel.isClosed() === true) {
          return { kind: 'success', text: `还没有会话。发一条 /codex <消息> 就会自动建立（或 /codex new 显式新建）。\n${chatPageLine()}` }
        }
        return {
          kind: 'success',
          text: [
            `Codex 会话在线 · 线程 ${String(channel.threadId)}`,
            `工作目录：${channel.cwd}`,
            `模型：${channel.model === undefined ? '（跟随 Codex 原生配置）' : channel.model}`,
            `已完成轮数：${channel.turnCount}`,
            chatPageLine(),
          ].join('\n'),
        }
      }
      if (text === 'open') {
        const url = chatPageUrl()
        if (url === undefined) return { kind: 'error', text: '本地服务尚未就绪，请稍后重试。' }
        const opened = openInBrowser(url)
        return {
          kind: 'success',
          text: `${opened ? '已在系统浏览器打开' : '无法自动打开，请手动访问'}：${url}`,
        }
      }
      if (text === 'new' || text === 'reset') {
        const channel = await channelFor(invocation.agent, true)
        return { kind: 'success', text: `已新建 Codex 会话 · 线程 ${String(channel.threadId)}（之前的上下文不再延续）` }
      }
      try {
        const channel = await channelFor(invocation.agent, false)
        const outcome = await channel.send(text, invocation.signal)
        const body = outcome.answer.length > MAX_ANSWER_CHARS
          ? `${outcome.answer.slice(0, MAX_ANSWER_CHARS)}\n…（回答过长，已截断）`
          : outcome.answer
        return { kind: 'success', text: body }
      } catch (error) {
        return { kind: 'error', text: `Codex 调用失败：${messageOf(error)}` }
      }
    },
  }), 'codex-chat: command')
}
