const modelKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')

const capabilityRules = {
  coding: /\b(?:cod(?:e|ing)|develop\w*|implement\w*|architect\w*)\b|开发|实现|搭建|编程|维护|架构/,
  research: /\b(?:research\w*|investigat\w*|analys\w*)\b|调研|研究|核验|数据分析|资讯/,
  review: /\b(?:review\w*|audit\w*)\b|审查|评审|复核|审核/,
  qa: /\b(?:qa|test\w*|validat\w*)\b|测试|验收|质量/,
  vision: /\b(?:vision|images?|visual|screenshots?)\b|识图|截图|视觉|页面核对/,
  device: /\b(?:device|browser|mobile)\b|真机|手机|电脑操作|浏览器操作/,
  writing: /\b(?:writ\w*|copywrit\w*|editor\w*)\b|写作|文案|撰写|编辑/,
  trading: /\b(?:trad\w*|broker\w*)\b|交易|账务|订单/,
  owner: /\b(?:owner|coordinat\w*)\b|统筹|全局|进度控制/,
}

const supportedEfforts = [
  ['none', 'minimal', 'low', 'off', 'nonthinking', 'disabled'],
  ['medium', 'normal', 'balanced'],
  ['high'],
  ['xhigh', 'max', 'maximum'],
  ['ultra'],
]

export const ROUTING_DEFAULTS = {
  ownerModel: 'gpt-6.2-sol',
  generalModel: 'gpt-6.2-sol',
  visionModel: 'gpt-6.1-terra',
  deepseekModel: '1017',
  deepseekProvider: '',
  defaultEffort: 'medium',
  visionAvailable: false,
}

export function normalizeRoutingPolicy(input) {
  const output = { ...ROUTING_DEFAULTS }
  for (const key of ['ownerModel', 'generalModel', 'visionModel', 'deepseekModel', 'deepseekProvider', 'defaultEffort']) {
    if (typeof input?.[key] === 'string') output[key] = input[key].trim().slice(0, 200)
  }
  output.visionAvailable = input?.visionAvailable === true
  return output
}

export function taskCapability(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (Object.hasOwn(capabilityRules, normalized)) return normalized
  return Object.keys(capabilityRules).find(capability => capabilityRules[capability].test(normalized)) || ''
}

export function matchMember(agents, request, ownerId) {
  const capability = taskCapability(request?.capability || request?.name)
  const wantedName = String(request?.name || '').trim().toLowerCase()
  const eligible = agents.filter(agent => agent.id !== ownerId
    && (request?.access !== 'write' || agent.permission !== 'read-only'))
  const identified = eligible.find(agent => agent.id === request?.id || (wantedName && agent.name.toLowerCase() === wantedName))
  if (identified || !capability) return identified
  return eligible.find(agent => agent.capability === capability)
    || eligible.find(agent => capabilityRules[capability].test(agent.name))
    || eligible.find(agent => !agent.capability && capabilityRules[capability].test(agent.role))
}

function configuredModel(models, requested) {
  if (!requested) return undefined
  const key = modelKey(requested)
  return models.find(model => model.id === requested)
    || models.find(model => [model.id, model.label, model.displayName].some(value => modelKey(value) === key))
}

function fallbackCodexModel(models) {
  for (const generation of ['6.2', '6.1', '6.0', '5.6']) {
    const sameGeneration = models.filter(model => {
      const version = model.id.match(/^gpt-(\d+(?:\.\d+)?)(?:-|$)/i)?.[1]
      return (version === '6' ? '6.0' : version) === generation
    })
    const candidate = sameGeneration.find(model => model.isDefault) || sameGeneration[0]
    if (candidate) return candidate
  }
  return models.find(model => model.isDefault) || models[0]
}

const acceptsImage = model => !model?.inputModalities?.length || model.inputModalities.includes('image')

function effortLevel(effort) {
  return supportedEfforts.findIndex(group => group.includes(modelKey(effort)))
}

function chooseEffort(model, requested) {
  const efforts = model?.efforts || []
  if (efforts.includes(requested)) return requested
  if (!efforts.length) return ''
  const level = effortLevel(requested)
  if (level < 0) return model.defaultEffort && efforts.includes(model.defaultEffort) ? model.defaultEffort : ''
  const ranked = efforts.map(value => ({ value, level: effortLevel(value) })).filter(item => item.level >= 0)
    .sort((first, second) => Math.abs(first.level - level) - Math.abs(second.level - level) || second.level - first.level)
  return ranked[0]?.value || (efforts.includes(model.defaultEffort) ? model.defaultEffort : '')
}

export function routeMember(agent, task, catalog, input) {
  if (agent.engine === 'agent') return { ...agent, routingReason: '沿用固定的 Agent 接入配置' }
  const policy = normalizeRoutingPolicy(input)
  const capability = taskCapability(task.capability || agent.capability || task.title)
  const vision = capability === 'vision' || capability === 'device'
  const owner = capability === 'owner'
  const needsImage = agent.engine === 'codex' && (vision || task.requiresImage === true)
  if (agent.routeLocked || task.profileSelected) return { ...agent, routingReason: '沿用已固定的成员或用户指定档位' }
  if (capability === 'device' && !policy.visionAvailable && !agent.skills?.some(skill => /手机|computer-use|phone|browser/i.test(skill))) {
    throw new Error('该任务需要已接入的手机或浏览器操作工具，请在路由设置中确认工具可用，或选择配置了相关技能的成员')
  }
  if (task.variantId) {
    if (needsImage && !acceptsImage(configuredModel(catalog.codex || [], agent.model))) {
      throw new Error('扩展档位沿用的模型不支持图片输入，请选择支持图片的成员')
    }
    return { ...agent, routingReason: '沿用原成员模型与扩展强度档位' }
  }
  const availableModels = agent.engine === 'dsh' ? (catalog.dsh || []).filter(model => !agent.provider || model.provider === agent.provider)
    : catalog.codex || []
  if (!availableModels.length) return { ...agent, routingReason: '运行时未返回这个引擎的模型目录，沿用成员配置' }
  const models = needsImage ? availableModels.filter(acceptsImage) : availableModels
  if (!models.length) throw new Error('可用 Codex 模型均不支持图片输入，请配置支持图片的模型')
  const preferred = agent.engine === 'dsh' ? (policy.deepseekProvider && agent.provider && policy.deepseekProvider !== agent.provider
    ? undefined
    : configuredModel(models.filter(model => !policy.deepseekProvider || model.provider === policy.deepseekProvider), policy.deepseekModel)
      || models.find(model => /deepseek/i.test(`${model.id} ${model.label} ${model.provider}`) && policy.deepseekModel === '1017'
        && /1017/.test(`${model.id} ${model.label}`)))
    : configuredModel(models, owner ? policy.ownerModel : vision ? policy.visionModel : policy.generalModel)
  const configured = configuredModel(models, agent.model)
  const available = preferred || configured || (agent.engine === 'codex' ? fallbackCodexModel(models) : undefined)
  if (!available) return { ...agent, routingReason: '未找到配置的模型，沿用成员的接入设置' }
  const requestedEffort = task.difficulty === 'simple' ? 'low'
    : task.difficulty === 'hard' ? (task.effort === 'ultra' ? 'ultra' : 'high') : policy.defaultEffort
  const effort = chooseEffort(available, requestedEffort)
  const reason = preferred ? `按${vision ? '视觉' : owner ? '统筹' : '常规'}模型偏好和任务难度选择`
    : configured ? '首选模型不可用，沿用可用的成员模型' : '首选和成员模型不可用，按目录中的候选模型顺序回退'
  return { ...agent, model: available.id, provider: available.provider || agent.provider, effort,
    routingReason: `${reason}${effort && effort !== requestedEffort ? '；已匹配该模型支持的档位' : ''}` }
}
