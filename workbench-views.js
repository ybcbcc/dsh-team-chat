const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

export function effortOptions(agent, catalog, selected = agent.effort) {
  const models = catalog[agent.engine === 'codex' ? 'codex' : 'dsh'] || []
  const route = agent.engine === 'agent' ? catalog.agentBackends?.find(backend => backend.id === agent.agentProvider)?.routeDefaults : undefined
  const model = models.find(model => model.id === agent.model && (model.provider || '') === (agent.provider || ''))
    || (!agent.model ? (agent.engine === 'codex' ? models.find(model => model.isDefault)
      : route ? models.find(model => model.id === route.model && model.provider === route.provider) : catalog.defaultDsh) : undefined)
  const efforts = [...new Set(['', ...(model?.efforts || []), ...(selected ? [selected] : [])])]
  return efforts.map(effort => `<option value="${escapeHtml(effort)}" ${effort === selected ? 'selected' : ''}>${escapeHtml(effort || '跟随模型默认')}</option>`).join('')
}

export function supportsMemberModel(agent, catalog) {
  return agent.engine !== 'agent' || Boolean(catalog.agentBackends?.find(backend => backend.id === agent.agentProvider)?.supportsModelOptions)
}

export function profileOptions(agent, selected = '') {
  return `<option value="" ${!selected ? 'selected' : ''}>默认 · ${escapeHtml(agent.effort || '模型默认')}</option>${(agent.variants || []).map(variant =>
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

export function renderTeamSettings(scene, catalog, sessionTitle = '') {
  const agents = scene.agents
  const skills = [...catalog.skills.filter(skill => !skill.custom), ...(scene.customSkills || []).map(skill => ({ name: `custom:${skill.id}`, label: skill.name, custom: true }))]
  const members = agents.map(agent => {
    const canSelectModel = supportsMemberModel(agent, catalog)
    return `<section class="sc-profile">
    <div class="sc-profile-head"><strong>${escapeHtml(agent.name)}</strong><button type="button" data-action="remove-agent" data-agent="${agent.id}" ${agents.length <= 2 ? 'disabled' : ''}>移除成员</button></div>
    <div class="sc-fields">
      <label>名称<input data-agent-field="name" data-agent="${agent.id}" data-focus="${agent.id}-name" value="${escapeHtml(agent.name)}"></label>
      <label>接入方式<select data-agent-field="engine" data-agent="${agent.id}"><option value="codex" ${agent.engine === 'codex' ? 'selected' : ''}>Codex 直接接入</option><option value="dsh" ${agent.engine === 'dsh' ? 'selected' : ''}>DSH 模型供应商</option><option value="agent" ${agent.engine === 'agent' ? 'selected' : ''}>其他 Agent · DSH 接入</option></select></label>
      ${agent.engine === 'agent' ? `<label class="sc-full">Agent 接入<input data-agent-field="agentProvider" data-agent="${agent.id}" data-focus="${agent.id}-backend" list="sc-agent-backends" value="${escapeHtml(agent.agentProvider || '')}" placeholder="选择已启用的接入，或填写接入名称"></label>` : ''}
      <label class="sc-full">职责<input data-agent-field="role" data-agent="${agent.id}" data-focus="${agent.id}-role" value="${escapeHtml(agent.role)}"></label>
      ${canSelectModel ? `<label>模型<select data-agent-field="model" data-agent="${agent.id}">${modelOptions(agent, catalog)}</select></label><label>默认思考强度<select data-agent-field="effort" data-agent="${agent.id}">${effortOptions(agent, catalog)}</select></label>` : '<p class="sc-small sc-muted sc-full">模型、强度与执行权限沿用此 Agent 的 DSH 接入配置。</p>'}
    </div>
    ${agent.engine === 'codex' ? `<label class="sc-check sc-member-fast"><input type="checkbox" data-agent-flag="fast" data-agent="${agent.id}" ${agent.fast ? 'checked' : ''}>快速模式</label>` : ''}
    <div class="sc-subsection-head"><h3>技能</h3><button type="button" class="sc-plain" data-action="new-skill" data-agent="${agent.id}">＋ 新增技能</button></div>
    <div class="sc-skills">${skills.map(skill => `<label class="sc-check"><input type="checkbox" data-skill="${escapeHtml(skill.name)}" data-agent="${agent.id}" ${agent.skills.includes(skill.name) ? 'checked' : ''}>${escapeHtml(skill.label || skill.name)}</label>`).join('') || '<span class="sc-small sc-muted">添加角色需要的操作说明，或刷新现有技能目录。</span>'}</div>
    <div class="sc-custom-skill-actions">${(scene.customSkills || []).map(skill => `<button type="button" class="sc-plain sc-small" data-action="edit-skill" data-id="${skill.id}" data-agent="${agent.id}">编辑 ${escapeHtml(skill.name)}</button>`).join('')}</div>
    ${canSelectModel ? `<div class="sc-subsection-head"><h3>扩展成员</h3><button type="button" class="sc-plain" data-action="add-variant" data-agent="${agent.id}">＋ 添加强度档位</button></div>
    <p class="sc-small sc-muted">共用本成员的模型、技能和角色记忆。统筹时按子任务难度选择思考强度。</p>
    ${(agent.variants || []).map(variant => variantView(agent, variant, catalog)).join('')}` : ''}
  </section>`}).join('')
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
  const sessionId = options.sessionId || ''
  return `<div class="${initial ? 'sc-binding-page' : 'sc-drawer'}"><section class="sc-drawer-content" aria-label="场景列表">
    <div class="sc-section-head"><h2>${initial ? '为当前需求选择场景' : '场景与会话'}</h2>${initial ? '' : '<button type="button" data-action="close-drawer">关闭</button>'}</div>
    <p class="sc-small sc-muted">场景保存长期项目知识。每次新需求可使用新会话，并绑定已有场景。</p>
    ${sessionId ? `<p>当前会话 · ${escapeHtml(options.sessionTitle || '当前需求')}</p>` : ''}
    <button type="button" class="sc-primary" data-action="new-scene">${sessionId ? '以当前会话创建新场景' : '创建新场景'}</button>
    ${(state.scenes || []).map(scene => `<article class="sc-scene-choice"><div><strong>${escapeHtml(scene.title)}</strong><p class="sc-small sc-muted">${escapeHtml(scene.cwd)} · ${scene.sessions?.length || 0} 个关联会话</p></div><button type="button" data-action="${sessionId ? 'bind-scene' : 'open-scene'}" data-id="${scene.id}">${sessionId ? '绑定当前会话' : '打开场景'}</button></article>`).join('') || '<p class="sc-small sc-muted">创建第一个场景后，后续会话就可以选择绑定它。</p>'}
    ${!initial && state.scene ? '<button type="button" data-action="new-demand">＋ 在当前场景新建需求会话</button>' : ''}
    ${!initial && state.scene?.sessions?.length ? `<h3>当前场景的关联会话</h3>${state.scene.sessions.map(session => `<button type="button" data-action="open-demand" data-session="${escapeHtml(session.id)}" data-title="${escapeHtml(session.title || '')}">${escapeHtml(session.title || session.id)}</button>`).join('')}` : ''}
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
