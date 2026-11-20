import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { estimateTokens, MEMORY_KINDS, relevantMemories } from './scenario-store.js'
import { normalizedUsage } from './context-insights.js'

const FINAL_STATES = new Set(['completed', 'disputed', 'incomplete', 'failed', 'cancelled', 'interrupted'])
const MAX_GRAPH_TASKS = 64
const MAX_AGENT_LAUNCHES = 3
const OUTCOME_BUDGET = 1200
const OWNER_CURRENT_USER_BUDGET = 12000
const OWNER_RETAINED_USER_BUDGET = 2400
const EXPERIENCE_LABELS = { reference: '参考案例', practice: '有效做法', pitfall: '踩坑与规避' }
const OUTPUT_CONTRACT = `只输出一个 JSON 对象。所有面向用户的内容使用中文，保留必要专业名称。
团队分工使用 tasks 字段中的已配置成员编号，由宿主定向交付和回收。summary 给出用户可独立阅读的简短结论，最多三句话。完整依据放入 evidence。
证据必须来自实际读取或执行，描述操作、文件路径与结果。需要用户补充时使用 question 字段。
memoryCandidates 可包含 {title,content,kind,evidence,reason,audience:"scene"|"role"}。项目事实与共同约束使用 scene，角色经验使用 role。类似任务与可复用产物用 reference，已验证有效的做法用 practice，实际遇到的失败与规避方法用 pitfall。写明触发条件、观察到的结果和下次如何做。`

const brief = (value, limit = OUTCOME_BUDGET) => String(value || '').trim().slice(0, limit)
const timestamp = () => new Date().toISOString()
const accepted = task => task?.state === 'completed' && task.accepted !== false
const canReplaceDependencies = task => task?.state === 'pending' && task.accepted !== true && !task.launches && !task.attempts?.length
  && !task.messageId && !task.needsVerification
function launchesFor(task, agentId) {
  if (!task.launchesByAgent) return task.agentId === agentId ? task.launches || 0 : 0
  return Object.hasOwn(task.launchesByAgent, agentId) ? task.launchesByAgent[agentId] : 0
}
function scheduledStart(value) {
  if (value == null) return undefined
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed = Date.parse(value)
    const day = value.slice(0, 10)
    if (Number.isFinite(parsed) && new Date(day).toISOString().slice(0, 10) === day) return new Date(parsed).toISOString()
  }
  throw new Error('最早执行时间须为含时区的 ISO 8601 时间')
}
const matchesTaskReport = (entry, task) => entry.kind === 'report' && entry.taskId === task.id
  && (task.messageId ? entry.messageId === task.messageId : entry.agentId === task.agentId
    && (entry.launch == null ? entry.text === task.error : entry.launch === task.launches))
const isOwnerUserInput = entry => entry.kind === 'user' || entry.kind === 'answer'
const ownerUserInputId = entry => entry.messageId || entry.questionId || entry.id

function ownerInputExcerpt(text, budget) {
  if (estimateTokens(text) <= budget) return text
  const marker = '\n[已截取，完整内容保存在原会话。]'
  const limit = budget - estimateTokens(marker)
  let start = 0
  let end = text.length
  while (start < end) {
    const middle = Math.ceil((start + end) / 2)
    if (estimateTokens(text.slice(0, middle)) <= limit) start = middle
    else end = middle - 1
  }
  if (/[\uD800-\uDBFF]$/.test(text.slice(0, start))) start--
  return text.slice(0, start) + marker
}

function newWorkflow() {
  return { version: 1, inbox: [], cursor: 0, pendingQuestion: '', finalCheck: false }
}

function hasEvidence(evidence) {
  return Array.isArray(evidence) && evidence.some(item => typeof item === 'string' ? item.trim()
    : item && typeof item === 'object' && !Array.isArray(item) && Object.values(item).some(value =>
      typeof value === 'string' ? value.trim() : typeof value === 'number' || typeof value === 'boolean'))
}

function reportStatus(result) {
  if (['blocked', 'failed', 'incomplete'].includes(result.status)) return 'failed'
  return brief(result.summary || result.answer) && hasEvidence(result.evidence) ? 'completed' : 'failed'
}

function executionAgent(agent, variantId = '') {
  if (!variantId) return { ...agent, baseName: agent.name, profileName: '成员配置' }
  const variant = (agent.variants || []).find(item => item.id === variantId)
  if (!variant) throw new Error('这个扩展成员已不存在，请重新选择')
  return { ...agent, baseName: agent.name, variantId: variant.id, profileName: variant.name,
    name: `${agent.name} · ${variant.name}`, effort: variant.effort }
}

export function parseResult(text) {
  const source = String(text || '').trim()
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [source, fenced?.[1]]
  const first = source.indexOf('{')
  const last = source.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1))
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const result = JSON.parse(candidate)
      if (result && typeof result === 'object' && !Array.isArray(result)) return result
    } catch { /* Try the next complete representation. */ }
  }
  throw new Error('成员返回的结构化结果无法解析，原始输出已保留在成员过程里')
}

export class RunCoordinator {
  constructor({ store, runAgent, loadSkills, publish, closeAgents, prepareTeam, routeTask, memoryCompiler }) {
    this.store = store
    this.runAgent = runAgent
    this.loadSkills = loadSkills
    this.publish = publish
    this.closeAgents = closeAgents
    this.prepareTeam = prepareTeam
    this.routeTask = routeTask
    this.memoryCompiler = memoryCompiler
    this.active = new Map()
    this.questions = new Map()
    this.writeQueues = new Map()
    this.disposed = false
    for (const run of store.interruptedRuns()) {
      run.state = 'interrupted'
      run.finishedAt = new Date().toISOString()
      if (run.workflow) delete run.workflow.waitingUntil
      for (const task of run.tasks || []) {
        if (task.state === 'working') task.state = 'interrupted'
      }
      for (const task of run.delegations || []) {
        if (task.state === 'working') task.state = 'interrupted'
      }
      run.questions = []
      store.saveRun(run)
      this.emit(run, 'run.interrupted', { run })
    }
  }

  emit(run, type, payload = {}) {
    if (this.disposed) return
    const event = this.store.event(run.scenarioId, run.id, type, { sessionId: run.sessionId, ...payload })
    this.publish(event)
    return event
  }

  update(run, state) {
    if (state) run.state = state !== 'cancelling' && run.questions?.length ? 'waiting_user' : state
    run.updatedAt = timestamp()
    this.store.saveRun(run)
    this.emit(run, 'run.updated', { run })
  }

  start(scene, { text, requestId, attachments = [], resumeRunId, sessionId, dshSessionId }) {
    sessionId ||= scene.dshSessionId || `local-${scene.id}`
    const existing = this.store.request(scene.id, requestId)
    if (existing) {
      if (existing.sessionId && existing.sessionId !== sessionId) throw new Error('发送标识属于另一个需求会话，请重新发送')
      return existing
    }
    if (this.disposed) throw new Error('插件正在重载，请稍后再发送')
    if ([...this.active.values()].some(item => item.run.scenarioId === scene.id && item.run.sessionId === sessionId)) {
      const error = new Error('当前场景的上一轮任务尚未结束')
      error.status = 409
      throw error
    }
    const previous = resumeRunId ? this.store.run(resumeRunId) : undefined
    if (resumeRunId && (!previous || previous.scenarioId !== scene.id || previous.sessionId !== sessionId || !FINAL_STATES.has(previous.state))) throw new Error('只能在原需求会话中接续已结束的任务')
    const mode = previous?.mode || scene.mode
    const auto = mode === 'orchestration' && scene.teamStrategy === 'auto'
    const ownerId = previous?.ownerId && scene.agents.some(agent => agent.id === previous.ownerId) ? previous.ownerId : scene.ownerId
    if (mode === 'confidence' && scene.agents.length < 2) throw new Error('置信协作需要至少两位成员')
    if (mode === 'orchestration' && !auto && !scene.agents.some(agent => agent.id === ownerId)) throw new Error('请先选择本次任务的 Owner')
    const run = {
      id: randomUUID(), scenarioId: scene.id, sessionId, dshSessionId, requestId, text, attachments,
      mode, ownerId, agents: structuredClone(scene.agents),
      scene: structuredClone(scene), state: 'queued', tasks: [], reviews: [],
      createdAt: timestamp(), resumeRunId: previous?.id,
      resumeContext: previous && (mode !== 'orchestration' || !previous.delegations?.length) ? this.resumeContext(previous) : '',
    }
    if (mode === 'orchestration') {
      run.workflow = newWorkflow()
      run.delegations = []
      if (previous) this.restoreGraph(run, previous)
    }
    this.store.transaction(() => {
      this.store.saveRun(run)
      const message = this.store.addMessage({ scenarioId: scene.id, sessionId, runId: run.id, role: 'user', text, attachments })
      run.userMessageId = message.id
      this.rememberUserRequest(run)
      this.store.saveRun(run)
      this.emit(run, 'message.added', { message })
      this.emit(run, 'run.created', { run })
    })
    const controller = new AbortController()
    const operation = { run, controller, promise: undefined }
    this.active.set(run.id, operation)
    operation.promise = this.perform(run, controller.signal).finally(() => this.active.delete(run.id))
    operation.promise.catch(() => {})
    return run
  }

  resumeContext(run) {
    const completed = new Set(run.tasks.filter(task => task.state === 'completed').map(task => task.messageId))
    const outputs = this.store.runMessages(run.id).filter(message => completed.has(message.id))
      .map(message => ({ agentId: message.agentId, stage: message.stage, messageId: message.id, result: message.structured || message.text }))
    return JSON.stringify({ request: run.text, state: run.state, tasks: run.tasks, delegations: run.delegations || [], completedOutputs: outputs, result: run.finalResult,
      instruction: '接续前核验已完成产物、文件和实际状态，复用有效成果。从失败或依赖受阻的任务继续分工，写入前核对上次已产生的部分修改。' })
  }

  restoreGraph(run, previous) {
    if (!previous.delegations?.length) return
    const oldWorkspace = previous.scene?.cwd
    const currentWorkspace = run.scene.cwd
    const workspaceChanged = Boolean(oldWorkspace && currentWorkspace && resolve(oldWorkspace) !== resolve(currentWorkspace))
    const past = structuredClone(previous.delegations)
    const byPlanId = new Map(past.map(task => [`${task.id.match(/^\d+-/)?.[0] || ''}${task.planTaskId}`, task.id]))
    const messages = this.store.runMessages(previous.id)
    const previousInbox = previous.workflow?.inbox || []
    const unreadInbox = previousInbox.slice(previous.workflow?.cursor || 0)
    const recoveredReports = new Map()
    for (const task of past) {
      const stage = [...(previous.tasks || [])].reverse().find(entry => entry.workflowTaskId === task.id
        || (!entry.workflowTaskId && entry.agentId === task.agentId && entry.title === task.title))
      const attempts = task.attempts || []
      const latestWrite = attempts.findLastIndex(attempt => attempt.kind === 'execute')
      const verified = !task.messageId && attempts.slice(latestWrite + 1).filter(attempt => attempt.kind === 'verify' && attempt.messageId)
        .map(attempt => this.store.message?.(attempt.messageId) || messages.find(message => message.id === attempt.messageId))
        .findLast(message => message?.runId === previous.id && message.structured?.recovery === 'verified' && reportStatus(message.structured) === 'completed')
      const reported = (task.messageId && this.store.message?.(task.messageId)) || verified || messages.find(message => message.id === task.messageId
        || (stage && message.operationId === stage.id && message.structured && !stage.title.startsWith('接续核验：')))
      const wasAccepted = task.state === 'completed' && (!previous.workflow || task.accepted === true)
      const unreadFailure = task.state === 'failed' && unreadInbox.findLast(entry => matchesTaskReport(entry, task))
      if (!previous.workflow) {
        const pass = task.id.match(/^\d+-/)?.[0] || ''
        task.dependencies = (task.dependencies || []).map(id => byPlanId.get(`${pass}${id}`) || id)
      }
      task.planTaskId = task.id
      const priorExecution = task.needsVerification || attempts.some(attempt => attempt.kind === 'execute') || stage
      if (!workspaceChanged) task.resultRunId ||= previous.id
      if (workspaceChanged) {
        Object.assign(task, {
          state: 'pending', accepted: false, acceptedAt: undefined, messageId: undefined, resultRunId: undefined,
          summary: undefined, error: undefined, launchesByAgent: {},
          needsVerification: task.access !== 'read' && Boolean(task.state === 'completed' || reported || priorExecution),
          forwarded: (task.forwarded || []).filter(item => item.messageId && this.store.message?.(item.messageId)?.role === 'user'),
        })
      } else if (reported && reportStatus(reported.structured || {}) === 'completed') {
        task.state = 'completed'
        task.messageId = reported.id
        task.summary = brief(reported.structured.summary || reported.text)
        task.accepted = wasAccepted
        if (!wasAccepted) recoveredReports.set(task.id, { kind: 'report', agentId: task.agentId, taskId: task.id,
          messageId: task.messageId, originRunId: task.resultRunId, text: task.summary, at: reported.at || timestamp(), messageSeq: reported.seq || 0 })
      } else if (wasAccepted) {
        task.state = 'completed'
        task.accepted = true
      } else if (unreadFailure || launchesFor(task, task.agentId) >= MAX_AGENT_LAUNCHES) {
        const failure = unreadFailure || previousInbox.findLast(entry => matchesTaskReport(entry, task))
        task.state = 'failed'
        task.accepted = false
        task.messageId = failure?.messageId || task.messageId || reported?.id
        task.resultRunId = failure?.originRunId || reported?.runId || task.resultRunId
        task.error ||= failure?.text || reported?.text || attempts.at(-1)?.error || stage?.error || '该成员的尝试已用尽，最后一次执行尚无可确认的交付。'
        task.needsVerification = task.access !== 'read'
        const receipt = { ...failure, kind: 'report', agentId: task.agentId, taskId: task.id, launch: task.launches,
          messageId: task.messageId, originRunId: task.resultRunId, text: failure?.text || task.error,
          at: failure?.at || reported?.at || timestamp(), messageSeq: reported?.seq || 0 }
        recoveredReports.set(task.id, receipt)
      } else {
        task.needsVerification = task.access !== 'read' && Boolean(priorExecution)
        task.state = 'pending'
        task.accepted = false
        task.error = undefined
      }
    }
    const oldAgents = previous.agents.filter(agent => !run.agents.some(item => item.id === agent.id) && past.some(task => task.agentId === agent.id))
    run.agents.push(...structuredClone(oldAgents))
    run.delegations = past
    for (const entry of unreadInbox) {
      if (entry.kind === 'user' || entry.kind === 'answer') this.recordInbox(run, { ...entry, originRunId: entry.originRunId || previous.id })
      const recovered = recoveredReports.get(entry.taskId)
      if (entry.kind === 'report' && recovered
        && (recovered.messageId ? entry.messageId === recovered.messageId : recovered.id && recovered.id === entry.id)) {
        this.recordInbox(run, { ...recovered, ...entry, originRunId: entry.originRunId || recovered.originRunId })
        recoveredReports.delete(entry.taskId)
      }
    }
    for (const entry of [...recoveredReports.values()].sort((first, second) => first.messageSeq - second.messageSeq)) this.recordInbox(run, entry)
    const resumeNote = workspaceChanged
      ? `工作区已由 ${oldWorkspace} 切换到 ${currentWorkspace}。保留原任务编号和依赖，旧交付留作历史。验收当前工作区重新取得的证据后才启动依赖步骤。已执行过的写入须先在当前工作区只读核验。`
      : '已恢复原分工与交付记录。'
    this.recordInbox(run, { kind: 'resume', text: `${resumeNote}${brief(previous.error || previous.finalResult, 350)}` })
  }

  recordInbox(run, entry) {
    const item = { id: randomUUID(), at: timestamp(), ...entry }
    run.workflow.inbox.push(item)
    return item
  }

  enqueue(run, entry) {
    const item = this.recordInbox(run, entry)
    this.store.transaction(() => {
      this.update(run)
      this.emit(run, 'owner.inbox.queued', { entryId: item.id, agentId: item.agentId, taskId: item.taskId, text: item.text, messageId: item.messageId })
    })
    this.active.get(run.id)?.wake?.()
    return item
  }

  followUp(runId, { text, requestId }) {
    const active = this.active.get(runId)
    const run = active?.run || this.store.run(runId)
    if (!run?.workflow || run.mode !== 'orchestration') throw new Error('仅统筹任务支持运行中补充')
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 100) throw new Error('缺少补充消息标识')
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new Error('请输入补充信息，单条最多十万字')
    if (run.workflow.inbox.some(item => item.requestId === requestId)) return run
    if (!active || active.controller.signal.aborted || FINAL_STATES.has(run.state)) throw new Error('这项任务已经结束')
    this.store.transaction(() => {
      const message = this.store.addMessage({ scenarioId: run.scenarioId, sessionId: run.sessionId, runId: run.id, role: 'user', text: text.trim() })
      this.emit(run, 'message.added', { message })
      this.rememberUserRequest({ ...run, text: message.text, userMessageId: message.id })
      this.enqueue(run, { kind: 'user', requestId, messageId: message.id, text: brief(message.text) })
    })
    return run
  }

  async perform(run, signal) {
    try {
      if (run.mode === 'orchestration') await this.orchestrate(run, signal)
      else await this.verify(run, signal)
    } catch (error) {
      if (this.disposed) return
      run.error = error.message
      const cancelled = signal.aborted && signal.reason?.message === '用户停止任务'
      const interrupted = signal.aborted && !cancelled
      for (const task of run.tasks) {
        if (['working', 'pending'].includes(task.state)) task.state = cancelled ? 'cancelled' : interrupted ? 'interrupted' : task.state === 'pending' ? 'blocked' : 'failed'
      }
      for (const task of run.delegations || []) {
        if (['working', 'pending'].includes(task.state)) task.state = cancelled ? 'cancelled' : interrupted ? 'interrupted' : task.state === 'pending' ? 'blocked' : 'failed'
      }
      this.finish(run, cancelled ? 'cancelled' : interrupted ? 'interrupted' : 'failed', cancelled ? '任务已停止。已完成操作与成员记录可以在右侧查看。' : `本轮任务中断。${error.message}`)
    } finally {
      for (const [id, pending] of this.questions) {
        if (pending.runId === run.id) {
          this.questions.delete(id)
          pending.reject(new Error('任务已结束'))
        }
      }
    }
  }

  currentHistory(run) {
    const summary = this.store.sessionSummary?.(run.scenarioId, run.sessionId)
    const messages = this.store.messages(run.scenarioId, undefined, 16, run.sessionId)
      .filter(message => !message.agentId && message.runId !== run.id && message.seq > (summary?.lastMessageSeq || 0))
      .map(message => `${message.role === 'user' ? '用户' : '团队'} ${message.text.slice(0, 2000)}`).join('\n')
    return [summary?.content ? `本会话工作摘要：\n${summary.content}` : '', messages].filter(Boolean).join('\n\n')
  }

  async call(run, agent, stage, instruction, signal, {
    readOnly = true, handoffs = [], variantId, effectiveAgent, workflowTaskId, operationId = randomUUID(),
    includeHistory = true, initialContext, onDispatch,
  } = {}) {
    signal.throwIfAborted()
    agent = effectiveAgent || executionAgent(agent, variantId ?? run.profileOverrides?.[agent.id] ?? '')
    readOnly = readOnly || agent.permission === 'read-only'
    const scene = run.scene
    const selected = initialContext?.memory || relevantMemories(this.store.memories(scene.id),
      `${run.text}\n${brief(instruction, 3000)}`, 2400, agent.roleId || agent.id)
    const history = includeHistory ? initialContext?.history ?? this.currentHistory(run) : ''
    const skills = initialContext ? [] : await this.loadSkills(agent, scene, signal)
    const duty = initialContext ? '独立核实本轮问题，使用共同提供的资料并留下证据' : agent.role
    const coordination = workflowTaskId ? '只与 Owner 协作。需要其他成员信息时在转发请求中说明，由 Owner 处理。' : ''
    const items = [
      { category: 'role', label: '角色与协作规则', content: `你是 ${agent.name}，职责为 ${duty}。当前阶段为 ${stage}。围绕本轮任务的验收要求开展工作，历史消息提供背景，最终回答遵循本轮用户要求。${coordination}${readOnly ? '本阶段进行读取、调研和审查，所有实际修改交由执行阶段。' : '按用户任务及已有授权执行，核对实际结果。'}\n${OUTPUT_CONTRACT}`, source: { type: 'agent', id: agent.id, revision: scene.revision } },
      { category: 'scene', label: '场景概况', content: `${scene.title}\n${scene.brief || ''}\n工作区 ${scene.cwd}`, source: { type: 'scenario', id: scene.id, revision: scene.revision } },
      { category: 'task', label: '本轮任务', content: `${run.text}\n\n${instruction}`, source: { type: 'message', id: run.userMessageId } },
      ...selected.map(entry => ({ category: 'memory', label: entry.title,
        content: `[${entry.status}${Object.hasOwn(EXPERIENCE_LABELS, entry.kind) ? ` · ${EXPERIENCE_LABELS[entry.kind]}` : ''}] ${entry.content}`, reason: entry.reason,
        source: { type: 'memory', id: entry.id, revision: entry.revision, audience: entry.audience || 'scene', roleId: entry.roleId || '', sources: entry.sources } })),
      ...skills.map(skill => ({ category: 'skill', label: skill.name, content: skill.content, source: { type: 'skill', name: skill.name, path: skill.path } })),
      ...handoffs.map(message => ({ category: 'handoff', label: message.label, content: message.content, source: message.source })),
    ]
    if (history) items.push({ category: 'history', label: '近期主聊天', content: history, source: { type: 'history', scenarioId: scene.id } })
    if (includeHistory && run.resumeContext) items.push({ category: 'history', label: '中断任务接续', content: run.resumeContext, source: { type: 'run', id: run.resumeRunId } })
    if (run.attachments.length) items.push({ category: 'attachment', label: '本轮附件', content: run.attachments.map(file => `${file.name} ${file.path}`).join('\n'), source: { type: 'attachment', files: run.attachments } })
    const prompt = items.map(item => `## ${item.label}\n${item.content}`).join('\n\n')
    const context = this.store.addContext({ scenarioId: scene.id, sessionId: run.sessionId, runId: run.id, agentId: agent.id, operationId, stage,
      engine: agent.engine, kind: 'stage', status: 'working', variantId: agent.variantId,
      agentProvider: agent.agentProvider || '', permissionSource: agent.engine === 'agent' ? 'provider-config' : agent.engine === 'codex' ? 'sandbox' : 'tool-filter',
      effectiveConfig: { model: agent.model, effort: agent.effort, profileName: agent.profileName, permission: agent.permission || 'default', routingReason: agent.routingReason },
      items: items.map(item => ({ ...item, estimatedTokens: estimateTokens(item.content) })), estimatedTokens: estimateTokens(prompt),
      sourceCoverage: '插件组装的完整请求材料。引擎额外注入的内容按运行时事件记录。', readOnly })
    this.emit(run, 'context.created', { agentId: agent.id, contextId: context.id, stage })
    const task = { id: operationId, agentId: agent.id, title: stage, state: 'working', readOnly, workflowTaskId,
      variantId: agent.variantId || '', model: agent.model, effort: agent.effort, profileName: agent.profileName, routingReason: agent.routingReason }
    run.tasks.push(task)
    this.update(run)
    let buffer = ''
    let timer
    let raw = ''
    let messageSaved = false
    const flush = () => {
      if (buffer) this.emit(run, 'agent.delta', { agentId: agent.id, operationId, text: buffer })
      buffer = ''
      clearTimeout(timer)
      timer = undefined
    }
    let contextLimitRequested = false
    const execute = () => {
      signal.throwIfAborted()
      onDispatch?.()
      return this.runAgent({ run, agent, stage, prompt, signal, readOnly, contextId: context.id,
      onQuestion: params => this.ask(run, agent, params, signal),
      onDelta: delta => {
        buffer += delta
        if (!timer) timer = setTimeout(flush, 100)
      },
      onEvent: (type, payload) => {
        this.emit(run, type, { agentId: agent.id, operationId, ...payload })
        if (payload.usage) this.store.updateContext(context.id, { reportedUsage: payload.usage })
        if (payload.contextWindow) this.store.updateContext(context.id, { contextWindow: payload.contextWindow })
        if (payload.threadId) {
          task.model = payload.model || task.model
          task.effort = payload.effort ?? task.effort
          task.provider = payload.provider || agent.provider
          this.store.updateContext(context.id, { threadId: payload.threadId,
            effectiveConfig: { model: task.model, provider: task.provider, effort: task.effort, permission: payload.permission || agent.permission || 'default', readOnly, routingReason: agent.routingReason } })
        }
        if (type === 'context.changed' && /compact|prune/.test(payload.kind || '')) this.memoryCompiler?.request(run, 'compaction')
        const input = normalizedUsage(payload.usage, agent.engine)?.input
        if (!contextLimitRequested && Number.isFinite(input) && payload.contextWindow > 0 && input >= payload.contextWindow * 0.75) {
          contextLimitRequested = true
          this.memoryCompiler?.request(run, 'context-limit')
        }
      },
      })
    }
    try {
      this.emit(run, 'agent.started', { agentId: agent.id, operationId, stage })
      const result = readOnly ? await execute() : await this.serialWrite(scene.cwd, execute, signal)
      signal.throwIfAborted()
      raw = result.answer || ''
      if (result.status && result.status !== 'completed') throw new Error(`${agent.name} 未完成本阶段，状态 ${result.status}${result.diagnostic ? `。${result.diagnostic}` : ''}`)
      const parsed = parseResult(raw)
      const roleCandidates = Array.isArray(parsed.memoryCandidates)
        ? parsed.memoryCandidates.filter(candidate => candidate.audience === 'role') : []
      const message = this.store.addMessage({ scenarioId: scene.id, sessionId: run.sessionId, runId: run.id, agentId: agent.id, agentName: agent.name,
        variantId: agent.variantId || '', model: task.model, effort: task.effort, profileName: agent.profileName,
        operationId, role: 'assistant', stage, text: parsed.summary || parsed.answer || raw, raw, structured: parsed })
      run.roleMemoryCandidates = [...(run.roleMemoryCandidates || []), ...roleCandidates.map(candidate => ({ ...candidate,
        roleId: agent.roleId || agent.id, sourceAgentId: agent.id, sourceMessageId: message.id }))]
      messageSaved = true
      task.state = 'completed'
      task.messageId = message.id
      task.summary = String(parsed.summary || parsed.answer || '').slice(0, 1200)
      this.store.updateContext(context.id, { finishedAt: new Date().toISOString(), response: raw, status: 'completed' })
      flush()
      this.emit(run, 'message.added', { message })
      this.emit(run, 'agent.completed', { agentId: agent.id, operationId })
      this.update(run)
      return { ...parsed, agentId: agent.id, roleId: agent.roleId || agent.id, messageId: message.id, model: task.model, effort: task.effort, provider: task.provider }
    } catch (error) {
      if (raw && !messageSaved) {
        const message = this.store.addMessage({ scenarioId: scene.id, sessionId: run.sessionId, runId: run.id, agentId: agent.id, agentName: agent.name,
          operationId, role: 'assistant', stage, text: raw, raw, error: error.message })
        this.emit(run, 'message.added', { message })
      }
      task.state = signal.aborted ? 'cancelled' : 'failed'
      task.error = error.message
      this.store.updateContext(context.id, { finishedAt: new Date().toISOString(), response: raw, status: task.state })
      flush()
      this.emit(run, 'agent.failed', { agentId: agent.id, operationId, message: error.message })
      this.update(run)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  handoff(result, label) {
    return { label, content: JSON.stringify(result), source: { type: 'agent-message', agentId: result.agentId, id: result.messageId } }
  }

  async collect(run, agents, stage, instruction, signal, options) {
    const results = await Promise.allSettled(agents.map(agent => this.call(run, agent, stage, instruction, signal, options)))
    signal.throwIfAborted()
    return results.map((result, index) => result.status === 'fulfilled'
      ? result.value : { agentId: agents[index].id, error: result.reason.message })
  }

  async verify(run, signal) {
    const lead = run.agents.find(agent => agent.id === run.scene.summarizerId) || run.agents[0]
    this.update(run, 'independent')
    const initialContext = { memory: relevantMemories(this.store.memories(run.scenarioId)
      .filter(entry => entry.status === 'confirmed' && entry.audience !== 'role'), run.text), history: this.currentHistory(run) }
    let proposals = await this.collect(run, run.agents, '独立处理',
      '独立调查并提出完成任务的方案。格式 {summary,evidence:[],needsExecution:boolean,proposedActions:[],memoryCandidates:[]}。needsExecution 只在用户任务需要实际修改或执行时为 true。', signal, { initialContext })
    if (proposals.some(result => result.error)) return this.incomplete(run, proposals)
    for (let round = 0; run.scene.reviewRounds === 0 || round < run.scene.reviewRounds; round++) {
      this.update(run, 'reviewing')
      const reviews = await this.collect(run, run.agents, `交叉验证 ${round + 1}`,
        '核对其他成员的主张和来源，实际读取必要证据。格式 {summary,verdict:"approved"|"changes_requested"|"insufficient_evidence",evidence:[],issues:[]}。', signal,
        { handoffs: proposals.map(result => this.handoff(result, '成员初步结果')) })
      run.reviews.push(...reviews)
      if (reviews.some(result => result.error)) return this.incomplete(run, reviews)
      if (reviews.every(result => result.verdict === 'approved')) break
      if (run.scene.reviewRounds > 0 && round + 1 === run.scene.reviewRounds) {
        return this.summarize(run, lead, signal, [...proposals, ...reviews], 'disputed')
      }
      this.update(run, 'resolving')
      proposals = await this.collect(run, run.agents, '补充核实',
        '处理审查意见，补充来源并修订方案。格式 {summary,evidence:[],needsExecution:boolean,proposedActions:[]}。', signal,
        { handoffs: [...proposals, ...reviews].map(result => this.handoff(result, '待核实内容')) })
      if (proposals.some(result => result.error)) return this.incomplete(run, proposals)
    }
    const results = [...proposals]
    if (proposals.some(result => result.needsExecution === true)) {
      this.update(run, 'working')
      const executor = run.agents.find(agent => agent.engine === 'codex') || lead
      const execution = await this.call(run, executor, '执行已验证方案',
        '根据用户任务、已核对的方案和已有授权执行所需操作。检查实际结果。格式 {summary,evidence:[],memoryCandidates:[]}。', signal,
        { readOnly: false, handoffs: proposals.map(result => this.handoff(result, '已验证方案')) })
      results.push(execution)
    }
    await this.summarize(run, lead, signal, results, 'completed', true)
  }

  async summarize(run, lead, signal, results, targetState, reviewFinal = false) {
    this.update(run, 'synthesizing')
    let summary
    const reviewLimit = run.scene.reviewRounds
    for (let attempt = 0; reviewFinal ? (reviewLimit === 0 || attempt < reviewLimit) : attempt < 1; attempt++) {
      summary = await this.call(run, lead, '统一结论',
        `综合收到的结果，简短回答用户，通常 150 至 300 字。保留必要分歧和待核实项。当前验证状态为 ${targetState}。格式 {answer,summary,evidence:[],memoryCandidates:[]}。`, signal,
        { handoffs: results.map(result => this.handoff(result, '成员结果与检查意见')) })
      if (typeof summary.answer !== 'string' || !summary.answer.trim()) throw new Error('统一结论缺少 answer 正文')
      if (!reviewFinal) break
      this.update(run, 'checking')
      const checks = await this.collect(run, run.agents.filter(agent => agent.id !== lead.id), '统一稿审查',
        '核对统一结论的关键主张、实际执行结果与任务完成情况。格式 {summary,verdict:"approved"|"changes_requested"|"insufficient_evidence",issues:[],evidence:[]}。', signal,
        { handoffs: [...results, summary].map(result => this.handoff(result, '最终稿与执行证据')) })
      run.reviews.push(...checks)
      if (checks.some(result => result.error)) return this.incomplete(run, checks)
      if (checks.every(result => result.verdict === 'approved')) {
        targetState = 'completed'
        break
      }
      targetState = 'disputed'
      results.push(...checks)
      if (reviewLimit > 0 && attempt + 1 === reviewLimit) summary.answer += '\n\n统一稿仍有审查分歧，具体意见可在成员过程中查看。'
    }
    this.finish(run, targetState, summary.answer, summary.memoryCandidates, summary.summary)
  }

  validatePlan(run, drafts, aliases = {}) {
    if (!Array.isArray(drafts) || run.delegations.length + drafts.length > MAX_GRAPH_TASKS) throw new Error('Owner 的分工超出本轮任务图容量')
    const ids = new Set(run.delegations.map(task => task.id))
    const tasks = drafts.map(draft => {
      const id = brief(draft?.id, 128)
      if (!id || ids.has(id)) throw new Error('Owner 返回了重复或缺失的任务编号')
      ids.add(id)
      const agentId = Object.hasOwn(aliases, draft.agentId) ? aliases[draft.agentId] : draft.agentId
      const agent = run.agents.find(member => member.id === agentId)
      if (!agent) throw new Error(`Owner 分配了不存在的成员：${brief(draft.agentId, 128)}`)
      if (agent.id === run.ownerId) throw new Error('Owner 应在当前决策中作答，把独立执行步骤分给其他成员')
      const instruction = brief(draft.instruction, 12000)
      const acceptanceCriteria = brief(draft.acceptanceCriteria, 2400)
      if (!instruction || !acceptanceCriteria) throw new Error('分工缺少任务说明或验收要求')
      if (!['read', 'write'].includes(draft.access)) throw new Error('每项分工必须明确为读取或写入')
      if (draft.access === 'write' && agent.permission === 'read-only') throw new Error('Owner 将需要写入的任务分配给了只读成员')
      const capability = brief(draft.capability, 120)
      const difficulty = ['simple', 'medium', 'hard'].includes(draft.difficulty) ? draft.difficulty : /vision|截图|视觉/i.test(capability) ? 'simple' : 'medium'
      const effort = difficulty === 'hard' && draft.effort === 'ultra' ? 'ultra' : undefined
      const variantId = draft.variantId || agent.variants?.find(variant => variant.difficulty === difficulty)?.id || ''
      executionAgent(agent, variantId)
      return { id, planTaskId: id, agentId, title: brief(draft.title, 200) || id, instruction, acceptanceCriteria,
        difficulty, capability, effort, variantId, access: draft.access, notBefore: scheduledStart(draft.notBefore),
        dependencies: [...new Set(Array.isArray(draft.dependencies) ? draft.dependencies : [])], required: draft.required !== false, state: 'pending' }
    })
    const resolved = new Set(run.delegations.map(task => task.id))
    while (resolved.size < ids.size) {
      const ready = tasks.filter(task => !resolved.has(task.id) && task.dependencies.every(id => resolved.has(id)))
      if (!ready.length) throw new Error('Owner 的任务依赖存在循环或引用了缺失的任务')
      ready.forEach(task => resolved.add(task.id))
    }
    return tasks
  }

  async configureTeam(run, members, signal) {
    if (run.scene.teamStrategy !== 'auto' || !this.prepareTeam) return {}
    const prepared = await this.prepareTeam(run, members, signal)
    signal.throwIfAborted()
    if (!prepared) return {}
    if (prepared.agents) {
      const historical = run.agents.filter(agent => !prepared.agents.some(current => current.id === agent.id)
        && run.delegations.some(task => task.agentId === agent.id))
      run.agents = [...prepared.agents, ...historical]
    }
    if (prepared.ownerId) run.ownerId = prepared.ownerId
    if (prepared.scene) run.scene = prepared.scene
    return prepared.aliases || {}
  }

  workflowHandoff(entry, label, limit = 12000) {
    const message = entry.messageId ? this.store.message?.(entry.messageId)
      || (entry.originRunId && this.store.runMessages(entry.originRunId).find(item => item.id === entry.messageId)) : undefined
    const result = message?.structured
    const detail = label === 'Owner 转交的相关资料' ? entry.text : result ? { summary: result.summary || result.answer, evidence: result.evidence, deliverables: result.deliverables,
      status: result.status, forwardRequest: label === '成员回报' ? result.forwardRequest : undefined } : message?.text || entry.text
    return { label, content: brief(typeof detail === 'string' ? detail : JSON.stringify(detail), limit),
      source: { type: 'agent-message', id: entry.messageId } }
  }

  async performDelegation(run, task, owner, signal) {
    let attempt
    let actual
    const profile = run.agents.find(agent => agent.id === task.agentId)
    try {
      signal.throwIfAborted()
      const variantId = task.profileSelected ? task.variantId : run.profileOverrides?.[profile.id] ?? task.variantId ?? ''
      const chosen = executionAgent(profile, variantId)
      actual = run.scene.teamStrategy === 'auto' && this.routeTask
        ? await this.routeTask(run, chosen, { ...task, variantId, profileSelected: task.profileSelected || Object.hasOwn(run.profileOverrides || {}, profile.id) }, signal) : chosen
      signal.throwIfAborted()
      if (task.access === 'write' && actual.permission === 'read-only') throw new Error('可用模型配置不具备本项任务要求的写入权限')
      task.variantId = variantId
      task.profileName = actual.profileName
      task.model = actual.model
      task.effort = actual.effort
      task.routingReason = actual.routingReason
      const handoffs = task.dependencies.map(id => run.delegations.find(item => item.id === id)).filter(accepted)
        .map(item => this.workflowHandoff(item, '已验收的前置产物'))
      handoffs.push(...(task.forwarded || []).map(item => this.workflowHandoff(item, 'Owner 转交的相关资料')))
      const perform = async (kind, instruction) => {
        attempt = { id: randomUUID(), agentId: profile.id, kind, state: 'working', startedAt: timestamp(), model: actual.model, effort: actual.effort }
        task.attempts ||= []
        task.attempts.push(attempt)
        this.update(run)
        const dispatch = { fromAgentId: owner.id, toAgentId: profile.id, taskId: task.id, attemptId: attempt.id,
          model: actual.model, effort: actual.effort }
        const result = await this.call(run, profile, kind === 'verify' ? `接续核验：${task.title}` : task.title, instruction, signal,
          { readOnly: kind === 'verify' || task.access === 'read', handoffs, effectiveAgent: actual,
            includeHistory: false, workflowTaskId: task.id, operationId: attempt.id,
            onDispatch: () => {
              this.emit(run, 'handoff.sent', { ...dispatch, delivery: 'assignment', text: instruction })
              for (const { text, messageId } of task.forwarded || []) {
                this.emit(run, 'handoff.sent', { ...dispatch, delivery: 'forward', text, messageId, replyTo: messageId })
              }
            },
          })
        attempt.state = 'reported'
        attempt.finishedAt = timestamp()
        attempt.messageId = result.messageId
        attempt.model = result.model || attempt.model
        attempt.effort = result.effort ?? attempt.effort
        return result
      }
      let result
      if (task.needsVerification) {
        const check = await perform('verify', `上次在写入阶段未能确认交付。先只读检查实际文件、持久状态和是否已发生外部操作。
此阶段只核验断点。原任务中的写入、启动和写权限检查由接下来的执行阶段处理，执行权限仍以该阶段实际配置为准。
原任务：${task.instruction}\n验收：${task.acceptanceCriteria}
返回 {summary,evidence:[],recovery:"verified"|"retry"|"blocked"}。已有产物满足当前验收要求时返回 verified。已核对断点且可安全继续时返回 retry，宿主会启动执行阶段。状态不明或执行阶段确有未满足的前置条件时说明证据并返回 blocked。`)
        this.emit(run, 'handoff.sent', { fromAgentId: profile.id, toAgentId: owner.id, taskId: task.id, attemptId: attempt.id,
          delivery: 'reply', text: check.summary || '', messageId: check.messageId, model: check.model, effort: check.effort })
        if (check.recovery === 'verified' && reportStatus(check) === 'completed') result = check
        else if (check.recovery !== 'retry' || reportStatus(check) !== 'completed') {
          throw new Error(`接续核验未确认可安全继续：${brief(check.summary, 350) || '缺少核验依据'}`)
        }
        task.needsVerification = false
        if (!result) handoffs.push(this.workflowHandoff({ ...check, originRunId: run.id }, '已核对的断点状态'))
      }
      if (!result) {
        const recovery = task.attempts?.some(item => item.kind === 'verify')
          ? '只读断点核验已结束，当前是执行阶段。沿用已核对的产物，在实际授权范围内执行剩余操作并保存证据。返回执行阶段的 status 与交付结果。' : ''
        result = await perform('execute', `${task.instruction}\n验收要求：${task.acceptanceCriteria}\n${recovery}\n格式 {summary,status:"completed"|"blocked"|"incomplete",evidence:[],deliverables:[],forwardRequest?:{toAgentId?,question},memoryCandidates:[]}。status 仅表示本项任务的验收情况：本项要求均已实现且有证据时填 completed，即使全局目标还有其他任务未做。没有证据或本项有缺项时说明具体卡点。\n如果工作还没开始但依赖之外只缺运行环境，请报告已经查到的恢复条件。`)
      }
      task.state = reportStatus(result)
      task.messageId = result.messageId
      task.resultRunId = run.id
      task.summary = brief(result.summary || result.answer)
      task.model = result.model || task.model
      task.effort = result.effort ?? task.effort
      task.accepted = false
      task.error = task.state === 'failed'
        ? `本项回报未达到验收条件${result.status ? `（${result.status}）` : ''}：${task.summary || '没有可验收的交付证据'}`
        : undefined
      if (task.state === 'failed' && task.access === 'write') task.needsVerification = true
      if (result.recovery !== 'verified') this.emit(run, 'handoff.sent', { fromAgentId: profile.id, toAgentId: owner.id,
        taskId: task.id, attemptId: attempt.id, delivery: 'reply', text: task.summary || task.error,
        messageId: result.messageId, model: task.model, effort: task.effort })
      this.enqueue(run, { kind: 'report', agentId: profile.id, taskId: task.id, launch: task.launches,
        messageId: result.messageId, originRunId: run.id, text: task.summary || task.error })
    } catch (error) {
      task.state = signal.aborted ? signal.reason?.message === '用户停止任务' ? 'cancelled' : 'interrupted' : 'failed'
      task.error = error.message
      if (task.access === 'write' && attempt?.kind === 'execute') task.needsVerification = true
      if (attempt?.state === 'working') Object.assign(attempt, { state: task.state, finishedAt: timestamp(), error: task.error })
      if (signal.aborted) { this.update(run); return }
      this.emit(run, 'handoff.sent', { fromAgentId: task.agentId, toAgentId: owner.id, taskId: task.id, attemptId: attempt?.id,
        delivery: 'reply', text: task.error, model: actual?.model, effort: actual?.effort })
      this.enqueue(run, { kind: 'report', agentId: task.agentId, taskId: task.id, launch: task.launches, text: task.error })
    }
  }

  retainedOwnerInputs(run, entries) {
    const chain = [run]
    const visited = new Set([run.id])
    while (chain.at(-1).resumeRunId && !visited.has(chain.at(-1).resumeRunId)) {
      const previous = this.store.run(chain.at(-1).resumeRunId)
      if (!previous || previous.scenarioId !== run.scenarioId || previous.sessionId !== run.sessionId) break
      chain.push(previous)
      visited.add(previous.id)
    }
    const currentIds = new Set(entries.filter(isOwnerUserInput).map(ownerUserInputId))
    const retained = new Map()
    for (const source of chain.reverse()) {
      const processed = source.workflow?.inbox.slice(0, source.workflow.cursor).filter(isOwnerUserInput) || []
      for (const entry of [...processed, ...(source.workflow?.ownerAnswers || [])]) {
        const id = ownerUserInputId(entry)
        if (id && !currentIds.has(id)) retained.set(id, { ...entry, originRunId: entry.originRunId || source.id })
      }
    }
    return [...retained.values()].sort((left, right) => (left.at || '').localeCompare(right.at || ''))
  }

  ownerUserHandoffs(run, entries, current) {
    const items = new Map()
    if (!entries.length) return { items }
    const budget = current ? OWNER_CURRENT_USER_BUDGET : OWNER_RETAINED_USER_BUDGET
    let remaining = budget - 120
    let truncated = 0
    for (const entry of [...entries].reverse()) {
      const id = ownerUserInputId(entry)
      if (!id || items.has(id)) continue
      const message = entry.kind === 'user' && entry.messageId ? this.store.message(entry.messageId) : undefined
      const label = `${current ? '' : '此前的'}${entry.kind === 'user' ? '用户补充' : '用户回答'}`
      const prefix = current && message ? `转交时可引用的用户补充消息编号：${id}\n` : `来源编号 ${id}\n`
      const text = entry.question ? `回答：${entry.text}\n问题：${entry.question}` : message?.text || entry.text
      if (!text) continue
      const overhead = estimateTokens(`## ${label}\n${prefix}\n\n`)
      const available = remaining - overhead
      if (available < 40) break
      const excerpt = ownerInputExcerpt(text, available)
      if (excerpt !== text) truncated++
      remaining -= overhead + estimateTokens(excerpt)
      items.set(id, { label, content: prefix + excerpt, source: { type: message ? 'message' : 'owner-user-input', id,
        runId: message?.runId || entry.originRunId || run.id, ...(entry.eventId ? { eventId: entry.eventId } : {}) } })
    }
    const omitted = entries.length - items.size
    const label = current ? '本次用户补充与回答' : '此前已收到的用户补充与回答'
    const summary = { label, content: `采用 ${items.size}/${entries.length} 条。${truncated ? ` ${truncated} 条正文截取。` : ''}${omitted ? ` ${omitted} 条较早内容因预算未注入。` : ''}`,
      source: { type: 'owner-user-input', runId: run.id } }
    return { summary, items }
  }

  async ownerDecision(run, owner, entries, signal, correction = '') {
    const initial = entries.some(entry => entry.kind === 'initial')
    const priorEntries = run.workflow.inbox.slice(0, run.workflow.cursor)
    const canAccept = []
    const graph = run.delegations.map(task => {
      const { id, title, agentId, state, access, dependencies, required, accepted, summary, error, needsVerification, messageId } = task
      const hasReport = entries.some(entry => matchesTaskReport(entry, task)) || priorEntries.some(entry => matchesTaskReport(entry, task))
      if (state === 'completed' && !accepted && hasReport) canAccept.push(id)
      const status = !accepted && !hasReport && ['completed', 'failed'].includes(state) ? 'awaiting_report' : state
      return { id, title, agentId, state: status, access, dependencies, required, accepted, needsVerification, notBefore: task.notBefore,
        ...(canReplaceDependencies(task) ? { canReplaceDependencies: true } : {}),
        ...(hasReport && !accepted ? {
          attemptsRemaining: Math.max(0, MAX_AGENT_LAUNCHES - launchesFor(task, agentId)),
          exhaustedAgentIds: Object.keys(task.launchesByAgent || { [agentId]: task.launches || 0 })
            .filter(id => launchesFor(task, id) >= MAX_AGENT_LAUNCHES),
        } : {}),
        ...(accepted || hasReport ? { summary: brief(summary || error, 300), messageId } : {}) }
    })
    const members = run.agents.map(({ id, name, role, model, effort, permission, variants = [] }) => ({
      id, name, role, model, effort, permission,
      variants: variants.map(({ id, name, difficulty, effort }) => ({ id, name, difficulty, effort })),
    }))
    const retained = this.ownerUserHandoffs(run, this.retainedOwnerInputs(run, entries), false)
    const current = this.ownerUserHandoffs(run, entries.filter(isOwnerUserInput), true)
    const handoffs = [retained.summary, ...[...retained.items.values()].reverse(), current.summary].filter(Boolean)
    for (const entry of entries) {
      if (entry.kind === 'initial') continue
      const handoff = isOwnerUserInput(entry) ? current.items.get(ownerUserInputId(entry))
        : this.workflowHandoff(entry, ({ report: '成员回报', resume: '接续记录', audit: '验收提醒' })[entry.kind] || '本轮消息')
      if (handoff) handoffs.push(handoff)
    }
    handoffs.unshift({ label: '本次允许验收的任务', content: JSON.stringify(canAccept), source: { type: 'run', id: run.id } })
    handoffs.push(...run.delegations.filter(task => task.state === 'completed' && !accepted(task)
      && !entries.some(entry => matchesTaskReport(entry, task)) && priorEntries.some(entry => matchesTaskReport(entry, task))).slice(0, 6)
      .map(task => this.workflowHandoff(task, `待验收的已读回报：${task.title}`, 1800)))
    if (entries.some(entry => entry.kind === 'audit' || entry.kind === 'resume')) {
      const deliverables = run.delegations.filter(task => task.messageId && accepted(task))
      const limit = Math.max(400, Math.min(2500, Math.floor(20000 / deliverables.length)))
      handoffs.push(...deliverables.map(task => this.workflowHandoff(task, `已验收产物：${task.title}`, limit)))
    }
    const stage = initial ? 'Owner 分工' : entries.some(entry => entry.kind === 'audit') ? 'Owner 检查与汇报' : 'Owner 处理回报'
    const verification = [
      '先检查任务图中的 access、状态和现有依赖。已验收且仍适用的证据直接复用。同一证据已有待执行、执行中或等待回报的 access:"write" 步骤时，沿用原任务；需要补充尚未启动的任务说明时，使用原编号的 retryTasks。',
      '独立验收确需新建测试账套、截图或报告，且还没有承担该项取证的可写步骤时，才在现有授权内安排 access:"write" 的隔离步骤，限定可写范围。只读复核使用这一步保存的证据。',
      'exhaustedAgentIds 列出该任务已用尽尝试次数的所有成员，含此前改派过的成员。',
      '对于有明确开始时间的任务，可在 tasks 或 retryTasks 中填 notBefore（含时区的 ISO 8601 时间），例如 2026-11-19T09:02:00+08:00。宿主届时才派发，其间其他就绪任务继续执行。在 retryTasks 设 notBefore:null 可以取消该项的时间限制。',
    ].join(' ')
    return this.call(run, owner, stage, `${verification}\n你统筹任务进度并持续推进到可核验交付。当前任务图 ${JSON.stringify(graph)}。现有成员 ${JSON.stringify(members)}。\n${run.scene.teamStrategy === 'auto' ? '优先用原成员，确有能力缺口时在 members 申请至多两名新成员，并让 tasks 或 retryTasks 的 agentId 引用申请编号。' : '只能使用现有成员。'}\n输出 {summary,answer?,complete?:boolean,outcome?:"answer"|"delivery",evidence?:[],question?:string,blocked?:string,members?:[{id,name,role,capability,difficulty}],tasks?:[{id,agentId,title,instruction,capability,difficulty:"simple"|"medium"|"hard",variantId?:string,effort?:"ultra",dependencies:[],access:"read"|"write",acceptanceCriteria,required?:boolean}],acceptTaskIds?:[],retryTasks?:[{taskId,agentId?,instruction?,dependencies?:[],replaceDependencies?:boolean,reason?:string}],forward?:[{toAgentId,taskId,messageId,text}],memoryCandidates?:[]}。\n按需从所选成员的 variants 选择 id 填入 tasks.variantId，使用该成员的原模型和所选强度。省略时，宿主按任务难度匹配该成员的档位。普通截图核对用 simple；常规档位明显不足的复杂任务才申请 ultra。按已收到的回报推进。看过证据后用 acceptTaskIds 验收；需要修正可用 retryTasks，在 dependencies 追加必须先完成的修复步骤，写入会先核验断点。只有标注 canReplaceDependencies 的任务可以替换前置依赖，同时提交 replaceDependencies:true、完整的 dependencies 列表（可以为空）以及 reason，说明哪项依赖可以调整及依据。原任务的全局验收要求继续生效。若当前成员无法交付，请在已收到且未验收的回报对应的 retryTasks 中给出 agentId、改派原因和下一步，沿用原任务编号和依赖。attemptsRemaining 为零时需要换有能力的成员或说明阻碍。已有任务编号不可重建。把必要的资料转给尚未启动的目标任务；无关成员无需等待。仅在关键授权、范围或决定缺失时问用户；非关键细节按安全合理默认推进。必须有独立验收时分配明确的复核步骤。只有必要任务均验收且没有未满足目标时，complete 才为 true；最终 answer 给出实际成果、使用方式、验收结论和局限。只有纯问答且已提供 evidence 时，才可不委托任务并用 outcome:"answer" 完成。${correction ? `\n上一次决策未通过调度校验：${correction}。请修正后重新提交。` : ''}`, signal,
    { includeHistory: initial, handoffs })
  }

  decisionActions(run, decision, entries, aliases) {
    const created = this.validatePlan(run, decision.tasks ?? [], aliases)
    if (decision.complete === true && !run.delegations.length && !created.length
      && (decision.outcome !== 'answer' || !hasEvidence(decision.evidence))) {
      throw new Error('没有可验收的团队交付；只有带依据的纯问答可由 Owner 直接完成')
    }
    const readEntries = run.workflow.inbox.slice(0, run.workflow.cursor + entries.length)
    const unreadEntries = run.workflow.inbox.slice(run.workflow.cursor + entries.length)
    const readReports = readEntries.filter(entry => entry.kind === 'report')
    const reported = new Set(readReports.map(entry => entry.messageId).filter(Boolean))
    const acceptTasks = [...new Set(decision.acceptTaskIds || [])].map(id => {
      const task = run.delegations.find(item => item.id === id)
      if (task?.state === 'failed' && reported.has(task.messageId)) {
        throw new Error(`任务 ${brief(id)} 的回报未通过，若实际产物可以核验，请用 retryTasks，不要直接验收`)
      }
      if (!task || (!reported.has(task.messageId) && task.accepted !== true) || task.state !== 'completed') throw new Error(`任务 ${brief(id)} 没有已收到的成功回报可验收`)
      return task
    })
    const retryInputs = decision.retryTasks ?? (decision.retryTaskIds || []).map(taskId => ({ taskId }))
    const retryIds = new Set()
    const deferredTasks = new Set()
    const retries = retryInputs.map(draft => {
      const task = run.delegations.find(item => item.id === draft.taskId)
      const replacingDependencies = draft.replaceDependencies === true
      if (draft.replaceDependencies !== undefined && typeof draft.replaceDependencies !== 'boolean') {
        throw new Error('替换前置依赖的标记必须是布尔值')
      }
      let dependencyReason
      if (replacingDependencies) {
        if (!canReplaceDependencies(task)) throw new Error(`只有尚未启动的待执行任务可以替换前置依赖（${brief(draft.taskId, 128)}）`)
        dependencyReason = typeof draft.reason === 'string' ? brief(draft.reason, 800) : ''
        if (!Array.isArray(draft.dependencies) || !dependencyReason) {
          throw new Error('替换前置依赖需要完整的依赖列表与调整原因')
        }
      }
      if (!task || !['pending', 'failed', 'completed'].includes(task.state) || accepted(task) || acceptTasks.includes(task)) {
        throw new Error(`任务 ${brief(draft.taskId)} 已启动或已验收，不能修改或重试`)
      }
      const agentId = draft.agentId === undefined ? task.agentId
        : Object.hasOwn(aliases, draft.agentId) ? aliases[draft.agentId] : draft.agentId
      const replacement = agentId === task.agentId ? undefined : run.agents.find(agent => agent.id === agentId && agent.id !== run.ownerId)
      if (agentId !== task.agentId && !replacement) throw new Error(`任务 ${brief(task.id)} 改派需要一位有效的执行成员`)
      if (replacement && task.state === 'pending') throw new Error(`任务 ${brief(task.id)} 尚未回报，不能按失败改派`)
      if (replacement && task.access === 'write' && replacement.permission === 'read-only') {
        throw new Error(`任务 ${brief(task.id)} 需要写入，不能改派给只读成员`)
      }
      const hasReport = readReports.some(entry => matchesTaskReport(entry, task))
      if (task.state !== 'pending' && !hasReport) {
        if (unreadEntries.some(entry => matchesTaskReport(entry, task))) {
          deferredTasks.add(task.id)
          return undefined
        }
        throw new Error(`任务 ${brief(task.id)} 的新回报仍在队列中，请等读到回报后再决定是否重试或改派`)
      }
      if (launchesFor(task, agentId) >= MAX_AGENT_LAUNCHES) {
        const available = run.agents.filter(agent => agent.id !== run.ownerId && launchesFor(task, agent.id) < MAX_AGENT_LAUNCHES
          && (task.access !== 'write' || agent.permission !== 'read-only')).map(agent => agent.id)
        const next = available.length ? `仍有次数且满足权限的成员编号：${available.join('、')}。请选择适合该任务的成员`
          : run.scene.teamStrategy === 'auto' ? '现有成员已无可用尝试，请申请具备能力的新成员或说明阻碍' : '现有成员已无可用尝试，请说明阻碍'
        throw new Error(`任务 ${brief(task.id)} 的成员 ${brief(agentId, 128)} 已用尽 ${MAX_AGENT_LAUNCHES} 次尝试。${next}`)
      }
      if (retryIds.has(task.id)) throw new Error(`任务 ${brief(task.id)} 在同一决定中只能修改、重试或改派一次`)
      retryIds.add(task.id)
      const dependencies = replacingDependencies ? draft.dependencies : [...task.dependencies, ...(draft.dependencies || [])]
      return { task, replacement, instruction: brief(draft.instruction, 4000), dependencyReason,
        notBefore: draft.notBefore === undefined ? task.notBefore : scheduledStart(draft.notBefore),
        dependencies: [...new Set(dependencies)] }
    }).filter(Boolean)
    if (retries.length) {
      const replacement = new Map(retries.map(entry => [entry.task.id, entry.dependencies]))
      const pending = [...run.delegations, ...created].map(task => ({ id: task.id, dependencies: replacement.get(task.id) || task.dependencies }))
      const resolved = new Set()
      while (resolved.size < pending.length) {
        const ready = pending.filter(task => !resolved.has(task.id) && task.dependencies.every(id => resolved.has(id)))
        if (!ready.length) throw new Error('重试计划引用了不存在的任务或形成依赖循环')
        ready.forEach(task => resolved.add(task.id))
      }
    }
    const transfers = []
    const skippedTransfers = []
    for (const draft of decision.forward || []) {
      const agentId = Object.hasOwn(aliases, draft.toAgentId) ? aliases[draft.toAgentId] : draft.toAgentId
      const task = [...run.delegations, ...created].find(item => item.id === draft.taskId)
      const retry = retries.find(entry => entry.task === task)
      const source = run.delegations.find(item => item.messageId && item.messageId === draft.messageId)
      const userSource = readEntries.find(entry => entry.kind === 'user' && entry.messageId && entry.messageId === draft.messageId)
      const text = brief(draft.text, 4000)
      if (!task || (retry?.replacement?.id || task.agentId) !== agentId || !text) {
        throw new Error('转发需要已存在的目标任务、正确的收件成员及转交内容')
      }
      const sameHandoff = item => item.messageId === draft.messageId && item.text === text
      if (task.forwarded?.some(sameHandoff) || transfers.some(item => item.task === task && sameHandoff(item))) continue
      let originRunId = source && (accepted(source) || reported.has(source.messageId))
        ? source.resultRunId || run.id : userSource && (userSource.originRunId || run.id)
      if (!originRunId) {
        const report = readReports.find(entry => entry.messageId && entry.messageId === draft.messageId)
        if (!report && draft.messageId && unreadEntries.some(entry => entry.messageId === draft.messageId
          && (entry.kind === 'report' || entry.kind === 'user'))) {
          deferredTasks.add(task.id)
          continue
        }
        const message = report && this.store.message(report.messageId)
        const reportRunId = report?.originRunId || run.id
        if (!message?.agentId || message.role !== 'assistant' || message.runId !== reportRunId
          || message.scenarioId !== run.scenarioId || message.sessionId !== run.sessionId
          || (report.agentId && report.agentId !== message.agentId)) {
          throw new Error('转发需要 Owner 已收到的成员回报或用户补充')
        }
        originRunId = reportRunId
      }
      if (task.state !== 'pending' && !retry) {
        skippedTransfers.push(task.id)
        continue
      }
      transfers.push({ task, messageId: draft.messageId, originRunId, text })
    }
    return { created, acceptTasks, retries, transfers, skippedTransfers, deferredTasks }
  }

  applyDecision(run, owner, entries, decision, { created, acceptTasks, retries, transfers, skippedTransfers = [], deferredTasks = new Set() }) {
    const newlyAccepted = acceptTasks.filter(task => task.accepted !== true)
    this.store.transaction(() => {
      run.delegations.push(...created)
      for (const task of acceptTasks) { task.accepted = true; task.acceptedAt ||= timestamp() }
      for (const { task, replacement, dependencies, instruction, dependencyReason, notBefore } of retries) {
        if (replacement) {
          const fromAgentId = task.agentId
          const toAgentId = replacement.id
          const reason = brief(instruction || task.error || task.summary, 400)
          task.launchesByAgent ||= { [fromAgentId]: task.launches || 0 }
          for (const attempt of task.attempts || []) attempt.agentId ||= fromAgentId
          task.reassignments ||= []
          task.reassignments.push({ at: timestamp(), fromAgentId, toAgentId, reason })
          task.agentId = toAgentId
          task.variantId = replacement.variants?.find(variant => variant.difficulty === task.difficulty)?.id || ''
          task.profileSelected = false
          task.model = undefined
          task.profileName = undefined
          task.routingReason = undefined
          this.emit(run, 'owner.decision', { taskId: task.id, text: `改派「${task.title}」给${replacement.name || toAgentId}：${reason}` })
        }
        task.needsVerification = task.access === 'write' && (task.needsVerification || Boolean(task.attempts?.length))
        const previousDependencies = task.dependencies
        task.dependencies = dependencies
        if (dependencyReason && (previousDependencies.length !== dependencies.length
          || dependencies.some(id => !previousDependencies.includes(id)))) {
          const change = `${previousDependencies.join('、') || '无'} → ${dependencies.join('、') || '无'}`
          this.emit(run, 'owner.decision', { taskId: task.id, messageId: decision.messageId, previousDependencies, dependencies,
            reason: dependencyReason, text: `调整「${task.title}」的前置依赖（${change}）。${dependencyReason}` })
        }
        if (notBefore !== task.notBefore) {
          task.notBefore = notBefore
          this.emit(run, 'owner.decision', { taskId: task.id, messageId: decision.messageId,
            text: notBefore ? `安排「${task.title}」在 ${notBefore} 或之后执行。` : `取消「${task.title}」的最早执行时间。` })
        }
        if (instruction) task.instruction = `${task.instruction}\n本次返工要求：${instruction}`.slice(-14000)
        task.state = 'pending'
        task.accepted = false
        task.error = undefined
        task.messageId = undefined
        task.resultRunId = undefined
        task.summary = undefined
      }
      for (const { task, messageId, originRunId, text } of transfers) {
        task.forwarded ||= []
        task.forwarded.push({ messageId, originRunId, text })
        this.emit(run, 'handoff.queued', { fromAgentId: owner.id, toAgentId: task.agentId, taskId: task.id,
          delivery: 'forward', text, messageId, replyTo: messageId })
      }
      if (skippedTransfers.length) {
        this.emit(run, 'owner.decision', {
          text: `这些任务已启动或已结束，新的转交未送达：${[...new Set(skippedTransfers)].join('、')}。需要补充时请另派后续步骤。`,
          messageId: decision.messageId,
        })
      }
      if (deferredTasks.size) {
        this.emit(run, 'owner.decision', { messageId: decision.messageId,
          text: `这些任务引用的回报或补充仍在排队，本次未重试或转交：${[...deferredTasks].join('、')}。读到对应消息后可再安排。` })
      }
      run.workflow.cursor += entries.length
      run.workflow.pendingQuestion = brief(decision.question, 4000)
      run.workflow.lastDecision = brief(decision.summary || decision.answer)
      this.update(run, run.delegations.length ? 'working' : 'planning')
      this.emit(run, 'owner.decision', { text: run.workflow.lastDecision, messageId: decision.messageId })
      this.emit(run, 'owner.inbox.processed', { entryIds: entries.map(entry => entry.id), text: run.workflow.lastDecision })
    })
    if (newlyAccepted.length) this.memoryCompiler?.request(run, 'milestone')
  }

  async orchestrate(run, signal) {
    await this.configureTeam(run, [], signal)
    const owner = run.agents.find(agent => agent.id === run.ownerId)
    if (!owner) throw new Error('没有可用的 Owner，请检查模型接入和场景设置')
    if (!run.workflow.inbox.length) this.recordInbox(run, { kind: 'initial', text: brief(run.text) })
    this.update(run, 'planning')
    const session = this.active.get(run.id)
    const workers = new Map()
    const workerController = new AbortController()
    const workerSignal = AbortSignal.any([signal, workerController.signal])
    const maxParallel = Math.max(1, Math.min(8, Number(run.scene.parallelLimit) || 3))
    let waiter
    let scheduleTimer
    let changed = false
    let workerError
    let dispatchWhileOwnerPending = false
    const wake = () => { changed = true; waiter?.() }
    session.wake = wake
    signal.addEventListener('abort', wake)
    const setScheduleWait = time => {
      const at = time ? new Date(time).toISOString() : undefined
      if (run.workflow.waitingUntil === at) return
      run.workflow.waitingUntil = at
      this.update(run)
    }
    const waitForWork = async () => {
      try {
        if (!changed) await new Promise(resolve => { waiter = resolve })
      } finally {
        waiter = undefined
        changed = false
      }
    }
    const launchReady = () => {
      clearTimeout(scheduleTimer)
      if (workerSignal.aborted || workerError || !run.workflow.cursor || run.workflow.pendingQuestion || run.questions?.length) return
      const now = Date.now()
      let nextStart
      for (const task of run.delegations) {
        if (workerSignal.aborted || workers.size >= maxParallel) break
        if (task.state !== 'pending' || launchesFor(task, task.agentId) >= MAX_AGENT_LAUNCHES
          || !task.dependencies.every(id => accepted(run.delegations.find(item => item.id === id)))) continue
        if ([...workers.keys()].some(other => other.agentId === task.agentId || (other.access === 'write' && task.access === 'write'))) continue
        const earliest = Date.parse(task.notBefore)
        if (earliest > now) {
          nextStart = Math.min(nextStart ?? earliest, earliest)
          continue
        }
        run.workflow.waitingUntil = undefined
        task.state = 'working'
        const workerLaunches = launchesFor(task, task.agentId) + 1
        task.launchesByAgent = { ...task.launchesByAgent, [task.agentId]: workerLaunches }
        task.launches = (task.launches || 0) + 1
        this.update(run)
        const work = this.performDelegation(run, task, owner, workerSignal)
          .catch(error => { workerError = error })
          .finally(() => {
            workers.delete(task)
            try {
              if (dispatchWhileOwnerPending) launchReady()
            } catch (error) { workerError ||= error }
            wake()
          })
        workers.set(task, work)
      }
      if (nextStart) {
        scheduleTimer = setTimeout(() => {
          try {
            if (dispatchWhileOwnerPending) launchReady()
          } catch (error) { workerError ||= error }
          wake()
        }, Math.min(2 ** 31 - 1, Math.max(0, nextStart - Date.now())))
      }
      return nextStart
    }
    let decision
    let deferredOwnerCursor = -1
    try {
      while (true) {
        signal.throwIfAborted()
        if (workerError) throw workerError
        launchReady()
        if (run.workflow.pendingQuestion) {
          const question = run.workflow.pendingQuestion
          const { questionId, ...answers } = await this.ask(run, owner, { ownerQueue: true,
            questions: [{ id: 'clarification', header: '补充信息', question }] }, signal)
          run.workflow.pendingQuestion = ''
          this.enqueue(run, { kind: 'answer', questionId, question, text: JSON.stringify(answers) })
        }
        const inbox = run.workflow.inbox.slice(run.workflow.cursor)
        if (inbox.length) {
          setScheduleWait()
          if (run.scene.inboxPolicy === 'stage' && workers.size && inbox[0].kind === 'report') {
            await waitForWork()
            continue
          }
          if (run.scene.inboxPolicy === 'batch' && workers.size && inbox[0].kind === 'report') {
            const remaining = 250 - (Date.now() - Date.parse(inbox[0].at))
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
          }
          const batchSize = run.scene.inboxPolicy === 'stage' ? 12 : run.scene.inboxPolicy === 'batch' ? 6 : 1
          const entries = run.workflow.inbox.slice(run.workflow.cursor, run.workflow.cursor + batchSize)
          this.emit(run, 'owner.inbox.processing', { entryIds: entries.map(entry => entry.id), text: entries.map(entry => entry.text).join('\n') })
          let correction = ''
          let deferred = false
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              dispatchWhileOwnerPending = attempt === 0
              try { decision = await this.ownerDecision(run, owner, entries, signal, correction) }
              finally { dispatchWhileOwnerPending = false }
              signal.throwIfAborted()
              const aliases = decision.members?.length ? await this.configureTeam(run, decision.members, signal) : {}
              if (workerError) throw workerError
              const actions = this.decisionActions(run, decision, entries, aliases)
              this.applyDecision(run, owner, entries, decision, actions)
              break
            } catch (error) {
              if (signal.aborted || workerError) throw error
              if (attempt) {
                if (!workers.size || deferredOwnerCursor === run.workflow.cursor) throw error
                deferredOwnerCursor = run.workflow.cursor
                deferred = true
                decision = undefined
                this.emit(run, 'owner.decision', { text: `调度暂缓，保留正在执行的任务和待处理回报：${brief(error.message, 400)}` })
                await Promise.allSettled([...workers.values()])
                break
              }
              correction = error.message
              this.emit(run, 'owner.decision', { text: `调度校验要求补充：${brief(correction, 400)}`, messageId: decision?.messageId })
            }
          }
          if (deferred) continue
        }
        signal.throwIfAborted()
        const readyForCompletion = () => !workers.size && run.workflow.cursor === run.workflow.inbox.length && !run.workflow.pendingQuestion
          && !run.questions?.length && run.delegations.every(task => accepted(task) || (task.required === false && task.state === 'failed'))
        if (decision?.complete === true && readyForCompletion()) {
          if (!brief(decision.answer)) throw new Error('Owner 汇报缺少 answer 正文')
          return this.finish(run, 'completed', decision.answer, decision.memoryCandidates, decision.summary)
        }
        const nextStart = launchReady()
        if (run.workflow.cursor < run.workflow.inbox.length || run.workflow.pendingQuestion) continue
        if (!workers.size) {
          if (nextStart) {
            setScheduleWait(nextStart)
            await waitForWork()
            continue
          }
          setScheduleWait()
          if (!run.workflow.finalCheck && run.delegations.length) {
            run.workflow.finalCheck = true
            this.enqueue(run, { kind: 'audit', text: '根据任务状态和验收证据检查全局目标。若还有可执行工作请继续分工，否则汇报完成或准确指出阻碍。' })
            continue
          }
          for (const task of run.delegations) {
            if (task.state === 'pending' && task.dependencies.some(id => !accepted(run.delegations.find(item => item.id === id)))) task.state = 'blocked'
          }
          const pending = run.delegations.filter(task => task.required !== false && !accepted(task))
          const details = pending.slice(0, 5).map(task => `${task.title}${task.error ? `：${brief(task.error, 160)}` : '：未验收'}`).join('；')
          const reason = brief(decision?.blocked || details || decision?.answer, 2000) || '缺少可验收的交付结果或进一步分工。'
          return this.finish(run, 'incomplete', `任务尚未完成。${reason}`)
        }
        run.workflow.finalCheck = false
        await waitForWork()
      }
    } catch (error) {
      if (!signal.aborted && workers.size) {
        this.emit(run, 'owner.decision', { text: `Owner 无法继续决策，等待当前成员保存结果后停止：${brief(error.message, 400)}` })
        await Promise.allSettled([...workers.values()])
      }
      throw error
    } finally {
      clearTimeout(scheduleTimer)
      delete session.wake
      delete run.workflow.waitingUntil
      signal.removeEventListener('abort', wake)
      workerController.abort(new Error('统筹调度结束'))
      await Promise.allSettled([...workers.values()])
    }
  }

  incomplete(run, results) {
    const failures = results.filter(result => result.error).map(result => `${run.agents.find(agent => agent.id === result.agentId)?.name || result.agentId} ${result.error}`)
    this.finish(run, 'incomplete', `本轮协作尚未完成。${failures.join('。')}。已完成的成员工作保存在右侧。`)
  }

  finish(run, state, answer, candidates = [], summary) {
    if (this.disposed) return
    run.state = state
    run.finalResult = answer
    run.finishedAt = timestamp()
    run.questions = []
    this.store.transaction(() => {
      const message = this.store.addMessage({ scenarioId: run.scenarioId, sessionId: run.sessionId, runId: run.id, role: 'assistant', text: answer, summary, state,
        agentName: run.mode === 'orchestration' ? run.agents.find(agent => agent.id === run.ownerId)?.name : '统一结论' })
      this.emit(run, 'message.added', { message })
      if (state === 'completed') this.consolidate(run, [...(Array.isArray(candidates) ? candidates : []).map(candidate => ({ ...candidate, sourceMessageId: message.id })), ...(run.roleMemoryCandidates || [])])
      this.store.saveRun(run)
      this.emit(run, 'run.finished', { run })
    })
    if (state === 'completed') this.memoryCompiler?.request(run, 'run-complete')
    else if (state === 'incomplete' || state === 'failed' || state === 'disputed') this.memoryCompiler?.request(run, 'run-incomplete')
  }

  consolidate(run, candidates) {
    const existing = this.store.memories(run.scenarioId)
    const write = (entry, candidate) => {
      const prior = existing.find(memory => memory.content === entry.content && memory.status !== 'deleted'
        && (memory.audience || 'scene') === (entry.audience || 'scene') && (memory.roleId || '') === (entry.roleId || ''))
      if (prior) return
      const sourceAgentId = candidate.sourceAgentId || (run.mode === 'orchestration' ? run.ownerId : run.scene.summarizerId)
      const memory = this.store.saveMemory(entry, undefined, { trigger: 'run-complete', sessionId: run.sessionId, runId: run.id,
        messageId: entry.sources[0].messageId, actor: run.agents.find(agent => agent.id === sourceAgentId)?.name, reason: candidate.reason })
      existing.push(memory)
      this.emit(run, 'memory.changed', { memory })
    }
    if (!Array.isArray(candidates)) return
    for (const candidate of candidates.slice(0, 12)) {
      if (typeof candidate.title !== 'string' || typeof candidate.content !== 'string' || !candidate.content.trim()) continue
      const audience = candidate.audience === 'role' ? 'role' : 'scene'
      const roleId = audience === 'role' ? (run.agents.find(agent => (agent.roleId || agent.id) === candidate.roleId)?.roleId || candidate.roleId
        || run.agents.find(agent => agent.id === (run.mode === 'orchestration' ? run.ownerId : run.scene.summarizerId))?.roleId
        || (run.mode === 'orchestration' ? run.ownerId : run.scene.summarizerId)) : ''
      if (audience === 'role' && !run.agents.some(agent => (agent.roleId || agent.id) === roleId)) continue
      const conflicting = existing.find(entry => entry.title === candidate.title && entry.content !== candidate.content && entry.status === 'confirmed'
        && (entry.audience || 'scene') === audience && (entry.roleId || '') === roleId)
      write({ scenarioId: run.scenarioId, title: candidate.title.slice(0, 200), content: candidate.content.slice(0, 20000),
        audience, roleId,
        kind: MEMORY_KINDS.has(candidate.kind) ? candidate.kind : 'learning',
        status: conflicting ? 'conflict' : 'candidate', conflictsWith: conflicting ? [conflicting.id] : [],
        sources: [{ type: 'run', id: run.id, sessionId: run.sessionId, messageId: candidate.sourceMessageId || run.userMessageId, evidence: candidate.evidence || [] }] }, candidate)
    }
  }

  rememberUserRequest(run) {
    if (!/^(?:(?:请(?:你)?(?:帮我)?|帮我)\s*)?(?:记住|记下来|把(?:这条|这件事|以下内容)记(?:住|下来))/.test(run.text.trimStart())) return
    if (this.store.memories(run.scenarioId).some(memory => memory.content === run.text && memory.status !== 'deleted')) return
    const memory = this.store.saveMemory({ scenarioId: run.scenarioId, title: run.text.slice(0, 60), content: run.text,
      kind: 'constraint', status: 'confirmed', sources: [{ type: 'user-message', id: run.userMessageId, runId: run.id, sessionId: run.sessionId }] },
    undefined, { trigger: 'user-request', actor: 'user', sessionId: run.sessionId, runId: run.id, messageId: run.userMessageId })
    this.emit(run, 'memory.changed', { memory })
  }

  setProfile(runId, { agentId, variantId = '', taskId }) {
    const run = this.active.get(runId)?.run
    if (!run) throw new Error('这项任务已结束，请在团队页调整下一轮配置')
    const agent = run.agents.find(item => item.id === agentId)
    if (!agent) throw new Error('任务中没有这位成员')
    executionAgent(agent, variantId)
    if (taskId) {
      const task = run.delegations?.find(item => item.id === taskId && item.agentId === agentId)
      if (!task || task.state !== 'pending') throw new Error('这项分工已经开始，请调整后续步骤的强度')
      task.variantId = variantId
      task.profileSelected = true
    } else {
      run.profileOverrides = { ...run.profileOverrides, [agentId]: variantId }
    }
    this.update(run)
    return run
  }

  syncProfiles(scene) {
    for (const { run } of this.active.values()) {
      if (run.scenarioId !== scene.id) continue
      for (const member of run.agents) {
        const current = scene.agents.find(agent => agent.id === member.id)
        if (!current || current.engine !== member.engine || current.model !== member.model || current.provider !== member.provider
          || (current.agentProvider || '') !== (member.agentProvider || '')) continue
        member.effort = current.effort
        // Pending assignments can still refer to a profile removed from team settings.
        member.variants = [...new Map([...(member.variants || []), ...(current.variants || [])].map(variant => [variant.id, structuredClone(variant)])).values()]
      }
      this.update(run)
    }
  }

  ask(run, agent, params, signal) {
    const id = randomUUID()
    if (!(run.questions || []).length) run.questionResumeState = run.state
    return new Promise((resolve, reject) => {
      const onAbort = () => settle(undefined, new Error('任务已停止'))
      const settle = (answer, error) => {
        signal.removeEventListener('abort', onAbort)
        this.questions.delete(id)
        run.questions = (run.questions || []).filter(question => question.id !== id)
        if (!signal.aborted && !this.disposed && !FINAL_STATES.has(run.state)) this.update(run, run.questions.length ? 'waiting_user' : run.questionResumeState)
        error ? reject(error) : resolve(params.ownerQueue ? { ...answer, questionId: id } : answer)
      }
      this.questions.set(id, { runId: run.id, resolve: answer => settle(answer), reject: error => settle(undefined, error) })
      run.questions = [...(run.questions || []), { id, agentId: agent.id, agentName: agent.name, questions: params.questions || [],
        kind: params.kind || 'question', details: params.details || '', ...(params.ownerQueue ? { ownerQueue: true } : {}) }]
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) { onAbort(); return }
      this.update(run, 'waiting_user')
      this.emit(run, 'user.question', { questionId: id, agentId: agent.id, questions: params.questions || [] })
    })
  }

  answer(runId, questionId, answers) {
    const question = this.questions.get(questionId)
    if (!question || question.runId !== runId) throw new Error('这个提问已经结束，请刷新当前任务')
    const run = this.active.get(runId)?.run
    const request = run?.questions?.find(item => item.id === questionId)
    if (!answers || typeof answers !== 'object' || !request?.questions.every(item =>
      Array.isArray(answers[item.id]?.answers) && answers[item.id].answers.some(value => typeof value === 'string' && value.trim()))) {
      throw new Error('请填写每个问题的回答')
    }
    if (request.kind === 'approval' && !request.questions.every(item => ['允许本次', '拒绝'].includes(answers[item.id]?.answers?.[0]))) {
      throw new Error('请选择允许本次或拒绝')
    }
    const responses = request.questions.map(item => answers[item.id].answers.join('、'))
    this.store.transaction(() => {
      const event = this.emit(run, 'user.answered', { questionId, agentId: request.agentId, text: responses.join('；') })
      if (run.workflow && request.agentId === run.ownerId && request.kind === 'question' && !request.ownerQueue) {
        const text = request.questions.map((item, index) => `回答：${responses[index]}\n问题：${item.question || item.header}`).join('\n\n')
        run.workflow.ownerAnswers ||= []
        run.workflow.ownerAnswers.push({ kind: 'answer', questionId, eventId: event?.eventId, at: event?.at, text })
        this.store.saveRun(run)
      }
    })
    question.resolve({ answers })
  }

  cancel(runId) {
    const operation = this.active.get(runId)
    if (!operation) return this.store.run(runId)
    this.update(operation.run, 'cancelling')
    operation.controller.abort(new Error('用户停止任务'))
    return operation.run
  }

  async serialWrite(key, operation, signal) {
    const previous = this.writeQueues.get(key) || Promise.resolve()
    const current = previous.then(operation, operation)
    const tail = current.then(() => undefined, () => undefined)
    this.writeQueues.set(key, tail)
    void tail.then(() => { if (this.writeQueues.get(key) === tail) this.writeQueues.delete(key) })
    if (!signal) return current
    let abort
    const stopped = new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    try { return await Promise.race([current, stopped]) }
    finally { signal.removeEventListener('abort', abort) }
  }

  async dispose() {
    for (const operation of this.active.values()) operation.controller.abort(new Error('插件已重载'))
    await this.closeAgents()
    await Promise.allSettled([...this.active.values()].map(operation => operation.promise))
    this.disposed = true
  }
}
