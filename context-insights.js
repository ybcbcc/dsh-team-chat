import { estimateTokens } from './scenario-store.js'

const CATEGORY_MAP = { role: 'system', scene: 'inject', task: 'user', memory: 'inject', skill: 'skill', history: 'user', handoff: 'inject', attachment: 'user' }
const asText = value => typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)

export function normalizedUsage(usage, engine = 'codex') {
  if (!usage || typeof usage !== 'object') return undefined
  const number = (...keys) => keys.map(key => usage[key]).find(value => typeof value === 'number' && Number.isFinite(value))
  const input = number('inputTokens', 'input_tokens', 'prompt_tokens')
  const cache = number('cachedInputTokens', 'cacheReadTokens', 'cached_input_tokens') ?? usage.input_tokens_details?.cached_tokens
  const cacheWrite = number('cacheWriteTokens')
  const output = number('outputTokens', 'output_tokens', 'completion_tokens')
  const reasoning = number('reasoningTokens', 'reasoning_tokens') ?? usage.output_tokens_details?.reasoning_tokens
  if ([input, cache, cacheWrite, output, reasoning].every(value => value === undefined)) return undefined
  return { input: input === undefined ? undefined : input + (engine === 'dsh' ? (cache || 0) + (cacheWrite || 0) : 0),
    cache, output, reasoning }
}

function promptItem(item, index) {
  return { ...item, key: item.key || `${item.category}-${index}`, category: CATEGORY_MAP[item.category] || item.category,
    originalCategory: item.originalCategory || item.category, estimatedTokens: item.estimatedTokens ?? estimateTokens(item.content) }
}

/** Captures the input surface immediately before each native model reply. */
export function createRuntimeCapture({ store, request }) {
  const surface = new Map()
  const calls = new Map()
  let tools = []
  let config = {}
  let capacity
  let startedAt
  let approximate = false
  const parent = store.context(request.contextId, request.run.scenarioId)
  const source = event => ({ type: 'runtime', threadId: event.threadId, sequence: event.seq })
  const contentOf = message => Array.isArray(message?.content)
    ? message.content.map(block => block.text ?? block.reasoning ?? asText(block)).join('\n')
    : asText(message?.content || '')
  const append = (event, category, message, extra = {}) => {
    const full = contentOf(message)
    const content = full.slice(0, 100000)
    if (content.length < full.length) approximate = true
    surface.set(event.seq, { key: `runtime-${event.seq}`, category, label: extra.tool || category,
      content, truncated: content.length < full.length, estimatedTokens: estimateTokens(full), source: source(event), ...extra })
    if (surface.size > 1000) { surface.delete(surface.keys().next().value); approximate = true }
  }
  return event => {
    const data = event.data || {}
    const at = new Date(event.time || Date.now()).toISOString()
    if (event.surfaceOp?.op === 'replace') {
      for (const seq of surface.keys()) if (seq >= event.surfaceOp.startSeq && seq <= event.surfaceOp.endSeq) surface.delete(seq)
    }
    if (event.type === 'request/header') {
      const header = data.header || {}
      config = { ...config, ...header.config }
      tools = (header.tools || []).map((tool, index) => ({ key: `schema-${index}`, category: 'tools', label: tool.name || `工具 ${index + 1}`,
        tool: tool.name, content: asText(tool), estimatedTokens: estimateTokens(asText(tool)), source: { type: 'tool-schema', name: tool.name } }))
    }
    if (event.type === 'request/context') { capacity = data.contextWindow || capacity; config = { ...config, model: data.model || config.model, provider: data.provider || config.provider } }
    if (event.type === 'step/start') startedAt = at
    if (event.type === 'system/message') append(event, 'system', data.message)
    if (event.type === 'user/message' || event.type === 'developer/message') {
      const message = data.message || data
      const injected = event.type === 'developer/message' || message.source?.kind
      append(event, message.source?.kind === 'skill-invocation' ? 'skill' : injected ? 'inject' : 'user', message,
        { label: message.source?.name || message.source?.kind || '用户消息' })
    }
    if (event.type === 'tool/call') {
      calls.set(data.callId, { tool: data.name, arguments: data.arguments, startedAt: at })
      request.onEvent('tool.started', { callId: data.callId, tool: data.name, arguments: data.arguments, startedAt: at })
    }
    if (event.type === 'tool/result') {
      const message = data.message || data
      const callId = message.source?.callId || data.callId
      const call = calls.get(callId) || {}
      append(event, call.tool === 'skill' ? 'skill' : 'tool', message, { label: call.tool || '工具结果', ...call, isError: message.isError })
      request.onEvent('tool.completed', { ...call, callId, text: contentOf(message).slice(0, 60000), isError: message.isError,
        durationMs: call.startedAt ? Math.max(0, Date.parse(at) - Date.parse(call.startedAt)) : undefined, finishedAt: at })
      calls.delete(callId)
    }
    if (event.type === 'assistant/message' && !event.surfaceOp) {
      const message = data.message || data
      const items = [...tools, ...surface.values()]
      const context = store.addContext({ ...parent, id: undefined, kind: 'runtime', parentContextId: parent.id,
        at: startedAt || at, finishedAt: at, stage: parent.stage, runtimeStep: data.step, runtimeTurn: data.turn,
        effectiveConfig: { model: config.model, provider: config.provider, effort: config.reasoningEffort, readOnly: request.readOnly },
        engine: 'dsh', contextWindow: capacity, approximate, threadId: event.threadId,
        items, estimatedTokens: items.reduce((sum, item) => sum + item.estimatedTokens, 0), reportedUsage: data.usage,
        response: contentOf(message), status: 'completed', sourceCoverage: 'DSH 会话事件重建的模型请求输入。分类 Token 按文本估算。' })
      request.onEvent('context.created', { contextId: context.id, stage: parent.stage, runtime: true,
        ...(capacity && data.usage ? { usage: data.usage, contextWindow: capacity } : {}) })
    }
    if (event.type === 'assistant/message') append(event, 'assistant', data.message || data,
      { label: '助手回复', kinds: ((data.message || data).content || []).map(block => block.type) })
    if (/^compaction\//.test(event.type)) {
      for (const seq of data.shadowedSeqs || []) surface.delete(seq)
      if (event.type === 'compaction/summary' && data.summary) append(event, 'inject', { content: data.summary }, { label: '压缩摘要' })
      if (event.type === 'compaction/prune' && !data.shadowedSeqs) approximate = true
      request.onEvent('context.changed', { kind: event.type.includes('prune') ? 'prune' : 'compact', tokens: data.shadowedTokenCount, at })
    }
    if (event.type === 'plan/mode') request.onEvent('context.changed', { kind: 'mode', text: data.active ? '进入计划模式' : '退出计划模式', at })
  }
}

function parseArguments(value) {
  if (typeof value !== 'string') return value || {}
  try { return JSON.parse(value) } catch { return { command: value } }
}

function toolRecord(event) {
  if (['reasoning', 'userMessage', 'agentMessage', 'assistantMessage', 'subAgentActivity', 'plan'].includes(event.tool)) return undefined
  let item
  try { item = event.item || JSON.parse(event.text) } catch { item = {} }
  if (!item || typeof item !== 'object') item = {}
  const args = parseArguments(event.arguments || item.arguments)
  const tool = event.tool || item.type || 'tool'
  const command = item.command || args.command || args.cmd || args.code
  const text = event.tool === 'commandExecution' ? item.aggregatedOutput || '' : event.text || ''
  const exitCode = item.exitCode ?? args.exitCode
  const isError = event.isError === true || (typeof exitCode === 'number' && exitCode !== 0) || item.status === 'failed'
  const files = []
  const kind = /image/i.test(tool) ? 'image' : /edit|write|fileChange|patch/i.test(tool) ? 'write' : /grep|search|glob/i.test(tool) ? 'search' : /read|file|image/i.test(tool) ? 'read' : undefined
  const path = args.file_path || args.path || args.file || item.path
  if (kind && typeof path === 'string') files.push({ path, kind })
  for (const change of item.changes || []) {
    if (change.path) files.push({ path: change.path, kind: 'write', diff: change.diff,
      added: change.diff?.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length,
      removed: change.diff?.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length })
  }
  for (const action of item.commandActions || []) {
    if (action.path && ['read', 'search'].includes(action.type)) files.push({ path: action.path, kind: action.type })
  }
  return { id: event.eventId, contextId: event.contextId, operationId: event.operationId, agentId: event.agentId, runId: event.runId,
    tool, arguments: args, text, at: event.at, durationMs: event.durationMs ?? item.durationMs,
    status: event.type === 'tool.started' ? 'running' : isError ? 'error' : 'ok', exitCode, files,
    command: typeof command === 'string' && /bash|shell|exec|command|run_code/i.test(tool) ? command : undefined,
    cwd: args.cwd || args.workdir || item.cwd }
}

/** Bounded summaries travel separately from full request bodies. */
export function contextInsights(store, scene, { agent = '', detail, before } = {}) {
  if (detail) {
    const context = store.context(detail, scene.id)
    if (!context || (agent && context.agentId !== agent)) return undefined
    const events = store.contextEvents(scene.id, context.operationId)
    return { context: { ...context, items: context.items.map(promptItem) },
      tools: events.filter(event => event.type === 'tool.completed').map(toolRecord).filter(Boolean) }
  }
  const rows = store.contexts(scene.id, agent, before, 601)
  const hasOlder = rows.length > 600
  const contexts = rows.slice(0, 600)
  const nativeOperations = new Set(contexts.filter(item => item.kind === 'runtime').map(item => item.operationId))
  const requests = contexts.filter(item => item.kind === 'runtime' || !nativeOperations.has(item.operationId)).map(context => {
    const totals = {}
    for (const item of context.items) {
      const category = CATEGORY_MAP[item.category] || item.category
      totals[category] = (totals[category] || 0) + item.estimatedTokens
    }
    const { items, response, ...summary } = context
    return { ...summary, totals, itemCount: items.length,
      skillNames: items.filter(item => item.category === 'skill').map(item => item.label),
      usage: normalizedUsage(context.reportedUsage, context.engine || scene.agents.find(agent => agent.id === context.agentId)?.engine),
      durationMs: context.finishedAt ? Math.max(0, Date.parse(context.finishedAt) - Date.parse(context.at)) : undefined }
  })
  const operations = new Set(contexts.map(context => context.operationId))
  const events = store.contextEvents(scene.id).filter(event => (!agent || event.agentId === agent) && (!event.operationId || operations.has(event.operationId)))
  const toolKey = event => `${event.operationId}/${event.callId || event.eventId}`
  const startedTools = new Map(events.filter(event => event.type === 'tool.started').map(event => [toolKey(event), event]))
  const completedKeys = new Set(events.filter(event => event.type === 'tool.completed').map(toolKey))
  const toolEvents = events.filter(event => event.type === 'tool.completed'
    || (event.type === 'tool.started' && !completedKeys.has(toolKey(event))))
  const tools = toolEvents.slice(-2000).map(event => {
    const tool = toolRecord(event)
    if (!tool) return undefined
    const start = startedTools.get(toolKey(event))
    if (start && tool.durationMs === undefined) tool.durationMs = Math.max(0, Date.parse(event.at) - Date.parse(start.at))
    return tool
  }).filter(Boolean)
  for (const tool of tools) {
    const related = requests.filter(request => request.operationId === tool.operationId).slice().reverse()
    tool.contextId = (related.find(request => request.finishedAt && Date.parse(request.finishedAt) >= Date.parse(tool.at)) || related.at(-1))?.id
  }
  const files = new Map()
  for (const tool of tools) {
    if (tool.status === 'running') continue
    for (const operation of tool.files) {
      const entry = files.get(operation.path) || { path: operation.path, kinds: [], operations: [], added: 0, removed: 0 }
      if (!entry.kinds.includes(operation.kind)) entry.kinds.push(operation.kind)
      entry.operations.push({ ...operation, toolId: tool.id, contextId: tool.contextId, tool: tool.tool, agentId: tool.agentId, at: tool.at, status: tool.status })
      entry.added += operation.added || 0
      entry.removed += operation.removed || 0
      files.set(operation.path, entry)
    }
  }
  const contextEvents = events.filter(event => ['context.created', 'context.changed', 'thread.started', 'handoff.sent', 'usage.updated'].includes(event.type))
    .map(event => ({ ...event,
      contextId: requests.find(request => request.id === event.contextId)?.id || requests.find(request => request.operationId === event.operationId)?.id,
      kind: event.type === 'context.created' ? event.runtime ? 'request' : 'inject' : event.type === 'thread.started' ? 'switch' : event.type === 'handoff.sent' ? 'handoff' : event.kind || 'usage' }))
  const runs = store.runs(scene.id, 600)
  return { requests, hasOlder, before: contexts.at(-1)?.seq, tools: tools.map(({ text, arguments: args, ...tool }) => ({ ...tool, preview: text.slice(0, 180) })),
    files: [...files.values()].slice(0, 400), events: contextEvents.slice(-400),
    runs: runs.map(({ id, text, createdAt, state, mode }) => ({ id, text: text.slice(0, 600), createdAt, state, mode })),
    bounds: { requests: 600, tools: 2000, events: 400, files: 400 },
    toolsTruncated: events.length === 4000 }
}
