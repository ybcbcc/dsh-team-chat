import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join, relative, isAbsolute, dirname } from 'node:path'
import { ScenarioStore, canonicalSessionId, conflict, MEMORY_KINDS, redactMemoryText } from './scenario-store.js'
import { RunCoordinator } from './coordinator.js'
import { contextInsights, createRuntimeCapture } from './context-insights.js'
import { createMemoryCompiler } from './memory-compiler.js'
import { matchMember, normalizeRoutingPolicy, routeMember, taskCapability } from './model-routing.js'

const READ_TOOLS = new Set([
  'read', 'read_image', 'read_file', 'read_files', 'glob', 'grep', 'ls', 'list_files', 'list_directory',
  'search', 'search_files', 'skill', 'web_search', 'web_fetch', 'list_agents', 'list_subagent_models',
  'search_sessions', 'read_session', 'get_session', 'list_sessions', 'get_working_directory',
  'memory_list', 'memory_get', 'memory_write',
])
const MEMORY_STATES = new Set(['candidate', 'confirmed', 'conflict', 'expired', 'archived', 'deleted'])
const COLLABORATION_EVENTS = ['message.added', 'handoff.queued', 'handoff.sent', 'owner.inbox.queued', 'owner.inbox.processing',
  'owner.inbox.processed', 'owner.decision', 'agent.started', 'agent.completed', 'agent.failed',
  'thread.started', 'user.question', 'user.answer', 'user.answered', 'run.interrupted', 'run.finished']

function fail(message, status = 400) {
  const error = new Error(message)
  error.status = status
  throw error
}

function textBlocks(content) {
  return Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : ''
}

export function createWorkbenchHost({ ctx, createChannel, resolveLauncher, defaultCwd, readJsonBody, writeJson, availableModels, storeUpload, log, dataHome }) {
  const home = dataHome || join(homedir(), '.dsh')
  const store = new ScenarioStore(join(home, 'codex-chat'))
  store.migrate(home)
  store.normalizeBindings()
  store.migrateScenarioSessions()
  store.migrateMemoryHistory()
  const listeners = new Map()
  const children = new Map()
  const channels = new Set()
  const parentHandles = new Map()
  const sockets = new Set()
  const optional = {}
  const sessionCreations = new Map()
  const runCatalogs = new WeakMap()
  const backendNames = new Set(['spawn', 'fork', 'codex', 'claude-code', 'claude', 'acp', 'dsh-sdk'])
  let closed = false
  for (const name of ['llm', 'skills', 'loader', 'sessionController', 'workspaceController', 'workspaceRegistry']) {
    ctx.inject([name], inner => {
      optional[name] = inner[name]
      inner.effect(() => () => { delete optional[name] }, `codex-chat: optional ${name}`)
    })
  }
  ctx.on('subagent/provider-added', provider => { backendNames.add(provider.name) })
  const publish = event => {
    for (const send of listeners.get(event.scenarioId) || []) send(event)
  }
  const memoryCompiler = createMemoryCompiler({ store, publish, complete: completeMemory })
  const coordinator = new RunCoordinator({ store, publish, runAgent, loadSkills, prepareTeam, routeTask, memoryCompiler,
    closeAgents: async () => {
      for (const channel of channels) channel.close()
      const disposing = [...children.values()].map(child => child.activation?.dispose()).filter(Boolean)
      await Promise.allSettled(disposing)
      await Promise.allSettled([...parentHandles.values()].map(handle => handle.then(value => value.dispose())))
      parentHandles.clear()
    },
  })

  ctx.on('tools/pre-execute', async (execution, next) => {
    const child = children.get(String(execution.agent?.session?.id))
    if (child?.memoryOnly) return { kind: 'deny', reason: '记忆整理只使用宿主交付的证据。' }
    if (child?.readOnly && (!READ_TOOLS.has(execution.name) || (child.agent.permission === 'read-only' && execution.name === 'memory_write'))) {
      return { kind: 'deny', reason: '当前协作阶段进行资料读取与审查，修改与执行由团队的执行阶段处理。' }
    }
    if (child?.agent.engine === 'dsh' && child.agent.permission === 'approve' && !child.readOnly && !READ_TOOLS.has(execution.name)) {
      child.signal.throwIfAborted()
      const response = await child.onQuestion({ kind: 'approval', details: JSON.stringify({ tool: execution.name, arguments: execution.arguments }, null, 2),
        questions: [{ id: 'approval', header: '工具审批', question: '是否允许本次工具操作？', options: [{ label: '允许本次' }, { label: '拒绝' }] }] })
      child.signal.throwIfAborted()
      if (response?.answers?.approval?.answers?.[0] !== '允许本次') return { kind: 'deny', reason: '用户拒绝了本次操作。' }
    }
    return next()
  })
  ctx.on('agent/created', ({ agent }) => {
    const child = children.get(String(agent.session.id))
    if (!child || child.memoryOnly) return
    agent.ctx.inject(['tools'], inner => {
      const output = { schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: value.text }] }
      const register = (name, description, properties, required, execute) => inner.tools.register({ name, description,
        parameters: { type: 'object', additionalProperties: false, properties, required }, output,
        async execute(args) { return { text: JSON.stringify(execute(args)) } } })
      const inScope = memory => memory.enabled
        && (memory.audience !== 'role' || memory.roleId === (child.agent.roleId || child.agent.id))
      const visibleMemory = memory => inScope(memory) && memory.status === 'confirmed'
      register('memory_list', '检索场景共享记忆与当前角色专属记忆，返回内容、状态及来源。',
        { query: { type: 'string' } }, [], args => store.memories(child.run.scenarioId)
          .filter(memory => visibleMemory(memory)
            && (!args.query || `${memory.title} ${memory.content}`.includes(args.query))))
      register('memory_get', '读取当前场景的一条记忆全文与版本。', { id: { type: 'string' } }, ['id'], args => {
        const memory = store.memory(args.id)
        if (!memory || memory.scenarioId !== child.run.scenarioId || !visibleMemory(memory)) fail('这条记忆当前未参与本角色检索')
        return memory
      })
      register('memory_write', '将可复用发现保存到当前场景，保留来源并进入待核实状态。更新条目时携带读取到的 revision。',
        { id: { type: 'string' }, revision: { type: 'integer' }, title: { type: 'string' }, content: { type: 'string' },
          detail: { type: 'string' }, kind: { type: 'string', enum: [...MEMORY_KINDS] }, audience: { type: 'string', enum: ['scene', 'role'] } }, ['title'], args => {
          const prior = args.id ? store.memory(args.id) : undefined
          if (args.id && (!prior || prior.scenarioId !== child.run.scenarioId || !inScope(prior))) fail('当前角色无法更新这条记忆')
          if (prior && ['deleted', 'archived', 'expired'].includes(prior.status)) fail('这条记忆已停用，请在记忆页恢复后更新')
          const data = memoryInput({ ...args, content: args.content || args.detail || prior?.content })
          if (prior?.status === 'candidate' && !Number.isInteger(args.revision)) fail('更新记忆需要携带当前 revision')
          const memory = store.saveMemory({ ...(prior?.status === 'candidate' ? prior : {}), ...data,
            scenarioId: child.run.scenarioId, audience: prior?.audience || args.audience || 'role',
            roleId: (prior?.audience || args.audience || 'role') === 'role' ? (child.agent.roleId || child.agent.id) : '',
            status: prior && prior.status !== 'candidate' ? 'conflict' : 'candidate',
            conflictsWith: prior && prior.status !== 'candidate' ? [prior.id] : [],
            sources: [...(prior?.sources || []), { type: 'agent', agentId: child.agent.id, runId: child.run.id }] },
          prior?.status === 'candidate' ? args.revision : undefined,
          { trigger: 'agent-tool', sessionId: child.run.sessionId, runId: child.run.id, actor: child.agent.name })
          publish(store.event(child.run.scenarioId, child.run.id, 'memory.changed', { memory }))
          return memory
        })
    })
  })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const child = children.get(String(agent.session.id))
    if (!child || frame.type !== 'chunk') return
    if (frame.chunk?.type === 'text-delta') child.onDelta(frame.chunk.text)
    if (frame.chunk?.type === 'usage') child.onEvent('usage.updated', { usage: frame.chunk.usage })
  })
  ctx.on('session/event', (session, event) => {
    const child = children.get(String(session.id))
    if (!child) return
    try {
      child.capture?.({ ...event, threadId: String(session.id) })
    } catch (error) { log(`workbench session event: ${error.message}`) }
  })

  function findParent(sessionId) {
    if (!sessionId) return undefined
    return ctx.agents.list().find(agent => canonicalSessionId(agent.session.id) === canonicalSessionId(sessionId))
      || ctx.agents.get(sessionId) || ctx.agents.get(`session-${sessionId}`)
  }

  async function ensureParent(sessionId, signal) {
    const live = findParent(sessionId)
    if (live) return live
    if (!sessionId) fail('请在场景设置中绑定一个 DSH Session，随后使用 DeepSeek 成员')
    let pending = parentHandles.get(sessionId)
    if (!pending) {
      pending = (async () => {
        let failure
        for (const candidate of [...new Set([sessionId, sessionId.replace(/^session-/, '')])]) {
          signal.throwIfAborted()
          try { return await ctx.agents.resume({ resumeSessionId: candidate, signal }) }
          catch (error) { failure = error }
        }
        throw failure
      })()
      parentHandles.set(sessionId, pending)
      pending.catch(() => { if (parentHandles.get(sessionId) === pending) parentHandles.delete(sessionId) })
    }
    const handle = await pending
    return handle.agent
  }

  async function loadSkills(agent, scene, signal) {
    const names = Array.isArray(agent.skills) ? agent.skills : []
    if (!names.length) return []
    const skills = []
    for (const name of names) {
      const custom = (scene.customSkills || []).find(skill => `custom:${skill.id}` === name)
      if (custom) { skills.push({ name: custom.name, content: custom.content }); continue }
      if (!optional.skills) fail('技能服务当前不可用，请移除技能配置或启用 DSH 技能服务')
      const skill = await optional.skills.get(name, { cwd: scene.cwd, signal })
      if (!skill) fail(`技能 ${name} 当前无法加载`)
      skills.push({ name: skill.name, content: skill.content, path: skill.path })
    }
    return skills
  }

  function routingCatalog(run) {
    let pending = runCatalogs.get(run)
    if (!pending) {
      pending = catalog(run.scene, false, false)
      runCatalogs.set(run, pending)
      pending.catch(() => { runCatalogs.delete(run) })
    }
    return pending
  }

  async function routeTask(run, agent, task, signal) {
    signal.throwIfAborted()
    if (task.access === 'write' && agent.permission === 'read-only') {
      fail(`成员 ${agent.name} 是只读成员，请将修改步骤分给有写入权限的成员`)
    }
    if (run.scene.teamStrategy !== 'auto') return agent
    const requiresImage = run.attachments?.some(item => item.kind === 'image')
    return routeMember(agent, { ...task, requiresImage }, await routingCatalog(run), run.scene.routingPolicy)
  }

  async function prepareTeam(run, requested, signal) {
    signal.throwIfAborted()
    const scene = sceneFor(run.scenarioId)
    if (run.scene.teamStrategy !== 'auto') return { agents: run.agents, ownerId: run.ownerId, scene: run.scene }
    const requiresImage = run.attachments?.some(item => item.kind === 'image')
    const aliases = Object.create(null)
    const known = [...scene.agents]
    const owner = known.find(agent => agent.id === (run.ownerId || scene.ownerId))
      || known.find(agent => agent.capability === 'owner')
      || known.find(agent => agent.engine === 'codex')
      || known[0]
    if (!owner) fail('场景里没有可作为 Owner 的模型接入')
    const agents = [...run.agents]
    const add = agent => {
      if (!agents.some(item => item.id === agent.id)) agents.push(agent)
    }
    add(owner)
    const added = []
    for (const member of requested || []) {
      if (!member || typeof member.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(member.id)) fail('Owner 给出的成员标识无效')
      const existing = matchMember(known, member, owner.id)
      if (existing) {
        aliases[member.id] = existing.id
        add(existing)
        continue
      }
      if (added.length === 2) fail('每次分工最多补充两位成员，请优先复用场景成员')
      if (known.length >= 64) fail('场景成员数已达到存储上限，请复用已配置的成员')
      const name = String(member.name || '').trim().slice(0, 80)
      const role = String(member.role || '').trim().slice(0, 1000)
      const capability = taskCapability(member.capability || name || role)
      if (!name || !role || !capability || capability === 'owner') fail('新成员需要名称、具体职责和可识别的能力')
      const id = `agent-${randomUUID()}`
      const models = await routingCatalog(run)
      const policy = normalizeRoutingPolicy(scene.routingPolicy)
      const preferredDsh = (models.dsh || []).find(model =>
        (model.id === policy.deepseekModel || (policy.deepseekModel === '1017' && /deepseek/i.test(model.label || model.id)
          && /1017/.test(`${model.id} ${model.label}`))) && (!policy.deepseekProvider || model.provider === policy.deepseekProvider))
      const engine = capability === 'writing' && preferredDsh && run.dshSessionId && !requiresImage
        ? 'dsh' : 'codex'
      const candidate = { id, roleId: id, name, role, capability, engine, agentProvider: '', permission: 'default',
        model: engine === 'dsh' ? preferredDsh.id : '', provider: engine === 'dsh' ? preferredDsh.provider : '',
        effort: '', variants: [], skills: [], autoAdded: true }
      const { routingReason, ...resolved } = routeMember(candidate, { capability, difficulty: 'medium', requiresImage }, models, scene.routingPolicy)
      known.push(resolved)
      added.push(resolved)
      add(resolved)
      aliases[member.id] = id
    }
    signal.throwIfAborted()
    const updated = added.length || !scene.ownerId
      ? store.transaction(() => {
        const current = sceneFor(scene.id)
        const byId = new Map(current.agents.map(agent => [agent.id, agent]))
        for (const entry of added) {
          const existing = matchMember([...byId.values()], entry, owner.id)
          if (existing) {
            for (const key of Object.keys(aliases)) if (aliases[key] === entry.id) aliases[key] = existing.id
            const index = agents.findIndex(agent => agent.id === entry.id)
            if (index !== -1) agents.splice(index, 1)
            add(existing)
          } else byId.set(entry.id, entry)
        }
        return store.saveScenario({ ...current, ownerId: current.ownerId || owner.id, agents: [...byId.values()] }, current.revision)
      }) : scene
    if (updated !== scene) publish(store.event(scene.id, run.id, 'scenario.updated', { scene: updated }))
    if (owner.engine !== 'agent' && !requested.length) {
      const routed = routeMember(owner, { capability: 'owner', difficulty: 'medium', requiresImage }, await routingCatalog(run), run.scene.routingPolicy)
      agents[agents.findIndex(agent => agent.id === owner.id)] = routed
    }
    return { agents, ownerId: owner.id, scene: { ...run.scene, ownerId: owner.id, agents: updated.agents, revision: updated.revision }, aliases }
  }

  async function completeMemory({ run, agent, prompt, signal }) {
    return runAgent({ run: { ...run, attachments: [] }, agent, stage: '整理场景记忆', prompt, signal,
      readOnly: true, memoryOnly: true, onDelta() {}, onEvent() {},
      onQuestion() { throw new Error('记忆整理不能请求审批或额外操作') } })
  }

  async function runAgent(request) {
    request.signal.throwIfAborted()
    if (request.agent.engine === 'dsh') return runDsh(request)
    if (request.agent.engine === 'agent') return runDsh(request, request.agent.agentProvider)
    const models = await availableModels()
    const model = request.agent.model ? models.find(item => item.id === request.agent.model) : models.find(item => item.isDefault)
    if (request.agent.effort && model?.efforts?.length && !model.efforts.includes(request.agent.effort)) {
      fail('所选 Codex 模型不支持这个思考强度，请调整对应扩展成员')
    }
    const options = { effort: request.agent.effort, fast: request.agent.fast === true, readOnly: request.readOnly, permission: request.agent.permission || 'default', turnTimeoutMs: 0 }
    const channel = createChannel(resolveLauncher(process.env.DSH_CODEX_BIN), request.run.scene.cwd,
      request.agent.model || process.env.DSH_CODEX_MODEL || undefined,
      { onDelta: request.onDelta, onQuestion: request.onQuestion,
        onEvent: (method, params) => {
          if (method === 'thread/tokenUsage/updated') {
            request.onEvent('usage.updated', { usage: params.tokenUsage?.last || params.tokenUsage,
              contextWindow: params.tokenUsage?.modelContextWindow })
          } else if (['item/started', 'item/completed'].includes(method) && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabToolCall', 'imageView'].includes(params.item?.type)) {
            const item = params.item || {}
            request.onEvent(method === 'item/started' ? 'tool.started' : 'tool.completed', {
              callId: item.id, tool: item.type || method, item, text: JSON.stringify(item).slice(0, 60000) })
          } else if (/compact/.test(method)) request.onEvent('context.changed', { kind: method })
        },
      }, options)
    channels.add(channel)
    const stop = () => channel.close(request.signal.reason?.message || '任务已停止')
    request.signal.addEventListener('abort', stop, { once: true })
    try {
      await channel.start(request.signal)
      request.onEvent('thread.started', { threadId: channel.threadId, model: channel.model, effort: channel.effort || options.effort, permission: options.permission, readOnly: request.readOnly })
      return await channel.send(request.prompt, request.signal, request.run.attachments)
    } finally {
      request.signal.removeEventListener('abort', stop)
      channel.close()
      channels.delete(channel)
    }
  }

  async function runDsh(request, providerName = 'spawn') {
    const backend = ctx.subagents.getProvider?.(providerName)
    if (request.agent.engine === 'agent' && !backend) fail(`Agent 接入 ${providerName} 当前不可用，请在 DSH 启用后刷新`)
    const parent = await ensureParent(request.run.dshSessionId || request.run.scene.dshSessionId, request.signal)
    const childId = randomUUID()
    const agentOptions = {}
    const canSelectModel = request.agent.engine === 'dsh' || backend?.capabilities.agentOptions
    if (canSelectModel) {
      if (request.agent.provider) agentOptions.provider = request.agent.provider
      if (request.agent.model) agentOptions.model = request.agent.model
      if (request.agent.effort) agentOptions.reasoningEffort = request.agent.effort
    } else if (request.agent.model || request.agent.provider || request.agent.effort) {
      fail('这个 Agent 的模型与思考强度由其 DSH 接入配置管理，请清除成员中的覆盖设置')
    }
    const llm = optional.llm
    const provider = agentOptions.provider || backend?.agentRouteDefaults?.provider || parent.options?.provider
    const model = agentOptions.model || backend?.agentRouteDefaults?.model || parent.options?.model
    if (canSelectModel && llm && provider && model && (request.agent.engine === 'dsh' || request.agent.provider || request.agent.model || request.agent.effort)) {
      const info = await llm.resolveModelInfo(provider, model, request.signal)
      const efforts = info.reasoning?.efforts?.map(effort => effort.id) || []
      if (agentOptions.reasoningEffort && !efforts.includes(agentOptions.reasoningEffort)) fail('所选模型不支持这个思考强度，请重新选择')
    }
    const child = { ...request, activation: undefined }
    if (request.contextId) child.capture = createRuntimeCapture({ store, request })
    children.set(childId, child)
    let activation
    const stop = () => { if (activation) void activation.dispose().catch(error => log(`cancel child: ${error.message}`)) }
    request.signal.addEventListener('abort', stop, { once: true })
    try {
      activation = await ctx.subagents.startActivation({ provider: providerName, childId, label: `${request.agent.name} · ${request.run.text.slice(0, 30)}`,
        cwd: request.run.scene.cwd, prompt: [{ type: 'text', text: request.prompt }], parent,
        ...(Object.keys(agentOptions).length ? { agentOptions } : {}), signal: request.signal, delivery: 'caller' })
      child.activation = activation
      request.onEvent('thread.started', { threadId: String(activation.childId || childId),
        model: canSelectModel ? model : undefined, provider: canSelectModel ? provider : undefined,
        effort: canSelectModel ? agentOptions.reasoningEffort || parent.options?.reasoningEffort : undefined,
        agentProvider: providerName, permissionSource: request.agent.engine === 'agent' ? 'provider-config' : 'tool-filter', permission: request.agent.permission || 'default', readOnly: request.readOnly })
      if (request.signal.aborted) stop()
      const result = await activation.result
      return { answer: result.structured ? JSON.stringify(result.structured) : textBlocks(result.output), status: result.stopReason, diagnostic: result.diagnostic }
    } finally {
      request.signal.removeEventListener('abort', stop)
      children.delete(childId)
      if (activation) await activation.dispose()
    }
  }

  function sceneFor(id) {
    if (!id) fail('缺少场景编号')
    const scene = store.scenario(id)
    if (!scene) fail('场景不存在', 404)
    return scene
  }

  function stateOf(id, before, sessionId = '') {
    const scene = sceneFor(id)
    id = scene.id
    const messages = store.messages(id, before, 80, sessionId)
    const runs = store.runs(id, 30, sessionId)
    return { scene, messages, runs, events: runs.length ? store.runEvents(runs[0].id) : [], sequence: store.lastSequence(id),
      sessionId, hasOlder: messages.length === 80, memoryCount: store.memories(id).filter(entry => entry.status !== 'deleted').length }
  }

  function sceneSession(scene, sessionId, historical = false) {
    const id = sessionId || scene.sessions.at(-1)?.id || `local-${scene.id}`
    if (typeof id !== 'string') fail('会话编号格式错误')
    if (id === `local-${scene.id}` || scene.sessions.some(session => session.id === id)) return id
    if (historical && (store.runs(scene.id, 1, id).length || store.messages(scene.id, undefined, 1, id).length)) return id
    fail('当前会话未关联这个场景', 404)
  }

  function collaboration(scene, search) {
    const sessionId = sceneSession(scene, search.get('session'), true)
    const runId = search.get('run') || ''
    const member = search.get('member') || ''
    if (member.length > 200) fail('成员编号格式错误')
    if (runId) {
      const run = store.run(runId)
      if (!run || run.scenarioId !== scene.id || run.sessionId !== sessionId) fail('当前会话没有该任务', 404)
    }
    const after = Math.max(0, Number(search.get('after')) || 0)
    const before = Math.min(Number.MAX_SAFE_INTEGER, Number(search.get('before')) || Number.MAX_SAFE_INTEGER)
    const following = search.has('after')
    const limit = 100
    const types = member ? ['handoff.sent'] : COLLABORATION_EVENTS
    const placeholders = types.map(() => '?').join(',')
    const memberFilter = member ? `AND (json_extract(data, '$.fromAgentId') = ? OR json_extract(data, '$.toAgentId') = ?)` : ''
    const rows = store.db.prepare(`SELECT seq, data FROM events WHERE scenario_id = ? AND seq > ? AND seq < ?
      AND (? = '' OR run_id = ?) AND json_extract(data, '$.sessionId') = ?
      AND type IN (${placeholders}) ${memberFilter} ORDER BY seq ${following ? 'ASC' : 'DESC'} LIMIT ?`)
      .all(scene.id, after, before, runId, runId, sessionId, ...types, ...(member ? [member, member] : []), limit + 1)
    const hasExtra = rows.length > limit
    const page = rows.slice(0, limit)
    if (!following) page.reverse()
    const events = page.map(row => ({ ...JSON.parse(row.data), sequence: row.seq }))
    const participants = new Map(scene.agents.map(agent => [agent.id, agent]))
    for (const id of new Set(events.map(event => event.runId).filter(Boolean))) {
      for (const agent of store.run(id)?.agents || []) {
        if (!participants.has(agent.id)) participants.set(agent.id, agent)
      }
    }
    return { events, participants: [...participants.values()].map(({ id, name, model, effort, engine }) => ({ id, name, model, effort, engine })),
      hasOlder: !following && hasExtra, hasMore: following && hasExtra }
  }

  function memoryOrigin(scene, body, trigger = 'manual') {
    const target = body.sessionId || body.runId || body.messageId
      ? store.memorySource(scene.id, { sessionId: body.sessionId, runId: body.runId, messageId: body.messageId }) : undefined
    if (body.sessionId && !target && !scene.sessions.some(session => session.id === body.sessionId) && body.sessionId !== `local-${scene.id}`) {
      fail('记忆来源会话不属于当前场景')
    }
    if ((body.runId && !target?.runAvailable) || (body.messageId && !target?.messageAvailable)) fail('记忆来源无法在该场景中定位')
    return { trigger, actor: 'user', sessionId: target?.sessionId || body.sessionId,
      runId: target?.runId, messageId: target?.messageId, reason: String(body.reason || '').slice(0, 500) }
  }

  function checkCwd(value) {
    const cwd = typeof value === 'string' && value.trim() ? value.trim() : defaultCwd()
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) fail('工作目录不存在')
    return realpathSync(cwd)
  }

  function validateScene(scene, patch) {
    const next = { ...scene }
    for (const key of ['title', 'brief', 'ownerId', 'summarizerId']) {
      if (typeof patch[key] === 'string') next[key] = patch[key].trim().slice(0, key === 'brief' ? 20000 : 200)
    }
    if (patch.cwd !== undefined) next.cwd = checkCwd(patch.cwd)
    if (patch.dshSessionId !== undefined) {
      if (typeof patch.dshSessionId !== 'string') fail('DSH Session 编号格式错误')
      next.dshSessionId = canonicalSessionId(patch.dshSessionId)
    }
    if (patch.mode !== undefined) {
      if (!['confidence', 'orchestration'].includes(patch.mode)) fail('协作模式无效')
      next.mode = patch.mode
    }
    if (patch.teamStrategy !== undefined) {
      if (!['auto', 'manual'].includes(patch.teamStrategy)) fail('团队组建方式无效')
      next.teamStrategy = patch.teamStrategy
    }
    if (patch.inboxPolicy !== undefined) {
      if (!['arrival', 'batch', 'stage'].includes(patch.inboxPolicy)) fail('回报处理方式无效')
      next.inboxPolicy = patch.inboxPolicy
    }
    if (patch.routingPolicy !== undefined) next.routingPolicy = normalizeRoutingPolicy(patch.routingPolicy)
    if (patch.reviewRounds !== undefined) {
      if (!Number.isSafeInteger(patch.reviewRounds) || patch.reviewRounds < 0) fail('交叉验证轮数需为非负整数，0 表示持续验证')
      next.reviewRounds = patch.reviewRounds
    }
    if (patch.agents !== undefined) {
      if (!Array.isArray(patch.agents) || patch.agents.length < 1 || patch.agents.length > 64) fail('团队需要 1 至 64 位成员')
      const ids = new Set()
      next.agents = patch.agents.map(agent => {
        if (!agent || typeof agent.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(agent.id) || ids.has(agent.id)) fail('成员编号缺失或重复')
        ids.add(agent.id)
        if (!['codex', 'dsh', 'agent'].includes(agent.engine)) fail('成员接入方式无效')
        if (agent.engine === 'agent') {
          if (typeof agent.agentProvider !== 'string' || !agent.agentProvider.trim()) fail('请选择或填写已在 DSH 启用的 Agent 接入名称')
          const backend = ctx.subagents.getProvider?.(agent.agentProvider.trim())
          if (!backend) fail(`Agent 接入 ${agent.agentProvider.trim()} 当前不可用，请先在 DSH 启用`)
          if (!backend.capabilities.agentOptions && (agent.model || agent.provider || agent.effort || agent.variants?.length)) {
            fail('这个 Agent 的模型和强度由接入配置管理，不支持成员覆盖或扩展强度档位')
          }
        }
        const permissions = agent.engine === 'codex' ? ['default', 'read-only', 'approve', 'full'] : agent.engine === 'dsh' ? ['default', 'read-only', 'approve'] : ['default']
        if (!permissions.includes(agent.permission || 'default')) fail('当前接入不支持这个执行权限，请重新选择')
        if (typeof agent.name !== 'string' || !agent.name.trim()) fail('请填写成员名称')
        if (typeof agent.role !== 'string' || !agent.role.trim()) fail('请填写成员职责')
        const variants = Array.isArray(agent.variants) ? agent.variants : []
        const variantIds = new Set()
        for (const variant of variants) {
          if (!variant || typeof variant.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(variant.id) || variantIds.has(variant.id)) fail('扩展成员编号缺失或重复')
          variantIds.add(variant.id)
          if (!['simple', 'medium', 'hard'].includes(variant.difficulty)) fail('请选择扩展成员的任务难度')
        }
        const prior = scene.agents.find(item => item.id === agent.id)
        return { id: agent.id, roleId: prior?.roleId || agent.id,
          engine: agent.engine, agentProvider: agent.engine === 'agent' ? agent.agentProvider.trim().slice(0, 200) : '',
          name: agent.name.slice(0, 80), role: agent.role.slice(0, 4000),
          capability: taskCapability(agent.capability ?? prior?.capability), routeLocked: (agent.routeLocked ?? prior?.routeLocked) === true,
          autoAdded: prior?.autoAdded === true,
          roleSummary: String(agent.roleSummary || '').slice(0, 120), showRoleSummary: agent.showRoleSummary === true,
          model: String(agent.model || '').slice(0, 200), provider: String(agent.provider || '').slice(0, 200),
          effort: String(agent.effort || '').slice(0, 80), fast: agent.fast === true, permission: agent.permission || 'default',
          variants: variants.map(variant => ({ id: variant.id, name: String(variant.name || '扩展成员').slice(0, 80),
            effort: String(variant.effort || '').slice(0, 80), difficulty: variant.difficulty })),
          skills: Array.isArray(agent.skills) ? [...new Set(agent.skills.filter(name => typeof name === 'string').map(name => name.slice(0, 200)))].slice(0, 20) : [] }
      })
    }
    if (patch.customSkills !== undefined) {
      if (!Array.isArray(patch.customSkills)) fail('自定义技能格式无效')
      const ids = new Set()
      next.customSkills = patch.customSkills.map(skill => {
        if (!skill || typeof skill.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(skill.id) || ids.has(skill.id)) fail('技能编号缺失或重复')
        ids.add(skill.id)
        if (typeof skill.name !== 'string' || !skill.name.trim() || typeof skill.content !== 'string' || !skill.content.trim()) fail('请填写技能名称和操作说明')
        return { id: skill.id, name: skill.name.trim().slice(0, 200), content: skill.content.slice(0, 30000), category: typeof skill.category === 'string' ? skill.category.trim().slice(0, 100) : '' }
      })
    }
    if (next.ownerId && !next.agents.some(agent => agent.id === next.ownerId)) next.ownerId = ''
    if (!next.agents.some(agent => agent.id === next.summarizerId)) next.summarizerId = next.agents[0].id
    return next
  }

  async function catalog(scene, refresh = false, includeSkills = true) {
    const result = { codex: [], dsh: [], skills: [], agentBackends: registeredBackends(scene), errors: [],
      permissionModes: { codex: ['default', 'read-only', 'approve', 'full'], dsh: ['default', 'read-only', 'approve'], agent: ['default'] } }
    const jobs = [
      availableModels({ refresh }).then(models => { result.codex = models }),
      (async () => {
        if (!optional.llm) return
        for (const provider of optional.llm.listProviders()) {
          const models = await optional.llm.listModels(provider.id)
          for (const model of models) {
            const resolved = await optional.llm.resolveModelInfo(provider.id, model.id)
            result.dsh.push({ id: model.id, provider: provider.id, label: model.name || model.id,
              efforts: resolved.reasoning?.efforts?.map(effort => effort.id) || [] })
          }
        }
        const parent = findParent(scene.sessions?.at(-1)?.id || scene.dshSessionId)
        result.defaultDsh = result.dsh.find(model => model.id === parent?.options?.model && model.provider === parent?.options?.provider)
      })(),
      (async () => {
        if (includeSkills && optional.skills) result.skills = await optional.skills.list({ cwd: scene.cwd })
      })(),
    ]
    const outcomes = await Promise.allSettled(jobs)
    outcomes.forEach(outcome => { if (outcome.status === 'rejected') result.errors.push(outcome.reason.message) })
    if (!result.defaultDsh && result.dsh.length) {
      const efforts = result.dsh[0].efforts.filter(effort => result.dsh.every(model => model.efforts.includes(effort)))
      result.defaultDsh = { id: '', label: '跟随引擎默认模型', efforts }
    }
    result.skills.push(...(scene.customSkills || []).map(skill => ({ name: `custom:${skill.id}`, label: skill.name, custom: true })))
    return result
  }

  function registeredBackends(scene) {
    for (const agent of scene.agents) if (agent.agentProvider) backendNames.add(agent.agentProvider)
    for (const entry of optional.loader?.entries?.() || []) {
      const config = entry.options?.config
      for (const candidate of [config?.providerName, config?.provider]) if (typeof candidate === 'string') backendNames.add(candidate)
    }
    const labels = { codex: 'Codex · DSH 接入', 'claude-code': 'Claude Code', claude: 'Claude', acp: 'ACP Agent', 'dsh-sdk': 'DSH SDK Agent', spawn: 'DSH 独立 Agent', fork: 'DSH 继承会话 Agent' }
    return [...backendNames].map(name => {
      const backend = ctx.subagents.getProvider?.(name)
      return backend ? { id: name, label: labels[name] || name, supportsModelOptions: Boolean(backend.capabilities.agentOptions),
        inheritsParentContext: Boolean(backend.inheritsParentContext), routeDefaults: backend.agentRouteDefaults } : undefined
    }).filter(Boolean)
  }

  async function sceneWorkspace(scene) {
    if (!optional.workspaceController || !optional.workspaceRegistry) return undefined
    const result = await optional.workspaceController.create({ path: checkCwd(scene.cwd) })
    const workspace = optional.workspaceRegistry.get(result.workspace.workspaceId)
    if (!workspace) fail('DSH 工作区登记后暂不可用，请重试', 503)
    return workspace
  }

  async function prepareSession(scene, sessionId) {
    sessionId = canonicalSessionId(sessionId)
    const binding = scene.sessions.find(session => session.id === sessionId)
    if (!binding) fail('这个会话尚未绑定当前场景', 409)
    const list = optional.sessionController?.list
      ? await optional.sessionController.list({}, AbortSignal.timeout(10000)) : undefined
    const native = list?.items?.find(session => canonicalSessionId(session.sessionId) === sessionId)
    const parent = native ? undefined : findParent(sessionId)
    const nativeSessionId = native?.sessionId || String(parent?.session.id || sessionId)
    const nativeAvailable = native || parent ? true : Array.isArray(list?.items) ? false : undefined
    let workspace
    if (native?.cwd && existsSync(native.cwd) && checkCwd(native.cwd) === checkCwd(scene.cwd)) {
      workspace = await sceneWorkspace(scene)
      if (workspace) await workspace.attachSession(nativeSessionId)
    }
    return { sessionId, nativeSessionId, nativeAvailable, sessionTitle: native?.title || binding.title || '',
      workspace: workspace ? { id: workspace.id, title: workspace.title, path: workspace.path } : undefined }
  }

  async function createScenarioSession(scene, body) {
    if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(body.requestId)) fail('缺少本次创建会话的标识')
    const title = String(body.title || '新需求').trim()
    if (!title || title.length > 200 || /[\r\n\u0000-\u001f]/.test(title)) fail('请填写 1 至 200 字的单行会话名称')
    const key = `${scene.id}/${body.requestId}`
    if (sessionCreations.has(key)) return sessionCreations.get(key)
    const operation = (async () => {
      let receipt = store.sessionRequest(body.requestId)
      if (receipt && receipt.scenarioId !== scene.id) fail('创建标识属于另一个场景')
      if (!receipt) {
        if (!optional.sessionController?.create) fail('当前 DSH 未提供会话创建服务，请通过 DSH 左上角新建会话后绑定', 503)
        const workspace = await sceneWorkspace(scene)
        const created = await optional.sessionController.create(workspace ? { workspaceId: workspace.id } : { cwd: checkCwd(scene.cwd) })
        if (typeof created.sessionId !== 'string' || !created.sessionId) fail('DSH 未返回有效的新会话编号')
        receipt = { id: body.requestId, scenarioId: scene.id, nativeSessionId: created.sessionId, sessionId: canonicalSessionId(created.sessionId) }
        store.transaction(() => {
          store.saveSessionRequest(receipt)
          store.bindSession(scene.id, receipt.sessionId, title)
        })
      } else if (store.sessionScene(receipt.sessionId)?.id !== scene.id) {
        fail('该会话已解除绑定或改绑，请刷新会话列表', 409)
      }
      if (optional.sessionController?.rename) await optional.sessionController.rename({ sessionId: receipt.nativeSessionId || receipt.sessionId, title })
      const updated = store.bindSession(scene.id, receipt.sessionId, title)
      publish(store.event(scene.id, null, 'scenario.updated', { scene: updated }))
      return { ...stateOf(scene.id, undefined, receipt.sessionId), nativeSessionId: receipt.nativeSessionId || receipt.sessionId, sessionTitle: title }
    })()
    sessionCreations.set(key, operation)
    try { return await operation }
    finally { sessionCreations.delete(key) }
  }

  function validAttachments(scene, input) {
    if (input === undefined) return []
    if (!Array.isArray(input) || input.length > 10) fail('每轮最多附带十个文件')
    const directory = realpathSync(scene.cwd)
    return input.map(file => {
      if (!file || typeof file.path !== 'string' || !existsSync(file.path)) fail('附件已不存在，请重新上传')
      const absolute = realpathSync(file.path)
      const within = relative(directory, absolute)
      if (within.startsWith('..') || isAbsolute(within)) fail('附件需要位于当前场景工作区')
      return { name: String(file.name || '附件').slice(0, 200), path: absolute, kind: file.kind === 'image' ? 'image' : 'file' }
    })
  }

  function sse(req, res, scene, after) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    res.flushHeaders?.()
    let live = true
    const send = event => {
      if (!live) return
      res.write(`${event.sequence ? `id: ${event.sequence}\n` : ''}data: ${JSON.stringify(event)}\n\n`)
    }
    const subscriptions = listeners.get(scene.id) || new Set()
    listeners.set(scene.id, subscriptions)
    subscriptions.add(send)
    const backlog = store.events(scene.id, after, 1001)
    if (backlog.length > 1000) send({ type: 'reset', sequence: store.lastSequence(scene.id) })
    else backlog.forEach(send)
    send({ type: 'ready', sequence: store.lastSequence(scene.id) })
    const heartbeat = setInterval(() => { if (live) res.write(': ping\n\n') }, 25000)
    heartbeat.unref?.()
    const close = () => {
      if (!live) return
      live = false
      clearInterval(heartbeat)
      subscriptions.delete(send)
      if (!subscriptions.size) listeners.delete(scene.id)
      sockets.delete(close)
      res.end()
    }
    sockets.add(close)
    res.on('close', close)
  }

  async function handle(req, res, url) {
    const path = url.pathname.replace(/\/+$/, '')
    if (path.startsWith('/codex-chat/assets/')) {
      const name = path.slice('/codex-chat/assets/'.length)
      if (!['workbench.js', 'workbench-views.js', 'workbench.css', 'context-dashboard.js'].includes(name)) { writeJson(res, { ok: false, error: '资源不存在' }, 404); return true }
      const file = fileURLToPath(new URL(`./${name}`, import.meta.url))
      res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': 'no-store' })
      res.end(readFileSync(file))
      return true
    }
    if (!path.startsWith('/codex-chat/v2/')) return false
    try {
      if (closed) fail('插件正在关闭', 503)
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin)
        if (origin.host !== req.headers.host) fail('请求来源无效', 403)
      }
      const route = path.slice('/codex-chat/v2/'.length).split('/')
      if (route[0] === 'directories' && req.method === 'GET') {
        const directory = checkCwd(url.searchParams.get('path') || homedir())
        const directories = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
          .map(entry => ({ name: entry.name, path: join(directory, entry.name) })).sort((a, b) => a.name.localeCompare(b.name))
        const roots = process.platform === 'win32'
          ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:\\`).filter(path => existsSync(path)) : ['/']
        writeJson(res, { ok: true, path: directory, parent: dirname(directory), roots, directories })
        return true
      }
      if (route[0] === 'bootstrap' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const sessionId = canonicalSessionId(body.dshSessionId)
        const previous = sessionId ? store.sessionScene(sessionId) : undefined
        let scene
        if (body.scenarioId) {
          scene = sceneFor(body.scenarioId)
          if (body.bind && sessionId) scene = store.bindSession(scene.id, sessionId, String(body.sessionTitle || ''))
          else if (sessionId && store.sessionScene(sessionId)?.id !== scene.id) fail('请先将当前会话绑定到这个场景')
        } else if (body.create) {
          if (previous) store.assertNoActiveRun(previous.id, sessionId)
          scene = store.resolve('', checkCwd(body.cwd))
          if (body.sessionTitle) scene = store.saveScenario({ ...scene, title: String(body.sessionTitle).slice(0, 200) })
          if (sessionId) scene = store.bindSession(scene.id, sessionId, String(body.sessionTitle || ''))
        } else {
          scene = sessionId ? store.sessionScene(sessionId) : undefined
          if (!scene && body.interactive) {
            writeJson(res, { ok: true, requiresBinding: true, sessionId, scenes: store.scenes() })
            return true
          }
          if (!scene) scene = store.resolve(sessionId, checkCwd(body.cwd))
        }
        if (!scene.cwd) scene = store.saveScenario({ ...scene, cwd: checkCwd(body.cwd) })
        if ((body.bind || body.create) && sessionId) {
          if (previous && previous.id !== scene.id) publish(store.event(previous.id, null, 'scenario.updated', { scene: store.scenario(previous.id) }))
          publish(store.event(scene.id, null, 'scenario.updated', { scene }))
        }
        const activeSession = sessionId || scene.sessions.at(-1)?.id || `local-${scene.id}`
        writeJson(res, { ok: true, ...stateOf(scene.id, undefined, activeSession) })
        return true
      }
      if (route[0] === 'scenarios' && route.length === 1 && req.method === 'GET') {
        writeJson(res, { ok: true, scenes: store.scenes(), sessions: ctx.agents.list().map(agent => ({ id: String(agent.session.id), name: String(agent.id) })) })
        return true
      }
      if (route[0] === 'scenarios' && route[1]) {
        const scene = sceneFor(route[1])
        if (route.length === 2 && req.method === 'GET') {
          const anchor = url.searchParams.get('message')
          const sessionId = url.searchParams.get('session') || ''
          let before = Number(url.searchParams.get('before')) || undefined
          if (anchor) {
            const message = store.message(anchor)
            if (!message || message.scenarioId !== scene.id || message.sessionId !== sceneSession(scene, sessionId, true)) {
              fail('来源消息不在当前会话', 404)
            }
            before = message.seq + 25
          }
          writeJson(res, { ok: true, ...stateOf(scene.id, before, sessionId) })
          return true
        }
        if (route.length === 2 && req.method === 'PATCH') {
          const body = await readJsonBody(req)
          if (!Number.isInteger(body.revision)) fail('保存场景需要携带当前版本')
          const next = store.saveScenario(validateScene(scene, body), body.revision)
          coordinator.syncProfiles(next)
          const event = store.event(scene.id, null, 'scenario.updated', { scene: next })
          publish(event)
          writeJson(res, { ok: true, scene: next })
          return true
        }
        if (route.length === 2 && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          if (!Number.isInteger(body.revision)) fail('删除场景需要携带当前版本')
          store.deleteScenario(scene.id, body.revision)
          publish({ type: 'scenario.deleted', scenarioId: scene.id })
          writeJson(res, { ok: true, deletedScenarioId: scene.id })
          return true
        }
        if (route[2] === 'skill' && route.length === 3 && req.method === 'GET') {
          const name = url.searchParams.get('name')
          const custom = (scene.customSkills || []).find(skill => `custom:${skill.id}` === name)
          if (custom) writeJson(res, { ok: true, skill: custom })
          else {
            if (!optional.skills) fail('技能服务当前不可用')
            const skills = await optional.skills.list({ cwd: scene.cwd })
            if (!skills.some(skill => skill.name === name)) fail('此技能已不在当前工作区目录中，请刷新技能目录')
            const skill = await optional.skills.get(name, { cwd: scene.cwd })
            if (!skill) fail('技能原文当前无法加载')
            writeJson(res, { ok: true, skill: { name: skill.name, content: skill.content, path: skill.path } })
          }
          return true
        }
        if (route[2] === 'catalog' && req.method === 'GET') {
          writeJson(res, { ok: true, ...await catalog(scene, url.searchParams.get('refresh') === '1') })
          return true
        }
        if (route[2] === 'sessions' && route.length === 3 && req.method === 'POST') {
          writeJson(res, { ok: true, ...await createScenarioSession(scene, await readJsonBody(req)) })
          return true
        }
        if (route[2] === 'sessions' && route.length === 5 && route[4] === 'open' && req.method === 'POST') {
          writeJson(res, { ok: true, ...await prepareSession(scene, decodeURIComponent(route[3])) })
          return true
        }
        if (route[2] === 'sessions' && route.length === 4 && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          if (!Number.isInteger(body.revision)) fail('解除绑定需要携带场景当前版本')
          const next = store.unbindSession(scene.id, decodeURIComponent(route[3]), body.revision)
          publish(store.event(scene.id, null, 'scenario.updated', { scene: next }))
          writeJson(res, { ok: true, scene: next })
          return true
        }
        if (route[2] === 'upload' && req.method === 'POST') {
          const body = await readJsonBody(req, 32 * 1024 * 1024)
          const stored = await storeUpload(checkCwd(scene.cwd), body.name, body.data)
          writeJson(res, { ok: true, ...stored })
          return true
        }
        if (route[2] === 'events' && req.method === 'GET') {
          const after = Number(req.headers['last-event-id'] || url.searchParams.get('after')) || 0
          sse(req, res, scene, after)
          return true
        }
        if (route.length === 3 && route[2] === 'collaboration' && req.method === 'GET') {
          writeJson(res, { ok: true, ...collaboration(scene, url.searchParams) })
          return true
        }
        if (route[2] === 'runs' && req.method === 'POST') {
          const body = await readJsonBody(req)
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 100000) fail('请输入任务，单条最多十万字')
          if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 100) fail('缺少本次发送标识')
          scene.cwd = checkCwd(scene.cwd)
          const attachments = validAttachments(scene, body.attachments)
          if (scene.agents.some(agent => agent.engine !== 'codex') && attachments.some(file => file.kind === 'image')) {
            fail('DSH 模型和外部 Agent 的图片任务当前需要文字说明或提取内容')
          }
          const sessionId = sceneSession(scene, body.sessionId)
          const run = coordinator.start(scene, { ...body, sessionId,
            dshSessionId: sessionId.startsWith('local-') ? scene.dshSessionId || scene.sessions.at(-1)?.id : sessionId,
            text: body.text.trim(), attachments })
          if (scene.title === '新场景') {
            const updated = store.saveScenario({ ...scene, title: body.text.replace(/\s+/g, ' ').slice(0, 40), brief: scene.brief || body.text.slice(0, 4000) })
            publish(store.event(scene.id, run.id, 'scenario.updated', { scene: updated }))
          }
          writeJson(res, { ok: true, run })
          return true
        }
        if (route[2] === 'context-insights' && req.method === 'GET') {
          const result = contextInsights(store, scene, { agent: url.searchParams.get('agent') || '',
            detail: url.searchParams.get('detail'), before: Number(url.searchParams.get('before')) || undefined })
          if (!result) fail('上下文快照不存在', 404)
          writeJson(res, { ok: true, ...result })
          return true
        }
        if (route[2] === 'contexts' && req.method === 'GET') {
          const detail = url.searchParams.get('detail')
          if (detail) {
            const context = store.context(detail, scene.id)
            if (!context) fail('上下文快照不存在', 404)
            writeJson(res, { ok: true, context })
          } else writeJson(res, { ok: true, contexts: store.contexts(scene.id, url.searchParams.get('agent'), Number(url.searchParams.get('before')) || undefined) })
          return true
        }
        if (route[2] === 'memories' && route[3] === 'history' && req.method === 'GET') {
          const requested = url.searchParams.get('number')
          const number = requested === null ? undefined : Number(requested)
          if (requested !== null && (!/^\d+$/.test(requested) || !Number.isSafeInteger(number) || number < 1)) fail('请输入有效的记忆编号')
          writeJson(res, { ok: true, ...store.memoryHistory(scene.id, { before: Number(url.searchParams.get('before')) || undefined,
            limit: Number(url.searchParams.get('limit')) || undefined, number }) })
          return true
        }
        if (route[2] === 'memories' && route[3] === 'source' && req.method === 'GET') {
          const source = store.memorySource(scene.id, Object.fromEntries(url.searchParams))
          if (!source) fail('没有可定位的来源记录', 404)
          writeJson(res, { ok: true, source })
          return true
        }
        if (route[2] === 'memories' && route[3] === 'consolidate' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const sessionId = sceneSession(scene, body.sessionId, true)
          const run = body.runId ? store.run(body.runId) : undefined
          if (body.runId && (!run || run.scenarioId !== scene.id || run.sessionId !== sessionId)) fail('任务不属于当前会话')
          writeJson(res, { ok: true, ...await memoryCompiler.consolidate({ scene, sessionId, runId: run?.id, trigger: 'manual-consolidation' }) })
          return true
        }
        if (route.length === 3 && route[2] === 'memories' && req.method === 'GET') {
          const scope = url.searchParams.get('scope') === 'legacy' ? 'legacy' : 'scenario'
          writeJson(res, { ok: true, memories: store.memories(scene.id, scope) })
          return true
        }
        if (route.length === 3 && route[2] === 'memories' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const origin = memoryOrigin(scene, body)
          const message = origin.messageId ? store.message(origin.messageId) : undefined
          const source = message ? {
            type: 'message', sessionId: origin.sessionId, runId: origin.runId, messageId: origin.messageId,
            sourceAt: message.at, stage: redactMemoryText(message.stage).slice(0, 120),
            quote: redactMemoryText(message.text).trim().slice(0, 300),
          } : { type: 'user-edit', at: new Date().toISOString() }
          const input = { ...memoryInput(body), scenarioId: scene.id, status: body.status || 'confirmed',
            sources: [source] }
          validateMemoryRole(input, scene)
          const memory = store.saveMemory(input, undefined, origin)
          publish(store.event(scene.id, null, 'memory.changed', { memory }))
          writeJson(res, { ok: true, memory })
          return true
        }
      }
      if (route[0] === 'runs' && route[1]) {
        const run = store.run(route[1])
        if (!run) fail('任务不存在', 404)
        if (req.method === 'GET' && route.length === 2) writeJson(res, { ok: true, run, messages: store.runMessages(run.id), events: store.runEvents(run.id) })
        else if (route[2] === 'profiles' && req.method === 'PATCH') {
          const body = await readJsonBody(req)
          writeJson(res, { ok: true, run: coordinator.setProfile(run.id, body) })
        } else if (route[2] === 'followups' && req.method === 'POST') {
          const body = await readJsonBody(req)
          writeJson(res, { ok: true, run: coordinator.followUp(run.id, body) })
        }
        else if (route[2] === 'cancel' && req.method === 'POST') writeJson(res, { ok: true, run: coordinator.cancel(run.id) })
        else if (route[2] === 'answers' && req.method === 'POST') {
          const body = await readJsonBody(req)
          coordinator.answer(run.id, body.questionId, body.answers)
          writeJson(res, { ok: true })
        } else fail('接口不存在', 404)
        return true
      }
      if (route[0] === 'memories' && route[1]) {
        const memory = store.memory(route[1])
        if (!memory) fail('记忆不存在', 404)
        if (route[2] === 'revisions' && req.method === 'GET') {
          writeJson(res, { ok: true, revisions: store.memoryRevisions(memory.id) })
          return true
        }
        if (route[2] === 'import' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const scene = sceneFor(body.scenarioId)
          if (memory.scope !== 'legacy') fail('这条资料已经属于一个场景')
          const imported = store.saveMemory({ ...memoryInput(memory), scenarioId: scene.id, status: 'candidate', enabled: true,
            sources: [...(memory.sources || []), { type: 'legacy-memory', id: memory.id }] }, undefined, memoryOrigin(scene, body, 'import'))
          publish(store.event(scene.id, null, 'memory.changed', { memory: imported }))
          writeJson(res, { ok: true, memory: imported })
          return true
        }
        if (req.method === 'PATCH' || req.method === 'DELETE') {
          if (memory.scope !== 'scenario') fail('请将旧库资料导入场景后编辑')
          const body = await readJsonBody(req)
          if (!Number.isInteger(body.revision)) throw conflict()
          const patch = req.method === 'DELETE' ? { status: 'deleted', enabled: false } : memoryInput(body, true)
          const scene = sceneFor(memory.scenarioId)
          validateMemoryRole({ ...memory, ...patch }, scene)
          const next = store.saveMemory({ ...memory, ...patch }, body.revision, memoryOrigin(scene, body))
          publish(store.event(memory.scenarioId, null, 'memory.changed', { memory: next }))
          writeJson(res, { ok: true, memory: next })
          return true
        }
      }
      fail('接口不存在', 404)
    } catch (error) {
      log(`workbench ${path}: ${error.message}`)
      writeJson(res, { ok: false, error: error.message }, error.status || 400)
      return true
    }
  }

  return { handle, async dispose() {
    closed = true
    for (const close of sockets) close()
    await memoryCompiler.dispose()
    await coordinator.dispose()
    store.close()
  } }
}

function validateMemoryRole(memory, scene) {
  if (memory.audience === 'role' && !scene.agents.some(agent => (agent.roleId || agent.id) === memory.roleId)) {
    fail('请选择这条记忆所属的角色')
  }
}

function memoryInput(body, patch = false) {
  const output = {}
  if (!patch || body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) fail('请填写记忆标题')
    output.title = body.title.trim().slice(0, 200)
  }
  if (!patch || body.content !== undefined) {
    if (typeof body.content !== 'string' || !body.content.trim()) fail('请填写记忆内容')
    output.content = body.content.slice(0, 20000)
  }
  if (body.kind !== undefined) {
    if (!MEMORY_KINDS.has(body.kind)) fail('记忆类型无效')
    output.kind = body.kind
  }
  if (body.status !== undefined) {
    if (!MEMORY_STATES.has(body.status)) fail('记忆状态无效')
    output.status = body.status
  }
  for (const field of ['enabled', 'pinned']) if (typeof body[field] === 'boolean') output[field] = body[field]
  if (body.audience !== undefined) {
    if (!['scene', 'role'].includes(body.audience)) fail('记忆所属范围无效')
    output.audience = body.audience
    if (body.audience === 'scene') output.roleId = ''
  }
  if (body.roleId !== undefined && body.audience !== 'scene') output.roleId = String(body.roleId)
  return output
}
