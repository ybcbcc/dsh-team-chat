const STATE_LABELS = {
  queued: '等待开始', independent: '独立处理', reviewing: '交叉验证', resolving: '补充核实', synthesizing: '汇总结论',
  planning: 'Owner 分工', working: '成员执行', checking: '检查交付', waiting_user: '等待你的补充', cancelling: '正在停止',
  completed: '已完成', disputed: '存在分歧', incomplete: '尚未完成', failed: '执行失败', cancelled: '已停止', interrupted: '运行中断',
  confirmed: '已确认', candidate: '待核实', conflict: '存在冲突', expired: '已过期', archived: '已归档', deleted: '已移除', pending: '待处理',
}
const TERMINAL = new Set(['completed', 'disputed', 'incomplete', 'failed', 'cancelled', 'interrupted'])
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const badge = state => `<span class="sc-badge ${['completed', 'confirmed'].includes(state) ? 'good' : ['failed', 'conflict'].includes(state) ? 'error' : ['candidate', 'disputed', 'incomplete', 'interrupted'].includes(state) ? 'warn' : ''}">${esc(STATE_LABELS[state] || state)}</span>`
const prose = text => String(text ?? '').split(/```[^\n]*\n([\s\S]*?)```/g).map((part, index) => index % 2 ? `<pre>${esc(part)}</pre>` : esc(part)).join('')
const time = at => at ? new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''


export async function mountWorkbench(root, options = {}) {
  const { createContextDashboard } = await import(`./context-dashboard.js?v=${Date.now()}`)
  const { renderTeamSettings, renderMemoryPage, renderScenePicker, renderFolderPicker, renderSkillEditor, renderSessionCreator, supportsMemberModel, profileOptions } = await import(`./workbench-views.js?v=${Date.now()}`)
  const base = options.apiBase || '/codex-chat/v2'
  const lifetime = new AbortController()
  let source
  let alive = true
  let refreshTimer
  let saveQueue = Promise.resolve()
  let catalogRequest
  let sceneGeneration = 0
  let memberDrag
  const memberScrolls = new Map()
  const memberWeights = new Map()
  const state = {
    scene: undefined, runs: [], messages: [], sequence: 0, hasOlder: false, view: 'chat', draft: '', attachments: [],
    error: '', notice: '', busy: false, uploading: false, showProcesses: true, mobilePane: 'main', collapsed: new Set(),
    selectedRunId: '', streams: new Map(), drawer: false, scenes: [], sessions: [],
    settings: undefined, settingsDirty: false, catalog: { codex: [], dsh: [], skills: [], errors: [] },
    memories: [], memoryId: '', memoryDraft: undefined, memoryScope: 'scenario', memoryQuery: '', revisions: [], questionAnswers: {},
    events: [], sessionId: '', requiresBinding: false, memoryAudience: 'all', folderPicker: undefined, skillEditor: undefined,
    newSessionDraft: undefined, creatingSession: false,
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
  const resize = new ResizeObserver(entries => root.classList.toggle('sc-narrow', entries[0].contentRect.width < 850))
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

  function loadMemberWeights() {
    memberWeights.clear()
    try {
      const saved = JSON.parse(localStorage.getItem(`dsh-codex-chat.member-heights.${state.scene.id}`) || '{}')
      for (const [id, weight] of Object.entries(saved)) {
        if (typeof weight === 'number' && Number.isFinite(weight) && weight > 0 && weight <= 100) memberWeights.set(id, weight)
      }
    } catch { /* Start with equal panes when saved preferences are unavailable. */ }
  }

  function saveMemberWeights() {
    try { localStorage.setItem(`dsh-codex-chat.member-heights.${state.scene.id}`, JSON.stringify(Object.fromEntries(memberWeights))) }
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
    else state.runs[index] = run
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
    if (!alive || state.scene.id !== id || state.sessionId !== sessionId || generation !== sceneGeneration) return
    state.scene = result.scene
    state.runs = result.runs
    mergeMessages(result.messages)
    state.hasOlder = result.hasOlder
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
    state.messages = []
    state.runs = []
    state.events = []
    state.memoryDraft = undefined
    state.settingsDirty = false
    state.drawer = false
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
    if (result.requiresBinding) { state.scene = undefined; state.scenes = result.scenes; render(); return }
    state.sessionId = result.sessionId || options.sessionId || ''
    try { state.draft = localStorage.getItem(`dsh-codex-chat.draft.${state.sessionId}`) || '' } catch { state.draft = '' }
    state.scene = result.scene
    loadMemberWeights()
    state.settings = structuredClone(result.scene)
    state.messages = result.messages
    state.events = result.events || []
    state.runs = result.runs
    state.sequence = result.sequence
    state.hasOlder = result.hasOlder
    state.selectedRunId = result.runs[0]?.id || ''
    state.busy = false
    state.error = ''
    if (!options.sessionId) localStorage.setItem('dsh-codex-chat.scenario', state.scene.id)
    connect()
    render(true)
    loadCatalog().catch(report)
    if (state.view === 'context') await contextDashboard.load()
  }

  function connect() {
    const generation = sceneGeneration
    source = new EventSource(`${base}/scenarios/${state.scene.id}/events?after=${state.sequence}`)
    source.onmessage = event => {
      if (!alive || generation !== sceneGeneration) return
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'ready') { state.notice = ''; render(); return }
        if (data.type === 'reset') { state.sequence = data.sequence; scheduleRefresh(); return }
        if (data.sequence <= state.sequence) return
        state.sequence = data.sequence
        if (data.sessionId && data.sessionId !== state.sessionId && !['scenario.updated', 'memory.changed'].includes(data.type)) return
        state.events.push(data)
        if (state.events.length > 200) state.events.shift()
        if (data.type === 'agent.delta') {
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
          else render()
          return
        }
        if (data.type === 'message.added') mergeMessages([data.message])
        if (data.run) {
          mergeRun(data.run)
          if (data.type === 'run.created') {
            state.selectedRunId = data.run.id
            state.showProcesses = true
            state.mobilePane = 'main'
            state.collapsed = new Set(data.run.agents.length > 2 ? data.run.agents.slice(1).map(agent => agent.id) : [])
          }
        }
        if (data.type === 'agent.completed' || data.type === 'agent.failed') state.streams.delete(data.operationId)
        if (data.type === 'scenario.updated') {
          state.scene = data.scene
          if (!state.settingsDirty) state.settings = structuredClone(data.scene)
        }
        if (data.type === 'memory.changed' && state.view === 'memory') loadMemories().catch(report)
        if (state.view === 'context' && /^(context\.|usage\.|tool\.|agent.completed|agent.failed|run.finished)/.test(data.type)) contextDashboard.schedule()
        if (data.type === 'run.finished') {
          for (const [id, stream] of state.streams) if (stream.runId === data.runId) state.streams.delete(id)
          scheduleRefresh()
        }
        render(data.type === 'message.added' && !data.message.agentId)
      } catch (error) { report(error) }
    }
    source.onerror = () => {
      if (!alive || generation !== sceneGeneration) return
      state.notice = '连接恢复中，任务仍在宿主继续执行'
      render()
    }
  }

  async function loadCatalog() {
    if (catalogRequest?.generation === sceneGeneration) return catalogRequest.promise
    const id = state.scene.id
    const generation = sceneGeneration
    const promise = api(`/scenarios/${id}/catalog`).then(result => {
      if (state.scene.id === id && generation === sceneGeneration) { state.catalog = result; render() }
    }).finally(() => { if (catalogRequest?.promise === promise) catalogRequest = undefined })
    catalogRequest = { generation, promise }
    return promise
  }

  function saveScene(patch) {
    const id = state.scene.id
    const operation = saveQueue.then(async () => {
      if (state.scene.id !== id) throw new Error('场景已切换，请在当前场景保存')
      const result = await api(`/scenarios/${id}`, 'PATCH', { ...patch, revision: state.scene.revision })
      state.scene = result.scene
      if (!state.settingsDirty) state.settings = structuredClone(result.scene)
      render()
      return result.scene
    })
    saveQueue = operation.catch(() => {})
    return operation
  }

  async function openDemand(sessionId, title = '', nativeSessionId = sessionId) {
    if (state.sessionId) {
      try { localStorage.setItem(`dsh-codex-chat.draft.${state.sessionId}`, state.draft) } catch { /* Keep navigation available. */ }
    }
    if (options.openSession?.(nativeSessionId)) return
    options.sessionId = sessionId
    options.sessionTitle = title
    const url = new URL(location.href)
    url.searchParams.set('dshSession', sessionId)
    url.searchParams.set('scenario', state.scene.id)
    if (['http:', 'https:', 'file:'].includes(location.protocol)) history.replaceState(null, '', url)
    return openScene(state.scene.id)
  }

  async function send(resumeRunId) {
    if (state.busy || state.uploading || activeRun()) return
    if (!state.draft.trim()) { state.error = '请先输入一项任务'; render(); return }
    await saveQueue
    if (state.scene.mode === 'orchestration' && !state.scene.ownerId) {
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
    render()
    try {
      const result = await api(`/scenarios/${sceneId}/runs`, 'POST', {
        requestId: crypto.randomUUID(), text, attachments: state.attachments, resumeRunId, sessionId,
      })
      if (state.scene.id !== sceneId || state.sessionId !== sessionId) return
      mergeRun(result.run)
      state.selectedRunId = result.run.id
      state.draft = ''
      try { localStorage.removeItem(`dsh-codex-chat.draft.${state.sessionId}`) } catch { /* The sent message is persisted by the host. */ }
      state.attachments = []
      state.showProcesses = true
      state.mobilePane = 'main'
      options.onRunStart?.()
    } finally {
      state.busy = false
      render(true)
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
        if (state.scene.id !== sceneId || state.sessionId !== sessionId) return
        const result = await api(`/scenarios/${sceneId}/upload`, 'POST', { name: file.name, data })
        if (state.scene.id !== sceneId || state.sessionId !== sessionId) return
        state.attachments.push(result)
      }
    } finally { state.uploading = false; render() }
  }

  async function loadMemories() {
    const id = state.scene.id
    const result = await api(`/scenarios/${id}/memories?scope=${state.memoryScope}`)
    if (state.scene.id !== id) return
    state.memories = result.memories
    if (!state.memories.some(memory => memory.id === state.memoryId)) state.memoryId = state.memories[0]?.id || ''
    render()
  }

  async function navigate(view) {
    state.view = view
    render()
    if (view === 'memory') await loadMemories()
    if (view === 'context') await contextDashboard.load()
  }

  function render(scrollBottom = false) {
    if (!alive) return
    if (memberDrag && (state.view !== 'chat' || !state.showProcesses || selectedRun()?.id !== memberDrag.runId
      || state.collapsed.has(memberDrag.upperId) || state.collapsed.has(memberDrag.lowerId))) stopMemberResize()
    const focused = root.contains(document.activeElement) ? document.activeElement : undefined
    const focusKey = focused?.dataset.focus || focused?.id
    const selection = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : undefined
    const openDetails = new Set([...root.querySelectorAll('details[open]')].map(element => element.dataset.detail || element.querySelector('summary')?.textContent))
    const scrolls = []
    for (const element of root.querySelectorAll('[data-scroll]')) {
      const position = { key: element.dataset.scroll, top: element.scrollTop, nearBottom: element.scrollHeight - element.scrollTop - element.clientHeight < 70 }
      if (element.classList.contains('sc-agent-body')) {
        if (!element.hidden) memberScrolls.set(position.key, position)
      } else scrolls.push(position)
    }
    if (!state.scene) {
      if (state.requiresBinding) { root.innerHTML = renderScenePicker(state, options, true); return }
      root.innerHTML = `<div class="sc-empty"><h2>场景协作</h2><p>${state.error ? esc(state.error) : '正在恢复场景与团队…'}</p>${state.error ? '<button type="button" data-action="retry-bootstrap">重试</button>' : ''}</div>`
      return
    }
    const run = selectedRun()
    root.innerHTML = `<header class="sc-top"><div class="sc-heading"><strong>${esc(state.scene.title)}</strong><span class="sc-small sc-muted">当前场景 · ${state.scene.agents.length} 位成员${state.sessionId ? ' · 当前需求会话' : ''}</span></div><button type="button" data-action="new-demand">＋ 新建需求会话</button><button type="button" data-action="scenes">场景</button>${options.onExpand ? `<button type="button" data-action="expand">${options.isExpanded?.() ? '收回工作区' : '展开工作区'}</button>` : ''}</header>
      <nav class="sc-nav" role="tablist" aria-label="场景功能">${Object.entries({ chat: '对话', team: '团队', memory: '记忆', context: '上下文' }).map(([view, label]) => `<button type="button" id="sc-tab-${view}" data-action="view" data-view="${view}" role="tab" aria-controls="sc-content" aria-selected="${view === state.view}">${label}</button>`).join('')}${state.view === 'chat' && run ? `<button type="button" class="sc-toggle" data-action="process-toggle">${state.showProcesses ? '收起过程' : '展开过程'}</button>` : ''}</nav>
      ${state.error || state.notice ? `<div class="sc-notice ${state.error ? 'error' : ''}" role="${state.error ? 'alert' : 'status'}"><span>${esc(state.error || state.notice)}</span><button type="button" class="sc-plain" data-action="dismiss" aria-label="关闭提示">×</button></div>` : ''}
      <div class="sc-content" id="sc-content" role="tabpanel" aria-labelledby="sc-tab-${state.view}">${state.view === 'chat' ? chatView() : state.view === 'team' ? teamView() : state.view === 'memory' ? memoryView() : contextView()}</div>
      <footer class="sc-footer"><span>${activeRun() ? STATE_LABELS[activeRun().state] || '处理中' : '场景已保存到本机'}</span><span>${esc(state.scene.cwd)}</span></footer>${state.drawer ? drawerView() : ''}${state.folderPicker ? renderFolderPicker(state.folderPicker) : ''}${state.skillEditor ? renderSkillEditor(state.skillEditor) : ''}${state.newSessionDraft ? renderSessionCreator(state.newSessionDraft, state.scene, state.creatingSession) : ''}`
    for (const detail of root.querySelectorAll('details')) {
      if (openDetails.has(detail.dataset.detail || detail.querySelector('summary')?.textContent)) detail.open = true
    }
    for (const saved of [...scrolls, ...memberScrolls.values()]) {
      const element = root.querySelector(`[data-scroll="${saved.key}"]`)
      if (element && !element.hidden) element.scrollTop = scrollBottom && saved.nearBottom ? element.scrollHeight : saved.top
    }
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
    const messages = state.messages.filter(message => !message.agentId)
    return `${split ? `<div class="sc-mobile-nav"><button type="button" data-action="mobile-main" aria-pressed="${state.mobilePane === 'main'}">主聊天</button><button type="button" data-action="mobile-process" aria-pressed="${state.mobilePane === 'process'}">成员过程 · ${run.agents.length}</button></div>` : ''}
      <div class="sc-chat ${split ? 'sc-split' : ''}" data-mobile="${state.mobilePane}"><section class="sc-main" aria-label="主聊天"><div class="sc-log" data-scroll="main">
      ${state.hasOlder ? '<button type="button" class="sc-plain sc-small" data-action="older">更早的消息</button>' : ''}
      ${messages.length ? messages.map(messageView).join('') : '<div class="sc-empty"><h2>从这个场景的第一项任务开始</h2><p>描述工作目标与约束，团队会逐步积累场景知识。</p></div>'}
      ${active ? `<div class="sc-small sc-muted" role="status">${esc(STATE_LABELS[active.state])} · ${active.tasks.filter(task => task.state === 'completed').length} 项阶段工作已完成</div>${questionsView(active)}` : ''}
      ${run && ['interrupted', 'incomplete', 'failed', 'cancelled', 'disputed'].includes(run.state) && !active ? `<button type="button" data-action="resume" data-run="${run.id}">接续这项任务</button>` : ''}</div>
      <div class="sc-composer">${state.scene.mode === 'orchestration' ? `<div class="sc-owner"><label for="sc-owner">由谁负责本次任务</label><select id="sc-owner" aria-label="选择 Owner" ${active ? 'disabled' : ''}><option value="">请选择 Owner</option>${state.scene.agents.map(agent => `<option value="${agent.id}" ${agent.id === state.scene.ownerId ? 'selected' : ''}>${esc(agent.name)}</option>`).join('')}</select></div>` : ''}
      ${state.attachments.length ? `<div class="sc-attachments">${state.attachments.map((file, index) => `<span class="sc-attachment">${esc(file.name)}<button type="button" data-action="remove-file" data-index="${index}" aria-label="移除 ${esc(file.name)}">×</button></span>`).join('')}</div>` : ''}
      <textarea id="sc-draft" aria-label="任务输入" placeholder="提出任务或继续这个场景…" ${state.busy ? 'disabled' : ''}>${esc(state.draft)}</textarea>
      <div class="sc-actions"><input type="file" id="sc-files" multiple hidden><button type="button" data-action="attach" aria-label="添加附件" ${state.uploading || active ? 'disabled' : ''}>＋</button><select id="sc-mode" aria-label="协作模式" ${active ? 'disabled' : ''}><option value="confidence" ${state.scene.mode === 'confidence' ? 'selected' : ''}>置信模式</option><option value="orchestration" ${state.scene.mode === 'orchestration' ? 'selected' : ''}>统筹模式</option></select>${state.scene.agents.slice(0, 2).map(agent => `<button type="button" data-action="team" data-agent="${agent.id}">${esc(agent.name)} · ${esc(agent.effort || '默认')}</button>`).join('')}${state.scene.agents.length > 2 ? `<button type="button" class="sc-plain" data-action="team">＋${state.scene.agents.length - 2} 位</button>` : ''}<button type="button" class="sc-send ${active ? '' : 'sc-primary'}" data-action="${active ? 'stop' : 'send'}" ${state.busy || state.uploading ? 'disabled' : ''}>${active ? '停止' : state.uploading ? '上传中' : '发送'}</button></div></div></section>${split ? `<div class="sc-separator" role="separator" aria-label="调整聊天区宽度" aria-orientation="vertical" tabindex="0"></div>${processView(run)}` : ''}</div>`
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
    return `<article class="sc-message ${user ? 'sc-message-user' : 'sc-message-assistant'}"><div class="sc-message-label">${esc(user ? '你' : message.agentName || '团队')}${message.state ? badge(message.state) : ''}<span>${esc(time(message.at))}</span></div>${content}${message.attachments?.length ? `<div class="sc-small sc-muted">附件 ${message.attachments.map(file => esc(file.name || file)).join('、')}</div>` : ''}</article>`
  }

  function questionsView(run) {
    return (run.questions || []).map(request => `<form class="sc-questions" data-question="${request.id}" data-run="${run.id}"><h3>${esc(request.agentName)} 需要你补充</h3>${request.questions.map(question => `<label>${esc(question.question || question.header)}${question.options?.length ? `<select name="${esc(question.id)}" data-focus="question-${esc(question.id)}"><option value="">请选择或在下面补充</option>${question.options.map(option => `<option value="${esc(option.label)}" ${state.questionAnswers[`${request.id}/${question.id}`] === option.label ? 'selected' : ''}>${esc(option.label)}${option.description ? ` · ${esc(option.description)}` : ''}</option>`).join('')}</select>` : ''}<input type="text" name="${esc(question.id)}-text" data-focus="question-text-${esc(question.id)}" aria-label="${esc(question.question || '补充说明')}" placeholder="填写你的回答" value="${esc(state.questionAnswers[`${request.id}/${question.id}-text`] || '')}"></label>`).join('')}<button type="submit" class="sc-primary">发送补充</button></form>`).join('')
  }

  function processView(run) {
    let previousExpanded
    const live = activeRun()?.id === run.id
    const assignments = run.delegations?.length ? `<details class="sc-assignments" data-detail="assignments-${run.id}"><summary>本轮分工 · ${run.delegations.length} 项</summary><div>${run.delegations.map(task => {
      const agent = run.agents.find(agent => agent.id === task.agentId)
      const variantId = task.state === 'pending' && !task.profileSelected ? run.profileOverrides?.[agent?.id] ?? task.variantId : task.variantId
      return `<article><div>${badge(task.state)} <strong>${esc(task.title)}</strong></div><span class="sc-small sc-muted">${esc(agent?.name)} · ${esc(task.profileName || agent?.variants?.find(variant => variant.id === variantId)?.name || '默认强度')}</span>
        ${live && task.state === 'pending' && agent?.variants?.length ? `<label>执行档位<select data-run-profile data-run="${run.id}" data-task="${task.id}" data-agent="${agent.id}">${profileOptions(agent, variantId)}</select></label>` : ''}</article>`
    }).join('')}</div></details>` : ''
    return `<aside class="sc-processes" aria-label="成员处理过程"><div class="sc-process-head"><select id="sc-run" aria-label="选择任务轮次">${state.runs.map(item => `<option value="${item.id}" ${run.id === item.id ? 'selected' : ''}>${esc(time(item.createdAt))} · ${esc(item.text.slice(0, 35))}</option>`).join('')}</select><button type="button" class="sc-plain" data-action="collapse-all">${run.agents.every(agent => state.collapsed.has(agent.id)) ? '展开全部' : '收起全部'}</button></div>
      ${assignments}${run.agents.map(agent => {
        const messages = state.messages.filter(message => message.runId === run.id && message.agentId === agent.id)
        const streams = [...state.streams.entries()].filter(([, stream]) => stream.agentId === agent.id && stream.runId === run.id)
        const task = [...run.tasks].reverse().find(task => task.agentId === agent.id)
        const tools = state.events.filter(event => event.runId === run.id && event.agentId === agent.id && event.type === 'tool.completed')
        const collapsed = state.collapsed.has(agent.id)
        let separator = ''
        if (!collapsed) {
          if (previousExpanded) {
            const percent = Math.round(memberWeight(previousExpanded.id) / (memberWeight(previousExpanded.id) + memberWeight(agent.id)) * 100)
            separator = `<div class="sc-member-separator" id="sc-member-split-${previousExpanded.id}-${agent.id}" role="separator" tabindex="0" aria-orientation="horizontal" aria-label="调整 ${esc(previousExpanded.name)} 与 ${esc(agent.name)} 的高度" aria-controls="sc-body-${previousExpanded.id} sc-body-${agent.id}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="上方 ${percent}%，下方 ${100 - percent}%" data-upper="${previousExpanded.id}" data-lower="${agent.id}" title="拖动调整高度，双击恢复均分"></div>`
          }
          previousExpanded = agent
        }
        return `${separator}<section class="sc-agent ${collapsed ? 'sc-collapsed' : ''}" data-agent-pane="${agent.id}" style="--sc-agent-weight:${memberWeight(agent.id)}"><header class="sc-agent-head"><strong>${esc(agent.name)}</strong><span class="sc-small sc-muted">${esc(agent.role)}${run.ownerId === agent.id && run.mode === 'orchestration' ? ' · Owner' : ''}</span>${task ? badge(task.state) : ''}<button type="button" data-action="collapse" data-agent="${agent.id}" aria-expanded="${!collapsed}" aria-controls="sc-body-${agent.id}">${collapsed ? '展开' : '收起'}</button></header><div class="sc-agent-body" id="sc-body-${agent.id}" data-scroll="agent-${run.id}-${agent.id}" ${collapsed ? 'hidden' : ''}>
          ${live && agent.variants?.length ? `<label class="sc-profile-selector">后续步骤的强度<select data-run-profile data-run="${run.id}" data-agent="${agent.id}">${profileOptions(agent, run.profileOverrides?.[agent.id])}</select></label>` : ''}
          <div><span class="sc-muted">任务输入</span><p class="sc-prose">${esc(run.text)}</p></div>
          ${messages.map(message => `<div><div class="sc-message-label">${esc(message.stage)}${message.profileName ? `<span class="sc-small sc-muted"> · ${esc(message.profileName)} · ${esc(message.effort || '模型默认')}</span>` : ''}${message.error ? badge('failed') : ''}</div><div class="sc-prose">${prose(message.text)}</div>${message.raw ? `<details data-detail="message-${message.id}"><summary>查看原始结果与证据</summary><pre>${esc(message.raw)}</pre></details>` : ''}</div>`).join('')}
          ${streams.map(([id, stream]) => `<div><span class="sc-muted">正在处理</span><div class="sc-stream" data-stream="${id}">${esc(stream.text)}</div></div>`).join('')}
          ${task?.error ? `<p class="sc-prose">${esc(task.error)}</p>` : ''}
          ${tools.map(tool => `<details data-detail="tool-${tool.sequence}"><summary>${esc(tool.tool)} · ${esc(time(tool.at))}</summary><pre>${esc(tool.text)}</pre></details>`).join('')}
          <div class="sc-source"><button type="button" data-action="agent-context" data-agent="${agent.id}">查看实际采用的上下文</button></div>
        </div></section>`
      }).join('')}</aside>`
  }


  function teamView() {
    const title = options.sessionTitle || state.scene.sessions?.find(session => session.id === state.sessionId)?.title
    return renderTeamSettings(state.settings || state.scene, state.catalog, title)
  }

  function memoryView() { return renderMemoryPage(state, { badge, prose, time }) }

  function contextView() { return contextDashboard.view() }

  function drawerView() { return renderScenePicker(state, options) }

  const listen = (type, handler) => root.addEventListener(type, handler, { signal: lifetime.signal })
  listen('sc-layout-change', () => {
    const button = root.querySelector('[data-action="expand"]')
    if (button) button.textContent = options.isExpanded?.() ? '收回工作区' : '展开工作区'
  })
  listen('input', event => {
    const input = event.target
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
    if (input.dataset.agentField && input.tagName === 'INPUT') {
      const agent = state.settings.agents.find(agent => agent.id === input.dataset.agent)
      agent[input.dataset.agentField] = input.value
      state.settingsDirty = true
    }
    if (input.dataset.memoryField) state.memoryDraft[input.dataset.memoryField] = input.value
    if (input.id === 'sc-memory-query') { state.memoryQuery = input.value; render() }
  })

  listen('change', event => {
    const input = event.target
    const perform = async () => {
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
      if (input.id === 'sc-run') {
        const result = await api(`/runs/${input.value}`)
        state.selectedRunId = input.value
        mergeMessages(result.messages)
        state.events = result.events || []
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
      }
      if (input.id === 'sc-memory-scope') { state.memoryScope = input.value; state.memoryDraft = undefined; return loadMemories() }
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

  listen('keydown', event => {
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
    }
  })

  listen('pointerdown', event => {
    const memberSeparator = event.target.closest('.sc-member-separator')
    if (memberSeparator) {
      if (event.button !== 0) return
      const pair = memberPair(memberSeparator)
      if (!pair || pair.height <= 4) return
      event.preventDefault()
      memberSeparator.focus({ preventScroll: true })
      memberDrag = { ...pair, pointerId: event.pointerId, startY: event.clientY, runId: selectedRun().id }
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
      if (action === 'open-demand') return openDemand(button.dataset.session, button.dataset.title)
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
      if (action === 'team') return navigate('team')
      if (action === 'process-toggle') { state.showProcesses = !state.showProcesses; state.mobilePane = 'main'; return render() }
      if (action === 'mobile-main' || action === 'mobile-process') { state.mobilePane = action === 'mobile-main' ? 'main' : 'process'; return render() }
      if (action === 'collapse') {
        const id = button.dataset.agent
        state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id)
        return render()
      }
      if (action === 'collapse-all') {
        const agents = selectedRun().agents
        state.collapsed = agents.every(agent => state.collapsed.has(agent.id)) ? new Set() : new Set(agents.map(agent => agent.id))
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
        state.drawer = true
        return render()
      }
      if (action === 'close-drawer') { state.drawer = false; return render() }
      if (action === 'open-scene') return openScene(button.dataset.id)
      if (action === 'new-scene') return openScene(undefined, { create: true })
      if (action === 'bind-scene') return openScene(button.dataset.id, { bind: true })
      if (action === 'reload-catalog') return loadCatalog()
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
        const skill = { id: editor.id || crypto.randomUUID(), name: editor.name.trim(), content: editor.content }
        state.settings.customSkills = [...(state.settings.customSkills || []).filter(item => item.id !== skill.id), skill]
        const agent = state.settings.agents.find(agent => agent.id === editor.agentId)
        agent.skills = [...new Set([...agent.skills, `custom:${skill.id}`])]
        state.settingsDirty = true
        state.skillEditor = undefined
        state.notice = '技能已加入成员，点击保存设置后应用'
        return render()
      }
      if (action === 'add-agent') {
        state.settings.agents.push({ id: `agent-${crypto.randomUUID()}`, name: `成员 ${state.settings.agents.length + 1}`, engine: 'codex', role: '资料调研', model: '', provider: '', effort: '', skills: [], variants: [] })
        state.settingsDirty = true
        return render()
      }
      if (action === 'remove-agent') {
        state.settings.agents = state.settings.agents.filter(agent => agent.id !== button.dataset.agent)
        state.settingsDirty = true
        return render()
      }
      if (action === 'save-team') {
        const saved = await saveScene(state.settings)
        state.settings = structuredClone(saved)
        state.settingsDirty = false
        state.notice = '设置已保存，从下一轮生效'
        if (activeRun()) state.notice = '设置已保存，强度与扩展档位将用于后续步骤'
        await loadCatalog()
        return render()
      }
      if (action === 'pick-memory') { state.memoryId = button.dataset.id; state.memoryDraft = undefined; state.revisions = []; return render() }
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
        const draft = state.memoryDraft
        const result = await api(draft.id ? `/memories/${draft.id}` : `/scenarios/${state.scene.id}/memories`, draft.id ? 'PATCH' : 'POST', draft)
        state.memoryId = result.memory.id
        state.memoryDraft = undefined
        return loadMemories()
      }
      if (action === 'delete-memory') { await api(`/memories/${memory.id}`, 'DELETE', { revision: memory.revision }); return loadMemories() }
      if (action === 'import-memory') {
        await api(`/memories/${memory.id}/import`, 'POST', { scenarioId: state.scene.id })
        state.memoryScope = 'scenario'
        return loadMemories()
      }
      if (action === 'memory-revisions') { state.revisions = (await api(`/memories/${memory.id}/revisions`)).revisions; return render() }
      if (action === 'restore-memory') {
        const old = state.revisions.find(item => item.revision === Number(button.dataset.revision))
        await api(`/memories/${memory.id}`, 'PATCH', { title: old.title, content: old.content, kind: old.kind,
          status: old.status, audience: old.audience || 'scene', roleId: old.roleId || '', revision: memory.revision })
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
    clearTimeout(refreshTimer)
    contextDashboard.dispose()
    root.replaceChildren()
  }
}
