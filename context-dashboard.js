const CATEGORIES = {
  system: ['系统提示词', '#7562ef'], tools: ['工具定义', '#efa900'], user: ['用户消息', '#18bd65'],
  inject: ['注入上下文', '#b15be4'], skill: ['技能注入', '#ff8b23'], assistant: ['助手消息', '#3982fb'], tool: ['工具结果', '#00b3a4'],
}
const EVENT_LABELS = { inject: '注入', compact: '压缩', prune: '清理', switch: '切换', mode: '模式', handoff: '交接', usage: '用量', request: '请求' }
const FILE_LABELS = { read: '读取', write: '写入', search: '搜索', image: '图片' }
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const fmt = value => typeof value === 'number' ? value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : '—'
const compact = value => value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : fmt(value)
const signed = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${compact(Math.abs(value))}`
const percent = (value, total) => total ? `${(value / total * 100).toFixed(1)}%` : '—'
const stamp = at => at ? new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
const duration = value => typeof value !== 'number' ? '—' : value < 1000 ? `${Math.round(value)}ms` : value < 60000 ? `${(value / 1000).toFixed(1)}s` : `${Math.floor(value / 60000)}m${Math.round(value % 60000 / 1000)}s`
const sum = (items, selector) => items.reduce((total, item) => total + (selector(item) || 0), 0)
const categoryLabel = key => CATEGORIES[key]?.[0] || key
const color = key => CATEGORIES[key]?.[1] || '#8c98a8'
const swatch = key => `<i class="cx-swatch" style="background:${color(key)}"></i>`
const empty = text => `<p class="cx-empty">${esc(text)}</p>`
const json = value => JSON.stringify(value, null, 2)

function formatted(text) {
  return String(text || '').split(/```[^\n]*\n([\s\S]*?)```/g).map((part, index) => {
    if (index % 2) return `<pre>${esc(part)}</pre>`
    return esc(part).replace(/^#{1,6} (.+)$/gm, '<h4>$1</h4>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>')
  }).join('')
}

function donut(parts, center, label) {
  const total = sum(parts, part => part.value)
  let offset = 0
  const bands = parts.filter(part => part.value > 0).map(part => {
    const start = offset
    offset += part.value / total * 100
    return `${part.color} ${start}% ${offset}%`
  })
  return `<div class="cx-donut" style="--cx-donut:${bands.length ? `conic-gradient(${bands.join(',')})` : 'var(--sc-border)'}" role="img" aria-label="${esc(label)} ${esc(center)}"><div><strong>${esc(center)}</strong><span>${esc(label)}</span></div></div>`
}

function toggleGroup(name, values, selected) {
  return `<div class="cx-switch" role="group" aria-label="${esc(name)}">${values.map(([value, label]) => `<button type="button" data-cx="${name}" data-value="${value}" aria-pressed="${selected === value}">${label}</button>`).join('')}</div>`
}

/** The dashboard owns view state while the workbench owns the scene and connection. */
export function createContextDashboard({ api, rerender, scene, agentName, openSource, root }) {
  const state = {
    data: undefined, sceneId: '', agent: '', selected: '', detail: undefined, baseline: undefined,
    loading: false, error: '', generation: 0, detailGeneration: 0, category: '', query: '', sort: 'size',
    dna: false, delta: false, granularity: 'step', overview: false, browserDelta: false,
    eventKind: '', eventQuery: '', fileKind: '', fileQuery: '', commandStatus: '', commandQuery: '',
    contentModes: new Map(), toolDetails: new Map(), copied: '',
  }
  const cache = new Map()
  let refreshTimer
  let disposed = false
  const requests = () => state.data?.requests || []
  const selected = () => requests().find(request => request.id === state.selected)
  const previous = request => requests().filter(item => item.agentId === request.agentId && item.seq < request.seq)[0]

  async function fetchDetail(id) {
    if (cache.has(id)) return cache.get(id)
    const result = await api(`/scenarios/${state.sceneId}/context-insights?detail=${encodeURIComponent(id)}`)
    if (disposed) return result
    cache.set(id, result)
    for (const tool of result.tools || []) state.toolDetails.set(tool.id, tool)
    if (cache.size > 12) cache.delete(cache.keys().next().value)
    return result
  }

  async function select(id, { reveal = false } = {}) {
    const generation = ++state.detailGeneration
    state.selected = id
    state.detail = undefined
    state.baseline = undefined
    state.query = ''
    rerender()
    if (!id) return
    try {
      const request = selected()
      const prior = request && previous(request)
      const [current, baseline] = await Promise.all([fetchDetail(id), prior ? fetchDetail(prior.id) : undefined])
      if (disposed || generation !== state.detailGeneration) return
      state.detail = current
      state.baseline = baseline
      rerender()
      if (reveal) root.querySelector('.cx-browser')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    } catch (error) { if (generation === state.detailGeneration) { state.error = error.message; rerender() } }
  }

  async function load(agent = state.agent) {
    const id = scene()?.id
    if (!id) return
    const generation = ++state.generation
    const changed = id !== state.sceneId || agent !== state.agent
    state.sceneId = id
    state.agent = agent
    if (changed) { state.detailGeneration++; cache.clear(); state.toolDetails.clear(); state.selected = ''; state.data = undefined; state.detail = undefined }
    state.loading = true
    state.error = ''
    rerender()
    try {
      const result = await api(`/scenarios/${id}/context-insights?agent=${encodeURIComponent(agent)}`)
      if (disposed || generation !== state.generation) return
      state.data = result
      state.loading = false
      // A running stage can acquire usage and tool results after its first selection.
      cache.clear()
      const next = result.requests.some(request => request.id === state.selected) ? state.selected : result.requests[0]?.id || ''
      await select(next)
    } catch (error) {
      if (generation === state.generation) { state.loading = false; state.error = error.message; rerender() }
    }
  }

  function schedule() {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { void load() }, 280)
  }

  function composition(totals, denominator = sum(Object.values(totals), value => value)) {
    return `<div class="cx-composition" aria-label="上下文分类组成">${Object.entries(totals).filter(([, value]) => value > 0).map(([key, value]) => `<button type="button" data-cx="category" data-value="${key}" style="width:${Math.min(100, value / (denominator || 1) * 100)}%;background:${color(key)}" title="${esc(categoryLabel(key))} ≈ ${fmt(value)}" aria-label="查看${esc(categoryLabel(key))}"></button>`).join('')}</div>`
  }

  function legend(totals) {
    const total = sum(Object.values(totals), value => value)
    return `<div class="cx-legend">${Object.entries(CATEGORIES).map(([key, [label]]) => `<button type="button" data-cx="category" data-value="${key}">${swatch(key)}<span>${label}</span><span>≈${compact(totals[key] || 0)}</span><small>${percent(totals[key] || 0, total)}</small></button>`).join('')}</div>`
  }

  function statsView() {
    const list = requests()
    const data = state.data
    const usageRows = list.filter(request => request.usage)
    const prompt = sum(usageRows, request => request.usage.input)
    const output = sum(usageRows, request => request.usage.output)
    const cached = sum(usageRows, request => request.usage.cache)
    const totals = {}
    for (const request of list) for (const [key, value] of Object.entries(request.totals)) totals[key] = (totals[key] || 0) + value
    const tools = data.tools
    const tally = new Map()
    tools.forEach(tool => tally.set(tool.tool, (tally.get(tool.tool) || 0) + 1))
    const stages = list.filter(request => request.kind !== 'runtime')
    const native = list.filter(request => request.kind === 'runtime')
    const elapsed = sum(list, request => request.durationMs)
    const toolTime = sum(tools, tool => tool.durationMs)
    const timed = list.filter(request => typeof request.durationMs === 'number').length
    const nativeTime = native.some(request => typeof request.durationMs === 'number') ? duration(sum(native, request => request.durationMs)) : '—'
    const stageTime = stages.some(request => typeof request.durationMs === 'number') ? duration(sum(stages, request => request.durationMs)) : '—'
    const chips = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 8)
    const skills = new Set(list.flatMap(request => (request.skillNames || []).map(name => `${request.operationId}/${name}`))).size
    return `<div class="cx-stats-top"><section class="cx-card cx-stats"><div class="cx-card-head"><h3>上下文统计</h3><span>${list.length} 条保留记录</span></div><div class="cx-kpis">${[
      [new Set(list.map(request => request.runId)).size, '任务轮次', 'trend'], [list.length, '请求 / 阶段', 'trend'],
      [skills, '技能条目', 'browser'], [tools.length, '工具调用', 'commands'],
    ].map(([value, label, jump]) => `<button type="button" data-cx="jump" data-value="${jump}"><strong>${fmt(value)}</strong><span>${label}</span></button>`).join('')}</div><div class="cx-stats-lines"><div><b>输入 / 输出</b><span>${usageRows.length ? `${compact(prompt)} / ${compact(output)}` : '尚无上报'}</span></div><div class="cx-pills">${Object.entries(FILE_LABELS).map(([kind, label]) => `<button type="button" data-cx="file-kind" data-value="${kind}">${label} ${data.files.filter(file => file.kinds.includes(kind)).length}</button>`).join('')}</div><div><b>工具调用</b><span>${tools.length}</span></div><div class="cx-pills">${chips.map(([name, count]) => `<button type="button" data-cx="tool-filter" data-value="${esc(name)}">${esc(name)} <b>${count}</b></button>`).join('') || '<span class="cx-muted">调用完成后显示工具分布</span>'}</div></div></section><section class="cx-card cx-info"><div class="cx-card-head"><h3>记录范围</h3></div><dl><div><dt>场景</dt><dd>${esc(scene().title)}</dd></div><div><dt>原生请求</dt><dd>${native.length}</dd></div><div><dt>阶段快照</dt><dd>${stages.length}</dd></div><div><dt>用量上报</dt><dd>${usageRows.length} / ${list.length}</dd></div></dl><p class="cx-note">DSH 原生请求逐步记录系统提示词、工具定义和消息。Codex 显示阶段输入与运行时上报用量。</p></section></div>
      <div class="cx-two"><section class="cx-card"><div class="cx-card-head"><h3>Token 统计</h3><span>缓存命中 ${prompt ? percent(cached, prompt) : '—'}</span></div><div class="cx-donut-row">${donut(Object.entries(totals).map(([key, value]) => ({ value, color: color(key) })), usageRows.length ? compact(prompt + output) : '—', '上报总量')}${legend(totals)}</div><div class="cx-facts"><span>输入 ${usageRows.length ? fmt(prompt) : '—'}</span><span>输出 ${usageRows.length ? fmt(output) : '—'}</span><span>缓存 ${usageRows.length ? fmt(cached) : '—'}</span></div><p class="cx-note">环形分类为保留请求的输入组成累计估算。计费 Token 与缓存读取使用运行时上报值。</p></section>
      <section class="cx-card"><div class="cx-card-head"><h3>耗时统计</h3><span>已计时 ${timed} / ${list.length}</span></div><div class="cx-donut-row">${donut([{ value: elapsed, color: '#3982fb' }], timed ? duration(elapsed) : '—', '成员累计耗时')}<div class="cx-timing-facts"><div><b>${nativeTime}</b><span>原生请求</span></div><div><b>${stageTime}</b><span>阶段执行</span></div><div><b>${tools.some(tool => typeof tool.durationMs === 'number') ? duration(toolTime) : '—'}</b><span>工具运行</span></div><div><b>${tools.filter(tool => tool.status === 'error').length}</b><span>工具错误</span></div></div></div><div class="cx-timing-strip" aria-label="各请求耗时">${list.slice().reverse().filter(request => request.durationMs > 0).map(request => `<button type="button" data-cx="pick" data-id="${request.id}" style="flex-grow:${request.durationMs};background:${request.engine === 'dsh' ? '#00b3a4' : '#3982fb'}" title="${esc(agentName(request.agentId))} ${esc(request.stage)} ${duration(request.durationMs)}"></button>`).join('')}</div><p class="cx-note">并行成员分别累计。工具运行可能包含在阶段耗时中。历史记录缺失的耗时显示为 —。</p></section></div>`
  }

  function currentView() {
    const current = requests()[0]
    if (!current) return ''
    const tokens = current.usage?.input ?? current.estimatedTokens
    const estimated = current.usage?.input === undefined
    const capacity = current.contextWindow
    const totals = current.totals
    const base = Math.max(sum(Object.values(totals), value => value), capacity || 0)
    return `<section class="cx-card"><div class="cx-card-head"><h3>当前上下文</h3><span title="${esc(current.threadId)}">${esc(agentName(current.agentId))} · ${esc(current.effectiveConfig?.model || '默认模型')}</span></div><div class="cx-occupancy sc-usage"><div><strong>${estimated ? '≈' : ''}${compact(tokens)}</strong><span>${capacity ? ` / ${compact(capacity)} tokens` : ' tokens'}</span></div><div><b>${capacity ? percent(tokens, capacity) : '—'}</b><span>${capacity ? '窗口占用' : '窗口容量未上报'}</span></div></div>${composition(totals, base)}${legend(totals)}<p class="cx-note">${esc(current.sourceCoverage)}${current.approximate ? ' · 部分较早材料超出保留范围' : ''}</p></section>`
  }

  function trendRequests() {
    const list = requests().slice().reverse()
    if (state.granularity === 'step') return list
    const grouped = new Map()
    for (const request of list) {
      const key = `${request.runId}/${request.agentId}`
      grouped.set(key, request)
    }
    return [...grouped.values()]
  }

  function trendView() {
    const list = trendRequests()
    const bars = list.map(request => {
      const previousRequest = previous(request)
      const values = Object.keys(CATEGORIES).map(key => [key, state.delta ? (request.totals[key] || 0) - (previousRequest?.totals[key] || 0) : request.totals[key] || 0])
      return { request, values, positive: sum(values, ([, value]) => Math.max(0, value)), negative: sum(values, ([, value]) => Math.max(0, -value)) }
    })
    const maxPositive = Math.max(1, ...bars.map(bar => bar.positive))
    const maxNegative = Math.max(1, ...bars.map(bar => bar.negative))
    const active = selected()
    const run = state.data.runs.find(run => run.id === active?.runId)
    return `<section class="cx-card cx-trend" id="cx-trend"><div class="cx-card-head"><h3>上下文趋势</h3><div class="cx-tools">${toggleGroup('granularity', [['step', '步骤'], ['turn', '轮次']], state.granularity)}${toggleGroup('trend-mode', [['total', '总量'], ['delta', '增量']], state.delta ? 'delta' : 'total')}<button type="button" data-cx="overview" aria-pressed="${state.overview}">总览</button></div></div><div class="cx-plot-wrap"><div class="cx-axis"><span>${compact(maxPositive)}</span><span>${compact(maxPositive / 2)}</span><span>0</span>${state.delta ? `<span>−${compact(maxNegative)}</span>` : ''}</div><div class="cx-plot-scroll" data-scroll="cx-plot"><div class="cx-plot ${state.overview ? 'cx-overview' : ''} ${state.delta ? 'cx-delta-plot' : ''}" style="--cx-bars:${Math.max(1, list.length)}">${bars.map(({ request, values, positive, negative }, index) => {
      const title = `${index + 1} · ${agentName(request.agentId)} · ${request.stage}\n${state.delta ? '变化' : '输入估算'} ${state.delta ? signed(positive - negative) : fmt(request.estimatedTokens)} tokens\n${stamp(request.at)}`
      return `<button type="button" class="cx-trend-bar" data-cx="pick" data-id="${request.id}" aria-pressed="${state.selected === request.id}" aria-label="${esc(title)}" title="${esc(title)}"><span class="cx-bar-positive">${values.filter(([, value]) => value > 0).reverse().map(([key, value]) => `<i style="height:${value / maxPositive * 100}%;background:${color(key)}"></i>`).join('')}</span>${state.delta ? `<span class="cx-bar-negative">${values.filter(([, value]) => value < 0).map(([key, value]) => `<i style="height:${-value / maxNegative * 100}%;background:${color(key)}"></i>`).join('')}</span>` : ''}<small>${index + 1}</small></button>`
    }).join('')}</div></div></div><div class="cx-trend-legend">${Object.keys(CATEGORIES).map(key => `<span>${swatch(key)}${categoryLabel(key)}</span>`).join('')}</div>${active ? `<div class="cx-step-brief"><div><b>${esc(agentName(active.agentId))} · ${esc(active.stage)}</b><span>${stamp(active.at)}</span></div><button type="button" data-cx="category" data-value="user"><span>用户</span>${esc(run?.text || '历史任务')}</button><button type="button" data-cx="jump" data-value="browser"><span>输入</span>≈${fmt(active.estimatedTokens)} tokens · ${active.itemCount} 项材料${active.usage ? ` · 上报输入 ${fmt(active.usage.input)} · 输出 ${fmt(active.usage.output)} · 缓存 ${fmt(active.usage.cache)}` : ''}</button><button type="button" data-cx="category" data-value="output"><span>回复</span>${esc(state.detail?.context.response?.slice(0, 160) || '打开请求内容查看运行结果')}</button></div>` : ''}<p class="cx-note">增量与同一成员的上一请求比较。轮次显示每位成员在该轮的最后一次输入。</p></section>`
  }

  function itemView(item, index, contextId) {
    const key = `${contextId}/${item.key || index}`
    const mode = state.contentModes.get(key) || 'formatted'
    const content = String(item.content || '')
    let schema
    if (item.category === 'tools') { try { schema = JSON.parse(content) } catch { /* The original definition remains readable. */ } }
    const parameters = schema?.parameters || schema?.inputSchema
    const source = item.source || {}
    return `<details class="cx-item sc-context-item" data-detail="${esc(key)}"><summary>${state.dna ? `<span class="cx-position">#${index + 1}</span>${swatch(item.category)}` : ''}<span>${esc(item.label || categoryLabel(item.category))}</span><small>${esc(item.tool || source.name || source.type || '')}</small><span>≈${compact(item.estimatedTokens)}</span></summary><div class="cx-item-body"><div class="cx-body-tools"><span>${content.split('\n').length} 行</span>${toggleGroup('content-mode', [['raw', '原文'], ['formatted', '格式化']], mode).replaceAll('data-value=', `data-key="${esc(key)}" data-value=`)}<button type="button" data-cx="copy" data-key="${esc(key)}">${state.copied === key ? '已复制' : '复制'}</button></div>${mode === 'raw' ? `<pre>${esc(content)}</pre>` : schema ? `<p>${esc(schema.description || '')}</p>${parameters ? `<div class="cx-schema">${Object.entries(parameters.properties || {}).map(([name, property]) => `<div><b>${esc(name)}</b><code>${esc(property.type || (property.anyOf ? 'anyOf' : ''))}</code><span>${parameters.required?.includes(name) ? '必填' : ''}</span><p>${esc(property.description || '')}</p></div>`).join('')}</div><details><summary>完整定义</summary><pre>${esc(content)}</pre></details>` : `<pre>${esc(content)}</pre>`}` : `<div class="cx-formatted">${formatted(content)}</div>`}${item.truncated ? `<p class="cx-note">正文超过保留上限，已截取前 10 万字符。</p>` : ''}${item.reason ? `<p class="cx-note">采用原因 ${esc(item.reason)}</p>` : ''}<details class="cx-provenance"><summary>来源与版本${source.revision ? ` · v${source.revision}` : ''}</summary><pre>${esc(json(source))}</pre>${source.type === 'memory' ? `<button type="button" data-cx="source" data-key="${esc(item.key)}">查看来源</button>` : ''}</details></div></details>`
  }

  function browserView() {
    const request = selected()
    const snapshot = state.detail?.context
    const baselineItems = state.baseline?.context.items || []
    const priorTokens = {}
    for (const item of baselineItems) priorTokens[item.category] = (priorTokens[item.category] || 0) + item.estimatedTokens
    let items = snapshot?.items || []
    if (state.browserDelta) {
      const old = new Set(baselineItems.map(item => `${item.category}/${item.label}/${item.content}`))
      items = items.filter(item => !old.has(`${item.category}/${item.label}/${item.content}`))
    }
    const query = state.query.trim().toLowerCase()
    const filtered = items.filter(item => `${item.label} ${item.content} ${json(item.source)}`.toLowerCase().includes(query))
    const sorted = list => list.slice().sort((a, b) => state.sort === 'size' ? b.estimatedTokens - a.estimatedTokens : state.sort === 'name' ? a.label.localeCompare(b.label) : 0)
    const totals = request?.totals || {}
    const total = sum(Object.values(totals), value => value)
    return `<section class="cx-card cx-browser" id="cx-browser"><div class="cx-card-head"><h3>上下文浏览器</h3><div class="cx-tools"><button type="button" data-cx="dna" aria-pressed="${state.dna}">DNA 模式</button>${toggleGroup('browser-mode', [['all', '完整'], ['delta', '新增']], state.browserDelta ? 'delta' : 'all')}</div></div><select id="sc-context-id" aria-label="选择请求步骤">${requests().map((request, index) => `<option value="${request.id}" ${state.selected === request.id ? 'selected' : ''}>${requests().length - index} · ${esc(agentName(request.agentId))} · ${esc(request.stage)}${request.runtimeStep !== undefined ? ` · 步骤 ${request.runtimeStep}` : ''} · ${stamp(request.at)}</option>`).join('')}</select><div class="cx-browser-meta"><b>${esc(request?.stage || '选择请求')}</b><span>估算 ≈${compact(request?.estimatedTokens || 0)}${request?.usage ? ` · 上报 ${compact(request.usage.input)}` : ''}</span></div>${composition(totals)}<div class="cx-browser-controls"><input type="search" id="cx-browser-query" value="${esc(state.query)}" placeholder="搜索名称、内容或来源…" aria-label="搜索上下文内容">${toggleGroup('sort', [['size', '大小'], ['name', '名称'], ['order', '顺序']], state.sort)}</div><div class="cx-browser-scroll" data-scroll="cx-browser">${!snapshot ? empty(state.error || '正在读取请求内容…') : state.dna ? `<div class="cx-dna-strip" aria-label="上下文读取顺序">${items.map(item => `<i style="flex-grow:${Math.max(1, item.estimatedTokens)};background:${color(item.category)}" title="${esc(item.label)}"></i>`).join('')}</div><p class="cx-note">按该请求保存的输入顺序排列</p>${filtered.map((item, index) => itemView(item, items.indexOf(item), snapshot.id)).join('') || empty('没有匹配的内容')}` : Object.keys(CATEGORIES).map(key => {
      const rows = filtered.filter(item => item.category === key)
      const allRows = items.filter(item => item.category === key)
      const delta = (totals[key] || 0) - (priorTokens[key] || 0)
      const open = state.category === key
      return `<div class="cx-category"><button type="button" class="cx-category-head" data-cx="category" data-value="${key}" aria-expanded="${open}"><span class="cx-chevron">${open ? '⌄' : '›'}</span>${swatch(key)}<b>${categoryLabel(key)}</b><small>${allRows.length} 项</small><span class="cx-category-metric">${state.baseline && delta ? `<em class="${delta < 0 ? 'cx-down' : 'cx-up'}">${signed(delta)}</em>` : ''}<span>≈${compact(totals[key] || 0)}</span><small>${percent(totals[key] || 0, total)}</small></span></button>${open ? `<div class="cx-category-body">${sorted(rows).map((item, index) => itemView(item, index, snapshot.id)).join('') || empty(allRows.length ? '没有匹配的内容' : '本次请求没有这类材料')}</div>` : ''}</div>`
    }).join('')}${snapshot ? `<details class="cx-output" data-detail="${snapshot.id}/output" ${state.category === 'output' ? 'open' : ''}><summary>本次请求 / 阶段的输出</summary><p class="cx-note">以下为本次输入之后产生的回复与工具结果。</p><div class="cx-formatted">${formatted(snapshot.response || '该阶段尚未保存回复')}</div>${(state.detail.tools || []).map(tool => `<details data-detail="${tool.id}"><summary>${esc(tool.tool)} · ${tool.status === 'error' ? '错误' : '完成'}</summary><pre>${esc(json(tool.arguments))}</pre><pre>${esc(tool.text)}</pre></details>`).join('')}</details>` : ''}</div></section>`
  }

  function eventsView() {
    const events = state.data.events
    const visible = events.filter(event => (!state.eventKind || event.kind === state.eventKind) && `${event.type} ${event.text || ''} ${agentName(event.agentId)}`.toLowerCase().includes(state.eventQuery.toLowerCase()))
    return `<section class="cx-card" id="cx-events"><div class="cx-card-head"><h3>上下文事件</h3><span>${events.length} 条</span></div><div class="cx-filter-pills"><button type="button" data-cx="event-kind" data-value="" aria-pressed="${!state.eventKind}">全部</button>${Object.entries(EVENT_LABELS).filter(([kind]) => events.some(event => event.kind === kind)).map(([kind, label]) => `<button type="button" data-cx="event-kind" data-value="${kind}" aria-pressed="${state.eventKind === kind}">${label} ${events.filter(event => event.kind === kind).length}</button>`).join('')}</div><input type="search" id="cx-event-query" value="${esc(state.eventQuery)}" placeholder="搜索事件或成员…" aria-label="搜索上下文事件"><div class="cx-log" data-scroll="cx-events">${visible.slice().reverse().map(event => `<details data-detail="${event.eventId}"><summary><span class="cx-event-kind">${esc(EVENT_LABELS[event.kind] || event.kind)}</span><span>${esc(agentName(event.agentId))}</span><small>${stamp(event.at)}</small></summary><p>${esc(event.text || event.stage || event.type)}${event.tokens !== undefined ? ` · ${fmt(event.tokens)} tokens` : ''}</p><pre>${esc(json(event))}</pre>${event.contextId ? `<button type="button" data-cx="pick" data-id="${event.contextId}">定位请求</button>` : ''}</details>`).join('') || empty('没有匹配的上下文事件')}</div></section>`
  }

  function filesView() {
    const files = state.data.files
    const visible = files.filter(file => (!state.fileKind || file.kinds.includes(state.fileKind)) && file.path.toLowerCase().includes(state.fileQuery.toLowerCase()))
    return `<section class="cx-card" id="cx-files"><div class="cx-card-head"><h3>文件活动</h3><span>${files.length} 个文件</span></div><div class="cx-filter-pills"><button type="button" data-cx="file-kind" data-value="" aria-pressed="${!state.fileKind}">全部</button>${Object.entries(FILE_LABELS).map(([kind, label]) => `<button type="button" data-cx="file-kind" data-value="${kind}" aria-pressed="${state.fileKind === kind}">${label} ${files.filter(file => file.kinds.includes(kind)).length}</button>`).join('')}</div><input type="search" id="cx-file-query" value="${esc(state.fileQuery)}" placeholder="按文件路径搜索…" aria-label="搜索文件活动"><div class="cx-log" data-scroll="cx-files">${visible.map(file => `<details data-detail="file/${esc(file.path)}"><summary><span class="cx-file-path" title="${esc(file.path)}">${esc(file.path.replace(/.*[/\\]/, ''))}</span><small>${file.operations.length} 次</small><span class="cx-up">${file.added ? `+${file.added}` : ''}</span><span class="cx-down">${file.removed ? `−${file.removed}` : ''}</span><small>${file.kinds.map(kind => FILE_LABELS[kind]).join(' / ')}</small></summary><p class="cx-path">${esc(file.path)}</p>${file.operations.map(operation => `<div class="cx-file-operation"><span>${esc(FILE_LABELS[operation.kind])} · ${esc(agentName(operation.agentId))} · ${stamp(operation.at)} · ${operation.status === 'error' ? '错误' : '完成'}</span>${operation.contextId ? `<button type="button" data-cx="locate-tool" data-id="${operation.contextId}">定位结果</button>` : ''}</div>`).join('')}</details>`).join('') || empty('已记录的文件读取、修改和搜索会显示在这里')}</div></section>`
  }

  function commandsView() {
    const commands = state.data.tools.filter(tool => tool.command)
    const programs = new Map()
    for (const command of commands) {
      const program = command.command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean) || '其他'
      programs.set(program, (programs.get(program) || 0) + 1)
    }
    const visible = commands.filter(command => (!state.commandStatus || command.status === state.commandStatus) && `${command.command} ${command.preview || ''}`.toLowerCase().includes(state.commandQuery.toLowerCase()))
    return `<section class="cx-card cx-commands" id="cx-commands"><div class="cx-card-head"><h3>命令执行</h3><span>${commands.length} 次 · ${commands.filter(command => command.status === 'error').length} 次错误</span></div><div class="cx-command-layout"><div class="cx-programs"><h4>程序分布</h4>${[...programs].sort((a, b) => b[1] - a[1]).map(([program, count]) => `<button type="button" data-cx="program" data-value="${esc(program)}" aria-pressed="${state.commandQuery === program}"><span>${esc(program.replace(/.*[/\\]/, ''))}</span><b>${count}</b></button>`).join('') || empty('执行命令后显示程序分布')}</div><div><div class="cx-browser-controls"><input type="search" id="cx-command-query" value="${esc(state.commandQuery)}" placeholder="搜索命令或程序…" aria-label="搜索命令">${toggleGroup('command-status', [['', '全部'], ['running', '运行中'], ['ok', '完成'], ['error', '错误']], state.commandStatus)}</div><div class="cx-command-list" data-scroll="cx-commands">${visible.slice().reverse().map(command => {
      const detail = state.toolDetails.get(command.id)
      return `<details data-detail="command/${command.id}"><summary><span class="${command.status === 'error' ? 'cx-down' : 'cx-up'}">${command.status === 'running' ? '运行中' : command.status === 'error' ? '错误' : '完成'}</span><code>${esc(command.command)}</code><small>${duration(command.durationMs)}</small></summary><div class="cx-command-meta"><span>${esc(agentName(command.agentId))} · ${stamp(command.at)}</span><span>${command.status === 'running' ? '等待结束' : command.exitCode === undefined ? '退出码未上报' : `退出码 ${command.exitCode}`}</span></div>${command.cwd ? `<p class="cx-path">${esc(command.cwd)}</p>` : ''}<pre>${esc(command.command)}</pre>${detail ? `<pre>${esc(detail.text || '空输出')}</pre>` : `<button type="button" data-cx="tool-output" ${command.status === 'running' ? 'disabled' : ''} data-id="${command.id}" data-context="${command.contextId || ''}">${command.status === 'running' ? '等待命令输出' : '读取命令输出'}</button>`}${command.contextId ? `<button type="button" data-cx="locate-tool" data-id="${command.contextId}">定位请求</button>` : ''}</details>`
    }).join('') || empty('没有匹配的命令记录')}</div></div></div></section>`
  }

  function view() {
    const list = requests()
    return `<section class="cx-dashboard" data-scroll="context"><div class="cx-toolbar"><h2>上下文洞察</h2><label>成员<select id="sc-context-agent"><option value="">全部成员</option>${scene().agents.map(agent => `<option value="${agent.id}" ${state.agent === agent.id ? 'selected' : ''}>${esc(agent.name)}</option>`).join('')}</select></label><button type="button" data-cx="refresh" ${state.loading ? 'disabled' : ''}>${state.loading ? '刷新中…' : '刷新'}</button></div><p class="cx-note">选择成员和请求步骤，核对任务要求、采用的记忆与工具结果。趋势用于定位输入增长，执行记录用于追查结论依据。</p>${state.error ? `<p class="cx-error" role="alert">${esc(state.error)}</p>` : ''}${!state.data ? empty(state.loading ? '正在读取上下文记录…' : '打开任务后查看上下文记录') : `${statsView()}${list.length ? `<div class="cx-two cx-main"><div class="cx-left">${currentView()}${trendView()}</div>${browserView()}</div>` : empty('发起协作任务后，这里会显示每位成员的上下文组成与执行记录。')}<div class="cx-two">${eventsView()}${filesView()}</div>${commandsView()}<p class="cx-note cx-foot">保存的输入材料与运行记录按需加载。当前最多显示 ${state.data.bounds.requests} 条请求、${state.data.bounds.events} 条事件与 ${state.data.bounds.files} 个文件。${state.data.hasOlder ? '<button type="button" data-cx="older">查看更早记录</button>' : ''}</p>`}</section>`
  }

  async function click(button, root) {
    const action = button.dataset.cx
    const value = button.dataset.value
    if (action === 'refresh') return load()
    if (action === 'pick') return select(button.dataset.id, { reveal: true })
    if (action === 'category') { state.category = state.category === value ? '' : value; rerender(); return }
    if (action === 'dna') state.dna = !state.dna
    if (action === 'browser-mode') state.browserDelta = value === 'delta'
    if (action === 'granularity') state.granularity = value
    if (action === 'trend-mode') state.delta = value === 'delta'
    if (action === 'overview') state.overview = !state.overview
    if (action === 'sort') state.sort = value
    if (action === 'event-kind') state.eventKind = value
    if (action === 'file-kind') state.fileKind = value
    if (action === 'command-status') state.commandStatus = value
    if (action === 'program') state.commandQuery = state.commandQuery === value ? '' : value
    if (action === 'content-mode') state.contentModes.set(button.dataset.key, value)
    if (action === 'source') return openSource(state.detail?.context.items.find(item => item.key === button.dataset.key)?.source)
    if (action === 'copy') {
      const item = state.detail?.context.items.find((item, index) => `${state.detail.context.id}/${item.key || index}` === button.dataset.key)
      if (item) { await navigator.clipboard.writeText(item.content); state.copied = button.dataset.key }
    }
    if (action === 'jump') {
      if (value === 'members') return root.querySelector('#sc-context-agent')?.focus()
      root.querySelector(`#cx-${value}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      return
    }
    if (action === 'tool-filter') { state.category = 'output'; state.query = ''; rerender(); root.querySelector('#cx-browser')?.scrollIntoView({ block: 'nearest' }); return }
    if (action === 'locate-tool') { state.category = 'output'; return select(button.dataset.id, { reveal: true }) }
    if (action === 'tool-output') { if (button.dataset.context) await fetchDetail(button.dataset.context) }
    if (action === 'older') {
      const generation = ++state.generation
      const result = await api(`/scenarios/${state.sceneId}/context-insights?agent=${encodeURIComponent(state.agent)}&before=${state.data.before}`)
      if (disposed || generation !== state.generation) return
      state.data = result
      return select(result.requests[0]?.id || '')
    }
    rerender()
    if (action === 'file-kind') root.querySelector('#cx-files')?.scrollIntoView({ block: 'nearest' })
  }

  function input(element) {
    const fields = { 'cx-browser-query': 'query', 'cx-event-query': 'eventQuery', 'cx-file-query': 'fileQuery', 'cx-command-query': 'commandQuery' }
    if (!fields[element.id]) return false
    state[fields[element.id]] = element.value
    rerender()
    return true
  }

  return { view, load, select, click, input, schedule,
    get agent() { return state.agent },
    dispose() { disposed = true; state.generation++; state.detailGeneration++; clearTimeout(refreshTimer); cache.clear() } }
}
