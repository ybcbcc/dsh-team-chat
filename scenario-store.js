import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_AGENTS = [
  { id: 'codex', name: 'Codex', engine: 'codex', role: '方案与实现', model: '', provider: '', effort: '', skills: [] },
  { id: 'deepseek', name: 'DeepSeek', engine: 'dsh', role: '审查与证据核查', model: '', provider: '', effort: '', skills: [] },
]

export const canonicalSessionId = value => value ? `session-${String(value).replace(/^session-/, '')}` : ''

const now = () => new Date().toISOString()
const decode = row => row ? JSON.parse(row.data) : undefined

export class ScenarioStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true })
    this.db = new DatabaseSync(join(directory, 'scenarios.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS scenarios (
        id TEXT PRIMARY KEY, session_id TEXT UNIQUE, updated_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL REFERENCES scenarios(id),
        request_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(scenario_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        scenario_id TEXT NOT NULL REFERENCES scenarios(id), run_id TEXT, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, scenario_id TEXT NOT NULL REFERENCES scenarios(id),
        run_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scenario_id TEXT REFERENCES scenarios(id),
        scope TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_revisions (
        id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id, revision)
      );
      CREATE TABLE IF NOT EXISTS contexts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        scenario_id TEXT NOT NULL REFERENCES scenarios(id), run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scenario_aliases (id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL REFERENCES scenarios(id));
      CREATE TABLE IF NOT EXISTS scenario_sessions (
        session_id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL REFERENCES scenarios(id),
        title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_requests (
        id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL REFERENCES scenarios(id), data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_scene ON messages(scenario_id, seq);
      CREATE INDEX IF NOT EXISTS events_scene ON events(scenario_id, seq);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
      CREATE INDEX IF NOT EXISTS contexts_scene ON contexts(scenario_id, seq);
      CREATE INDEX IF NOT EXISTS runs_scene ON runs(scenario_id, created_at);
      CREATE INDEX IF NOT EXISTS memories_scene ON memories(scenario_id, scope);
    `)
  }

  transaction(operation) {
    if (this.transactionDepth) return operation()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth = 1
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth = 0
    }
  }

  scenario(id) {
    const scene = decode(this.db.prepare(`SELECT data FROM scenarios WHERE id = ? OR id =
      (SELECT scenario_id FROM scenario_aliases WHERE id = ?)`).get(id, id))
    if (!scene) return undefined
    return { ...scene, customSkills: scene.customSkills || [],
      agents: scene.agents.map(agent => ({ ...agent, roleId: agent.roleId || agent.id, variants: agent.variants || [] })),
      sessions: this.db.prepare('SELECT session_id AS id, title FROM scenario_sessions WHERE scenario_id = ? ORDER BY created_at').all(scene.id) }
  }

  sessionScene(sessionId) {
    const binding = this.db.prepare('SELECT scenario_id FROM scenario_sessions WHERE session_id = ?').get(canonicalSessionId(sessionId))
    return binding ? this.scenario(binding.scenario_id) : undefined
  }

  bindSession(scenarioId, sessionId, title = '') {
    return this.transaction(() => {
      sessionId = canonicalSessionId(sessionId)
      const target = this.scenario(scenarioId)
      if (!sessionId || !target) throw new Error('请选择场景和会话')
      const previous = this.sessionScene(sessionId)
      const binding = previous?.sessions.find(session => session.id === sessionId)
      if (previous?.id === target.id && (!title || binding.title === title)) return target
      if (previous && previous.id !== target.id) this.assertNoActiveRun(previous.id, sessionId)
      this.db.prepare(`INSERT INTO scenario_sessions VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET scenario_id = excluded.scenario_id,
        title = CASE WHEN excluded.title = '' THEN scenario_sessions.title ELSE excluded.title END`)
        .run(sessionId, target.id, title, now())
      if (previous && previous.id !== target.id) {
        const remaining = this.scenario(previous.id)
        this.saveScenario({ ...remaining, dshSessionId: remaining.dshSessionId === sessionId
          ? remaining.sessions.at(-1)?.id || '' : remaining.dshSessionId })
      }
      return this.saveScenario({ ...this.scenario(target.id), dshSessionId: target.dshSessionId || sessionId })
    })
  }

  assertNoActiveRun(scenarioId, sessionId = '') {
    const active = this.interruptedRuns().some(run => run.scenarioId === scenarioId
      && (!sessionId || canonicalSessionId(run.sessionId || run.dshSessionId || run.scene?.dshSessionId) === sessionId))
    if (active) {
      const error = new Error('相关会话还有任务正在执行，请先停止任务再管理绑定或删除场景')
      error.status = 409
      throw error
    }
  }

  unbindSession(scenarioId, sessionId, expectedRevision) {
    return this.transaction(() => {
      const scene = this.scenario(scenarioId)
      sessionId = canonicalSessionId(sessionId)
      if (!scene) throw new Error('场景不存在')
      if (!scene.sessions.some(session => session.id === sessionId)) return scene
      if (scene.revision !== expectedRevision) throw conflict()
      this.assertNoActiveRun(scene.id, sessionId)
      this.db.prepare('DELETE FROM scenario_sessions WHERE scenario_id = ? AND session_id = ?').run(scene.id, sessionId)
      const remaining = this.scenario(scene.id)
      return this.saveScenario({ ...remaining, dshSessionId: remaining.dshSessionId === sessionId
        ? remaining.sessions.at(-1)?.id || '' : remaining.dshSessionId })
    })
  }

  deleteScenario(scenarioId, expectedRevision) {
    return this.transaction(() => {
      const scene = this.scenario(scenarioId)
      if (!scene) throw new Error('场景不存在')
      if (scene.revision !== expectedRevision) throw conflict()
      this.assertNoActiveRun(scene.id)
      this.db.prepare('DELETE FROM memory_revisions WHERE id IN (SELECT id FROM memories WHERE scenario_id = ?)').run(scene.id)
      for (const table of ['contexts', 'messages', 'events', 'runs', 'memories', 'session_requests', 'scenario_aliases', 'scenario_sessions']) {
        this.db.prepare(`DELETE FROM ${table} WHERE scenario_id = ?`).run(scene.id)
      }
      this.db.prepare('DELETE FROM scenarios WHERE id = ?').run(scene.id)
      return scene
    })
  }

  sessionRequest(id) {
    return decode(this.db.prepare('SELECT data FROM session_requests WHERE id = ?').get(id))
  }

  saveSessionRequest(request) {
    this.db.prepare('INSERT INTO session_requests VALUES (?, ?, ?)').run(request.id, request.scenarioId, JSON.stringify(request))
  }

  resolve(sessionId, cwd) {
    sessionId = canonicalSessionId(sessionId)
    const existing = sessionId ? this.sessionScene(sessionId)
      || decode(this.db.prepare('SELECT data FROM scenarios WHERE session_id = ?').get(sessionId)) : undefined
    if (existing) return existing
    const scene = {
      id: randomUUID(), dshSessionId: sessionId || '', title: '新场景', brief: '', cwd,
      mode: 'confidence', ownerId: '', summarizerId: 'codex', agents: structuredClone(DEFAULT_AGENTS),
      reviewRounds: 2, revision: 1, createdAt: now(), updatedAt: now(),
    }
    this.db.prepare('INSERT INTO scenarios VALUES (?, ?, ?, ?)').run(scene.id, sessionId || null, scene.updatedAt, JSON.stringify(scene))
    if (sessionId) this.bindSession(scene.id, sessionId)
    return this.scenario(scene.id)
  }

  saveScenario(scene, expectedRevision) {
    return this.transaction(() => {
      const current = this.scenario(scene.id)
      if (!current) throw new Error('场景不存在')
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw conflict()
      const next = { ...scene, dshSessionId: canonicalSessionId(scene.dshSessionId), revision: current.revision + 1, updatedAt: now() }
      this.db.prepare('UPDATE scenarios SET session_id = ?, updated_at = ?, data = ? WHERE id = ?')
        .run(next.dshSessionId || null, next.updatedAt, JSON.stringify(next), next.id)
      return next
    })
  }

  scenes() {
    return this.db.prepare('SELECT data FROM scenarios ORDER BY updated_at DESC').all().map(decode)
      .map(({ id, title, brief, cwd, dshSessionId, updatedAt, revision }) => ({ id, title, brief, cwd, dshSessionId, updatedAt, revision,
        sessions: this.scenario(id).sessions }))
  }

  saveRun(run) {
    this.db.prepare(`INSERT INTO runs VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
      .run(run.id, run.scenarioId, run.requestId, run.createdAt, JSON.stringify(run))
  }

  run(id) {
    return decode(this.db.prepare('SELECT data FROM runs WHERE id = ?').get(id))
  }

  request(scenarioId, requestId) {
    return decode(this.db.prepare('SELECT data FROM runs WHERE scenario_id = ? AND request_id = ?').get(scenarioId, requestId))
  }

  runs(scenarioId, limit = 30, sessionId = '') {
    return this.db.prepare(`SELECT data FROM runs WHERE scenario_id = ?
      AND (? = '' OR json_extract(data, '$.sessionId') = ?) ORDER BY created_at DESC LIMIT ?`)
      .all(scenarioId, sessionId, sessionId, limit).map(decode)
  }

  interruptedRuns() {
    const active = new Set(['queued', 'independent', 'reviewing', 'resolving', 'synthesizing', 'planning', 'working', 'checking', 'waiting_user', 'cancelling'])
    return this.db.prepare('SELECT data FROM runs').all().map(decode).filter(run => active.has(run.state))
  }

  addMessage(message) {
    const entry = { id: randomUUID(), at: now(), ...message }
    const result = this.db.prepare('INSERT INTO messages(id, scenario_id, run_id, data) VALUES (?, ?, ?, ?)')
      .run(entry.id, entry.scenarioId, entry.runId || null, JSON.stringify(entry))
    return { ...entry, seq: Number(result.lastInsertRowid) }
  }

  messages(scenarioId, before, limit = 80, sessionId = '') {
    return this.db.prepare(`SELECT seq, data FROM messages WHERE scenario_id = ? AND seq < ?
      AND (? = '' OR json_extract(data, '$.sessionId') = ?) ORDER BY seq DESC LIMIT ?`)
      .all(scenarioId, before || Number.MAX_SAFE_INTEGER, sessionId, sessionId, limit).reverse().map(row => ({ ...decode(row), seq: row.seq }))
  }

  runMessages(runId) {
    return this.db.prepare('SELECT seq, data FROM messages WHERE run_id = ? ORDER BY seq')
      .all(runId).map(row => ({ ...decode(row), seq: row.seq }))
  }

  event(scenarioId, runId, type, payload = {}) {
    const entry = { eventId: randomUUID(), schemaVersion: 1, scenarioId, runId, type, at: now(), ...payload }
    const result = this.db.prepare('INSERT INTO events(scenario_id, run_id, type, data) VALUES (?, ?, ?, ?)')
      .run(scenarioId, runId || null, type, JSON.stringify(entry))
    return { ...entry, sequence: Number(result.lastInsertRowid) }
  }

  events(scenarioId, after = 0, limit = 1000) {
    return this.db.prepare('SELECT seq, data FROM events WHERE scenario_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(scenarioId, after, limit).map(row => ({ ...decode(row), sequence: row.seq }))
  }

  lastSequence(scenarioId) {
    return this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE scenario_id = ?').get(scenarioId).seq
  }

  runEvents(runId) {
    return this.db.prepare("SELECT seq, data FROM events WHERE run_id = ? AND type != 'agent.delta' ORDER BY seq DESC LIMIT 200")
      .all(runId).reverse().map(row => ({ ...decode(row), sequence: row.seq }))
  }

  addContext(snapshot) {
    const entry = { ...snapshot, id: snapshot.id || randomUUID(), at: snapshot.at || now() }
    this.db.prepare('INSERT INTO contexts(id, scenario_id, run_id, agent_id, data) VALUES (?, ?, ?, ?, ?)')
      .run(entry.id, entry.scenarioId, entry.runId, entry.agentId, JSON.stringify(entry))
    return entry
  }

  updateContext(id, patch) {
    const entry = decode(this.db.prepare('SELECT data FROM contexts WHERE id = ?').get(id))
    if (!entry) return
    this.db.prepare('UPDATE contexts SET data = ? WHERE id = ?').run(JSON.stringify({ ...entry, ...patch }), id)
  }

  contexts(scenarioId, agentId, before, limit = 30) {
    return this.db.prepare(`SELECT seq, data FROM contexts WHERE scenario_id = ? AND (? = '' OR agent_id = ?)
      AND seq < ? ORDER BY seq DESC LIMIT ?`)
      .all(scenarioId, agentId || '', agentId || '', before || Number.MAX_SAFE_INTEGER, limit)
      .map(row => {
        const context = decode(row)
        const { response, ...summary } = context
        return { ...summary, seq: row.seq, items: context.items.map(({ content, ...item }) => item) }
      })
  }

  contextEvents(scenarioId, operationId = '') {
    return this.db.prepare(`SELECT seq, data FROM events WHERE scenario_id = ?
      AND type IN ('context.created', 'context.changed', 'thread.started', 'handoff.sent', 'usage.updated', 'tool.started', 'tool.completed')
      AND (? = '' OR json_extract(data, '$.operationId') = ?) ORDER BY seq DESC LIMIT 4000`)
      .all(scenarioId, operationId, operationId).reverse().map(row => ({ ...decode(row), sequence: row.seq }))
  }

  context(id, scenarioId) {
    return decode(this.db.prepare('SELECT data FROM contexts WHERE id = ? AND scenario_id = ?').get(id, scenarioId))
  }

  memories(scenarioId, scope = 'scenario') {
    return this.db.prepare(`SELECT data FROM memories WHERE scope = ? AND (? = 'legacy' OR scenario_id = ?)
      ORDER BY updated_at DESC`).all(scope, scope, scenarioId).map(decode)
  }

  memory(id) {
    return decode(this.db.prepare('SELECT data FROM memories WHERE id = ?').get(id))
  }

  saveMemory(input, expectedRevision) {
    return this.transaction(() => {
      const existing = input.id ? this.memory(input.id) : undefined
      if (input.id && !existing) throw new Error('记忆不存在')
      if (existing && expectedRevision !== undefined && existing.revision !== expectedRevision) throw conflict()
      const entry = {
        scope: 'scenario', audience: 'scene', roleId: '', kind: 'note', status: 'candidate', enabled: true, pinned: false, sources: [],
        createdAt: now(), ...existing, ...input, id: existing?.id || randomUUID(),
        revision: (existing?.revision || 0) + 1, updatedAt: now(),
      }
      this.db.prepare(`INSERT INTO memories VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data`)
        .run(entry.id, entry.scenarioId || null, entry.scope, entry.updatedAt, JSON.stringify(entry))
      this.db.prepare('INSERT INTO memory_revisions VALUES (?, ?, ?)').run(entry.id, entry.revision, JSON.stringify(entry))
      return entry
    })
  }

  memoryRevisions(id) {
    return this.db.prepare('SELECT data FROM memory_revisions WHERE id = ? ORDER BY revision DESC').all(id).map(decode)
  }

  migrate(home) {
    if (this.db.prepare('SELECT id FROM migrations WHERE id = ?').get('legacy-v1')) return
    const history = join(home, 'codex-chat', 'conversations.json')
    const files = [history, join(home, 'memory', 'memories.json'), join(home, 'memory', 'learnings.json')]
    const backup = join(home, 'codex-chat', 'migration-backup-v1')
    mkdirSync(backup, { recursive: true })
    for (const file of files) {
      if (existsSync(file)) {
        const target = join(backup, file === history ? 'conversations.json' : file.split(/[\\/]/).pop())
        if (!existsSync(target)) copyFileSync(file, target)
      }
    }
    this.transaction(() => {
      const conversations = readLegacy(history)?.conversations || []
      for (const conversation of conversations) {
        if (!conversation || typeof conversation.id !== 'string') continue
        const scene = this.resolve(conversation.dshSessionId || '', conversation.options?.cwd || '')
        const next = { ...scene, title: conversation.title || scene.title, agents: structuredClone(DEFAULT_AGENTS) }
        if (conversation.options?.model) next.agents[0].model = conversation.options.model
        if (conversation.options?.effort) next.agents[0].effort = conversation.options.effort
        if (typeof conversation.options?.fast === 'boolean') next.agents[0].fast = conversation.options.fast
        this.db.prepare('UPDATE scenarios SET data = ? WHERE id = ?').run(JSON.stringify(next), scene.id)
        for (const [index, message] of (conversation.messages || []).entries()) {
          if (typeof message?.text !== 'string') continue
          this.addMessage({ ...message, id: `legacy-${conversation.id}-${index}`, scenarioId: scene.id, role: message.role === 'user' ? 'user' : 'assistant', importedFrom: conversation.id })
        }
      }
      for (const file of files.slice(1)) {
        for (const entry of readLegacy(file)?.memories || []) {
          if (!entry || typeof entry.title !== 'string') continue
          const memory = { ...entry, id: `legacy-${entry.id}`, scope: 'legacy', scenarioId: null, status: 'candidate', enabled: false, revision: 1,
            content: entry.detail || '', sources: [{ type: 'legacy', path: file, originalId: entry.id }], updatedAt: entry.updatedAt || now() }
          this.db.prepare('INSERT OR IGNORE INTO memories VALUES (?, NULL, ?, ?, ?)').run(memory.id, 'legacy', memory.updatedAt, JSON.stringify(memory))
          this.db.prepare('INSERT OR IGNORE INTO memory_revisions VALUES (?, 1, ?)').run(memory.id, JSON.stringify(memory))
        }
      }
      this.db.prepare('INSERT INTO migrations VALUES (?, ?)').run('legacy-v1', now())
    })
  }

  normalizeBindings() {
    if (this.db.prepare('SELECT id FROM migrations WHERE id = ?').get('session-bindings-v2')) return
    this.transaction(() => {
      const groups = new Map()
      for (const scene of this.db.prepare('SELECT data FROM scenarios').all().map(decode)) {
        if (!scene.dshSessionId) continue
        const key = canonicalSessionId(scene.dshSessionId)
        const group = groups.get(key) || []
        group.push(scene)
        groups.set(key, group)
      }
      for (const [sessionId, scenes] of groups) {
        const target = scenes.find(scene => scene.dshSessionId === sessionId) || scenes[0]
        for (const scene of scenes) this.db.prepare('UPDATE scenarios SET session_id = NULL WHERE id = ?').run(scene.id)
        for (const scene of scenes.filter(scene => scene.id !== target.id)) {
          for (const table of ['messages', 'events', 'memories', 'contexts']) {
            this.db.prepare(`UPDATE ${table} SET scenario_id = ?, data = json_set(data, '$.scenarioId', ?) WHERE scenario_id = ?`)
              .run(target.id, target.id, scene.id)
          }
          for (const run of this.runs(scene.id, 100000)) {
            if (this.request(target.id, run.requestId)) run.requestId = `${scene.id}-${run.requestId}`
            run.scenarioId = target.id
            run.scene.id = target.id
            this.db.prepare('UPDATE runs SET scenario_id = ?, request_id = ?, data = ? WHERE id = ?')
              .run(target.id, run.requestId, JSON.stringify(run), run.id)
          }
          this.db.prepare('UPDATE scenario_aliases SET scenario_id = ? WHERE scenario_id = ?').run(target.id, scene.id)
          this.db.prepare('INSERT OR REPLACE INTO scenario_aliases VALUES (?, ?)').run(scene.id, target.id)
          this.db.prepare('DELETE FROM scenarios WHERE id = ?').run(scene.id)
        }
        target.dshSessionId = sessionId
        this.db.prepare('UPDATE scenarios SET session_id = ?, data = ? WHERE id = ?').run(sessionId, JSON.stringify(target), target.id)
      }
      this.db.prepare('INSERT INTO migrations VALUES (?, ?)').run('session-bindings-v2', now())
    })
  }

  close() { this.db.close() }

  migrateScenarioSessions() {
    if (this.db.prepare('SELECT id FROM migrations WHERE id = ?').get('scenario-sessions-v3')) return
    this.transaction(() => {
      for (const scene of this.db.prepare('SELECT data FROM scenarios').all().map(decode)) {
        if (scene.dshSessionId) this.bindSession(scene.id, scene.dshSessionId)
        const sessionId = canonicalSessionId(scene.dshSessionId) || `local-${scene.id}`
        this.db.prepare(`UPDATE runs SET data = json_set(data, '$.sessionId', ?)
          WHERE scenario_id = ? AND json_extract(data, '$.sessionId') IS NULL`).run(sessionId, scene.id)
        this.db.prepare(`UPDATE messages SET data = json_set(data, '$.sessionId', COALESCE(
          (SELECT json_extract(runs.data, '$.sessionId') FROM runs WHERE runs.id = messages.run_id), ?))
          WHERE scenario_id = ? AND json_extract(data, '$.sessionId') IS NULL`).run(sessionId, scene.id)
      }
      this.db.prepare('INSERT INTO migrations VALUES (?, ?)').run('scenario-sessions-v3', now())
    })
  }
}

function readLegacy(file) {
  if (!existsSync(file)) return undefined
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { throw new Error(`旧数据读取失败，已保留原始文件 ${file}。${error.message}`) }
}

export function conflict() {
  const error = new Error('资料已在另一处更新，请刷新后再保存')
  error.status = 409
  return error
}

export function estimateTokens(text) {
  const content = String(text || '')
  const cjk = (content.match(/[\u3400-\u9fff]/g) || []).length
  return Math.ceil(cjk + (content.length - cjk) / 4)
}

export function relevantMemories(entries, input, budget = 2400, roleId = '') {
  const terms = new Set((input.toLowerCase().match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2}/g) || []))
  const eligible = entries.filter(entry => entry.enabled && ['confirmed', 'candidate', 'conflict'].includes(entry.status)
    && (entry.audience !== 'role' || entry.roleId === roleId))
  const ranked = eligible.map(entry => {
    const text = `${entry.title} ${entry.content}`.toLowerCase()
    const matches = [...terms].filter(term => text.includes(term)).length
    return { entry, score: matches * 3 + (entry.pinned ? 100 : 0) + (['preference', 'decision', 'constraint'].includes(entry.kind) ? 5 : 0) }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score)
  const selected = []
  let tokens = 0
  for (const { entry, score } of ranked) {
    const cost = estimateTokens(entry.content) + estimateTokens(entry.title)
    let content = entry.content
    let reason = entry.pinned ? '用户固定' : score >= 5 && ['preference', 'decision', 'constraint'].includes(entry.kind) ? '场景约束与偏好' : '与本轮任务相关'
    if (tokens + cost > budget) {
      const remaining = budget - tokens - estimateTokens(entry.title) - 30
      if (remaining < 100 || (!entry.pinned && !['preference', 'decision', 'constraint'].includes(entry.kind))) continue
      content = content.slice(0, remaining)
      reason += '，内容按本轮预算截取，完整记录可在记忆页查看'
    }
    selected.push({ ...entry, content, reason })
    tokens += estimateTokens(content) + estimateTokens(entry.title)
  }
  return selected
}
