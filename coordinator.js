import { randomUUID } from 'node:crypto'
import { estimateTokens, relevantMemories } from './scenario-store.js'

const FINAL_STATES = new Set(['completed', 'disputed', 'incomplete', 'failed', 'cancelled', 'interrupted'])
const OUTPUT_CONTRACT = `只输出一个 JSON 对象。所有面向用户的内容使用中文，保留必要专业名称。
团队分工使用 tasks 字段中的已配置成员编号，由宿主定向交付和回收。summary 给出用户可独立阅读的简短结论，最多三句话。完整依据放入 evidence。
证据必须来自实际读取或执行，描述操作、文件路径与结果。需要用户补充时使用 question 字段。
memoryCandidates 可包含 {title,content,kind,evidence,audience:"scene"|"role"}。项目事实与共同约束使用 scene，当前角色的工作方法与经验使用 role。`

function executionAgent(agent, variantId = '') {
  if (!variantId) return { ...agent, baseName: agent.name, profileName: '默认强度' }
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
  constructor({ store, runAgent, loadSkills, publish, closeAgents }) {
    this.store = store
    this.runAgent = runAgent
    this.loadSkills = loadSkills
    this.publish = publish
    this.closeAgents = closeAgents
    this.active = new Map()
    this.questions = new Map()
    this.writeQueues = new Map()
    this.disposed = false
    for (const run of store.interruptedRuns()) {
      run.state = 'interrupted'
      run.finishedAt = new Date().toISOString()
      for (const task of run.tasks || []) {
        if (task.state === 'working') task.state = 'interrupted'
      }
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
    if (state) run.state = state
    run.updatedAt = new Date().toISOString()
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
    if (scene.agents.length < 2) throw new Error('协作需要至少两位成员')
    if (scene.mode === 'orchestration' && !scene.agents.some(agent => agent.id === scene.ownerId)) throw new Error('请先选择本次任务的 Owner')
    const previous = resumeRunId ? this.store.run(resumeRunId) : undefined
    if (resumeRunId && (!previous || previous.scenarioId !== scene.id || !FINAL_STATES.has(previous.state))) throw new Error('无法接续这条任务')
    const run = {
      id: randomUUID(), scenarioId: scene.id, sessionId, dshSessionId, requestId, text, attachments,
      mode: scene.mode, ownerId: scene.ownerId, agents: structuredClone(scene.agents),
      scene: structuredClone(scene), state: 'queued', tasks: [], reviews: [],
      createdAt: new Date().toISOString(), resumeRunId: previous?.id,
      resumeContext: previous ? this.resumeContext(previous) : '',
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
    return JSON.stringify({ request: run.text, state: run.state, tasks: run.tasks, result: run.finalResult,
      instruction: '接续前先核对已完成操作与实际状态，再推进尚未完成的工作。' })
  }

  async perform(run, signal) {
    try {
      if (run.mode === 'orchestration') await this.orchestrate(run, signal)
      else await this.verify(run, signal)
    } catch (error) {
      if (this.disposed) return
      run.error = error.message
      const cancelled = signal.aborted
      for (const task of run.tasks) {
        if (['working', 'pending'].includes(task.state)) task.state = cancelled ? 'cancelled' : 'failed'
      }
      for (const task of run.delegations || []) {
        if (['working', 'pending'].includes(task.state)) task.state = cancelled ? 'cancelled' : 'failed'
      }
      this.finish(run, cancelled ? 'cancelled' : 'failed', cancelled ? '任务已停止。已完成操作与成员记录可以在右侧查看。' : `本轮任务中断。${error.message}`)
    } finally {
      for (const [id, pending] of this.questions) {
        if (pending.runId === run.id) {
          this.questions.delete(id)
          pending.reject(new Error('任务已结束'))
        }
      }
    }
  }

  async call(run, agent, stage, instruction, signal, { readOnly = true, handoffs = [], variantId } = {}) {
    signal.throwIfAborted()
    agent = executionAgent(agent, variantId ?? run.profileOverrides?.[agent.id] ?? '')
    const scene = run.scene
    const operationId = randomUUID()
    const selected = relevantMemories(this.store.memories(scene.id), run.text, 2400, agent.roleId || agent.id)
    const history = this.store.messages(scene.id, undefined, 16, run.sessionId)
      .filter(message => !message.agentId && message.runId !== run.id)
      .map(message => `${message.role === 'user' ? '用户' : '团队'} ${message.text.slice(0, 2000)}`).join('\n')
    const skills = await this.loadSkills(agent, scene, signal)
    const items = [
      { category: 'role', label: '角色与协作规则', content: `你是 ${agent.name}，职责为 ${agent.role}。当前阶段为 ${stage}。围绕本轮任务的验收要求开展工作，历史消息提供背景，最终回答遵循本轮用户要求。${readOnly ? '本阶段进行读取、调研和审查，所有实际修改交由执行阶段。' : '按用户任务及已有授权执行，核对实际结果。'}\n${OUTPUT_CONTRACT}`, source: { type: 'agent', id: agent.id, revision: scene.revision } },
      { category: 'scene', label: '场景概况', content: `${scene.title}\n${scene.brief || ''}\n工作区 ${scene.cwd}`, source: { type: 'scenario', id: scene.id, revision: scene.revision } },
      { category: 'task', label: '本轮任务', content: `${run.text}\n\n${instruction}`, source: { type: 'message', id: run.userMessageId } },
      ...selected.map(entry => ({ category: 'memory', label: entry.title, content: `[${entry.status}] ${entry.content}`, reason: entry.reason,
        source: { type: 'memory', id: entry.id, revision: entry.revision, audience: entry.audience || 'scene', roleId: entry.roleId || '', sources: entry.sources } })),
      ...skills.map(skill => ({ category: 'skill', label: skill.name, content: skill.content, source: { type: 'skill', name: skill.name, path: skill.path } })),
      ...handoffs.map(message => ({ category: 'handoff', label: message.label, content: message.content, source: message.source })),
    ]
    if (history) items.push({ category: 'history', label: '近期主聊天', content: history, source: { type: 'history', scenarioId: scene.id } })
    if (run.resumeContext) items.push({ category: 'history', label: '中断任务接续', content: run.resumeContext, source: { type: 'run', id: run.resumeRunId } })
    if (run.attachments.length) items.push({ category: 'attachment', label: '本轮附件', content: run.attachments.map(file => `${file.name} ${file.path}`).join('\n'), source: { type: 'attachment', files: run.attachments } })
    const prompt = items.map(item => `## ${item.label}\n${item.content}`).join('\n\n')
    const context = this.store.addContext({ scenarioId: scene.id, runId: run.id, agentId: agent.id, operationId, stage,
      engine: agent.engine, kind: 'stage', status: 'working', variantId: agent.variantId,
      agentProvider: agent.agentProvider || '', permissionSource: agent.engine === 'agent' ? 'provider-config' : agent.engine === 'codex' ? 'sandbox' : 'tool-filter',
      effectiveConfig: { model: agent.model, effort: agent.effort, profileName: agent.profileName },
      items: items.map(item => ({ ...item, estimatedTokens: estimateTokens(item.content) })), estimatedTokens: estimateTokens(prompt),
      sourceCoverage: '插件组装的完整请求材料。引擎额外注入的内容按运行时事件记录。', readOnly })
    this.emit(run, 'context.created', { agentId: agent.id, contextId: context.id, stage })
    const task = { id: operationId, agentId: agent.id, title: stage, state: 'working', readOnly,
      variantId: agent.variantId || '', effort: agent.effort, profileName: agent.profileName }
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
    const execute = () => this.runAgent({ run, agent, stage, prompt, signal, readOnly, contextId: context.id,
      onQuestion: params => this.ask(run, agent, params, signal),
      onDelta: delta => {
        buffer += delta
        if (!timer) timer = setTimeout(flush, 100)
      },
      onEvent: (type, payload) => {
        this.emit(run, type, { agentId: agent.id, operationId, ...payload })
        if (payload.usage) this.store.updateContext(context.id, { reportedUsage: payload.usage })
        if (payload.contextWindow) this.store.updateContext(context.id, { contextWindow: payload.contextWindow })
        if (payload.threadId) this.store.updateContext(context.id, { threadId: payload.threadId,
          effectiveConfig: { model: payload.model, provider: payload.provider, effort: payload.effort, readOnly } })
      },
    })
    try {
      this.emit(run, 'agent.started', { agentId: agent.id, operationId, stage })
      const result = readOnly ? await execute() : await this.serialWrite(scene.cwd, execute)
      signal.throwIfAborted()
      raw = result.answer || ''
      if (result.status && result.status !== 'completed') throw new Error(`${agent.name} 未完成本阶段，状态 ${result.status}${result.diagnostic ? `。${result.diagnostic}` : ''}`)
      const parsed = parseResult(raw)
      const roleCandidates = Array.isArray(parsed.memoryCandidates)
        ? parsed.memoryCandidates.filter(candidate => candidate.audience === 'role') : []
      run.roleMemoryCandidates = [...(run.roleMemoryCandidates || []), ...roleCandidates.map(candidate => ({ ...candidate,
        roleId: agent.roleId || agent.id, sourceAgentId: agent.id }))]
      const message = this.store.addMessage({ scenarioId: scene.id, sessionId: run.sessionId, runId: run.id, agentId: agent.id, agentName: agent.name,
        variantId: agent.variantId || '', effort: agent.effort, profileName: agent.profileName,
        operationId, role: 'assistant', stage, text: parsed.summary || parsed.answer || raw, raw, structured: parsed })
      messageSaved = true
      task.state = 'completed'
      task.messageId = message.id
      task.summary = String(parsed.summary || parsed.answer || '').slice(0, 1200)
      this.store.updateContext(context.id, { finishedAt: new Date().toISOString(), response: raw, status: 'completed' })
      flush()
      this.emit(run, 'message.added', { message })
      this.emit(run, 'agent.completed', { agentId: agent.id, operationId })
      this.update(run)
      return { ...parsed, agentId: agent.id, roleId: agent.roleId || agent.id, messageId: message.id }
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
    let proposals = await this.collect(run, run.agents, '独立处理',
      '独立调查并提出完成任务的方案。格式 {summary,evidence:[],needsExecution:boolean,proposedActions:[],memoryCandidates:[]}。needsExecution 只在用户任务需要实际修改或执行时为 true。', signal)
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

  validatePlan(run, plan) {
    if (!Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > 12) throw new Error('Owner 的分工需要包含 1 至 12 项任务')
    const ids = new Set()
    const tasks = plan.tasks.map(task => {
      if (typeof task.id !== 'string' || !task.id || ids.has(task.id)) throw new Error('Owner 返回了重复或缺失的任务编号')
      ids.add(task.id)
      if (!run.agents.some(agent => agent.id === task.agentId)) throw new Error('Owner 分配了不存在的成员')
      if (typeof task.instruction !== 'string' || !task.instruction.trim()) throw new Error('分工缺少任务说明')
      const agent = run.agents.find(agent => agent.id === task.agentId)
      const variantId = task.variantId || agent.variants?.find(variant => variant.difficulty === task.difficulty)?.id || ''
      executionAgent(agent, variantId)
      return { ...task, variantId, dependencies: Array.isArray(task.dependencies) ? task.dependencies : [], access: task.access === 'read' ? 'read' : 'write', state: 'pending' }
    })
    const done = new Set()
    while (done.size < tasks.length) {
      const ready = tasks.filter(task => !done.has(task.id) && task.dependencies.every(id => done.has(id)))
      if (!ready.length) throw new Error('Owner 的任务依赖存在循环或引用了缺失的任务')
      ready.forEach(task => done.add(task.id))
    }
    return tasks
  }

  async orchestrate(run, signal) {
    const owner = run.agents.find(agent => agent.id === run.ownerId)
    this.update(run, 'planning')
    let plan = await this.call(run, owner, 'Owner 分工',
      `将用户任务分给合适成员。成员 ${JSON.stringify(run.agents.map(({ id, name, role, effort, variants }) => ({ id, name, role, effort, variants })))}。
      格式 {summary,question?:string,tasks:[{id,agentId,variantId?:string,difficulty:"simple"|"medium"|"hard",title,instruction,dependencies:[],access:"read"|"write",acceptanceCriteria}]}。
      按任务难度选择该成员已配置的扩展成员 variantId，简单任务使用低强度，复杂任务使用高强度。模型、技能与角色记忆沿用原成员。
      每项任务可独立验收。修改与执行选择 write，资料读取与审查选择 read。`, signal)
    if (typeof plan.question === 'string' && plan.question.trim()) {
      const answers = await this.ask(run, owner, { questions: [{ id: 'clarification', header: '补充信息', question: plan.question }] }, signal)
      plan = await this.call(run, owner, '补充信息后分工',
        `根据用户回答继续分工。格式 {summary,tasks:[{id,agentId,title,instruction,dependencies:[],access:"read"|"write",acceptanceCriteria}]}。\n用户回答 ${JSON.stringify(answers)}`, signal,
        { handoffs: [this.handoff(plan, 'Owner 初步判断')] })
    }
    const results = []
    for (let pass = 0; pass < 2; pass++) {
      const tasks = this.validatePlan(run, plan)
      run.delegations = [...(run.delegations || []), ...tasks.map(task => ({ ...task, id: `${pass}-${task.id}`, planTaskId: task.id }))]
      this.update(run, 'working')
      const completed = new Set()
      while (completed.size < tasks.length) {
        const ready = tasks.filter(task => !completed.has(task.id) && task.dependencies.every(id => completed.has(id)))
        for (const task of ready) {
          signal.throwIfAborted()
          const member = run.agents.find(agent => agent.id === task.agentId)
          const displayed = run.delegations.find(entry => entry.id === `${pass}-${task.id}`)
          const variantId = displayed.profileSelected ? displayed.variantId : run.profileOverrides?.[member.id] ?? displayed.variantId ?? ''
          const profile = executionAgent(member, variantId)
          displayed.variantId = variantId
          displayed.profileName = profile.profileName
          displayed.effort = profile.effort
          displayed.state = 'working'
          this.emit(run, 'handoff.sent', { fromAgentId: owner.id, toAgentId: member.id, taskId: displayed.id, text: task.instruction })
          this.update(run)
          const result = await this.call(run, member, task.title || '成员执行',
            `${task.instruction}\n验收要求 ${task.acceptanceCriteria || '完成用户目标并提供执行证据'}\n格式 {summary,evidence:[],memoryCandidates:[]}。`, signal,
            { readOnly: task.access === 'read', variantId,
              handoffs: results.map(result => this.handoff(result, '已有成员产物')) })
          results.push(result)
          completed.add(task.id)
          displayed.state = 'completed'
          displayed.messageId = result.messageId
          displayed.summary = result.summary
          this.emit(run, 'handoff.sent', { fromAgentId: member.id, toAgentId: owner.id, taskId: displayed.id, text: result.summary || '' })
          this.update(run)
        }
      }
      this.update(run, 'checking')
      const check = await this.call(run, owner, 'Owner 检查与汇报',
        '核对任务目标与成员实际产物。格式 {answer,summary,complete:boolean,tasks:[],memoryCandidates:[]}。工作已完成时 complete 为 true。需要返工时 tasks 使用原分工格式，并在 answer 中说明当前进展。给用户的 answer 通常 150 至 300 字。', signal,
        { handoffs: results.map(result => this.handoff(result, '成员交付物')) })
      if (check.complete === true) {
        if (typeof check.answer !== 'string' || !check.answer.trim()) throw new Error('Owner 汇报缺少 answer 正文')
        return this.finish(run, 'completed', check.answer, check.memoryCandidates, check.summary)
      }
      if (pass === 1 || !Array.isArray(check.tasks) || !check.tasks.length) {
        return this.finish(run, 'incomplete', check.answer || 'Owner 检查后仍有待完成工作，详见成员记录。')
      }
      plan = check
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
    run.finishedAt = new Date().toISOString()
    this.store.transaction(() => {
      const message = this.store.addMessage({ scenarioId: run.scenarioId, sessionId: run.sessionId, runId: run.id, role: 'assistant', text: answer, summary, state,
        agentName: run.mode === 'orchestration' ? run.agents.find(agent => agent.id === run.ownerId)?.name : '统一结论' })
      this.emit(run, 'message.added', { message })
      if (state === 'completed') this.consolidate(run, [...(Array.isArray(candidates) ? candidates : []), ...(run.roleMemoryCandidates || [])])
      this.store.saveRun(run)
      this.emit(run, 'run.finished', { run })
    })
  }

  consolidate(run, candidates) {
    const existing = this.store.memories(run.scenarioId)
    const write = (entry) => {
      const prior = existing.find(memory => memory.content === entry.content && memory.status !== 'deleted'
        && (memory.audience || 'scene') === (entry.audience || 'scene') && (memory.roleId || '') === (entry.roleId || ''))
      if (prior) return
      const memory = this.store.saveMemory(entry)
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
        kind: ['fact', 'decision', 'preference', 'constraint', 'blocker', 'learning', 'note'].includes(candidate.kind) ? candidate.kind : 'learning',
        status: conflicting ? 'conflict' : 'candidate', conflictsWith: conflicting ? [conflicting.id] : [],
        sources: [{ type: 'run', id: run.id, evidence: candidate.evidence || [] }] })
    }
  }

  rememberUserRequest(run) {
    if (!/(?:请)?记住|记下来|以后(?:都|请|要|按)|今后(?:都|请|要|按)/.test(run.text)) return
    if (this.store.memories(run.scenarioId).some(memory => memory.content === run.text && memory.status !== 'deleted')) return
    const memory = this.store.saveMemory({ scenarioId: run.scenarioId, title: run.text.slice(0, 60), content: run.text,
      kind: 'constraint', status: 'confirmed', sources: [{ type: 'user-message', id: run.userMessageId, runId: run.id }] })
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
        if (!signal.aborted && !this.disposed) this.update(run, run.questions.length ? 'waiting_user' : run.questionResumeState)
        error ? reject(error) : resolve(answer)
      }
      this.questions.set(id, { runId: run.id, resolve: answer => settle(answer), reject: error => settle(undefined, error) })
      run.questions = [...(run.questions || []), { id, agentId: agent.id, agentName: agent.name, questions: params.questions || [] }]
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
    question.resolve({ answers })
  }

  cancel(runId) {
    const operation = this.active.get(runId)
    if (!operation) return this.store.run(runId)
    this.update(operation.run, 'cancelling')
    operation.controller.abort(new Error('用户停止任务'))
    return operation.run
  }

  async serialWrite(key, operation) {
    const previous = this.writeQueues.get(key) || Promise.resolve()
    const current = previous.then(operation, operation)
    const tail = current.then(() => undefined, () => undefined)
    this.writeQueues.set(key, tail)
    try { return await current }
    finally { if (this.writeQueues.get(key) === tail) this.writeQueues.delete(key) }
  }

  async dispose() {
    for (const operation of this.active.values()) operation.controller.abort(new Error('插件已重载'))
    await this.closeAgents()
    await Promise.allSettled([...this.active.values()].map(operation => operation.promise))
    this.disposed = true
  }
}
