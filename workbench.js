const STATE_LABELS = {
  queued: '等待开始', independent: '独立处理', reviewing: '交叉验证', resolving: '补充核实', synthesizing: '汇总结论',
  planning: 'Owner 分工', working: '成员执行', checking: '检查交付', waiting_user: '等待你的补充', cancelling: '正在停止',
  stage_completed: '阶段完成', blocked: '依赖受阻', completed: '已完成', disputed: '存在分歧', incomplete: '尚未完成', failed: '执行失败', cancelled: '已停止', interrupted: '运行中断',
  confirmed: '已确认', candidate: '待核实', conflict: '存在冲突', expired: '已过期', archived: '已归档', deleted: '已移除', pending: '待处理',
}
const TERMINAL = new Set(['completed', 'disputed', 'incomplete', 'failed', 'cancelled', 'interrupted'])
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const badge = state => `<span class="sc-badge ${['completed', 'confirmed'].includes(state) ? 'good' : ['failed', 'conflict'].includes(state) ? 'error' : ['candidate', 'disputed', 'incomplete', 'interrupted', 'blocked'].includes(state) ? 'warn' : ''}">${esc(STATE_LABELS[state] || state)}</span>`
const prose = text => String(text ?? '').split(/```[^\n]*\n([\s\S]*?)```/g).map((part, index) => index % 2 ? `<pre>${esc(part)}</pre>` : esc(part)).join('')
const time = at => at ? new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
const historyTime = at => at ? new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
const fullTime = at => at ? new Date(at).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
const collaborationEvent = event => ['handoff.queued', 'handoff.sent', 'owner.decision', 'user.question', 'user.answered', 'run.interrupted', 'run.finished'].includes(event.type)
  || event.type?.startsWith('owner.inbox.') || (event.type === 'message.added' && !event.message?.agentId)
const eventBody = event => event.text || event.message?.text || (event.type === 'user.question' ? event.questions?.map(question => question.question || question.header).join('\n') : '')
const historyPage = () => ({ loaded: false, loading: false, hasOlder: false, before: undefined, error: '', events: new Map() })


export async function mountWorkbench(root, options = {}) {
  const { createContextDashboard } = await import(`./context-dashboard.js?v=${Date.now()}`)
  const { renderTeamSettings, renderMemberPopover, memberModelName, effortLabel, renderMemoryPage, renderScenePicker, renderFolderPicker, renderSkillEditor, renderSkillViewer, renderSessionCreator, supportsMemberModel, profileOptions } = await import(`./workbench-views.js?v=${Date.now()}`)
  const base = options.apiBase || '/codex-chat/v2'
  const lifetime = new AbortController()
  let source
  let alive = true
  let refreshTimer
  let saveQueue = Promise.resolve()
  let catalogRequest
  let sceneGeneration = 0
  let memberDrag
  let openSelect
  let pendingRender = false
  const detailStates = new Map()
  const memberScrolls = new Map()
  const memberWeights = new Map()
  const timelines = new Map()
  const memberHistories = new Map()
  let collaboration = historyPage()
  let participantCatalog = new Map()
  let loadingInboxReplay = false
  let inboxReplayAfter
  let memoryHistoryRequest = 0
  let pendingSource
  let pendingSend
  const state = {
    scene: undefined, runs: [], messages: [], sequence: 0, hasOlder: false, view: 'chat', draft: '', attachments: [],
    error: '', notice: '', busy: false, uploading: false, showProcesses: true, mobilePane: 'main', collapsed: new Set(),
    selectedRunId: '', streams: new Map(), drawer: false, scenes: [], sessions: [],
    settings: undefined, settingsDirty: false, editingMembers: new Set(), skillViewer: undefined, memberPicker: false, quickMemberId: '', savingSettings: false, catalog: { codex: [], dsh: [], skills: [], errors: [] },
    memories: [], memoryCount: 0, memoryId: '', memoryDraft: undefined, savingMemoryDraft: undefined, memoryScope: 'scenario', memoryQuery: '', revisions: [], questionAnswers: {},
    events: [], sessionId: '', requiresBinding: false, memoryAudience: 'all', folderPicker: undefined, skillEditor: undefined,
    newSessionDraft: undefined, creatingSession: false,
    sceneAction: undefined, managingScene: false,
    processMembers: [], processScope: 'session', processCompact: false, exportingTimeline: '', sourceMessage: undefined, sourceViewer: undefined,
    memoryHistory: [], memoryHistoryHasOlder: false, memoryHistoryOpen: false, memoryHistoryLoading: false,
    memoryHistoryNumber: undefined, memoryHistoryNumberDraft: '', memoryConsolidating: false,
  }
  const contextDashboard = createContextDashboard({ api, rerender: render, scene: () => state.scene, agentName, root,
    openSource: async reference => {
      if (reference?.type === 'memory') {
        state.memoryAudience = reference.audience === 'role' ? `role:${reference.roleId}` : 'scene'
        await navigate('memory')
        state.memoryId = reference.id
        render()
      }
    } })
  root.classList.add('scw')
  root.setAttribute('aria-label', '场景协作工作区')
  const composerResize = new ResizeObserver(positionMemberPopover)
  const resize = new ResizeObserver(entries => {
    const width = entries[0].contentRect.width
    root.classList.toggle('sc-narrow', width < 850)
    const compact = width < 540
    if (state.processCompact !== compact) { state.processCompact = compact; render() }
    positionMemberPopover()
  })
  resize.observe(root)

  async function api(path, method = 'GET', body) {
    const response = await fetch(`${base}${path}`, { method, cache: 'no-store', signal: lifetime.signal,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    let result
    try { result = await response.json() }
    catch { throw new Error(`接口未返回有效数据，HTTP ${response.status}`) }
    if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`)
    return result
  }

  function selectedRun() { return state.runs.find(run => run.id === state.selectedRunId) || state.runs[0] }
  function activeRun() { return state.runs.find(run => !TERMINAL.has(run.state)) }
  function agentName(id, run = selectedRun()) { return (run?.agents || state.scene?.agents || []).find(agent => agent.id === id)?.name || id || '成员' }
  function memberWeight(id) { return memberWeights.get(id) || 1 }
  function orchestrationView(run) { return run?.mode === 'orchestration' }
  function canFollowUp(run = activeRun()) { return run?.mode === 'orchestration' && Boolean(run.workflow) && run.state !== 'cancelling' }
  function automaticTeam() { return state.scene.teamStrategy === 'auto' }

  function runProgress(run) {
    if (!run) return state.busy && pendingSend?.generation === sceneGeneration ? ['正在发送', 'running'] : []
    if (run.state === 'cancelling') return ['正在停止', 'running']
    if (run.questions?.some(question => question.kind === 'approval')) return ['等待你的审批', 'waiting']
    if (run.state === 'waiting_user' || run.questions?.length) return ['等待你补充', 'waiting']
    if (run.state === 'queued') return ['等待开始', 'running']
    if (orchestrationView(run)) {
      const owner = run.tasks?.findLast(task => task.state === 'working' && task.agentId === run.ownerId && !task.workflowTaskId)
      const members = new Set((run.delegations || []).filter(task => task.state === 'working').map(task => task.agentId)).size
      if (owner) {
        const label = { 'Owner 分工': 'Owner 正在分工', 'Owner 检查与汇报': 'Owner 正在核验交付' }[owner.title] || 'Owner 正在处理回报'
        return [members ? `${label} · ${members} 位成员执行中` : label, 'running']
      }
      if (members) return [`${members} 位成员执行中`, 'running']
      if (run.workflow?.cursor < run.workflow?.inbox?.length) return ['等待 Owner 处理', 'running']
      const waitingUntil = run.workflow?.waitingUntil
      if (Number.isFinite(Date.parse(waitingUntil))) return [`等待计划时间 · ${fullTime(waitingUntil)}`, 'waiting']
      return [run.state === 'planning' ? '正在准备分工' : '正在安排下一步', 'running']
    }
    return [{ independent: '成员独立思考中', reviewing: '成员交叉验证中', resolving: '成员补充核实中', working: '成员执行中',
      synthesizing: '正在汇总结论', checking: '正在审查结论' }[run.state] || '处理中', 'running']
  }

  function layoutKey() { return `dsh-codex-chat.process-layout.${state.scene.id}.${state.sessionId}` }
  function loadProcessLayout() {
    state.processMembers = []
    state.processScope = 'session'
    try {
      const layout = JSON.parse(localStorage.getItem(layoutKey()) || '{}')
      if (Array.isArray(layout.members)) state.processMembers = [...new Set(layout.members.filter(id => typeof id === 'string'))].slice(0, 2)
      if (layout.scope === 'run') state.processScope = 'run'
      if (typeof layout.width === 'string' && /^\d+(?:\.\d+)?%$/.test(layout.width)) root.style.setProperty('--sc-split', layout.width)
      else root.style.removeProperty('--sc-split')
    } catch { /* The default layout remains available. */ }
  }

  function saveProcessLayout() {
    try { localStorage.setItem(layoutKey(), JSON.stringify({ members: state.processMembers, scope: state.processScope, width: root.style.getPropertyValue('--sc-split') })) }
    catch { /* The current panel choices still apply. */ }
  }

  function collaborationQuery({ run, member, before, after } = {}) {
    const query = new URLSearchParams({ session: state.sessionId })
    if (run) query.set('run', run)
    if (member) query.set('member', member)
    if (before !== undefined) query.set('before', before)
    if (after !== undefined) query.set('after', after)
    return `/scenarios/${state.scene.id}/collaboration?${query}`
  }

  function orderedEvents(history) { return [...history.events.values()].sort((first, second) => first.sequence - second.sequence) }

  function memberHistory(run, member, create = false) {
    const key = `${run}/${member}`
    if (create && !memberHistories.has(key)) memberHistories.set(key, { ...historyPage(), run, member })
    return memberHistories.get(key)
  }

  function memberExchange(event, member) {
    return event.type === 'handoff.sent' && (event.fromAgentId === member || event.toAgentId === member)
  }

  function captureMemberExchange(event) {
    if (event.type !== 'handoff.sent') return
    for (const history of memberHistories.values()) {
      if ((!history.run || event.runId === history.run) && memberExchange(event, history.member)) history.events.set(event.sequence, event)
    }
  }

  function keepInitialFocus() {
    if (state.processMembers.length) return
    const ownerId = selectedRun()?.ownerId
    if (!ownerId) return
    const latest = orderedEvents(collaboration).findLast(event => event.type === 'handoff.sent'
      && (event.fromAgentId === ownerId || event.toAgentId === ownerId))
    const memberId = latest?.fromAgentId === ownerId ? latest?.toAgentId : latest?.fromAgentId
    if (!memberId || memberId === ownerId) return
    state.processMembers = [memberId]
    saveProcessLayout()
  }

  function mergeCollaboration(history, result) {
    for (const member of result.participants || []) {
      if (member?.id) participantCatalog.set(member.id, member)
    }
    for (const event of result.events || []) {
      if (Number.isFinite(event.sequence) && (!history.member || memberExchange(event, history.member))) history.events.set(event.sequence, event)
    }
  }

  async function loadCollaboration(run = '', older = false, member = '') {
    if (!state.scene) return
    const timeline = !member && run
    const history = member ? memberHistory(run, member, true) : timeline ? timelines.get(run) || historyPage() : collaboration
    if (timeline && !timelines.has(run)) timelines.set(run, history)
    if (history.loading) return history.request
    if (older ? !history.hasOlder : history.loaded) return
    const generation = sceneGeneration
    const before = older ? history.before : undefined
    history.loading = true
    history.error = ''
    render()
    history.request = (async () => {
      try {
        const result = await api(collaborationQuery({ run, member, before }))
        if (!alive || generation !== sceneGeneration) return
        mergeCollaboration(history, result)
        if (!run && !member) keepInitialFocus()
        history.hasOlder = Boolean(result.hasOlder)
        const earliest = Math.min(...(result.events || []).map(event => event.sequence))
        if (Number.isFinite(earliest)) history.before = earliest
        history.loaded = true
      } catch (error) {
        if (alive && generation === sceneGeneration) history.error = error.message
      } finally {
        history.loading = false
        history.request = undefined
        if (alive && generation === sceneGeneration) render(false, !older)
      }
    })()
    return history.request
  }

  async function resumeCollaborationFeed(after) {
    inboxReplayAfter = Math.min(inboxReplayAfter ?? after, after)
    if (loadingInboxReplay) return
    const generation = sceneGeneration
    loadingInboxReplay = true
    try {
      while (alive && generation === sceneGeneration && inboxReplayAfter !== undefined) {
        let cursor = inboxReplayAfter
        inboxReplayAfter = undefined
        while (alive && generation === sceneGeneration) {
          const page = await api(collaborationQuery({ after: cursor }))
          if (!alive || generation !== sceneGeneration) return
          mergeCollaboration(collaboration, page)
          for (const event of page.events || []) {
            const timeline = timelines.get(event.runId)
            if (timeline) timeline.events.set(event.sequence, event)
            captureMemberExchange(event)
          }
          const next = Math.max(cursor, ...(page.events || []).map(event => event.sequence))
          if (!page.hasMore || next <= cursor) break
          cursor = next
        }
      }
    } finally {
      if (generation === sceneGeneration) { loadingInboxReplay = false; render() }
    }
  }

  function captureCollaboration(event) {
    if (!collaborationEvent(event) || !Number.isFinite(event.sequence)) return
    collaboration.events.set(event.sequence, event)
    captureMemberExchange(event)
    if (event.type === 'handoff.sent') keepInitialFocus()
    const timeline = timelines.get(event.runId)
    if (timeline) timeline.events.set(event.sequence, event)
  }

  function loadMemberCollapses(run) {
    const agents = run?.agents || []
    const active = [...(run?.tasks || [])].reverse().find(task => task.state === 'working')?.agentId || run?.ownerId || agents[0]?.id
    let collapsed = agents.length > 2 ? agents.filter(agent => agent.id !== active).map(agent => agent.id) : []
    try {
      const saved = localStorage.getItem(`dsh-codex-chat.member-collapse.${state.scene.id}.${run?.id}`)
      if (saved !== null) collapsed = JSON.parse(saved).filter(id => agents.some(agent => agent.id === id))
    } catch { /* Use the compact initial layout when saved layout is unavailable. */ }
    state.collapsed = new Set(collapsed)
  }

  function saveMemberCollapses() {
    try { localStorage.setItem(`dsh-codex-chat.member-collapse.${state.scene.id}.${selectedRun()?.id}`, JSON.stringify([...state.collapsed])) }
    catch { /* The current layout remains usable without persistent storage. */ }
  }

  function loadMemberWeights() {
    memberWeights.clear()
    try {
      const saved = JSON.parse(localStorage.getItem(`${layoutKey()}.heights`) || localStorage.getItem(`dsh-codex-chat.member-heights.${state.scene.id}`) || '{}')
      for (const [id, weight] of Object.entries(saved)) {
        if (typeof weight === 'number' && Number.isFinite(weight) && weight > 0 && weight <= 100) memberWeights.set(id, weight)
      }
    } catch { /* Start with equal panes when saved preferences are unavailable. */ }
  }

  function saveMemberWeights() {
    try { localStorage.setItem(`${layoutKey()}.heights`, JSON.stringify(Object.fromEntries(memberWeights))) }
    catch { state.notice = '高度已调整，当前浏览器未能保存布局' }
  }

  function memberPair(separator) {
    const panes = [...root.querySelectorAll('[data-agent-pane]')]
    const upper = panes.find(pane => pane.dataset.agentPane === separator.dataset.upper)
    const lower = panes.find(pane => pane.dataset.agentPane === separator.dataset.lower)
    if (!upper || !lower || upper.classList.contains('sc-collapsed') || lower.classList.contains('sc-collapsed')) return
    const upperHeight = upper.getBoundingClientRect().height
    const lowerHeight = lower.getBoundingClientRect().height
    const height = upperHeight + lowerHeight
    if (height <= 4) return
    return { upperId: separator.dataset.upper, lowerId: separator.dataset.lower, upperHeight, height,
      totalWeight: memberWeight(separator.dataset.upper) + memberWeight(separator.dataset.lower),
      minimum: Math.min(upper.querySelector('.sc-agent-head').offsetHeight + 50, height / 2),
      maximum: height - Math.min(lower.querySelector('.sc-agent-head').offsetHeight + 50, height / 2) }
  }

  function applyMemberSize(pair, upperHeight) {
    const height = Math.max(pair.minimum, Math.min(pair.maximum, upperHeight))
    // Each pane contributes two border pixels outside its flexible content.
    const fraction = (height - 2) / (pair.height - 4)
    memberWeights.set(pair.upperId, pair.totalWeight * fraction)
    memberWeights.set(pair.lowerId, pair.totalWeight * (1 - fraction))
    for (const pane of root.querySelectorAll('[data-agent-pane]')) {
      pane.style.setProperty('--sc-agent-weight', memberWeight(pane.dataset.agentPane))
    }
    for (const separator of root.querySelectorAll('.sc-member-separator')) {
      const percent = Math.round(memberWeight(separator.dataset.upper) / (memberWeight(separator.dataset.upper) + memberWeight(separator.dataset.lower)) * 100)
      separator.setAttribute('aria-valuenow', percent)
      separator.setAttribute('aria-valuetext', `上方 ${percent}%，下方 ${100 - percent}%`)
    }
  }

  function stopMemberResize() {
    if (!memberDrag) return
    const pointerId = memberDrag.pointerId
    memberDrag = undefined
    root.classList.remove('sc-member-resizing')
    if (root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId)
    saveMemberWeights()
  }
  function mergeMessages(messages) {
    const all = new Map(state.messages.map(message => [message.id, message]))
    messages.forEach(message => all.set(message.id, message))
    state.messages = [...all.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0))
  }
  function mergeRun(run) {
    const index = state.runs.findIndex(item => item.id === run.id)
    if (index < 0) state.runs.unshift(run)
    else {
      const current = state.runs[index]
      if (!TERMINAL.has(run.state) && (TERMINAL.has(current.state)
        || (run.updatedAt || run.createdAt) < (current.updatedAt || current.createdAt))) return
      state.runs[index] = run
    }
  }
  function report(error) {
    if (!alive || error.name === 'AbortError') return
    state.error = error.message || String(error)
    render()
  }

  async function refresh() {
    if (!state.scene || !alive) return
    const id = state.scene.id
    const sessionId = state.sessionId
    const generation = sceneGeneration
    const result = await api(`/scenarios/${id}?session=${encodeURIComponent(sessionId)}`)
    if (!alive || state.scene?.id !== id || state.sessionId !== sessionId || generation !== sceneGeneration) return
    if (result.sequence < state.sequence) { scheduleRefresh(); return }
    state.scene = result.scene
    state.runs = result.runs
    mergeMessages(result.messages)
    state.hasOlder = result.hasOlder
    state.memoryCount = result.memoryCount || 0
    if (!state.settingsDirty) state.settings = structuredClone(result.scene)
    render()
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { refresh().catch(report) }, 120)
  }

  async function openScene(sceneId, { bind = false, create = false } = {}) {
    const generation = ++sceneGeneration
    clearTimeout(refreshTimer)
    if (state.sessionId) {
      try { localStorage.setItem(`dsh-codex-chat.draft.${state.sessionId}`, state.draft) } catch { /* Draft persistence is best effort. */ }
    }
    stopMemberResize()
    source?.close()
    memberScrolls.clear()
    state.streams.clear()
    collaboration = historyPage()
    participantCatalog = new Map()
    timelines.clear()
    memberHistories.clear()
    inboxReplayAfter = undefined
    loadingInboxReplay = false
    state.exportingTimeline = ''
    state.sourceMessage = undefined
    state.sourceViewer = undefined
    state.messages = []
    state.runs = []
    state.events = []
    state.memoryDraft = undefined
    state.savingMemoryDraft = undefined
    state.memoryHistory = []
    state.memoryHistoryHasOlder = false
    state.memoryHistoryOpen = false
    state.memoryHistoryLoading = false
    state.memoryHistoryNumber = undefined
    state.memoryHistoryNumberDraft = ''
    state.memoryConsolidating = false
    state.settingsDirty = false
    state.drawer = false
    state.sceneAction = undefined
    state.busy = true
    render()
    let result
    try {
      result = await api('/bootstrap', 'POST', { scenarioId: sceneId, dshSessionId: options.sessionId || '',
        sessionTitle: options.sessionTitle || '', cwd: options.cwd || '', interactive: true, bind, create })
    } catch (error) {
      if (generation !== sceneGeneration) return
      throw error
    }
    if (!alive || generation !== sceneGeneration) return
    state.busy = false
    state.requiresBinding = Boolean(result.requiresBinding)
    if (result.requiresBinding) {
      state.scene = undefined
      state.sessionId = result.sessionId || options.sessionId || ''
      state.scenes = result.scenes
      state.error = ''
      render()
      return
    }
    state.sessionId = result.sessionId || options.sessionId || ''
    try { state.draft = localStorage.getItem(`dsh-codex-chat.draft.${state.sessionId}`) || '' } catch { state.draft = '' }
    state.scene = result.scene
    loadProcessLayout()
    loadMemberWeights()
    state.settings = structuredClone(result.scene)
    state.editingMembers.clear()
    state.skillViewer = undefined
    state.memberPicker = false
    state.messages = result.messages
    state.events = result.events || []
    state.runs = result.runs
    state.sequence = result.sequence
    state.hasOlder = result.hasOlder
    state.memoryCount = result.memoryCount || 0
    state.selectedRunId = result.runs[0]?.id || ''
    detailStates.clear()
    loadMemberCollapses(result.runs[0])
    state.busy = false
    state.error = ''
    if (!options.sessionId) localStorage.setItem('dsh-codex-chat.scenario', state.scene.id)
    connect()
    render(true)
    loadCatalog().catch(report)
    if (orchestrationView(selectedRun())) {
      loadCollaboration().catch(report)
      if (state.processScope === 'run') loadCollaboration(selectedRun().id).catch(report)
    }
    if (state.view === 'context') await contextDashboard.load()
    await restoreMemoryAnchor()
  }

  function connect() {
    const generation = sceneGeneration
    source = new EventSource(`${base}/scenarios/${state.scene.id}/events?after=${state.sequence}`)
    source.onmessage = event => {
      if (!alive || generation !== sceneGeneration) return
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'scenario.deleted') {
          if (!state.managingScene) showBindingPicker().catch(report)
          return
        }
        if (data.type === 'ready') { state.notice = ''; render(); return }
        if (data.type === 'reset') {
          const after = state.sequence
          state.sequence = data.sequence
          resumeCollaborationFeed(after).catch(report)
          scheduleRefresh()
          return
        }
        if (data.sequence <= state.sequence) return
        state.sequence = data.sequence
        if (data.sessionId && data.sessionId !== state.sessionId && !['scenario.updated', 'memory.changed'].includes(data.type)) return
        state.events.push(data)
        if (state.events.length > 200) state.events.shift()
        captureCollaboration(data)
        if (data.type === 'agent.delta') {
          const previouslyStreaming = state.streams.has(data.operationId)
          const stream = state.streams.get(data.operationId) || { agentId: data.agentId, runId: data.runId, text: '' }
          stream.text = (stream.text + data.text).slice(-60000)
          state.streams.set(data.operationId, stream)
          const element = root.querySelector(`[data-stream="${data.operationId}"]`)
          if (element) {
            const body = element.closest('.sc-agent-body')
            const follow = body && body.scrollHeight - body.scrollTop - body.clientHeight < 70
            element.textContent = stream.text
            if (follow) body.scrollTop = body.scrollHeight
          }
          else if (!orchestrationView(selectedRun()) || !previouslyStreaming) render()
          return
        }
        if (data.type === 'message.added') mergeMessages([data.message])
        if (data.run) {
          mergeRun(data.run)
          if (data.type === 'run.created') {
            if (state.processScope !== 'run' || !state.selectedRunId || !orchestrationView(data.run)) state.selectedRunId = data.run.id
            state.showProcesses = true
            loadMemberCollapses(data.run)
            if (orchestrationView(data.run)) loadCollaboration().catch(report)
          }
        }
        if (data.type === 'agent.completed' || data.type === 'agent.failed') state.streams.delete(data.operationId)
        if (data.type === 'scenario.updated') {
          if (!state.managingScene && !state.sessionId.startsWith('local-')
            && !data.scene.sessions.some(session => session.id === state.sessionId)) {
            showBindingPicker().catch(report)
            return
          }
          state.scene = data.scene
          if (!state.settingsDirty) state.settings = structuredClone(data.scene)
          state.scenes = state.scenes.map(scene => scene.id === data.scene.id ? data.scene : scene)
        }
        if (data.type === 'memory.changed' && state.view === 'memory') {
          loadMemories().catch(report)
          if (state.memoryHistoryOpen) loadMemoryHistory().catch(report)
        }
        if (state.view === 'context' && /^(context\.|usage\.|tool\.|agent.completed|agent.failed|run.finished)/.test(data.type)) contextDashboard.schedule()
        if (data.type === 'run.finished') {
          for (const [id, stream] of state.streams) if (stream.runId === data.runId) state.streams.delete(id)
          scheduleRefresh()
        }
        render(data.type === 'message.added' && !data.message.agentId, data.type === 'handoff.sent')
      } catch (error) { report(error) }
    }
    source.onerror = () => {
      if (!alive || generation !== sceneGeneration) return
      state.notice = '连接中断，正在恢复任务状态'
      render()
    }
  }

  async function loadCatalog(refresh = false) {
    if (catalogRequest?.generation === sceneGeneration) {
      if (!refresh || catalogRequest.refresh) return catalogRequest.promise
      await catalogRequest.promise
    }
    const id = state.scene?.id
    if (!id) return
    const generation = sceneGeneration
    const promise = api(`/scenarios/${id}/catalog${refresh ? '?refresh=1' : ''}`).then(result => {
      if (state.scene?.id === id && generation === sceneGeneration) { state.catalog = result; render() }
    }).finally(() => { if (catalogRequest?.promise === promise) catalogRequest = undefined })
    catalogRequest = { generation, promise, refresh }
    return promise
  }

  function saveScene(patch) {
    patch = structuredClone(patch)
    const id = state.scene.id
    const generation = sceneGeneration
    const operation = saveQueue.then(async () => {
      if (state.scene?.id !== id) throw new Error('场景已切换，请在当前场景保存')
      const result = await api(`/scenarios/${id}`, 'PATCH', { ...patch, revision: state.scene.revision })
      if (state.scene?.id === id && generation === sceneGeneration) {
        state.scene = result.scene
        if (!state.settingsDirty) state.settings = structuredClone(result.scene)
        render()
      }
      return result.scene
    })
    saveQueue = operation.catch(() => {})
    return operation
  }

  async function openDemand(sessionId, title = '', nativeSessionId = sessionId, sceneId = state.scene?.id, { requireNative = false } = {}) {
    if (state.sessionId) {
      try { localStorage.setItem(`dsh-codex-chat.draft.${state.sessionId}`, state.draft) } catch { /* Keep navigation available. */ }
    }
    if (sceneId) {
      const generation = sceneGeneration
      const prepared = await api(`/scenarios/${sceneId}/sessions/${encodeURIComponent(sessionId)}/open`, 'POST', {})
      if (!alive || generation !== sceneGeneration) return
      if (requireNative && prepared.nativeAvailable === false) return false
      nativeSessionId = prepared.nativeSessionId
      title = prepared.sessionTitle || title
    }
    if (options.openSession?.(nativeSessionId)) return
    options.sessionId = sessionId
    options.sessionTitle = title
    const url = new URL(location.href)
    url.searchParams.set('dshSession', sessionId)
    if (sceneId) url.searchParams.set('scenario', sceneId)
    else url.searchParams.delete('scenario')
    if (['http:', 'https:', 'file:'].includes(location.protocol)) history.replaceState(null, '', url)
    return openScene(sceneId)
  }

  async function showBindingPicker() {
    if (!options.sessionId && state.sessionId && !state.sessionId.startsWith('local-')) options.sessionId = state.sessionId
    try { localStorage.removeItem('dsh-codex-chat.scenario') } catch { /* Binding choices remain available without storage. */ }
    const url = new URL(location.href)
    url.searchParams.delete('scenario')
    if (options.sessionId) url.searchParams.set('dshSession', options.sessionId)
    if (['http:', 'https:', 'file:'].includes(location.protocol)) history.replaceState(null, '', url)
    return openScene()
  }

  async function manageScene() {
    const action = state.sceneAction
    if (!action || state.managingScene) return
    state.managingScene = true
    render()
    try {
      const path = `/scenarios/${action.sceneId}${action.type === 'unbind' ? `/sessions/${encodeURIComponent(action.sessionId)}` : ''}`
      const result = await api(path, 'DELETE', { revision: action.revision })
      state.sceneAction = undefined
      state.error = ''
      if (state.scene?.id === action.sceneId) {
        if (action.type === 'delete' || state.sessionId === action.sessionId) return await showBindingPicker()
        state.scene = result.scene
        if (!state.settingsDirty) state.settings = structuredClone(result.scene)
      }
      const list = await api('/scenarios')
      state.scenes = list.scenes
      state.sessions = list.sessions
    } finally { state.managingScene = false; render() }
  }

  async function send(resumeRunId) {
    if (state.busy || state.uploading) return
    if (!state.draft.trim()) { state.error = '请先输入一项任务'; render(); return }
    await saveQueue
    if (state.busy || state.uploading || !state.scene) return
    const current = activeRun()
    if (current && (resumeRunId || !canFollowUp(current))) return
    if (!current && state.scene.mode === 'orchestration' && !automaticTeam() && !state.scene.ownerId) {
      state.error = '请选择本次任务的 Owner'
      render()
      root.querySelector('#sc-owner')?.focus()
      return
    }
    state.busy = true
    state.error = ''
    const text = state.draft
    const sceneId = state.scene.id
    const sessionId = state.sessionId
    const generation = sceneGeneration
    const fingerprint = JSON.stringify([sceneId, sessionId, text, state.attachments, current?.id, resumeRunId])
    if (pendingSend?.fingerprint !== fingerprint) pendingSend = { fingerprint, requestId: crypto.randomUUID() }
    pendingSend.generation = generation
    const { requestId } = pendingSend
    render()
    try {
      const result = current
        ? await api(`/runs/${current.id}/followups`, 'POST', { requestId, text })
        : await api(`/scenarios/${sceneId}/runs`, 'POST', { requestId, text, attachments: state.attachments, resumeRunId, sessionId })
      if (state.scene?.id !== sceneId || state.sessionId !== sessionId || generation !== sceneGeneration) return
      pendingSend = undefined
      if (result.run) {
        mergeRun(result.run)
        if (state.processScope !== 'run' || !state.selectedRunId || !orchestrationView(result.run)) state.selectedRunId = result.run.id
      }
      if (result.message) mergeMessages([result.message])
      state.draft = ''
      try { localStorage.removeItem(`dsh-codex-chat.draft.${state.sessionId}`) } catch { /* The sent message is persisted by the host. */ }
      if (!current) state.attachments = []
      state.showProcesses = true
      if (!current) options.onRunStart?.()
    } finally {
      if (generation === sceneGeneration) { state.busy = false; render(true) }
    }
  }

  async function upload(files) {
    if (!state.scene || state.uploading || activeRun()) return
    state.uploading = true
    const sceneId = state.scene.id
    const sessionId = state.sessionId
    render()
    try {
      for (const file of files) {
        if (state.attachments.length >= 10) throw new Error('每轮最多十个附件')
        if (file.size > 15 * 1024 * 1024) throw new Error(`${file.name} 超过 15 MB`)
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).split(',')[1])
          reader.onerror = () => reject(new Error(`无法读取 ${file.name}`))
          reader.readAsDataURL(file)
        })
        if (state.scene?.id !== sceneId || state.sessionId !== sessionId) return
        const result = await api(`/scenarios/${sceneId}/upload`, 'POST', { name: file.name, data })
        if (state.scene?.id !== sceneId || state.sessionId !== sessionId) return
        state.attachments.push(result)
      }
    } finally { state.uploading = false; render() }
  }

  async function loadMemories() {
    const id = state.scene.id
    const result = await api(`/scenarios/${id}/memories?scope=${state.memoryScope}`)
    if (state.scene?.id !== id) return
    state.memories = result.memories
    if (state.memoryScope === 'scenario') state.memoryCount = result.memories.filter(memory => memory.status !== 'deleted').length
    if (!state.memories.some(memory => memory.id === state.memoryId)) state.memoryId = state.memories[0]?.id || ''
    render()
  }

  async function loadMemoryHistory(older = false, replace = false) {
    if (state.memoryScope === 'legacy' || (state.memoryHistoryLoading && !replace) || (older && !state.memoryHistoryHasOlder)) return
    const generation = sceneGeneration
    const request = ++memoryHistoryRequest
    const before = older ? state.memoryHistory.at(-1)?.historySeq : undefined
    const query = new URLSearchParams()
    if (before) query.set('before', before)
    if (state.memoryHistoryNumber !== undefined) query.set('number', state.memoryHistoryNumber)
    state.memoryHistoryLoading = true
    render()
    try {
      const result = await api(`/scenarios/${state.scene.id}/memories/history?${query}`)
      if (generation !== sceneGeneration || request !== memoryHistoryRequest) return
      state.memoryHistory = [...new Map([...(older ? state.memoryHistory : []), ...(result.history || [])].map(entry => [entry.historySeq, entry])).values()]
      state.memoryHistoryHasOlder = Boolean(result.hasOlder)
    } catch (error) {
      if (generation === sceneGeneration && request === memoryHistoryRequest) throw error
    } finally {
      if (generation === sceneGeneration && request === memoryHistoryRequest) { state.memoryHistoryLoading = false; render() }
    }
  }

  function filterMemoryHistory(value) {
    const text = value.trim().replace(/^#\s*/, '')
    const number = text ? Number(text) : undefined
    if (text && (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < 1)) throw new Error('请输入有效的记忆编号，例如 #50')
    state.error = ''
    state.memoryHistoryNumber = number
    state.memoryHistoryNumberDraft = number === undefined ? '' : `#${number}`
    state.memoryHistory = []
    state.memoryHistoryHasOlder = false
    return loadMemoryHistory(false, true)
  }

  function sourceAnchorKey(sessionId) { return `dsh-codex-chat.source-anchor.${sessionId}` }

  async function readSourceRun(anchor) {
    const sceneId = state.scene.id
    const result = await api(`/runs/${encodeURIComponent(anchor.run)}`)
    if (result.run?.scenarioId !== sceneId || result.run?.sessionId !== anchor.session) {
      throw new Error('找不到来源会话中的这项历史任务')
    }
    return result
  }

  async function showStoredMemorySource(anchor) {
    const generation = sceneGeneration
    const query = new URLSearchParams({ session: anchor.session })
    if (anchor.message) query.set('message', anchor.message)
    const result = anchor.run ? await readSourceRun(anchor) : await api(`/scenarios/${state.scene.id}?${query}`)
    if (generation !== sceneGeneration) return
    const messages = (result.messages || []).filter(message => anchor.run || !message.agentId || message.id === anchor.message)
    state.sourceViewer = { messages, session: anchor.title || (anchor.session.startsWith('local-') ? '浏览器会话' : anchor.session) }
    render()
    focusSourceAnchor(anchor.message || result.run?.userMessageId || (anchor.run ? messages[0]?.id : ''))
  }

  async function openMemorySource(anchor) {
    if (!anchor.session) throw new Error('这条记录没有可定位的来源会话')
    if (anchor.session === state.sessionId) return showMemoryAnchor(anchor)
    if (!state.scene.sessions?.some(session => session.id === anchor.session)) {
      return showStoredMemorySource(anchor)
    }
    const generation = sceneGeneration
    pendingSource = anchor
    try { localStorage.setItem(sourceAnchorKey(anchor.session), JSON.stringify(anchor)) } catch { /* In-page navigation can still carry the anchor. */ }
    let navigationError
    try {
      if (await openDemand(anchor.session, '', anchor.session, state.scene.id, { requireNative: true }) !== false) return
    } catch (error) { navigationError = error }
    pendingSource = undefined
    try { localStorage.removeItem(sourceAnchorKey(anchor.session)) } catch { /* Storage is optional. */ }
    if (generation === sceneGeneration && (!navigationError || anchor.run || anchor.message)) return showStoredMemorySource(anchor)
    if (navigationError) throw navigationError
  }

  async function restoreMemoryAnchor() {
    const key = sourceAnchorKey(state.sessionId)
    let anchor = pendingSource?.session === state.sessionId ? pendingSource : undefined
    pendingSource = undefined
    try { anchor ||= JSON.parse(localStorage.getItem(key) || 'null'); localStorage.removeItem(key) } catch { /* Use an available in-page anchor. */ }
    if (anchor) await showMemoryAnchor(anchor)
  }

  async function showMemoryAnchor(anchor) {
    const generation = sceneGeneration
    let targetMessage
    if (anchor.message) {
      const result = await api(`/scenarios/${state.scene.id}?${new URLSearchParams({ session: state.sessionId, message: anchor.message })}`)
      if (generation !== sceneGeneration) return
      mergeMessages(result.messages || [])
      targetMessage = state.messages.find(message => message.id === anchor.message)
    }
    const runId = anchor.run
    let run = state.runs.find(item => item.id === runId)
    if (runId && (!run || (!anchor.message && !state.messages.some(message =>
      run.userMessageId ? message.id === run.userMessageId : message.runId === runId && !message.agentId)))) {
      const result = await readSourceRun(anchor)
      if (generation !== sceneGeneration) return
      run = result.run
      mergeRun(run)
      mergeMessages(result.messages || [])
    }
    if (targetMessage?.agentId && !run) return showStoredMemorySource(anchor)
    state.view = 'chat'
    state.mobilePane = 'main'
    if (runId) state.selectedRunId = runId
    if (targetMessage?.agentId) {
      state.sourceMessage = targetMessage
      state.showProcesses = true
      state.processScope = 'run'
      state.processMembers = [targetMessage.agentId]
      state.mobilePane = 'process'
      if (orchestrationView(run)) await loadCollaboration(runId, false, targetMessage.agentId)
      else { loadMemberCollapses(run); state.collapsed.delete(targetMessage.agentId) }
    }
    if (generation !== sceneGeneration) return
    render()
    if (!focusSourceAnchor(anchor.message || run?.userMessageId, runId) && anchor.message) { state.notice = '已打开来源会话，原消息当前无法定位'; render() }
  }

  function focusSourceAnchor(messageId, runId) {
    const target = (messageId && [...root.querySelectorAll('[data-message-id]')].find(element => element.dataset.messageId === messageId))
      || (runId && [...root.querySelectorAll('.sc-message[data-run]')].find(element => element.dataset.run === runId))
    if (!target) return false
    target.scrollIntoView({ block: 'center' })
    target.focus({ preventScroll: true })
    return true
  }

  function sourceViewer() {
    const { messages, session } = state.sourceViewer
    const transcript = messages.map(message => `<article class="sc-message" data-message-id="${esc(message.id)}" data-focus="memory-source-${esc(message.id)}" tabindex="-1">
      <div class="sc-message-label"><strong>${esc(message.agentName || (message.role === 'user' ? '你' : '团队'))}</strong> · ${esc(historyTime(message.at))}</div>
      <div class="sc-prose">${prose(message.text)}</div></article>`).join('')
    return `<div class="sc-drawer"><section class="sc-drawer-content" role="dialog" aria-label="历史会话来源" data-scroll="memory-source">
      <div class="sc-section-head"><h2>历史会话来源</h2><button type="button" data-action="close-source-viewer">关闭</button></div>
      <p class="sc-small sc-muted">来源会话 · ${esc(session)}</p>
      ${transcript || '<p class="sc-small sc-muted">当前没有可打开的历史消息。</p>'}</section></div>`
  }

  async function navigate(view) {
    state.view = view
    render()
    if (view === 'memory') await Promise.all([loadMemories(), state.memoryHistoryOpen && loadMemoryHistory()])
    if (view === 'context') await contextDashboard.load()
  }

  async function draftMemoryFromMessage(messageId) {
    const generation = sceneGeneration
    let message = state.messages.find(item => item.id === messageId)
    if (!message) {
      const query = new URLSearchParams({ session: state.sessionId, message: messageId })
      const result = await api(`/scenarios/${state.scene.id}?${query}`)
      if (generation !== sceneGeneration || state.view !== 'chat') return
      message = result.messages?.find(item => item.id === messageId)
    }
    if (!message?.sessionId) throw new Error('找不到可作为来源的原消息')
    const text = String(message.text || '').trim()
    const speaker = message.role === 'user' ? '你' : message.agentName || '团队'
    const sessionTitle = state.scene.sessions?.find(session => session.id === message.sessionId)?.title
    const member = state.scene.agents.find(agent => agent.id === message.agentId)
    state.memoryScope = 'scenario'
    state.memoryAudience = 'all'
    state.memoryKind = 'all'
    state.memoryQuery = ''
    state.revisions = []
    state.memoryDraft = {
      title: text.split(/\r?\n/)[0].slice(0, 100), content: text.slice(0, 20000), kind: 'note', status: 'confirmed',
      audience: member ? 'role' : 'scene', roleId: member ? member.roleId || member.id : '',
      messageSource: { sessionId: message.sessionId, runId: message.runId, messageId: message.id,
        sessionTitle: sessionTitle || options.sessionTitle || '当前会话', speaker, at: message.at,
        excerpt: text.length > 160 ? `${text.slice(0, 160)}…` : text },
    }
    const loading = navigate('memory')
    root.querySelector('[data-focus="memory-title"]')?.focus()
    await loading
  }

  function positionMemberPopover() {
    const popup = root.querySelector('.sc-member-popover')
    if (!popup) return
    const composer = popup.closest('.sc-composer')
    const log = root.querySelector('.sc-log')
    popup.style.maxHeight = `${Math.max(0, composer.getBoundingClientRect().top - log.getBoundingClientRect().top - 16)}px`
  }

  function render(scrollBottom = false, followProcess = false) {
    if (!alive) return
    if (openSelect && root.contains(openSelect)) { pendingRender = true; return }
    pendingRender = false
    if (memberDrag && (state.view !== 'chat' || !state.showProcesses
      || (memberDrag.process ? state.processCompact || !state.processMembers.includes(memberDrag.upperId) || !state.processMembers.includes(memberDrag.lowerId)
        : selectedRun()?.id !== memberDrag.runId || state.collapsed.has(memberDrag.upperId) || state.collapsed.has(memberDrag.lowerId)))) stopMemberResize()
    const focused = root.contains(document.activeElement) ? document.activeElement : undefined
    const focusKey = focused?.dataset.focus || focused?.id
    const selection = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : undefined
    for (const element of root.querySelectorAll('details')) detailStates.set(element.dataset.detail || element.querySelector('summary')?.textContent, element.open)
    const scrolls = []
    for (const element of root.querySelectorAll('[data-scroll]')) {
      const transcript = element.classList.contains('sc-transcript')
      const visibleEntry = transcript ? [...element.querySelectorAll('[data-history-sequence]')].find(entry => entry.offsetTop + entry.clientHeight >= element.scrollTop) : undefined
      const position = { key: element.dataset.scroll, top: element.scrollTop, left: element.scrollLeft, nearBottom: element.scrollHeight - element.scrollTop - element.clientHeight < 70,
        sequence: visibleEntry?.dataset.historySequence, offset: visibleEntry ? visibleEntry.offsetTop - element.scrollTop : undefined, transcript }
      if (element.classList.contains('sc-agent-body')) {
        if (!element.hidden && element.getClientRects().length) memberScrolls.set(position.key, position)
      } else scrolls.push(position)
    }
    if (!state.scene) {
      if (state.requiresBinding) { root.innerHTML = renderScenePicker(state, options, true); return }
      root.innerHTML = `<div class="sc-empty"><h2>场景协作</h2><p>${state.error ? esc(state.error) : '正在恢复场景与团队…'}</p>${state.error ? '<button type="button" data-action="retry-bootstrap">重试</button>' : ''}</div>`
      return
    }
    const run = selectedRun()
    const [progress, progressState] = runProgress(activeRun())
    const demandTitle = state.scene.sessions?.find(session => session.id === state.sessionId)?.title || options.sessionTitle || '未命名需求'
    root.innerHTML = `<header class="sc-top"><div class="sc-heading"><strong>${esc(state.scene.title)}</strong><span class="sc-small sc-muted">${state.scene.agents.length} 位成员 · 当前需求 · ${esc(demandTitle)}</span><span class="sc-small sc-muted sc-workspace-path">资料目录 · ${esc(state.scene.cwd)}</span></div><button type="button" data-action="new-demand">＋ 新建需求会话</button><button type="button" data-action="scenes">场景</button>${options.onExpand ? `<button type="button" data-action="expand">${options.isExpanded?.() ? '收回工作区' : '展开工作区'}</button>` : ''}</header>
      <nav class="sc-nav" role="tablist" aria-label="场景功能">${Object.entries({ chat: '对话', team: '团队', memory: '记忆', context: '上下文' }).map(([view, label]) => `<button type="button" id="sc-tab-${view}" data-action="view" data-view="${view}" role="tab" aria-label="${label}" aria-controls="sc-content" aria-selected="${view === state.view}">${label}${view === 'memory' ? `<span class="sc-memory-count" aria-hidden="true">${state.memoryCount}</span>` : ''}</button>`).join('')}${state.view === 'chat' && run ? `<button type="button" class="sc-toggle" data-action="process-toggle">${state.showProcesses ? '收起过程' : '展开过程'}</button>` : ''}</nav>
      ${state.error || state.notice ? `<div class="sc-notice ${state.error ? 'error' : ''}" role="${state.error ? 'alert' : 'status'}"><span>${esc(state.error || state.notice)}</span><button type="button" class="sc-plain" data-action="dismiss" aria-label="关闭提示">×</button></div>` : ''}
      <div class="sc-content" id="sc-content" ${state.savingSettings ? 'inert aria-busy="true"' : ''} role="tabpanel" aria-labelledby="sc-tab-${state.view}">${state.view === 'chat' ? chatView() : state.view === 'team' ? teamView() : state.view === 'memory' ? memoryView() : contextView()}</div>
      <footer class="sc-footer">${progress ? `<div class="sc-run-progress" role="status" data-state="${progressState}"><span aria-hidden="true"></span>${esc(progress)}</div>` : '<span>场景已保存到本机</span>'}<span class="sc-footer-directory" title="${esc(state.scene.cwd)}">${esc(state.scene.cwd)}</span></footer>${state.drawer ? drawerView() : ''}${state.folderPicker ? renderFolderPicker(state.folderPicker) : ''}${state.skillEditor ? renderSkillEditor(state.skillEditor) : ''}${state.skillViewer ? renderSkillViewer(state.skillViewer) : ''}${state.newSessionDraft ? renderSessionCreator(state.newSessionDraft, state.scene, state.creatingSession) : ''}${state.sourceViewer ? sourceViewer() : ''}`
    composerResize.disconnect()
    const composer = root.querySelector('.sc-composer')
    if (composer) composerResize.observe(composer)
    positionMemberPopover()
    for (const detail of root.querySelectorAll('details')) {
      const key = detail.dataset.detail || detail.querySelector('summary')?.textContent
      if (detailStates.has(key)) detail.open = detailStates.get(key)
    }
    resizeRoleEditors()
    const scrollElements = new Map([...root.querySelectorAll('[data-scroll]')].map(element => [element.dataset.scroll, element]))
    for (const saved of [...scrolls, ...memberScrolls.values()]) {
      const element = scrollElements.get(saved.key)
      if (!element || element.hidden) continue
      element.scrollLeft = saved.left || 0
      const anchor = saved.sequence ? element.querySelector(`[data-history-sequence="${saved.sequence}"]`) : undefined
      element.scrollTop = (saved.transcript ? followProcess : scrollBottom) && saved.nearBottom ? element.scrollHeight
        : anchor ? anchor.offsetTop - saved.offset : saved.top
      scrollElements.delete(saved.key)
    }
    for (const element of scrollElements.values()) if (element.classList.contains('sc-transcript')) element.scrollTop = element.scrollHeight
    if (scrollBottom && !scrolls.some(saved => saved.key === 'main')) {
      const log = root.querySelector('[data-scroll="main"]')
      if (log) log.scrollTop = log.scrollHeight
    }
    if (focusKey) {
      const target = [...root.querySelectorAll('[data-focus], [id]')].find(element => (element.dataset.focus || element.id) === focusKey)
      if (target && !target.disabled) {
        target.focus({ preventScroll: true })
        if (selection && typeof target.setSelectionRange === 'function') {
          try { target.setSelectionRange(...selection) } catch { /* Selects and non-text inputs retain native focus. */ }
        }
      }
    }
  }

  function chatView() {
    const run = selectedRun()
    const active = activeRun()
    const split = run && state.showProcesses
    const autoTeam = automaticTeam()
    const followUp = canFollowUp(active)
    const messages = state.messages.filter(message => !message.agentId)
    return `${split ? `<div class="sc-mobile-nav"><button type="button" data-action="mobile-main" aria-pressed="${state.mobilePane === 'main'}">主聊天</button><button type="button" data-action="mobile-process" aria-pressed="${state.mobilePane === 'process'}">${orchestrationView(run) ? '协作消息' : `成员过程 · ${run.agents.length}`}</button></div>` : ''}
      <div class="sc-chat ${split ? 'sc-split' : ''}" data-mobile="${state.mobilePane}"><section class="sc-main" aria-label="主聊天"><div class="sc-log" data-scroll="main">
      ${state.hasOlder ? '<button type="button" class="sc-plain sc-small" data-action="older">更早的消息</button>' : ''}
      ${messages.length ? messages.map(messageView).join('') : `<div class="sc-empty"><h2>开始当前需求</h2><p>${state.memoryCount ? `本场景已保存 ${state.memoryCount} 条记忆，团队会按职责选用。` : '描述工作目标与约束，团队会逐步积累场景知识。'}</p>${state.memoryCount ? '<button type="button" class="sc-plain" data-action="view" data-view="memory">查看场景记忆</button>' : ''}</div>`}
      ${active ? `${questionsView(active)}${orchestrationView(active) ? timelineView(active.id, 'active') : ''}` : ''}
      ${run && ['interrupted', 'incomplete', 'failed', 'cancelled', 'disputed'].includes(run.state) && !active ? `<button type="button" data-action="resume" data-run="${run.id}">接续这项任务</button>` : ''}</div>
      <div class="sc-composer">${state.memberPicker ? renderMemberPopover(state.settings || state.scene, state.catalog, state.quickMemberId, state.editingMembers, state.settingsDirty, state.savingSettings) : ''}${state.scene.mode === 'orchestration' ? `<div class="sc-owner"><label for="sc-owner">任务负责人</label><select id="sc-owner" aria-label="选择 Owner" ${active ? 'disabled' : ''}><option value="">${autoTeam ? '自动选择 Owner' : '请选择 Owner'}</option>${state.scene.agents.map(agent => `<option value="${agent.id}" ${agent.id === state.scene.ownerId ? 'selected' : ''}>${esc(agent.name)}</option>`).join('')}</select>${autoTeam ? '<span class="sc-muted">自动组队</span>' : ''}</div>` : ''}
      ${state.attachments.length ? `<div class="sc-attachments">${state.attachments.map((file, index) => `<span class="sc-attachment">${esc(file.name)}<button type="button" data-action="remove-file" data-index="${index}" aria-label="移除 ${esc(file.name)}">×</button></span>`).join('')}</div>` : ''}
      <textarea id="sc-draft" aria-label="任务输入" placeholder="${followUp ? '补充信息或调整当前任务…' : '提出任务或继续这个场景…'}" ${state.busy ? 'disabled' : ''}>${esc(state.draft)}</textarea>
      <div class="sc-actions"><input type="file" id="sc-files" multiple hidden><button type="button" data-action="attach" aria-label="添加附件" ${state.uploading || active ? 'disabled' : ''}>＋</button><select id="sc-mode" aria-label="协作模式" ${active ? 'disabled' : ''}><option value="confidence" ${state.scene.mode === 'confidence' ? 'selected' : ''}>置信模式</option><option value="orchestration" ${state.scene.mode === 'orchestration' ? 'selected' : ''}>统筹模式</option></select>${state.scene.agents.slice(0, 2).map(agent => `<button type="button" data-action="quick-members" data-agent="${agent.id}" aria-haspopup="dialog" aria-expanded="${state.memberPicker}"><span>${esc(agent.name)}</span><small>${esc(memberModelName(agent, state.catalog))} · ${esc(effortLabel(agent.effort || ''))}</small></button>`).join('')}${state.scene.agents.length > 2 ? `<button type="button" class="sc-plain" data-action="quick-members" aria-haspopup="dialog" aria-expanded="${state.memberPicker}">＋${state.scene.agents.length - 2} 位</button>` : ''}${active ? `<button type="button" class="sc-plain" data-action="stop" ${active.state === 'cancelling' ? 'disabled' : ''}>停止</button>` : ''}${!active || followUp ? `<button type="button" class="sc-send sc-primary" data-action="send" ${state.busy || state.uploading ? 'disabled' : ''}>${followUp ? '发送补充' : state.uploading ? '上传中' : '发送'}</button>` : ''}</div></div></section>${split ? `<div class="sc-separator" role="separator" aria-label="调整聊天区宽度" aria-orientation="vertical" tabindex="0"></div>${orchestrationView(run) ? collaborationView(run) : processView(run)}` : ''}</div>`
  }

  function memoryDraftAction(messageId) {
    return messageId ? `<button type="button" class="sc-plain sc-message-memory" data-action="memory-from-message" data-message="${esc(messageId)}">存为记忆</button>` : ''
  }

  function messageView(message) {
    const user = message.role === 'user'
    const text = String(message.text || '')
    const source = state.messages.find(item => item.runId === message.runId && item.agentId && item.structured?.answer === text)
    const summary = message.summary || source?.structured?.summary
    const brief = typeof summary === 'string' && summary.trim() ? summary : text.split('\n').find(line => line.trim())?.slice(0, 240)
    const expanded = state.runs.find(run => run.id === message.runId)?.text.match(/完整代码|全文|详细报告|逐条说明/)
    const fold = !user && !expanded && text.length > 300 && brief && brief !== text
    const content = fold
      ? `<div class="sc-prose">${prose(brief)}</div><details data-detail="answer-${message.id}"><summary class="sc-small sc-muted">完整答复</summary><div class="sc-prose">${prose(text)}</div></details>`
      : `<div class="sc-prose">${prose(text)}</div>`
    const run = state.runs.find(item => item.id === message.runId)
    return `<article class="sc-message ${user ? 'sc-message-user' : 'sc-message-assistant'}" data-run="${esc(message.runId)}" data-message-id="${esc(message.id)}" tabindex="-1"><div class="sc-message-label">${esc(user ? '你' : message.agentName || '团队')}${message.state ? badge(message.state) : ''}<span>${esc(time(message.at))}</span>${memoryDraftAction(message.sessionId && message.id)}</div>${content}${message.attachments?.length ? `<div class="sc-small sc-muted">附件 ${message.attachments.map(file => esc(file.name || file)).join('、')}</div>` : ''}${!user && message.runId && (!run || orchestrationView(run)) ? timelineView(message.runId, message.id) : ''}</article>`
  }

  function questionsView(run) {
    return (run.questions || []).map(request => `<form class="sc-questions" data-question="${request.id}" data-run="${run.id}"><h3>${esc(request.agentName)} ${request.kind === 'approval' ? '等待你的审批' : '需要你补充'}</h3>${request.details ? `<pre class="sc-approval-details">${esc(request.details)}</pre>` : ''}${request.questions.map(question => `<label>${esc(question.question || question.header)}${question.options?.length ? `<select name="${esc(question.id)}" data-focus="question-${esc(question.id)}"><option value="">${request.kind === 'approval' ? '请选择审批结果' : '请选择或在下面补充'}</option>${question.options.map(option => `<option value="${esc(option.label)}" ${state.questionAnswers[`${request.id}/${question.id}`] === option.label ? 'selected' : ''}>${esc(option.label)}${option.description ? ` · ${esc(option.description)}` : ''}</option>`).join('')}</select>` : ''}${request.kind === 'approval' ? '' : `<input type="text" name="${esc(question.id)}-text" data-focus="question-text-${esc(question.id)}" aria-label="${esc(question.question || '补充说明')}" placeholder="填写你的回答" value="${esc(state.questionAnswers[`${request.id}/${question.id}-text`] || '')}">`}</label>`).join('')}<button type="submit" class="sc-primary">${request.kind === 'approval' ? '提交审批' : '发送补充'}</button></form>`).join('')
  }

  function participants() {
    const people = new Map(participantCatalog)
    for (const run of [...state.runs].reverse()) {
      for (const member of run.agents || []) people.set(member.id, member)
    }
    for (const member of state.scene.agents || []) people.set(member.id, member)
    return people
  }

  function eventLabel(event, names) {
    const name = id => names.get(id)?.name || id || '成员'
    if (event.type === 'handoff.queued') return `${name(event.fromAgentId)} 排队转交给 ${name(event.toAgentId)}`
    if (event.type === 'handoff.sent') {
      const verb = event.delivery === 'forward' ? '转发' : event.delivery === 'reply' ? '回复' : '发给'
      return `${name(event.fromAgentId)} ${verb} ${name(event.toAgentId)}`
    }
    if (event.type === 'owner.inbox.queued') return `${event.agentId ? name(event.agentId) : '你的补充'} · 进入队列`
    if (event.type === 'owner.inbox.processing') return 'Owner 开始处理'
    if (event.type === 'owner.inbox.processed') return 'Owner 已处理'
    if (event.type === 'message.added') return event.message?.role === 'user' ? '你发给 Owner' : 'Owner 向你汇报'
    if (event.type === 'user.question') return `${name(event.agentId)} 请求补充`
    if (event.type === 'user.answered') return '你已回答'
    if (event.type === 'run.interrupted') return '任务中断'
    if (event.type === 'run.finished') return STATE_LABELS[event.run?.state] || '任务结束'
    return 'Owner 决定'
  }

  function timelineView(runId, key) {
    const history = timelines.get(runId)
    const people = participants()
    const events = history ? orderedEvents(history).filter(collaborationEvent) : []
    const body = events.map(event => `<li data-history-sequence="${event.sequence}"><div class="sc-timeline-row"><time datetime="${esc(event.at)}">${esc(historyTime(event.at))}</time><strong>${esc(eventLabel(event, people))}</strong></div>${eventBody(event) ? `<div class="sc-prose">${prose(eventBody(event))}</div>` : ''}</li>`).join('')
    return `<details class="sc-timeline" data-timeline-run="${esc(runId)}" data-detail="timeline-${esc(key)}"><summary>协作时间线${events.length ? ` · ${events.length} 条` : ''}</summary><div class="sc-timeline-content">${history?.error ? `<p class="sc-small" role="alert">${esc(history.error)}</p><button type="button" data-action="timeline-retry" data-run="${esc(runId)}">重试</button>` : ''}${history?.hasOlder ? `<button type="button" class="sc-plain" data-action="timeline-older" data-run="${esc(runId)}" ${history.loading ? 'disabled' : ''}>读取较早事件</button>` : ''}${history?.loading ? '<p class="sc-small sc-muted" role="status">正在读取协作事件…</p>' : ''}${body ? `<ol class="sc-timeline-events">${body}</ol>` : history?.loaded ? '<p class="sc-small sc-muted">暂无已保存的调度和交接事件。</p>' : ''}<button type="button" class="sc-plain" data-action="export-timeline" data-run="${esc(runId)}" ${state.exportingTimeline ? 'disabled' : ''}>${state.exportingTimeline === runId ? '正在整理…' : '导出 Markdown'}</button></div></details>`
  }

  async function exportTimeline(runId) {
    if (state.exportingTimeline) return
    const generation = sceneGeneration
    state.exportingTimeline = runId
    render()
    try {
      const saved = historyPage()
      let before
      while (alive && generation === sceneGeneration) {
        const page = await api(collaborationQuery({ run: runId, before }))
        if (generation !== sceneGeneration) return
        mergeCollaboration(saved, page)
        const next = Math.min(...(page.events || []).map(event => event.sequence))
        if (!page.hasOlder || !Number.isFinite(next) || (before !== undefined && next >= before)) break
        before = next
      }
      if (!alive || generation !== sceneGeneration) return
      const run = state.runs.find(item => item.id === runId)
      const title = run?.text?.split('\n')[0].slice(0, 70) || '协作时间线'
      const people = participants()
      const text = ['# 协作时间线', '', title, '', ...orderedEvents(saved).filter(collaborationEvent).flatMap(event => [
        `## ${historyTime(event.at)} · ${eventLabel(event, people)}`, '', eventBody(event) || '', '',
      ])].join('\n')
      const fileUrl = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=UTF-8' }))
      const link = root.ownerDocument.createElement('a')
      link.href = fileUrl
      link.download = `协作时间线-${runId.slice(0, 8)}.md`
      root.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(fileUrl), 2500)
    } finally {
      if (generation === sceneGeneration) { state.exportingTimeline = ''; render() }
    }
  }

  function delegationPlan(run, people) {
    const delegations = run.delegations || []
    if (!delegations.length) return ''
    const live = activeRun()?.id === run.id && run.state !== 'cancelling'
    const byId = new Map(delegations.map(task => [task.id, task]))
    for (const task of delegations) if (task.planTaskId && !byId.has(task.planTaskId)) byId.set(task.planTaskId, task)
    const working = delegations.filter(task => task.state === 'working')
    const writer = working.find(task => task.access === 'write')
    const rows = delegations.map(task => {
      const member = run.agents?.find(agent => agent.id === task.agentId) || people.get(task.agentId)
      const pending = task.state === 'pending'
      const selectedProfile = task.profileSelected ? task.variantId : run.profileOverrides?.[task.agentId] ?? task.variantId
      const variant = member?.variants?.find(item => item.id === selectedProfile)
      const configuredModel = memberModelName(member || {}, state.catalog)
      const configuredEffort = variant?.effort ?? member?.effort ?? ''
      const model = pending ? configuredModel : task.model || configuredModel
      const effort = pending ? configuredEffort : task.effort ?? configuredEffort
      const selectable = pending && run.scene?.teamStrategy === 'auto' && member && member.engine !== 'agent' && !member.routeLocked
        && !task.profileSelected && !Object.hasOwn(run.profileOverrides || {}, task.agentId)
      const settings = [member?.name || task.agentId, model, effortLabel(effort), selectable ? '执行时可自动调整' : ''].filter(Boolean).join(' · ')
      const dependencies = (task.dependencies || []).map(id => ({ id, task: byId.get(id) }))
      const incomplete = dependencies.filter(item => item.task?.state !== 'completed' || item.task.accepted === false)
      const title = item => item.task?.title || item.id
      const waits = []
      if (live && task.state === 'pending') {
        if (incomplete.length) waits.push(`等待前置任务：${incomplete.map(item => `「${title(item)}」${item.task?.accepted === false && item.task.state === 'completed' ? '待验收' : ''}`).join('、')}`)
        if (Date.parse(task.notBefore) > Date.now()) waits.push(`等待计划时间 · ${fullTime(task.notBefore)}`)
        if (!waits.length) {
          const sameMember = working.find(item => item.agentId === task.agentId)
          if (sameMember) waits.push(`等待同一成员结束「${sameMember.title}」`)
          if (task.access === 'write' && writer) waits.push(`等待本轮工作区写入名额：「${writer.title}」`)
          if (!waits.length) waits.push('等待本轮调度')
        }
      }
      const acceptance = typeof task.acceptanceCriteria === 'string' ? task.acceptanceCriteria : JSON.stringify(task.acceptanceCriteria, null, 2)
      const key = `collab-task-${run.id}-${task.id}`
      const displayState = task.state === 'completed' && task.accepted === false ? '<span class="sc-badge warn">待验收</span>' : badge(task.state)
      return `<li><details class="sc-collab-task" data-detail="${esc(key)}"><summary data-focus="${esc(key)}">${displayState} <strong>${esc(task.title)}</strong>${settings ? ` <small class="sc-muted">${esc(settings)}</small>` : ''}</summary>
        <div class="sc-collab-task-content"><div class="sc-collab-task-field"><strong>任务指令</strong><div class="sc-prose">${esc(task.instruction || '没有保存任务指令。')}</div></div>
        <div class="sc-collab-task-field"><strong>验收要求</strong><div class="sc-prose">${esc(acceptance || '没有保存验收要求。')}</div></div>
        ${dependencies.length ? `<div class="sc-small sc-muted">前置任务 · ${esc(dependencies.map(title).join('、'))}</div>` : ''}
        ${task.routingReason ? `<div class="sc-small sc-muted">${esc(task.routingReason)}</div>` : ''}${task.error ? `<div class="sc-small sc-muted">${esc(task.error)}</div>` : ''}
        ${live && task.state === 'pending' && member?.variants?.length ? `<label>执行档位<select aria-label="${esc(task.title)}的执行档位" data-run-profile data-run="${esc(run.id)}" data-task="${esc(task.id)}" data-agent="${esc(task.agentId)}">${profileOptions(member, selectedProfile)}</select></label>` : ''}</div></details>
        ${waits.length ? `<p class="sc-collab-task-wait sc-small sc-muted">${waits.map(esc).join(' · ')}</p>` : ''}</li>`
    }).join('')
    const key = `collab-plan-${run.id}`
    return `<details class="sc-collab-plan" data-detail="${esc(key)}" data-scroll="${esc(key)}"><summary data-focus="${esc(key)}">本轮分工 · ${delegations.length} 项</summary><ul>${rows}</ul></details>`
  }

  function collaborationView(run) {
    const selectedScope = state.processScope === 'run'
    const paneRun = selectedScope ? run.id : ''
    const history = selectedScope ? timelines.get(run.id) || historyPage() : collaboration
    const people = participants()
    const events = orderedEvents(history).filter(event => event.type === 'handoff.sent')
    const agents = [...people.values()]
    const available = agents.filter(member => member.id !== run.ownerId)
    if ((!available.length || state.sourceMessage?.agentId === run.ownerId) && people.has(run.ownerId)) available.push(people.get(run.ownerId))
    const latest = events.findLast(event => event.fromAgentId === run.ownerId || event.toAgentId === run.ownerId)
    const recentId = latest?.fromAgentId === run.ownerId ? latest?.toAgentId : latest?.fromAgentId
    const preferred = state.processMembers.filter(id => available.some(member => member.id === id))
    const primaryId = preferred[0] || recentId || available[0]?.id
    const secondaryId = !state.processCompact ? preferred[1] : undefined
    const selected = [primaryId, secondaryId].filter(id => people.has(id))
    const profile = ({ model, effort }) => [model, effort !== undefined ? effortLabel(effort) : ''].filter(Boolean).join(' · ')
    const plan = delegationPlan(run, people)
    const separator = selected.length === 2 ? `<div class="sc-member-separator" id="sc-collab-split" role="separator" tabindex="0" aria-orientation="horizontal" aria-label="调整两段对话的高度" aria-controls="sc-transcript-0 sc-transcript-1" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(memberWeight(primaryId) / (memberWeight(primaryId) + memberWeight(secondaryId)) * 100)}" data-upper="${esc(primaryId)}" data-lower="${esc(secondaryId)}" data-process-split title="拖动调整高度，双击恢复均分"></div>` : ''
    const panes = selected.map((id, index) => {
      const member = people.get(id)
      let paneHistory = memberHistory(paneRun, id)
      if (!paneHistory && (preferred.length || latest || history.loaded || history.error)) {
        paneHistory = memberHistory(paneRun, id, true)
        const generation = sceneGeneration
        queueMicrotask(() => {
          if (alive && generation === sceneGeneration) loadCollaboration(paneRun, false, id).catch(report)
        })
      }
      const relevant = paneHistory ? orderedEvents(paneHistory) : []
      const working = [...(activeRun()?.tasks || [])].reverse().find(task => task.agentId === id && task.state === 'working')
      const stream = working ? [...state.streams.entries()].find(([, value]) => value.runId === activeRun()?.id && value.agentId === id) : undefined
      let previous
      const messages = relevant.map(event => {
        const eventRun = state.runs.find(item => item.id === event.runId)
        const sender = people.get(event.fromAgentId)?.name || event.fromAgentId || '成员'
        const other = event.toAgentId === id ? '' : people.get(event.toAgentId)?.name
        const fromOwner = event.fromAgentId === (eventRun?.ownerId || run.ownerId) || event.toAgentId === id
        const divider = previous !== event.runId && !selectedScope ? `<div class="sc-transcript-divider" aria-label="任务轮次"><time datetime="${esc(event.at)}">${esc(time(event.at))}</time>${eventRun?.text ? `<span>${esc(eventRun.text.slice(0, 52))}</span>` : ''}</div>` : ''
        previous = event.runId
        const context = profile(event)
        const delivery = event.delivery === 'forward' ? '转发' : event.delivery === 'assignment' ? '下发' : event.delivery === 'reply' ? '回报' : ''
        const original = event.messageId ? state.messages.find(message => message.id === event.messageId) : undefined
        const detailKey = `collab-message-${index}-${event.sequence}`
        const evidence = original && (original.raw || original.text !== event.text)
          ? `<details data-detail="${detailKey}"><summary>原始回报与证据</summary><pre>${esc(original.raw || original.text)}</pre></details>`
          : !original && event.messageId ? `<button type="button" class="sc-plain sc-exchange-source" data-action="collab-source" data-message="${esc(event.messageId)}" data-detail-key="${detailKey}">原始回报与证据</button>` : ''
        return `${divider}<article class="sc-exchange${fromOwner ? ' sc-exchange-owner' : ''}" data-history-sequence="${event.sequence}" data-message-id="${esc(event.messageId)}" tabindex="-1"><div class="sc-exchange-meta"><strong>${esc(sender)}</strong>${other ? `<span>→ ${esc(other)}</span>` : ''}${delivery ? `<span>${delivery}</span>` : ''}<time datetime="${esc(event.at)}">${esc(historyTime(event.at))}</time>${memoryDraftAction(event.messageId)}</div><div class="sc-exchange-bubble sc-prose">${prose(event.text || original?.text || '')}</div>${context ? `<small class="sc-muted">${esc(context)}</small>` : ''}${evidence}</article>`
      }).join('')
      const paneScope = `data-member="${esc(id)}" data-run="${esc(paneRun)}"`
      const earlier = paneHistory?.hasOlder ? `<button type="button" class="sc-plain sc-transcript-older" data-action="collab-older" ${paneScope} ${paneHistory.loading ? 'disabled' : ''}>读取较早消息</button>` : ''
      const filter = selectedScope ? run.id : state.sessionId
      const source = state.sourceMessage
      const origin = selectedScope && source?.agentId === id && source.runId === run.id && !relevant.some(event => event.messageId === source.id)
        ? `<details data-detail="collab-source-${esc(source.id)}" data-message-id="${esc(source.id)}" tabindex="-1" open><summary>记忆来源 · ${esc(source.stage || '原消息')}</summary><pre>${esc(source.raw || source.text)}</pre></details>` : ''
      const comparison = index ? `<select id="sc-collab-compare" aria-label="对比成员">${available.filter(person => person.id !== primaryId).map(person => `<option value="${esc(person.id)}" ${person.id === id ? 'selected' : ''}>${esc(person.name)}</option>`).join('')}</select><button type="button" data-action="close-comparison" aria-label="关闭对比">关闭</button>` : ''
      const paneStatus = paneHistory?.error ? `<p role="alert">${esc(paneHistory.error)}</p><button type="button" data-action="collab-retry" ${paneScope}>重试</button>`
        : !paneHistory?.loaded || paneHistory.loading ? '<p class="sc-small sc-muted" role="status">正在读取协作消息…</p>'
          : !messages && !origin ? `<p class="sc-transcript-empty sc-muted">${paneHistory.hasOlder ? '这页没有这位成员的消息。' : '这位成员还没有下发任务或回报。'}</p>` : ''
      return `${index ? separator : ''}<section class="sc-agent sc-thread-pane" data-agent-pane="${esc(id)}" style="--sc-agent-weight:${memberWeight(id)}"><header class="sc-agent-head sc-thread-head"><div class="sc-agent-identity"><strong>${esc(member.name)}</strong>${id === run.ownerId ? '<span class="sc-owner-mark">Owner</span>' : ''}<small>${esc(`${memberModelName(member, state.catalog)} · ${effortLabel(member.effort || '')}`)}</small></div>${working ? badge('working') : ''}${relevant.length ? '<button type="button" data-action="collab-latest" aria-label="跳到最新协作消息">最新</button>' : ''}${comparison}</header><div class="sc-agent-body sc-transcript" id="sc-transcript-${index}" data-scroll="collab-${esc(filter)}-${esc(id)}" aria-label="与${esc(member.name)}的协作消息">${origin}${earlier}${paneStatus}${messages}${stream ? `<details data-detail="stream-${esc(stream[0])}"><summary>查看正在执行的阶段</summary><div class="sc-stream" data-stream="${esc(stream[0])}">${esc(stream[1].text)}</div></details>` : ''}<div class="sc-source"><button type="button" data-action="agent-context" data-agent="${esc(id)}">查看实际采用的上下文</button></div></div></section>`
    }).join('')
    return `<aside class="sc-processes sc-collaboration" aria-label="协作消息"><div class="sc-process-head"><strong>协作消息</strong><div class="sc-collab-filters"><select id="sc-collab-scope" aria-label="消息范围"><option value="session" ${!selectedScope ? 'selected' : ''}>本会话</option><option value="run" ${selectedScope ? 'selected' : ''}>按任务筛选</option></select>${selectedScope ? `<select id="sc-run" aria-label="选择任务轮次">${state.runs.map(item => `<option value="${esc(item.id)}" ${item.id === run.id ? 'selected' : ''}>${esc(time(item.createdAt))} · ${esc(item.text.slice(0, 35))}</option>`).join('')}</select>` : ''}${!state.processCompact && available.length > 1 && !secondaryId ? `<button type="button" class="sc-plain" data-action="compare-members" data-agent="${esc(primaryId)}">对比两位</button>` : ''}</div></div>${plan}${run.error ? `<p class="sc-run-interruption sc-small">${esc(run.error)}</p>` : ''}<div class="sc-collab-member-list" data-scroll="collaboration-members" aria-label="选择成员">${available.map(member => `<button type="button" data-action="focus-participant" data-agent="${esc(member.id)}" data-focus="participant-${esc(member.id)}" aria-pressed="${member.id === primaryId}">${esc(member.name)}</button>`).join('')}</div><div class="sc-member-panes sc-thread-panes">${panes || '<p class="sc-transcript-empty sc-muted">等待 Owner 分配任务。</p>'}</div></aside>`
  }

  function processView(run) {
    let previousExpanded
    const live = activeRun()?.id === run.id
    const delegationState = task => run.state === 'failed' && task.state === 'failed'
      && !run.tasks.some(stage => stage.agentId === task.agentId && stage.title === task.title) ? 'blocked' : task.state
    const taskConfig = (task, agent) => {
      const variantId = task.state === 'pending' && !task.profileSelected ? run.profileOverrides?.[agent?.id] ?? task.variantId : task.variantId
      const variant = agent?.variants?.find(item => item.id === variantId)
      const effort = task.state !== 'pending' && task.effort !== undefined ? task.effort : variant ? variant.effort : agent?.effort
      return { variantId, label: `${memberModelName(agent || {}, state.catalog)} · ${effortLabel(effort || '')}${variant ? ` · ${variant.name}` : ''}` }
    }
    const taskInstruction = task => `<p class="sc-prose">${esc(task.instruction || '这条历史任务未保存下发指令。')}</p>${task.acceptanceCriteria ? `<p class="sc-small sc-prose"><strong>验收要求</strong> ${esc(typeof task.acceptanceCriteria === 'string' ? task.acceptanceCriteria : JSON.stringify(task.acceptanceCriteria))}</p>` : ''}${task.dependencies?.length ? `<p class="sc-small sc-muted">依赖 ${task.dependencies.map(id => esc(run.delegations.find(item => item.planTaskId === id)?.title || id)).join('、')}</p>` : ''}`
    const assignments = run.delegations?.length ? `<details class="sc-assignments" data-detail="assignments-${run.id}" open><summary>Owner 本轮分工 · ${run.delegations.length} 项</summary><div>${run.delegations.map(task => {
      const agent = run.agents.find(agent => agent.id === task.agentId)
      const profile = taskConfig(task, agent)
      return `<article><details data-detail="assignment-${run.id}-${task.id}"><summary>${badge(delegationState(task))} <strong>${esc(task.title)}</strong><span class="sc-assignment-config">${esc(agent?.name)} · ${esc(profile.label)}</span></summary>${taskInstruction(task)}</details>
        ${live && task.state === 'pending' && agent?.variants?.length ? `<label>执行档位<select data-run-profile data-run="${run.id}" data-task="${task.id}" data-agent="${agent.id}">${profileOptions(agent, profile.variantId)}</select></label>` : ''}</article>`
    }).join('')}</div></details>` : ''
    return `<aside class="sc-processes" aria-label="成员处理过程"><div class="sc-process-head">${badge(run.state)}<select id="sc-run" aria-label="选择任务轮次">${state.runs.map(item => `<option value="${item.id}" ${run.id === item.id ? 'selected' : ''}>${esc(time(item.createdAt))} · ${esc(item.text.slice(0, 35))}</option>`).join('')}</select><button type="button" class="sc-plain" data-action="collapse-all">${run.agents.every(agent => state.collapsed.has(agent.id)) ? '展开全部' : '收起全部'}</button></div>
      ${run.error ? `<p class="sc-run-interruption sc-small">任务在“${esc(run.tasks.find(task => task.state === 'failed')?.title || '执行阶段')}”中断。${esc(run.error)}。可在主聊天点击“接续这项任务”恢复处理。</p>` : ''}${assignments}<div class="sc-member-panes">${run.agents.map(agent => {
        const messages = state.messages.filter(message => message.runId === run.id && message.agentId === agent.id)
        const streams = [...state.streams.entries()].filter(([, stream]) => stream.agentId === agent.id && stream.runId === run.id)
        const task = [...run.tasks].reverse().find(task => task.agentId === agent.id)
        const tools = state.events.filter(event => event.runId === run.id && event.agentId === agent.id && event.type === 'tool.completed')
        const collapsed = state.collapsed.has(agent.id)
        const member = state.scene.agents.find(member => member.id === agent.id) || agent
        const assigned = (run.delegations || []).filter(task => task.agentId === agent.id)
        const profile = taskConfig(task || { state: 'pending' }, agent)
        let separator = ''
        if (!collapsed) {
          if (previousExpanded) {
            const percent = Math.round(memberWeight(previousExpanded.id) / (memberWeight(previousExpanded.id) + memberWeight(agent.id)) * 100)
            separator = `<div class="sc-member-separator" id="sc-member-split-${previousExpanded.id}-${agent.id}" role="separator" tabindex="0" aria-orientation="horizontal" aria-label="调整 ${esc(previousExpanded.name)} 与 ${esc(agent.name)} 的高度" aria-controls="sc-body-${previousExpanded.id} sc-body-${agent.id}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="上方 ${percent}%，下方 ${100 - percent}%" data-upper="${previousExpanded.id}" data-lower="${agent.id}" title="拖动调整高度，双击恢复均分"></div>`
          }
          previousExpanded = agent
        }
        return `${separator}<section class="sc-agent ${collapsed ? 'sc-collapsed' : ''}" data-agent-pane="${agent.id}" style="--sc-agent-weight:${memberWeight(agent.id)}"><header class="sc-agent-head"><div class="sc-agent-identity"><strong>${esc(agent.name)}</strong>${run.ownerId === agent.id && run.mode === 'orchestration' ? '<span class="sc-owner-mark">Owner</span>' : ''}<small title="${esc(profile.label)}">${esc(profile.label)}</small>${member.showRoleSummary && member.roleSummary ? `<span class="sc-agent-role-summary" title="${esc(member.roleSummary)}">${esc(member.roleSummary)}</span>` : ''}</div>${task ? badge(task.state === 'completed' ? 'stage_completed' : task.state) : ''}<button type="button" data-action="collapse" data-agent="${agent.id}" aria-expanded="${!collapsed}" aria-controls="sc-body-${agent.id}">${collapsed ? '展开' : '收起'}</button></header><div class="sc-agent-body" id="sc-body-${agent.id}" data-scroll="agent-${run.id}-${agent.id}" ${collapsed ? 'hidden' : ''}>
          ${live && agent.variants?.length ? `<label class="sc-profile-selector">后续步骤的强度<select data-run-profile data-run="${run.id}" data-agent="${agent.id}">${profileOptions(agent, run.profileOverrides?.[agent.id])}</select></label>` : ''}
          ${assigned.length ? `<section class="sc-agent-orders"><h3>Owner 下发的任务</h3>${assigned.map(order => `<article><strong>${esc(order.title)}</strong>${badge(delegationState(order))}<p class="sc-small sc-muted">${esc(taskConfig(order, agent).label)}</p>${taskInstruction(order)}</article>`).join('')}</section>` : !messages.length && !streams.length && !tools.length ? '<p class="sc-small sc-muted">等待任务分配</p>' : ''}
          ${messages.map(message => `<div data-message-id="${esc(message.id)}" tabindex="-1"><div class="sc-message-label">${esc(message.stage)}${message.profileName ? `<span class="sc-small sc-muted"> · ${esc(message.profileName === '默认强度' ? '成员配置' : message.profileName)} · ${esc(effortLabel(message.effort || ''))}</span>` : ''}${message.error ? badge('failed') : ''}${memoryDraftAction(message.sessionId && message.id)}</div><div class="sc-prose">${prose(message.text)}</div>${message.raw ? `<details data-detail="message-${message.id}"><summary>查看原始结果与证据</summary><pre>${esc(message.raw)}</pre></details>` : ''}</div>`).join('')}
          ${streams.map(([id, stream]) => `<div><span class="sc-muted">正在处理</span><div class="sc-stream" data-stream="${id}">${esc(stream.text)}</div></div>`).join('')}
          ${task?.error ? `<p class="sc-prose">${esc(task.error)}</p>` : ''}
          ${tools.map(tool => `<details data-detail="tool-${tool.sequence}"><summary>${esc(tool.tool)} · ${esc(time(tool.at))}</summary><pre>${esc(tool.text)}</pre></details>`).join('')}
          <div class="sc-source"><button type="button" data-action="agent-context" data-agent="${agent.id}">查看实际采用的上下文</button></div>
        </div></section>`
      }).join('')}</div></aside>`
  }


  function teamView() {
    const title = options.sessionTitle || state.scene.sessions?.find(session => session.id === state.sessionId)?.title
    return renderTeamSettings(state.settings || state.scene, state.catalog, title, state.editingMembers)
  }

  function memoryView() { return renderMemoryPage(state, { badge, prose, time: fullTime }) }

  function contextView() { return contextDashboard.view() }

  function drawerView() { return renderScenePicker(state, options) }

  function resizeRoleEditors() {
    for (const editor of root.querySelectorAll('details[open] textarea[data-auto-grow]')) {
      editor.style.height = 'auto'
      editor.style.height = `${editor.scrollHeight + 2}px`
    }
  }

  const listen = (type, handler) => root.addEventListener(type, handler, { signal: lifetime.signal })
  root.addEventListener('toggle', resizeRoleEditors, { capture: true, signal: lifetime.signal })
  root.addEventListener('toggle', event => {
    const runId = event.target.dataset.timelineRun
    if (!runId || !event.target.open) return
    const history = timelines.get(runId)
    if (!history?.loaded && !history?.error) loadCollaboration(runId).catch(report)
  }, { capture: true, signal: lifetime.signal })
  listen('focusout', event => {
    if (event.target !== openSelect) return
    openSelect = undefined
    queueMicrotask(() => { if (pendingRender && !openSelect) render() })
  })

  listen('sc-layout-change', () => {
    const button = root.querySelector('[data-action="expand"]')
    if (button) button.textContent = options.isExpanded?.() ? '收回工作区' : '展开工作区'
  })
  listen('input', event => {
    const input = event.target
    if (input.matches(':disabled') || (input.dataset.agent && !input.hasAttribute('data-run-profile') && !state.editingMembers.has(input.dataset.agent))) return
    if (contextDashboard.input(input)) return
    if (input.id === 'sc-new-session-title') state.newSessionDraft.title = input.value
    if (input.dataset.skillField) state.skillEditor[input.dataset.skillField] = input.value
    if (input.dataset.variantField && input.tagName === 'INPUT') {
      const agent = state.settings.agents.find(agent => agent.id === input.dataset.agent)
      agent.variants.find(variant => variant.id === input.dataset.variant)[input.dataset.variantField] = input.value
      state.settingsDirty = true
    }
    if (input.id === 'sc-draft') {
      state.draft = input.value
      try { localStorage.setItem(`dsh-codex-chat.draft.${state.sessionId}`, state.draft) } catch { /* Keep editing available. */ }
    }
    const questionForm = input.closest('form[data-question]')
    if (questionForm && input.name) state.questionAnswers[`${questionForm.dataset.question}/${input.name}`] = input.value
    if (input.dataset.setting) { state.settings[input.dataset.setting] = input.value; state.settingsDirty = true }
    if (input.hasAttribute('data-effort-slider')) {
      const agent = state.settings.agents.find(agent => agent.id === input.dataset.agent)
      agent.effort = JSON.parse(input.dataset.efforts)[Number(input.value)] || ''
      const label = input.closest('.sc-effort-control').querySelector('.sc-effort-ticks').children[Number(input.value)].textContent
      input.closest('.sc-effort-control').querySelector('output').textContent = label
      input.setAttribute('aria-valuetext', label)
      state.settingsDirty = true
    }
    if (input.dataset.agentField && ['INPUT', 'TEXTAREA'].includes(input.tagName)) {
      const agent = state.settings.agents.find(agent => agent.id === input.dataset.agent)
      agent[input.dataset.agentField] = input.value
      state.settingsDirty = true
    }
    if (input.hasAttribute('data-auto-grow')) resizeRoleEditors()
    if (input.dataset.memoryField) state.memoryDraft[input.dataset.memoryField] = input.value
    if (input.id === 'sc-memory-history-number') state.memoryHistoryNumberDraft = input.value
    if (input.id === 'sc-memory-query') { state.memoryQuery = input.value; render() }
  })

  listen('change', event => {
    const input = event.target
    if (input === openSelect) openSelect = undefined
    if (pendingRender) queueMicrotask(() => { if (pendingRender && !openSelect) render() })
    if (input.matches(':disabled') || (input.dataset.agent && !input.hasAttribute('data-run-profile') && !state.editingMembers.has(input.dataset.agent))) return
    const perform = async () => {
      if (input.dataset.routing) {
        const field = input.dataset.routing
        const policy = state.settings.routingPolicy ||= {}
        if (field === 'deepseek') {
          const [provider, model] = input.value.split('::')
          if (model) { policy.deepseekProvider = provider; policy.deepseekModel = model }
          else { delete policy.deepseekProvider; delete policy.deepseekModel }
        } else if (field === 'visionAvailable') policy[field] = input.checked
        else if (input.value) policy[field] = input.value
        else delete policy[field]
        state.settingsDirty = true
        return
      }
      if (input.dataset.variantField && input.tagName === 'SELECT') {
        const agent = state.settings.agents.find(agent => agent.id === input.dataset.agent)
        agent.variants.find(variant => variant.id === input.dataset.variant)[input.dataset.variantField] = input.value
        state.settingsDirty = true
        return
      }
      if (input.hasAttribute('data-run-profile')) {
        const result = await api(`/runs/${input.dataset.run}/profiles`, 'PATCH', {
          agentId: input.dataset.agent, variantId: input.value, taskId: input.dataset.task || undefined,
        })
        mergeRun(result.run)
        state.notice = '强度已调整，将用于尚未开始的步骤'
        return render()
      }
      if (input.hasAttribute('data-memory-audience')) {
        state.memoryDraft.audience = input.value === 'scene' ? 'scene' : 'role'
        state.memoryDraft.roleId = input.value === 'scene' ? '' : input.value.slice(5)
        return
      }
      if (input.id === 'sc-memory-audience') {
        state.memoryAudience = input.value
        state.memoryDraft = undefined
        state.memoryId = state.memories.find(memory => input.value === 'all'
          || (input.value === 'scene' ? memory.audience !== 'role' : memory.roleId === input.value.slice(5)))?.id || ''
        return render()
      }
      if (input.id === 'sc-files') return upload([...input.files])
      if (input.dataset.agentField === 'agentProvider' && input.tagName === 'INPUT') {
        const agent = state.settings.agents.find(agent => agent.id === input.dataset.agent)
        agent.agentProvider = input.value.trim()
        if (!supportsMemberModel(agent, state.catalog)) { agent.model = ''; agent.provider = ''; agent.effort = ''; agent.variants = [] }
        state.settingsDirty = true
        return render()
      }
      if (input.id === 'sc-mode') return saveScene({ mode: input.value })
      if (input.id === 'sc-owner') return saveScene({ ownerId: input.value })
      if (input.id === 'sc-collab-scope') {
        state.processScope = input.value
        saveProcessLayout()
        render()
        return loadCollaboration(input.value === 'run' ? selectedRun()?.id : undefined)
      }
      if (input.id === 'sc-collab-compare') {
        if (input.value && input.value !== state.processMembers[0]) state.processMembers[1] = input.value
        saveProcessLayout()
        return render()
      }
      if (input.id === 'sc-run') {
        const generation = sceneGeneration
        const result = await api(`/runs/${input.value}`)
        if (generation !== sceneGeneration) return
        state.selectedRunId = input.value
        mergeRun(result.run)
        loadMemberCollapses(result.run)
        mergeMessages(result.messages)
        state.events = [...new Map([...state.events, ...(result.events || [])].map(item => [item.sequence, item])).values()].sort((first, second) => first.sequence - second.sequence).slice(-400)
        if (orchestrationView(result.run) && state.processScope === 'run') await loadCollaboration(result.run.id)
        return render()
      }
      if (input.dataset.agentField && input.tagName === 'SELECT') {
        const agent = state.settings.agents.find(agent => agent.id === input.dataset.agent)
        if (input.dataset.agentField === 'model') {
          const index = input.value.indexOf('::')
          agent.provider = input.value.slice(0, index)
          agent.model = input.value.slice(index + 2)
          agent.effort = ''
        } else if (input.dataset.agentField === 'engine') {
          agent.engine = input.value
          agent.permission = 'default'
          agent.model = ''; agent.provider = ''; agent.effort = ''; agent.variants = []
          agent.agentProvider = input.value === 'agent' ? state.catalog.agentBackends?.find(backend => !['spawn', 'fork'].includes(backend.id))?.id || '' : ''
        }
        else agent[input.dataset.agentField] = input.value
        state.settingsDirty = true
        render()
      }
      if (input.dataset.skill) {
        const agent = state.settings.agents.find(agent => agent.id === input.dataset.agent)
        agent.skills = input.checked ? [...new Set([...agent.skills, input.dataset.skill])] : agent.skills.filter(name => name !== input.dataset.skill)
        state.settingsDirty = true
      }
      if (input.dataset.agentFlag) {
        const agent = state.settings.agents.find(agent => agent.id === input.dataset.agent)
        agent[input.dataset.agentFlag] = input.checked
        state.settingsDirty = true
      }
      if (input.dataset.setting) {
        state.settings[input.dataset.setting] = input.dataset.setting === 'reviewRounds' ? Number(input.value) : input.value
        state.settingsDirty = true
        if (input.dataset.setting === 'teamStrategy') render()
      }
      if (input.id === 'sc-memory-scope') { state.memoryScope = input.value; state.memoryDraft = undefined; return loadMemories() }
      if (input.id === 'sc-memory-kind') { state.memoryKind = input.value; return render() }
      if (input.dataset.memoryToggle) {
        const memory = state.memories.find(item => item.id === state.memoryId)
        await api(`/memories/${memory.id}`, 'PATCH', { revision: memory.revision, [input.dataset.memoryToggle]: input.checked })
        return loadMemories()
      }
      if (input.id === 'sc-context-agent') return contextDashboard.load(input.value)
      if (input.id === 'sc-context-id') return contextDashboard.select(input.value)
    }
    perform().catch(report)
  })

  root.ownerDocument.addEventListener('keydown', event => {
    if (event.key === 'Escape' && openSelect) { openSelect = undefined; if (pendingRender) queueMicrotask(() => render()) }
    if (event.key === 'Escape' && state.sourceViewer) { event.preventDefault(); state.sourceViewer = undefined; render(); return }
    if (event.key !== 'Escape' || !state.memberPicker) return
    event.preventDefault()
    state.memberPicker = false
    render()
    root.querySelector('[data-action="quick-members"]')?.focus()
  }, { signal: lifetime.signal })
  listen('keydown', event => {
    if (event.target.tagName === 'SELECT' && ['ArrowDown', 'ArrowUp', ' ', 'Enter'].includes(event.key)) openSelect = event.target
    if (event.target.classList.contains('sc-member-separator') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      const pair = memberPair(event.target)
      if (!pair) return
      event.preventDefault()
      const height = event.key === 'Home' ? pair.minimum : event.key === 'End' ? pair.maximum
        : pair.upperHeight + pair.height * (event.key === 'ArrowUp' ? -0.03 : 0.03)
      applyMemberSize(pair, height)
      saveMemberWeights()
    }
    if (event.target.id === 'sc-draft' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      send().catch(report)
    }
    if (event.target.classList.contains('sc-separator') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault()
      const current = parseFloat(root.style.getPropertyValue('--sc-split')) || 50
      root.style.setProperty('--sc-split', `${Math.max(30, Math.min(70, current + (event.key === 'ArrowLeft' ? -2 : 2)))}%`)
      saveProcessLayout()
    }
  })

  listen('pointerdown', event => {
    if (event.target.tagName === 'SELECT') openSelect = event.target
    const memberSeparator = event.target.closest('.sc-member-separator')
    if (memberSeparator) {
      if (event.button !== 0) return
      const pair = memberPair(memberSeparator)
      if (!pair || pair.height <= 4) return
      event.preventDefault()
      memberSeparator.focus({ preventScroll: true })
      memberDrag = { ...pair, pointerId: event.pointerId, startY: event.clientY, runId: selectedRun()?.id, process: memberSeparator.hasAttribute('data-process-split') }
      root.classList.add('sc-member-resizing')
      root.setPointerCapture(event.pointerId)
      return
    }
    if (!event.target.classList.contains('sc-separator')) return
    event.preventDefault()
    const separator = event.target
    const bounds = root.querySelector('.sc-chat').getBoundingClientRect()
    const move = pointer => root.style.setProperty('--sc-split', `${Math.max(30, Math.min(70, (pointer.clientX - bounds.left) / bounds.width * 100))}%`)
    const stop = () => {
      separator.removeEventListener('pointermove', move)
      separator.removeEventListener('pointerup', stop)
      separator.removeEventListener('pointercancel', stop)
      saveProcessLayout()
    }
    separator.setPointerCapture(event.pointerId)
    separator.addEventListener('pointermove', move)
    separator.addEventListener('pointerup', stop)
    separator.addEventListener('pointercancel', stop)
  })

  listen('pointermove', event => {
    if (memberDrag && memberDrag.pointerId === event.pointerId) {
      applyMemberSize(memberDrag, memberDrag.upperHeight + event.clientY - memberDrag.startY)
    }
  })
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    listen(type, event => { if (memberDrag?.pointerId === event.pointerId) stopMemberResize() })
  }
  listen('dblclick', event => {
    const separator = event.target.closest('.sc-member-separator')
      || document.elementFromPoint(event.clientX, event.clientY)?.closest('.sc-member-separator')
    if (!separator || !root.contains(separator)) return
    const pair = memberPair(separator)
    if (!pair) return
    applyMemberSize(pair, pair.height / 2)
    saveMemberWeights()
  })

  listen('submit', event => {
    if (event.target.id === 'sc-memory-history-search') {
      event.preventDefault()
      Promise.resolve().then(() => filterMemoryHistory(state.memoryHistoryNumberDraft)).catch(report)
      return
    }
    const form = event.target.closest('form[data-question]')
    if (!form) return
    event.preventDefault()
    const run = state.runs.find(run => run.id === form.dataset.run)
    const request = run.questions.find(request => request.id === form.dataset.question)
    const data = new FormData(form)
    const answers = {}
    for (const question of request.questions) {
      const text = String(data.get(`${question.id}-text`) || data.get(question.id) || '').trim()
      if (!text) { report(new Error('请填写每个问题的回答')); return }
      answers[question.id] = { answers: [text] }
    }
    api(`/runs/${run.id}/answers`, 'POST', { questionId: request.id, answers }).catch(report)
  })

  listen('click', event => {
    const contextButton = event.target.closest('button[data-cx]')
    if (contextButton && !contextButton.disabled) { contextDashboard.click(contextButton, root).catch(report); return }
    const button = event.target.closest('button[data-action]')
    if (!button || button.disabled) return
    const action = button.dataset.action
    const perform = async () => {
      if (action === 'retry-bootstrap') return openScene()
      if (action === 'new-demand') {
        state.drawer = false
        state.newSessionDraft = { title: '', requestId: crypto.randomUUID() }
        render()
        root.querySelector('#sc-new-session-title')?.focus()
        return
      }
      if (action === 'close-demand') { state.newSessionDraft = undefined; return render() }
      if (action === 'create-demand') {
        if (state.creatingSession) return
        state.creatingSession = true
        render()
        try {
          const result = await api(`/scenarios/${state.scene.id}/sessions`, 'POST', state.newSessionDraft)
          state.newSessionDraft = undefined
          await openDemand(result.sessionId, result.sessionTitle, result.nativeSessionId)
        } finally { state.creatingSession = false; if (alive) render() }
        return
      }
      if (action === 'open-demand') return openDemand(button.dataset.session, button.dataset.title, button.dataset.session, button.dataset.scene)
      if (action === 'view') return navigate(button.dataset.view)
      if (action === 'dismiss') { state.error = ''; state.notice = ''; return render() }
      if (action === 'expand') return options.onExpand?.()
      if (action === 'send') return send()
      if (action === 'stop') { if (activeRun()) await api(`/runs/${activeRun().id}/cancel`, 'POST', {}); return }
      if (action === 'resume') {
        const run = state.runs.find(run => run.id === button.dataset.run)
        state.draft = run.text
        return send(run.id)
      }
      if (action === 'attach') return root.querySelector('#sc-files').click()
      if (action === 'remove-file') { state.attachments.splice(Number(button.dataset.index), 1); return render() }
      if (action === 'quick-members') {
        state.memberPicker = !state.memberPicker || Boolean(button.dataset.agent && button.dataset.agent !== state.quickMemberId)
        state.quickMemberId = button.dataset.agent || state.quickMemberId || state.scene.agents[0].id
        render()
        if (state.memberPicker) root.querySelector('.sc-member-popover [data-action="close-members"]')?.focus()
        return loadCatalog()
      }
      if (action === 'pick-quick-member') { state.quickMemberId = button.dataset.agent; return render() }
      if (action === 'close-members') { state.memberPicker = false; return render() }
      if (action === 'team') return navigate('team')
      if (action === 'process-toggle') { state.showProcesses = !state.showProcesses; state.mobilePane = 'main'; return render() }
      if (action === 'mobile-main' || action === 'mobile-process') { state.mobilePane = action === 'mobile-main' ? 'main' : 'process'; return render() }
      if (action === 'focus-participant') {
        const id = button.dataset.agent
        const comparison = state.processMembers[1]
        state.processMembers = [id]
        if (comparison && comparison !== id) state.processMembers.push(comparison)
        saveProcessLayout()
        return render()
      }
      if (action === 'compare-members') {
        const primary = button.dataset.agent
        const comparison = [...participants().keys()].find(id => id !== primary && id !== selectedRun()?.ownerId)
        if (primary && comparison) state.processMembers = [primary, comparison]
        saveProcessLayout()
        render()
        root.querySelector('#sc-collab-compare')?.focus()
        return
      }
      if (action === 'close-comparison') { state.processMembers = state.processMembers.slice(0, 1); saveProcessLayout(); return render() }
      if (action === 'collab-latest') {
        const transcript = button.closest('.sc-thread-pane')?.querySelector('.sc-transcript')
        if (transcript) transcript.scrollTop = transcript.scrollHeight
        return
      }
      if (action === 'collab-source') {
        const generation = sceneGeneration
        const query = new URLSearchParams({ session: state.sessionId, message: button.dataset.message })
        const result = await api(`/scenarios/${state.scene.id}?${query}`)
        if (generation !== sceneGeneration) return
        mergeMessages(result.messages || [])
        detailStates.set(button.dataset.detailKey, true)
        return render()
      }
      if (action === 'collab-older' || action === 'collab-retry') {
        const { run = '', member = '' } = button.dataset
        const older = action === 'collab-older' || memberHistory(run, member)?.loaded
        return loadCollaboration(run, Boolean(older), member)
      }
      if (action === 'timeline-retry' || action === 'timeline-older') return loadCollaboration(button.dataset.run, action === 'timeline-older')
      if (action === 'export-timeline') return exportTimeline(button.dataset.run)
      if (action === 'collapse') {
        const id = button.dataset.agent
        state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id)
        saveMemberCollapses()
        return render()
      }
      if (action === 'collapse-all') {
        const agents = selectedRun().agents
        state.collapsed = agents.every(agent => state.collapsed.has(agent.id)) ? new Set() : new Set(agents.map(agent => agent.id))
        saveMemberCollapses()
        return render()
      }
      if (action === 'older') {
        const before = state.messages[0]?.seq
        const result = await api(`/scenarios/${state.scene.id}?before=${before}&session=${encodeURIComponent(state.sessionId)}`)
        mergeMessages(result.messages)
        state.hasOlder = result.hasOlder
        return render()
      }
      if (action === 'scenes') {
        const result = await api('/scenarios')
        state.scenes = result.scenes
        state.sessions = result.sessions
        state.sceneAction = undefined
        state.drawer = true
        return render()
      }
      if (action === 'close-drawer') { state.drawer = false; return render() }
      if (action === 'open-scene') {
        const scene = state.scenes.find(scene => scene.id === button.dataset.id)
        const session = scene.sessions.at(-1)
        return session ? openDemand(session.id, session.title, session.id, scene.id) : openScene(scene.id)
      }
      if (action === 'new-scene' || action === 'bind-scene') {
        if (!options.sessionId && state.sessionId && !state.sessionId.startsWith('local-')) options.sessionId = state.sessionId
        return action === 'new-scene' ? openScene(undefined, { create: true }) : openScene(button.dataset.id, { bind: true })
      }
      if (action === 'delete-scene' || action === 'unbind-session') {
        const scene = state.scenes.find(scene => scene.id === button.dataset.id)
        const session = scene.sessions.find(session => session.id === button.dataset.session)
        state.sceneAction = { type: action === 'delete-scene' ? 'delete' : 'unbind', sceneId: scene.id,
          sceneTitle: scene.title, revision: scene.revision, sessionCount: scene.sessions.length,
          sessionId: session?.id, sessionTitle: session?.title || '未命名会话' }
        state.error = ''
        render()
        root.querySelector('[role="alertdialog"]')?.scrollIntoView({ block: 'nearest' })
        return
      }
      if (action === 'cancel-scene-action') { state.sceneAction = undefined; return render() }
      if (action === 'confirm-scene-action') return manageScene()
      if (action === 'edit-member') {
        const id = button.dataset.agent
        if (state.editingMembers.has(id)) state.editingMembers.delete(id)
        else state.editingMembers.add(id)
        return render()
      }
      if (action === 'view-skill') {
        const name = button.dataset.skillName
        const custom = state.settings.customSkills?.find(skill => `custom:${skill.id}` === name)
        if (custom) { state.skillViewer = custom; return render() }
        const metadata = state.catalog.skills.find(skill => skill.name === name)
        const viewer = { name, content: '正在读取技能原文…', sourcePath: metadata?.resourceBase?.path }
        state.skillViewer = viewer
        render()
        try {
          const result = await api(`/scenarios/${state.scene.id}/skill?name=${encodeURIComponent(name)}`)
          if (state.skillViewer === viewer) state.skillViewer = { ...viewer, ...result.skill }
        } catch (error) {
          if (state.skillViewer === viewer) state.skillViewer = { ...viewer, content: error.message }
          throw error
        }
        return render()
      }
      if (action === 'close-skill-viewer') { state.skillViewer = undefined; return render() }
      if (['new-skill', 'edit-skill', 'add-variant', 'remove-variant', 'remove-agent'].includes(action)
        && !state.editingMembers.has(button.dataset.agent)) return
      if (action === 'reload-catalog') return loadCatalog(true)
      if (action === 'pick-folder') {
        const selected = await options.pickDirectory?.()
        if (selected === null) return
        if (typeof selected === 'string') {
          state.settings.cwd = selected
          state.settingsDirty = true
          return render()
        }
        state.folderPicker = await api(`/directories?path=${encodeURIComponent(state.settings.cwd || '')}`)
        return render()
      }
      if (action === 'browse-folder') {
        state.folderPicker = await api(`/directories?path=${encodeURIComponent(button.dataset.path)}`)
        return render()
      }
      if (action === 'close-folder') { state.folderPicker = undefined; return render() }
      if (action === 'select-folder') {
        state.settings.cwd = state.folderPicker.path
        state.settingsDirty = true
        state.folderPicker = undefined
        return render()
      }
      if (action === 'add-variant' || action === 'remove-variant') {
        const agent = state.settings.agents.find(agent => agent.id === button.dataset.agent)
        agent.variants ||= []
        if (action === 'add-variant') agent.variants.push({ id: crypto.randomUUID(), name: '新强度档位', effort: '', difficulty: 'simple' })
        else agent.variants = agent.variants.filter(variant => variant.id !== button.dataset.variant)
        state.settingsDirty = true
        return render()
      }
      if (action === 'new-skill' || action === 'edit-skill') {
        const skill = state.settings.customSkills?.find(skill => skill.id === button.dataset.id)
        state.skillEditor = { ...(skill || { name: '', content: '' }), agentId: button.dataset.agent }
        return render()
      }
      if (action === 'close-skill') { state.skillEditor = undefined; return render() }
      if (action === 'save-skill') {
        const editor = state.skillEditor
        if (!editor.name.trim() || !editor.content.trim()) throw new Error('请填写技能名称和操作说明')
        const skill = { id: editor.id || crypto.randomUUID(), name: editor.name.trim(), content: editor.content, category: editor.category?.trim() || '场景技能' }
        state.settings.customSkills = [...(state.settings.customSkills || []).filter(item => item.id !== skill.id), skill]
        const agent = state.settings.agents.find(agent => agent.id === editor.agentId)
        agent.skills = [...new Set([...agent.skills, `custom:${skill.id}`])]
        state.settingsDirty = true
        state.skillEditor = undefined
        state.notice = '技能已加入成员，点击保存设置后应用'
        return render()
      }
      if (action === 'add-agent') {
        const id = `agent-${crypto.randomUUID()}`
        state.editingMembers.add(id)
        state.settings.agents.push({ id, name: `成员 ${state.settings.agents.length + 1}`, engine: 'codex', role: '资料调研', model: '', provider: '', effort: '', skills: [], variants: [] })
        state.settingsDirty = true
        return render()
      }
      if (action === 'remove-agent') {
        state.settings.agents = state.settings.agents.filter(agent => agent.id !== button.dataset.agent)
        state.settingsDirty = true
        return render()
      }
      if (action === 'save-team') {
        if (state.savingSettings) return
        state.savingSettings = true
        const generation = sceneGeneration
        render()
        let saved
        try { saved = await saveScene(state.settings) }
        finally { state.savingSettings = false; render() }
        if (generation !== sceneGeneration) return render()
        state.settings = structuredClone(saved)
        state.settingsDirty = false
        state.editingMembers.clear()
        state.notice = '设置已保存，从下一轮生效'
        if (activeRun()) state.notice = '设置已保存，强度与扩展档位将用于后续步骤'
        await loadCatalog()
        return render()
      }
      if (action === 'pick-memory') { state.memoryId = button.dataset.id; state.memoryDraft = undefined; state.revisions = []; return render() }
      if (action === 'memory-history') {
        state.memoryHistoryOpen = !state.memoryHistoryOpen
        render()
        if (state.memoryHistoryOpen) await loadMemoryHistory()
        return
      }
      if (action === 'memory-history-older') return loadMemoryHistory(true)
      if (action === 'memory-history-clear') return filterMemoryHistory('')
      if (action === 'consolidate-memory') {
        if (state.memoryConsolidating) return
        const generation = sceneGeneration
        state.memoryConsolidating = true
        render()
        try {
          const result = await api(`/scenarios/${state.scene.id}/memories/consolidate`, 'POST', { sessionId: state.sessionId })
          if (generation !== sceneGeneration) return
          state.notice = result.message || '会话整理已完成，可在记忆页查看新增内容'
          await loadMemories()
          if (state.memoryHistoryOpen) await loadMemoryHistory()
        } finally {
          if (generation === sceneGeneration) { state.memoryConsolidating = false; render() }
        }
        return
      }
      if (action === 'memory-source') {
        const generation = sceneGeneration
        const query = new URLSearchParams({ sessionId: button.dataset.session, runId: button.dataset.run, messageId: button.dataset.message })
        const { source: origin } = await api(`/scenarios/${state.scene.id}/memories/source?${query}`)
        if (generation !== sceneGeneration) return
        if (origin.available === false) throw new Error('原记录已移除或未迁入这个场景')
        return openMemorySource({ session: origin.sessionId, title: button.dataset.title || origin.sessionTitle,
          run: origin.runAvailable === false ? '' : origin.runId, message: origin.messageAvailable === false ? '' : origin.messageId })
      }
      if (action === 'close-source-viewer') { state.sourceViewer = undefined; return render() }
      if (action === 'memory-from-message') return draftMemoryFromMessage(button.dataset.message)
      if (action === 'clear-memory-message-source' && state.memoryDraft) {
        delete state.memoryDraft.messageSource
        render()
        root.querySelector('[data-focus="memory-title"]')?.focus()
        return
      }
      const memory = state.memories.find(item => item.id === state.memoryId)
      if (action === 'new-memory') {
        state.memoryDraft = { title: '', content: '', kind: 'note', status: 'confirmed',
          audience: state.memoryAudience.startsWith('role:') ? 'role' : 'scene',
          roleId: state.memoryAudience.startsWith('role:') ? state.memoryAudience.slice(5) : '' }
        return render()
      }
      if (action === 'edit-memory') { state.memoryDraft = structuredClone(memory); return render() }
      if (action === 'cancel-memory') { state.memoryDraft = undefined; return render() }
      if (action === 'save-memory') {
        const entry = state.memoryDraft
        if (!entry || state.savingMemoryDraft === entry) return
        const { messageSource, ...draft } = entry
        const source = messageSource ? { sessionId: messageSource.sessionId, runId: messageSource.runId, messageId: messageSource.messageId }
          : { sessionId: state.sessionId }
        state.savingMemoryDraft = entry
        render()
        try {
          const result = await api(draft.id ? `/memories/${draft.id}` : `/scenarios/${state.scene.id}/memories`, draft.id ? 'PATCH' : 'POST', { ...draft, ...source })
          if (state.memoryDraft !== entry) return
          state.memoryId = result.memory.id
          state.memoryDraft = undefined
          await loadMemories()
        } finally {
          if (state.savingMemoryDraft === entry) { state.savingMemoryDraft = undefined; render() }
        }
        return
      }
      if (action === 'delete-memory') { await api(`/memories/${memory.id}`, 'DELETE', { revision: memory.revision, sessionId: state.sessionId }); return loadMemories() }
      if (action === 'import-memory') {
        await api(`/memories/${memory.id}/import`, 'POST', { scenarioId: state.scene.id })
        state.memoryScope = 'scenario'
        return loadMemories()
      }
      if (action === 'memory-revisions') { state.revisions = (await api(`/memories/${memory.id}/revisions`)).revisions; return render() }
      if (action === 'restore-memory') {
        const old = state.revisions.find(item => item.revision === Number(button.dataset.revision))
        await api(`/memories/${memory.id}`, 'PATCH', { title: old.title, content: old.content, kind: old.kind,
          status: old.status, audience: old.audience || 'scene', roleId: old.roleId || '', revision: memory.revision, sessionId: state.sessionId })
        state.revisions = []
        return loadMemories()
      }
      if (action === 'agent-context') { state.view = 'context'; return contextDashboard.load(button.dataset.agent) }
    }
    perform().catch(report)
  })

  listen('dragover', event => {
    if (![...event.dataTransfer.types].includes('Files')) return
    event.preventDefault()
    if (!root.querySelector('.sc-drop')) root.insertAdjacentHTML('beforeend', '<div class="sc-drop">松开以添加附件</div>')
  })
  listen('dragleave', event => { if (!root.contains(event.relatedTarget)) root.querySelector('.sc-drop')?.remove() })
  listen('drop', event => {
    event.preventDefault()
    root.querySelector('.sc-drop')?.remove()
    upload([...event.dataTransfer.files]).catch(report)
  })

  render()
  let savedScene
  if (!options.sessionId) {
    const params = new URLSearchParams(location.search)
    savedScene = params.get('scenario') || localStorage.getItem('dsh-codex-chat.scenario')
  }
  try { await openScene(savedScene) }
  catch (error) {
    if (savedScene && /场景不存在/.test(error.message)) {
      localStorage.removeItem('dsh-codex-chat.scenario')
      await openScene().catch(report)
    } else report(error)
  }
  return () => {
    stopMemberResize()
    alive = false
    lifetime.abort()
    source?.close()
    resize.disconnect()
    composerResize.disconnect()
    clearTimeout(refreshTimer)
    contextDashboard.dispose()
    root.replaceChildren()
  }
}
