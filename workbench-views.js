const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

export function effortValues(agent, catalog, selected = agent.effort) {
  const models = catalog[agent.engine === 'codex' ? 'codex' : 'dsh'] || []
  const route = agent.engine === 'agent' ? catalog.agentBackends?.find(backend => backend.id === agent.agentProvider)?.routeDefaults : undefined
  const model = models.find(model => model.id === agent.model && (model.provider || '') === (agent.provider || ''))
    || (!agent.model ? (agent.engine === 'codex' ? models.find(model => model.isDefault)
      : route ? models.find(model => model.id === route.model && model.provider === route.provider) : catalog.defaultDsh) : undefined)
  const efforts = [...new Set(['', ...(model?.efforts || []), ...(selected ? [selected] : [])])]
  return efforts
}

export function effortOptions(agent, catalog, selected = agent.effort) {
  return effortValues(agent, catalog, selected).map(effort => `<option value="${escapeHtml(effort)}" ${effort === selected ? 'selected' : ''}>${escapeHtml(effort || '跟随模型默认')}</option>`).join('')
}

export function supportsMemberModel(agent, catalog) {
  return agent.engine !== 'agent' || Boolean(catalog.agentBackends?.find(backend => backend.id === agent.agentProvider)?.supportsModelOptions)
}

export function profileOptions(agent, selected = '') {
  return `<option value="" ${!selected ? 'selected' : ''}>成员配置 · ${escapeHtml(effortLabel(agent.effort || ''))}</option>${(agent.variants || []).map(variant =>
    `<option value="${variant.id}" ${variant.id === selected ? 'selected' : ''}>${escapeHtml(variant.name)} · ${escapeHtml(variant.effort || '模型默认')}</option>`).join('')}`
}

function modelOptions(agent, catalog) {
  const models = catalog[agent.engine === 'codex' ? 'codex' : 'dsh'] || []
  const value = `${agent.provider || ''}::${agent.model || ''}`
  const options = [{ value: '::', label: '跟随引擎默认模型' }, ...models.map(model => {
    const name = model.label || model.id
    const duplicate = models.filter(item => (item.label || item.id) === name).length > 1
    return { value: `${model.provider || ''}::${model.id}`, label: duplicate ? `${name} (${model.provider})` : name }
  })]
  if (agent.model && !options.some(option => option.value === value)) options.push({ value, label: agent.model })
  return options.map(option => `<option value="${escapeHtml(option.value)}" ${value === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')
}

function variantView(agent, variant, catalog) {
  return `<div class="sc-variant-row">
    <label>名称<input data-variant-field="name" data-agent="${agent.id}" data-variant="${variant.id}" data-focus="variant-${variant.id}" value="${escapeHtml(variant.name)}"></label>
    <label>任务难度<select data-variant-field="difficulty" data-agent="${agent.id}" data-variant="${variant.id}">
      ${[['simple', '简单'], ['medium', '中等'], ['hard', '困难']].map(([value, label]) => `<option value="${value}" ${value === variant.difficulty ? 'selected' : ''}>${label}</option>`).join('')}
    </select></label>
    <label>思考强度<select data-variant-field="effort" data-agent="${agent.id}" data-variant="${variant.id}">${effortOptions(agent, catalog, variant.effort)}</select></label>
    <button type="button" class="sc-plain" data-action="remove-variant" data-agent="${agent.id}" data-variant="${variant.id}" aria-label="移除${escapeHtml(variant.name)}">移除</button>
  </div>`
}

export const effortLabel = effort => ({ '': '模型默认', none: '不思考', minimal: '最低', low: '低', medium: '中等', high: '高', xhigh: '很高', max: '最高', ultra: '极高' }[effort] || effort)

export function memberModelName(agent, catalog) {
  return agent.model || (agent.engine === 'codex' ? catalog.codex?.find(model => model.isDefault)?.id : agent.engine === 'dsh' ? catalog.defaultDsh?.id : '') || '接入默认模型'
}

function modelControl(agent, catalog) {
  const canSelectModel = supportsMemberModel(agent, catalog)
  const efforts = effortValues(agent, catalog)
  return `<div class="sc-effort-control">
            ${canSelectModel ? `<output class="sc-effort-value" data-effort-label="${agent.id}">${escapeHtml(effortLabel(agent.effort || ''))}</output>
            <label class="sc-effort-slider-label">思考强度<input type="range" min="0" max="${efforts.length - 1}" step="1" value="${Math.max(0, efforts.indexOf(agent.effort || ''))}" data-effort-slider data-efforts="${escapeHtml(JSON.stringify(efforts))}" data-agent="${agent.id}" data-focus="effort-${agent.id}" aria-valuetext="${escapeHtml(effortLabel(agent.effort || ''))}" ${efforts.length < 2 ? 'disabled' : ''}></label>
            <div class="sc-effort-ticks" aria-hidden="true">${efforts.map(effort => `<span>${escapeHtml(effortLabel(effort))}</span>`).join('')}</div>
            <select aria-label="模型" data-agent-field="model" data-agent="${agent.id}">${modelOptions(agent, catalog)}</select>` : '<p class="sc-small sc-muted">模型和强度沿用此 Agent 的 DSH 接入配置。</p>'}
          </div>`
}

function permissionControl(agent, catalog) {
  if (!catalog.permissionModes?.[agent.engine]) return '<p class="sc-small sc-muted">当前宿主尚未提供权限设置，插件重载后刷新目录即可使用。</p>'
  const choices = agent.engine === 'codex'
    ? [['default', '工作区权限 · 自动审核'], ['approve', '工作区权限 · 向我申请审批'], ['full', '完全权限 · 无需审批'], ['read-only', '只读']]
    : agent.engine === 'dsh'
      ? [['default', '沿用 DSH 权限'], ['approve', '操作工具执行前向我审批'], ['read-only', '只读']]
      : [['default', '沿用 Agent 接入权限']]
  const description = agent.engine === 'codex'
    ? ({ default: '可写工作区，额外权限由自动审核处理。', approve: '额外权限申请会显示在主聊天，由你允许或拒绝。', full: '执行阶段可访问工作区外文件和网络，操作无需逐项审批。', 'read-only': '仅允许读取和调研。' }[agent.permission || 'default'])
    : agent.engine === 'dsh' ? 'DSH 宿主权限继续生效。操作审批用于工具执行前的人工确认，只读会限制操作工具。' : '权限由该 Agent 接入插件配置。'
  return `<label>执行权限<select data-agent-field="permission" data-agent="${agent.id}">${choices.map(([value, label]) => `<option value="${value}" ${value === (agent.permission || 'default') ? 'selected' : ''}>${label}</option>`).join('')}</select><span class="sc-small sc-muted">${escapeHtml(description)}</span></label><p class="sc-small sc-muted">调研与审查阶段按只读要求执行，权限调整用于下一轮任务。</p>`
}

export function renderMemberPopover(scene, catalog, selectedId, editingMembers, dirty, saving) {
  const agent = scene.agents.find(agent => agent.id === selectedId) || scene.agents[0]
  const editing = editingMembers.has(agent.id)
  return `<section class="sc-member-popover" role="dialog" aria-label="成员快捷设置">
    <div class="sc-section-head"><h3>成员快捷设置</h3><button type="button" class="sc-plain" data-action="close-members" aria-label="关闭成员快捷设置">×</button></div>
    <div class="sc-member-list" data-scroll="quick-members">${scene.agents.map(member => `<button type="button" data-action="pick-quick-member" data-agent="${member.id}" aria-pressed="${member.id === agent.id}"><strong>${escapeHtml(member.name)}</strong><span>${escapeHtml(memberModelName(member, catalog))} · ${escapeHtml(effortLabel(member.effort || ''))}</span></button>`).join('')}</div>
    <div class="sc-member-quick-body" data-scroll="quick-body"><div class="sc-profile-actions"><strong>${escapeHtml(agent.name)}</strong><button type="button" data-action="edit-member" data-agent="${agent.id}" ${saving ? 'disabled' : ''}>${editing ? '完成编辑' : '编辑'}</button></div>
    <fieldset ${editing && !saving ? '' : 'disabled'}>${modelControl(agent, catalog)}${permissionControl(agent, catalog)}</fieldset></div>
    <div class="sc-quick-save"><span class="sc-small sc-muted">${dirty ? '有尚未保存的设置' : '已保存'} · 模型与权限用于下一轮</span><button type="button" class="sc-primary" data-action="save-team" ${saving || !dirty ? 'disabled' : ''}>${saving ? '保存中…' : '保存设置'}</button></div>
  </section>`
}

function memberSkills(agent, skills, editing) {
  const groups = new Map()
  for (const skill of skills) {
    const category = skill.category || (skill.custom ? '场景技能' : ({ 'dsh-office': 'Office 文档', 'dsh-windows-acl': 'Windows 环境诊断' }[skill.provider] || skill.provider || skill.source || 'DSH 技能'))
    const key = typeof category === 'string' ? category : 'DSH 技能'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(skill)
  }
  return [...groups].map(([category, entries]) => `<details class="sc-skill-group" data-detail="skills-${escapeHtml(agent.id)}-${escapeHtml(category)}">
    <summary><span>${escapeHtml(category)}</span><small>${entries.filter(skill => agent.skills.includes(skill.name)).length} / ${entries.length}</small><span class="sc-fold-arrow" aria-hidden="true"></span></summary>
    <div>${entries.map(skill => `<div class="sc-skill-row">
      <input type="checkbox" aria-label="选择技能 ${escapeHtml(skill.label || skill.name)}" data-skill="${escapeHtml(skill.name)}" data-agent="${agent.id}" ${agent.skills.includes(skill.name) ? 'checked' : ''} ${editing ? '' : 'disabled'}>
      <button type="button" class="sc-skill-link" data-action="view-skill" data-skill-name="${escapeHtml(skill.name)}">${escapeHtml(skill.label || skill.name)}</button>
      ${editing && skill.custom ? `<button type="button" class="sc-plain" data-action="edit-skill" data-id="${escapeHtml(skill.id)}" data-agent="${agent.id}">编辑</button>` : ''}
    </div>`).join('')}</div></details>`).join('') || '<p class="sc-small sc-muted">暂无技能，可在编辑时添加。</p>'
}

export function renderTeamSettings(scene, catalog, sessionTitle = '', editingMembers = new Set()) {
  const agents = scene.agents
  const skills = [...catalog.skills.filter(skill => !skill.custom), ...(scene.customSkills || []).map(skill => ({ ...skill, name: `custom:${skill.id}`, label: skill.name, custom: true }))]
  // Keep selected skills visible even when their source is temporarily unavailable.
  for (const name of new Set(agents.flatMap(agent => agent.skills))) {
    if (!skills.some(skill => skill.name === name)) skills.push({ name, category: '待恢复的技能' })
  }
  const members = agents.map(agent => {
    const canSelectModel = supportsMemberModel(agent, catalog)
    const editing = editingMembers.has(agent.id)
    const disabled = editing ? '' : 'disabled'
    const model = memberModelName(agent, catalog)
    return `<details class="sc-profile ${editing ? 'sc-profile-editing' : ''}" data-detail="profile-${agent.id}" ${editing ? 'open' : ''}>
      <summary class="sc-profile-head"><strong>${escapeHtml(agent.name)}</strong><span class="sc-profile-model">${escapeHtml(model)} · ${escapeHtml(effortLabel(agent.effort || ''))}</span><span class="sc-fold-arrow" aria-hidden="true"></span></summary>
      <div class="sc-profile-body">
        <div class="sc-profile-actions"><span class="sc-small sc-muted">${editing ? '编辑中 · 保存设置后应用' : '查看模式'}</span><button type="button" data-action="edit-member" data-agent="${agent.id}">${editing ? '完成编辑' : '编辑'}</button>${editing ? `<button type="button" class="sc-plain sc-danger" data-action="remove-agent" data-agent="${agent.id}" ${agents.length <= 2 ? 'disabled' : ''}>移除成员</button>` : ''}</div>
        <section class="sc-member-section"><h3>名称</h3><fieldset ${disabled}><input aria-label="名称" data-agent-field="name" data-agent="${agent.id}" data-focus="${agent.id}-name" value="${escapeHtml(agent.name)}"></fieldset></section>
        <section class="sc-member-section"><h3>职责</h3>
          <fieldset ${disabled}><label>过程窗口的简短职责<input data-agent-field="roleSummary" data-agent="${agent.id}" data-focus="${agent.id}-role-summary" maxlength="120" value="${escapeHtml(agent.roleSummary || '')}" placeholder="例如：实现与维护"></label><label class="sc-check"><input type="checkbox" data-agent-flag="showRoleSummary" data-agent="${agent.id}" ${agent.showRoleSummary ? 'checked' : ''}>在过程标题显示简短职责</label></fieldset>
          <details class="sc-role-description" data-detail="role-${agent.id}"><summary>展开完整职责</summary>${editing ? `<textarea class="sc-role-editor" data-auto-grow aria-label="完整职责" data-agent-field="role" data-agent="${agent.id}" data-focus="${agent.id}-role">${escapeHtml(agent.role)}</textarea>` : `<p class="sc-prose">${escapeHtml(agent.role)}</p>`}</details>
        </section>
        <section class="sc-member-section"><h3>模型</h3><fieldset ${disabled}>
          ${modelControl(agent, catalog)}
          ${permissionControl(agent, catalog)}
          <label>接入方式<select data-agent-field="engine" data-agent="${agent.id}"><option value="codex" ${agent.engine === 'codex' ? 'selected' : ''}>Codex 直接接入</option><option value="dsh" ${agent.engine === 'dsh' ? 'selected' : ''}>DSH 模型供应商</option><option value="agent" ${agent.engine === 'agent' ? 'selected' : ''}>其他 Agent · DSH 接入</option></select></label>
          ${agent.engine === 'agent' ? `<label>Agent 接入<input data-agent-field="agentProvider" data-agent="${agent.id}" data-focus="${agent.id}-backend" list="sc-agent-backends" value="${escapeHtml(agent.agentProvider || '')}"></label>` : ''}
          ${agent.engine === 'codex' ? `<label class="sc-check sc-member-fast"><input type="checkbox" data-agent-flag="fast" data-agent="${agent.id}" ${agent.fast ? 'checked' : ''}>快速模式</label>` : ''}
        </fieldset></section>
        <section class="sc-member-section"><div class="sc-member-section-head"><h3>技能</h3>${editing ? `<button type="button" class="sc-plain" data-action="new-skill" data-agent="${agent.id}">＋ 新增技能</button>` : ''}</div>${memberSkills(agent, skills, editing)}</section>
        <section class="sc-member-section"><div class="sc-member-section-head"><h3>扩展成员</h3>${canSelectModel && editing ? `<button type="button" class="sc-plain" data-action="add-variant" data-agent="${agent.id}">＋ 添加强度档位</button>` : ''}</div>
          <p class="sc-small sc-muted">共用模型、技能与角色记忆，按任务难度选择强度。</p><fieldset ${disabled}>${(agent.variants || []).map(variant => variantView(agent, variant, catalog)).join('') || '<p class="sc-small sc-muted">暂无扩展成员</p>'}</fieldset>
        </section>
      </div>
    </details>`
  }).join('')
  return `<section class="sc-page" data-scroll="team">
    <div class="sc-section-head"><h2>团队与场景设置</h2></div>
    <div class="sc-fields">
      <label>场景名称<input data-setting="title" data-focus="title" value="${escapeHtml(scene.title)}"></label>
      <label>工作区<div class="sc-input-action"><input data-setting="cwd" data-focus="cwd" value="${escapeHtml(scene.cwd)}"><button type="button" data-action="pick-folder">选择文件夹</button></div></label>
      <label class="sc-full">场景目标与边界<textarea data-setting="brief" data-focus="brief">${escapeHtml(scene.brief)}</textarea></label>
    </div>
    <div class="sc-scene-binding"><span>当前需求会话 · ${escapeHtml(sessionTitle || '浏览器会话')}<small>此场景已关联 ${scene.sessions?.length || (scene.dshSessionId ? 1 : 0)} 个会话</small></span><button type="button" data-action="scenes">管理场景与会话</button></div>
    ${scene.mode === 'confidence' ? `<div class="sc-mode-settings sc-fields">
      <label>交叉验证轮数<input type="number" min="0" step="1" data-setting="reviewRounds" value="${scene.reviewRounds}"><span class="sc-small sc-muted">每轮互审后补充核实。0 表示持续验证，直到一致或你停止。</span></label>
      <label>统一结论由谁汇总<select data-setting="summarizerId">${agents.map(agent => `<option value="${agent.id}" ${agent.id === scene.summarizerId ? 'selected' : ''}>${escapeHtml(agent.name)}</option>`).join('')}</select></label>
    </div>` : `<div class="sc-mode-settings sc-fields"><label>任务负责人 Owner<select data-setting="ownerId"><option value="">请选择负责人</option>${agents.map(agent => `<option value="${agent.id}" ${agent.id === scene.ownerId ? 'selected' : ''}>${escapeHtml(agent.name)}</option>`).join('')}</select></label></div>`}
    <div class="sc-subsection-head"><h2>协作成员</h2><button type="button" data-action="reload-catalog">刷新模型与技能</button></div>
    <p class="sc-small sc-muted">新模型先在 DSH 的模型设置中配置供应商，再刷新目录。其他 Agent 先启用其 DSH 接入插件，再选择接入名称。</p>
    <datalist id="sc-agent-backends">${(catalog.agentBackends || []).map(backend => `<option value="${escapeHtml(backend.id)}">${escapeHtml(backend.label)}</option>`).join('')}</datalist>
    <div class="sc-roster">${members}<button type="button" class="sc-add-member" data-action="add-agent" ${agents.length >= 8 ? 'disabled' : ''}>＋ 添加成员</button></div>
    <div class="sc-save-row"><button type="button" class="sc-primary" data-action="save-team">保存设置</button><span class="sc-small sc-muted">强度和扩展档位用于后续步骤；模型、角色与技能用于下一轮任务。</span></div>
    ${catalog.errors.length ? `<p class="sc-small sc-muted">${escapeHtml(catalog.errors.join('。'))}</p>` : ''}
  </section>`
}

function memoryAudienceOptions(scene, selected) {
  const roles = scene.agents.map(agent => ({ id: agent.roleId || agent.id, name: `${agent.name} · ${agent.role}` }))
  const unique = [...new Map(roles.map(role => [role.id, role])).values()]
  return `<option value="scene" ${selected === 'scene' ? 'selected' : ''}>场景共享</option>${unique.map(role => `<option value="role:${role.id}" ${selected === `role:${role.id}` ? 'selected' : ''}>${escapeHtml(role.name)}</option>`).join('')}`
}

export function renderMemoryPage(state, { badge, prose, time }) {
  const { scene, memories, memoryId, memoryDraft, revisions, memoryScope, memoryQuery, memoryAudience } = state
  const entries = memories.filter(memory => (!memoryQuery || `${memory.title} ${memory.content}`.includes(memoryQuery))
    && (memoryAudience === 'all' || (memoryAudience === 'scene' ? memory.audience !== 'role' : memory.audience === 'role' && memory.roleId === memoryAudience.slice(5))))
  const memory = memories.find(item => item.id === memoryId)
  const fields = memoryDraft || memory
  const audienceName = entry => entry.audience === 'role'
    ? scene.agents.find(agent => (agent.roleId || agent.id) === entry.roleId)?.name || '历史角色' : '场景共享'
  let detail = '<p class="sc-small sc-muted">选择一条记忆查看内容、采用状态和来源。</p>'
  if (fields && memoryDraft) {
    detail = `<div class="sc-fields">
      <label class="sc-full">标题<input data-memory-field="title" data-focus="memory-title" value="${escapeHtml(fields.title)}"></label>
      <label>所属范围<select data-memory-audience>${memoryAudienceOptions(scene, fields.audience === 'role' ? `role:${fields.roleId}` : 'scene')}</select></label>
      <label>类型<select data-memory-field="kind">${[['constraint', '约束'], ['fact', '事实'], ['decision', '决策'], ['preference', '偏好'], ['blocker', '阻碍'], ['learning', '经验知识'], ['note', '一般记录']].map(([value, label]) => `<option value="${value}" ${value === fields.kind ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>状态<select data-memory-field="status">${[['candidate', '待核实'], ['confirmed', '已确认'], ['conflict', '存在冲突'], ['expired', '已过期'], ['archived', '已归档']].map(([value, label]) => `<option value="${value}" ${value === fields.status ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="sc-full">内容<textarea data-memory-field="content" data-focus="memory-content">${escapeHtml(fields.content)}</textarea></label>
    </div><div class="sc-detail-actions"><button type="button" class="sc-primary" data-action="save-memory">保存记忆</button><button type="button" data-action="cancel-memory">取消编辑</button></div>`
  } else if (memory) {
    detail = `<h3>${escapeHtml(memory.title)}</h3>${badge(memory.status)}<span class="sc-memory-audience">${escapeHtml(audienceName(memory))}</span>
      <p class="sc-prose">${prose(memory.content)}</p><p class="sc-small sc-muted">版本 v${memory.revision} · ${escapeHtml(time(memory.updatedAt))}</p>
      ${memory.scope === 'scenario' ? `<div class="sc-detail-actions"><label class="sc-check"><input type="checkbox" data-memory-toggle="enabled" ${memory.enabled ? 'checked' : ''}>后续请求采用</label><label class="sc-check"><input type="checkbox" data-memory-toggle="pinned" ${memory.pinned ? 'checked' : ''}>固定重要记忆</label></div>` : ''}
      <details><summary>来源</summary><pre class="sc-source-json">${escapeHtml(JSON.stringify(memory.sources || [], null, 2))}</pre></details>
      <div class="sc-detail-actions">${memory.scope === 'legacy' ? '<button type="button" data-action="import-memory">导入当前场景</button>' : '<button type="button" data-action="edit-memory">编辑</button><button type="button" data-action="memory-revisions">修订历史</button><button type="button" data-action="delete-memory">移除</button>'}</div>
      ${revisions.map(revision => `<details class="sc-memory-revision"><summary>v${revision.revision} · ${escapeHtml(time(revision.updatedAt))}</summary><p class="sc-prose">${escapeHtml(revision.content)}</p><button type="button" data-action="restore-memory" data-revision="${revision.revision}">恢复此版本</button></details>`).join('')}`
  }
  return `<section class="sc-page" data-scroll="memory">
    <div class="sc-section-head"><h2>场景与角色记忆</h2><button type="button" data-action="new-memory">新增记忆</button></div>
    <div class="sc-memory-filters"><label>资料库<select id="sc-memory-scope"><option value="scenario" ${memoryScope === 'scenario' ? 'selected' : ''}>当前场景</option><option value="legacy" ${memoryScope === 'legacy' ? 'selected' : ''}>旧版共享资料</option></select></label>
      ${memoryScope !== 'legacy' ? `<label>记忆层级<select id="sc-memory-audience"><option value="all" ${memoryAudience === 'all' ? 'selected' : ''}>全部层级</option>${memoryAudienceOptions(scene, memoryAudience)}</select></label>` : ''}
      <label>搜索<input id="sc-memory-query" data-focus="memory-query" value="${escapeHtml(memoryQuery)}" placeholder="标题或内容"></label></div>
    <p class="sc-small sc-muted">场景共享保存项目事实与共同约束。角色记忆保存专属方法与经验，同角色的扩展成员共用。</p>
    <div class="sc-memory-layout"><div class="sc-memory-list">${entries.map(entry => `<button type="button" class="sc-memory-row" data-action="pick-memory" data-id="${entry.id}" aria-pressed="${entry.id === memoryId}">${escapeHtml(entry.title)}<span class="sc-small">${escapeHtml(audienceName(entry))} · v${entry.revision} ${badge(entry.status)}</span></button>`).join('') || '<p class="sc-small sc-muted">在这个层级新增记忆，或切换层级查看已有知识。</p>'}</div><section class="sc-memory-detail">${detail}</section></div>
  </section>`
}

export function renderScenePicker(state, options, initial = false) {
  const sessionId = options.sessionId || (state.sessionId?.startsWith('local-') ? '' : state.sessionId) || ''
  const sameSession = id => String(id || '').replace(/^session-/, '') === String(sessionId).replace(/^session-/, '')
  const currentScene = (state.scenes || []).find(scene => scene.sessions?.some(session => sameSession(session.id)))
  const sessionTitle = options.sessionTitle || currentScene?.sessions.find(session => sameSession(session.id))?.title || '未命名会话'
  const action = state.sceneAction
  const busy = state.managingScene
  const confirmation = action ? `<section class="sc-scene-confirm" role="alertdialog" aria-label="${action.type === 'delete' ? '删除场景确认' : '解除绑定确认'}">
    <strong>${action.type === 'delete' ? `删除场景“${escapeHtml(action.sceneTitle)}”` : `解除“${escapeHtml(action.sessionTitle)}”的绑定`}</strong>
    <p>${action.type === 'delete' ? `将删除此场景的团队设置、记忆、插件内对话与协作记录，并解除 ${action.sessionCount} 个会话的关联。` : `将此会话从“${escapeHtml(action.sceneTitle)}”中解除绑定，之后可重新选择场景。`}</p>
    <div class="sc-scene-actions"><button type="button" data-action="cancel-scene-action" ${busy ? 'disabled' : ''}>取消</button><button type="button" class="sc-danger" data-action="confirm-scene-action" ${busy ? 'disabled' : ''}>${busy ? '处理中…' : action.type === 'delete' ? '确认删除场景' : '确认解除绑定'}</button></div>
  </section>` : ''
  return `<div class="${initial ? 'sc-binding-page' : 'sc-drawer'}"><section class="sc-drawer-content" aria-label="场景列表">
    <div class="sc-section-head"><h2>${initial ? '为当前需求选择场景' : '场景与会话'}</h2>${initial ? '' : '<button type="button" data-action="close-drawer">关闭</button>'}</div>
    <p class="sc-small sc-muted">场景保存长期项目知识。每次新需求可使用新会话，并绑定已有场景。</p>
    ${sessionId ? `<div class="sc-current-session"><strong>当前会话 · ${escapeHtml(sessionTitle)}</strong><span class="sc-small sc-muted">${currentScene ? `已绑定场景 · ${escapeHtml(currentScene.title)}` : '待绑定场景'}</span></div>` : ''}
    <button type="button" class="sc-primary" data-action="new-scene">${sessionId ? '以当前会话创建新场景' : '创建新场景'}</button>
    <div class="sc-scene-list" data-scroll="scene-list">${(state.scenes || []).map(scene => {
      const bound = scene.sessions?.some(session => sameSession(session.id))
      return `<article class="sc-scene-choice" data-scene-choice="${scene.id}">
        <div class="sc-scene-choice-head"><div class="sc-scene-identity"><strong>${escapeHtml(scene.title)}</strong>${state.scene?.id === scene.id ? '<span class="sc-current-mark">当前场景</span>' : ''}<p class="sc-small sc-muted sc-scene-path">${escapeHtml(scene.cwd || '工作区待设置')}</p></div>
          <div class="sc-scene-actions"><button type="button" data-action="${sessionId ? 'bind-scene' : 'open-scene'}" data-id="${scene.id}" ${bound || busy ? 'disabled' : ''}>${sessionId ? bound ? '已绑定' : currentScene ? '改绑到此场景' : '绑定当前会话' : '打开场景'}</button><button type="button" class="sc-plain sc-danger" data-action="delete-scene" data-id="${scene.id}" ${busy ? 'disabled' : ''}>删除场景</button></div></div>
        <div class="sc-scene-session-heading">关联会话 · ${scene.sessions?.length || 0}</div>
        ${scene.sessions?.length ? `<ul class="sc-scene-sessions">${scene.sessions.map(session => `<li class="sc-bound-session" data-bound-session="${escapeHtml(session.id)}">
          <button type="button" class="sc-session-open" data-action="open-demand" data-scene="${scene.id}" data-session="${escapeHtml(session.id)}" data-title="${escapeHtml(session.title || '')}" ${busy ? 'disabled' : ''}><span class="sc-session-name">${escapeHtml(session.title || (sameSession(session.id) ? sessionTitle : '未命名会话'))}${sameSession(session.id) ? '<span class="sc-current-mark">当前会话</span>' : ''}</span><small class="sc-session-id">${escapeHtml(session.id)}</small></button>
          <button type="button" class="sc-plain sc-unbind-session" data-action="unbind-session" data-id="${scene.id}" data-session="${escapeHtml(session.id)}" ${busy ? 'disabled' : ''}>解除绑定</button>
        </li>`).join('')}</ul>` : '<p class="sc-small sc-muted sc-no-sessions">暂未关联会话</p>'}
        ${action?.sceneId === scene.id ? confirmation : ''}
      </article>`
    }).join('') || '<p class="sc-small sc-muted">创建第一个场景后，后续会话就可以选择绑定它。</p>'}</div>
    ${!initial && state.scene ? '<button type="button" data-action="new-demand">＋ 在当前场景新建需求会话</button>' : ''}
    ${state.error ? `<p class="sc-notice error" role="alert">${escapeHtml(state.error)}</p>` : ''}
  </section></div>`
}

export function renderFolderPicker(folder) {
  return `<div class="sc-drawer"><section class="sc-drawer-content" aria-label="选择工作区文件夹">
    <div class="sc-section-head"><h2>选择工作区文件夹</h2><button type="button" data-action="close-folder">取消</button></div>
    <p class="sc-path">${escapeHtml(folder.path)}</p><div class="sc-actions">${folder.roots.map(path => `<button type="button" data-action="browse-folder" data-path="${escapeHtml(path)}">${escapeHtml(path)}</button>`).join('')}<button type="button" data-action="browse-folder" data-path="${escapeHtml(folder.parent)}">上一级</button></div>
    <div class="sc-folder-list">${folder.directories.map(directory => `<button type="button" data-action="browse-folder" data-path="${escapeHtml(directory.path)}">▸ ${escapeHtml(directory.name)}</button>`).join('') || '<p class="sc-small sc-muted">此目录没有子文件夹。</p>'}</div>
    <button type="button" class="sc-primary" data-action="select-folder">选择此文件夹</button>
  </section></div>`
}

export function renderSkillEditor(editor) {
  return `<div class="sc-drawer"><section class="sc-drawer-content" aria-label="编辑技能">
    <div class="sc-section-head"><h2>${editor.id ? '编辑技能' : '新增技能'}</h2><button type="button" data-action="close-skill">取消</button></div>
    <label>技能名称<input data-skill-field="name" data-focus="skill-name" value="${escapeHtml(editor.name)}"></label>
    <label>分类<input data-skill-field="category" data-focus="skill-category" value="${escapeHtml(editor.category || '场景技能')}"></label>
    <label>操作说明<textarea class="sc-skill-instructions" data-skill-field="content" data-focus="skill-content" placeholder="写清使用条件、执行步骤与检查要求">${escapeHtml(editor.content)}</textarea></label>
    <button type="button" class="sc-primary" data-action="save-skill">添加并选择技能</button>
  </section></div>`
}

export function renderSessionCreator(draft, scene, busy) {
  return `<div class="sc-drawer"><section class="sc-drawer-content" aria-label="新建需求会话">
    <div class="sc-section-head"><h2>新建需求会话</h2><button type="button" data-action="close-demand" ${busy ? 'disabled' : ''}>取消</button></div>
    <p>关联场景 · ${escapeHtml(scene.title)}</p>
    <label>需求名称<input id="sc-new-session-title" data-focus="new-session-title" value="${escapeHtml(draft.title)}" placeholder="例如：登录页需求" maxlength="200" ${busy ? 'disabled' : ''}></label>
    <p class="sc-small sc-muted">新会话使用独立聊天，沿用这个场景的团队、共享知识和角色记忆。</p>
    <button type="button" class="sc-primary" data-action="create-demand" ${busy ? 'disabled' : ''}>${busy ? '创建中…' : '创建并打开'}</button>
  </section></div>`
}

export function renderSkillViewer(skill) {
  return `<div class="sc-drawer"><section class="sc-drawer-content" aria-label="技能原文">
    <div class="sc-section-head"><h2>${escapeHtml(skill.name)}</h2><button type="button" data-action="close-skill-viewer">关闭</button></div>
    <p class="sc-path sc-small sc-muted">${escapeHtml(skill.path || (skill.sourcePath ? `来源目录 · ${skill.sourcePath}` : '场景数据库中的自定义技能'))}</p>
    <pre class="sc-skill-source">${escapeHtml(skill.content)}</pre>
  </section></div>`
}
