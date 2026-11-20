import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RunCoordinator } from '../coordinator.js'
import { ScenarioStore } from '../scenario-store.js'

function fixture(context, decide, publish = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-coordinator-'))
  const store = new ScenarioStore(directory)
  const initial = store.resolve('', directory)
  const scene = store.saveScenario({ ...initial, mode: 'orchestration', teamStrategy: 'manual', ownerId: 'owner',
    agents: ['owner', 'worker', 'replacement', 'qa'].map(id => ({ id, name: id, engine: 'codex', role: id })) }, initial.revision)
  const coordinator = new RunCoordinator({
    store, publish, loadSkills: async () => [], closeAgents: async () => {},
    runAgent: async request => ({ status: 'completed', answer: JSON.stringify(await decide(request)) }),
  })
  context.after(async () => {
    await coordinator.dispose()
    store.close()
    for (const file of ['scenarios.sqlite', 'scenarios.sqlite-shm', 'scenarios.sqlite-wal', 'product.txt']) {
      rmSync(join(directory, file), { force: true })
    }
    rmdirSync(directory)
  })
  return { coordinator, scene, store, artifact: join(directory, 'product.txt') }
}

function task(id, agentId, access = 'read', dependencies = []) {
  return { id, title: id, agentId, access, dependencies, instruction: `Execute ${id}`, acceptanceCriteria: 'Supply evidence' }
}

function incoming(run) {
  return run.workflow.inbox[run.workflow.cursor]
}

function delivery(summary) {
  return { summary, status: 'completed', evidence: ['Observed output'] }
}

function submit(coordinator, scene, requestId, resumeRunId) {
  const run = coordinator.start(scene, { text: 'Deliver the requested work.', requestId, resumeRunId })
  return { id: run.id, done: coordinator.active.get(run.id).promise }
}

test('Owner cannot accept or forward an unread report and duplicate transfers remain a single event', async context => {
  const { coordinator, scene, store } = fixture(context, ({ prompt }) => {
    assert.match(prompt, /Use the research result/)
    assert.match(prompt, /Include the user clarification/)
    return { summary: 'The attempt returned empty evidence', status: 'completed', evidence: [null, {}] }
  })
  const earlier = { id: 'earlier', kind: 'user', messageId: 'user-follow-up' }
  const queued = { id: 'report', kind: 'report', taskId: 'research', messageId: 'research-result' }
  const research = { ...task('research', 'worker'), state: 'completed', accepted: false, messageId: queued.messageId }
  const build = { ...task('build', 'replacement', 'write', ['research']), state: 'pending' }
  const run = { id: 'dispatch', scenarioId: scene.id, sessionId: 'local-session', requestId: 'dispatch',
    createdAt: new Date().toISOString(), scene, ownerId: 'owner', agents: scene.agents,
    state: 'working', text: 'Deliver the requested work.', attachments: [], tasks: [],
    workflow: { cursor: 0, inbox: [earlier, queued] }, delegations: [research, build] }
  store.saveRun(run)
  const forward = { taskId: 'build', toAgentId: 'replacement', messageId: queued.messageId, text: 'Use the research result' }
  const owner = scene.agents[0]
  const validate = (decision, entries) => coordinator.decisionActions(run, decision, entries, {})
  assert.throws(() => validate({ acceptTaskIds: ['research'] }, [earlier]), /成功回报/)
  const deferred = { retryTasks: [{ taskId: 'research' }], forward: [forward] }
  const early = validate(deferred, [earlier])
  assert.equal(early.transfers.length, 0)
  assert.equal(early.retries.length, 0)
  assert.deepEqual([...early.deferredTasks], ['research', 'build'])
  const userForward = { forward: [{ ...forward, messageId: earlier.messageId, text: 'Include the user clarification' }] }
  assert.equal(validate(userForward, []).transfers.length, 0)
  const combined = { ...deferred, forward: [forward, ...userForward.forward] }
  coordinator.applyDecision(run, owner, [earlier], combined, validate(combined, [earlier]))
  assert.equal(store.run(run.id).workflow.cursor, 1)
  assert.equal(store.run(run.id).delegations[0].state, 'completed')
  const decision = { acceptTaskIds: ['research'], forward: [forward, forward] }
  coordinator.applyDecision(run, owner, [queued], decision, validate(decision, [queued]))
  build.state = 'working'
  const repeated = { forward: [forward] }
  coordinator.applyDecision(run, owner, [], repeated, validate(repeated, []))
  const saved = store.run(run.id)
  assert.equal(saved.delegations[0].accepted, true)
  assert.equal(saved.workflow.cursor, 2)
  assert.deepEqual(saved.delegations[1].forwarded.map(item => item.messageId), [earlier.messageId, queued.messageId])
  assert.deepEqual(store.events(scene.id).filter(event => event.type === 'handoff.queued').map(event => event.messageId),
    [earlier.messageId, queued.messageId])
  const delivered = () => store.events(scene.id).filter(event => event.type === 'handoff.sent' && event.delivery === 'forward')
  assert.equal(delivered().length, 0)
  await coordinator.performDelegation(run, build, owner, new AbortController().signal)
  assert.deepEqual(delivered().map(event => event.messageId),
    [earlier.messageId, queued.messageId])
  assert.equal(build.state, 'failed')
})

test('Owner can forward a read report after retry replaces the current result', context => {
  const { coordinator, scene, store } = fixture(context, () => ({}))
  const sessionId = 'local-session'
  const runId = 'dispatch-retry'
  const priorRunId = 'dispatch-before-resume'
  const saveReport = (id, originRunId, session = sessionId) => {
    const message = store.addMessage({ runId: originRunId, scenarioId: scene.id, sessionId: session,
      agentId: 'worker', role: 'assistant', text: id })
    return { id, kind: 'report', taskId: 'research', agentId: 'worker', messageId: message.id, originRunId }
  }
  const earlier = saveReport('earlier-report', priorRunId)
  const unread = saveReport('unread-report', runId)
  const foreign = saveReport('foreign-report', priorRunId, 'another-session')
  const wrongOrigin = { ...saveReport('unmatched-origin', runId), originRunId: priorRunId }
  const research = { ...task('research', 'worker'), state: 'working', accepted: false, messageId: unread.messageId }
  const build = { ...task('build', 'replacement'), state: 'pending' }
  const run = { id: runId, scenarioId: scene.id, sessionId, requestId: runId, resumeRunId: priorRunId,
    createdAt: new Date().toISOString(), scene, ownerId: 'owner', agents: scene.agents, state: 'working',
    workflow: { cursor: 1, inbox: [earlier, unread, foreign, wrongOrigin] }, delegations: [research, build] }
  store.saveRun(run)
  const decisionFor = entry => ({ forward: [{ taskId: 'build', toAgentId: 'replacement', messageId: entry.messageId,
    text: 'Use the earlier evidence to continue' }] })
  const validate = (entry, reading = []) => coordinator.decisionActions(run, decisionFor(entry), reading, {})
  assert.equal(validate(unread).transfers.length, 0)
  assert.equal(validate(unread, [unread]).transfers[0].originRunId, runId)
  assert.throws(() => validate(foreign, [unread, foreign]), /已收到的成员回报/)
  assert.throws(() => validate(wrongOrigin, [unread, foreign, wrongOrigin]), /已收到的成员回报/)

  const actions = validate(earlier)
  assert.equal(actions.transfers[0].originRunId, priorRunId)
  coordinator.applyDecision(run, scene.agents[0], [], decisionFor(earlier), actions)
  assert.equal(validate(earlier).transfers.length, 0)
  assert.equal(store.run(runId).workflow.cursor, 1)
  assert.deepEqual(store.run(runId).delegations[1].forwarded.map(({ messageId, originRunId }) => ({ messageId, originRunId })),
    [{ messageId: earlier.messageId, originRunId: priorRunId }])
})

test('Repeated invalid Owner decisions preserve an independent write and resume consumes its saved report', { timeout: 5000 }, async context => {
  const started = Promise.withResolvers()
  const hold = Promise.withResolvers()
  const draining = Promise.withResolvers()
  let resumed = false
  let aborted = false
  let writes = 0
  const { coordinator, scene, store, artifact } = fixture(context, async ({ agent, run, signal }) => {
    const entry = incoming(run)
    if (agent.id === 'owner') {
      if (entry.kind === 'initial' || !resumed) return { tasks: [task('build', 'worker', 'write')] }
      if (entry.kind === 'report') return { acceptTaskIds: ['build'], summary: 'Recovered the saved result' }
      return { complete: true, answer: 'Saved output checked' }
    }
    assert.equal(writes++, 0)
    const onAbort = () => { aborted = true; hold.reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    started.resolve()
    try { await hold.promise }
    finally { signal.removeEventListener('abort', onAbort) }
    writeFileSync(artifact, 'completed before shutdown')
    return delivery('Write completed')
  }, event => {
    if (event.type === 'owner.decision' && event.text?.startsWith('调度暂缓')) draining.resolve(true)
  })
  const first = submit(coordinator, scene, 'first')
  await started.promise
  coordinator.followUp(first.id, { text: 'Continue the independent operation', requestId: 'follow-up' })
  const paused = await Promise.race([draining.promise, first.done.then(() => false)])
  hold.resolve()
  assert.equal(paused, true)
  await first.done
  const failed = store.run(first.id)
  assert.equal(aborted, false)
  assert.equal(failed.state, 'failed')
  assert.equal(readFileSync(artifact, 'utf8'), 'completed before shutdown')
  assert.equal(failed.workflow.inbox.findLast(entry => entry.kind === 'report').messageId, failed.delegations[0].messageId)
  assert.equal(store.message(failed.delegations[0].messageId).structured.status, 'completed')
  resumed = true
  const next = submit(coordinator, scene, 'resumed', first.id)
  await next.done
  assert.equal(store.run(next.id).state, 'completed')
  assert.equal(writes, 1)
})

test('An exhausted write can be reassigned under the same ID and verified read-only before dependent QA', { timeout: 5000 }, async context => {
  const calls = []
  let checkedCorrection = false
  const { coordinator, scene, store, artifact } = fixture(context, async ({ agent, run, stage, readOnly, prompt }) => {
    const entry = incoming(run)
    if (agent.id === 'owner') {
      if (entry.kind === 'initial') return { tasks: [task('build', 'worker', 'write'), task('verify', 'qa', 'read', ['build'])] }
      const [, serializedGraph] = prompt.match(/当前任务图 (.+?)。现有成员/) || []
      assert.deepEqual(JSON.parse(serializedGraph).map(({ id, access }) => ({ id, access })), [
        { id: 'build', access: 'write' },
        { id: 'verify', access: 'read' },
      ])
      if (entry.taskId === 'verify') return { acceptTaskIds: ['verify'], complete: true, answer: 'Verified' }
      const build = run.delegations.find(item => item.id === 'build')
      if (build.state === 'completed') return { acceptTaskIds: ['build'] }
      if (build.agentId === 'replacement') {
        assert.match(prompt, /"attemptsRemaining":2,"exhaustedAgentIds":\["worker"\]/)
        if (!prompt.includes('的成员 worker 已用尽 3 次尝试')) return { retryTasks: [{ taskId: 'build', agentId: 'worker' }] }
        assert.match(prompt, /仍有次数且满足权限的成员编号：replacement、qa/)
        checkedCorrection = true
        return { retryTasks: [{ taskId: 'build', instruction: 'Use the retained evidence' }] }
      }
      return { retryTasks: [{ taskId: 'build', ...(build.launches === 3 ? { agentId: 'replacement' } : {}), instruction: 'Check the retained output' }] }
    }
    calls.push({ agent: agent.id, stage, readOnly })
    if (agent.id === 'worker') {
      if (!readOnly) writeFileSync(artifact, 'retained output')
      throw new Error('Worker connection failed')
    }
    assert.equal(readOnly, true)
    assert.equal(readFileSync(artifact, 'utf8'), 'retained output')
    if (agent.id === 'replacement' && calls.filter(call => call.agent === 'replacement').length === 1) {
      return { summary: 'One more evidence check is needed', recovery: 'blocked' }
    }
    return { ...delivery('Verified the retained output'), ...(agent.id === 'replacement' ? { recovery: 'verified' } : {}) }
  })
  const execution = submit(coordinator, scene, 'reassign')
  await execution.done
  const saved = store.run(execution.id)
  assert.equal(saved.state, 'completed')
  assert.equal(checkedCorrection, true)
  const [build, qa] = saved.delegations
  assert.equal(build.id, 'build')
  assert.equal(build.agentId, 'replacement')
  assert.deepEqual(build.launchesByAgent, { worker: 3, replacement: 2 })
  assert.deepEqual(build.attempts.map(item => item.agentId), ['worker', 'worker', 'worker', 'replacement', 'replacement'])
  assert.deepEqual(qa.dependencies, ['build'])
  assert.equal(qa.accepted, true)
  assert.deepEqual(calls.slice(-2), [
    { agent: 'replacement', stage: '接续核验：build', readOnly: true },
    { agent: 'qa', stage: 'verify', readOnly: true },
  ])
  assert.equal(calls.filter(call => !call.readOnly).length, 1)
})

test('A scheduled task waits for its time without taking a worker slot or exhausting an attempt', { timeout: 5000 }, async context => {
  const start = Date.parse('2026-11-19T00:59:00Z')
  const notBefore = '2026-11-19T09:02:00+08:00'
  const secondStart = '2026-11-19T09:03:00+08:00'
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start })
  const waiting = Promise.withResolvers()
  const waitingAgain = Promise.withResolvers()
  const ownerBusy = Promise.withResolvers()
  const finishOwner = Promise.withResolvers()
  const calls = []
  const { coordinator, scene, store } = fixture(context, async ({ agent, run, stage }) => {
    const entry = incoming(run)
    if (agent.id !== 'owner') {
      calls.push({ stage, at: Date.now() })
      return delivery(stage)
    }
    if (entry.kind === 'initial') return { tasks: [
      { ...task('collect', 'worker'), notBefore }, task('prepare', 'worker'),
      { ...task('collect-again', 'worker', 'read', ['collect']), notBefore: secondStart },
    ] }
    if (entry.kind === 'user') {
      ownerBusy.resolve()
      await finishOwner.promise
      return { summary: 'Supplement received' }
    }
    if (entry.taskId !== 'collect-again') return { acceptTaskIds: [entry.taskId] }
    return { acceptTaskIds: ['collect-again'], complete: true, answer: 'Collected at the scheduled times' }
  }, event => {
    if (event.type !== 'run.updated') return
    if (event.run?.workflow.waitingUntil === '2026-11-19T01:02:00.000Z') waiting.resolve(event.run.id)
    if (event.run?.workflow.waitingUntil === '2026-11-19T01:03:00.000Z') waitingAgain.resolve()
  })
  const execution = submit(coordinator, scene, 'scheduled')
  const waitingRunId = await waiting.promise
  assert.equal(waitingRunId, execution.id)
  const queued = store.run(execution.id)
  assert.equal(queued.workflow.waitingUntil, '2026-11-19T01:02:00.000Z')
  assert.equal(queued.delegations[0].launches, undefined)
  assert.equal(queued.delegations[1].accepted, true)
  await new Promise(resolve => setImmediate(resolve))
  context.mock.timers.tick(179999)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [{ stage: 'prepare', at: start }])
  context.mock.timers.tick(1)
  await waitingAgain.promise
  coordinator.followUp(execution.id, { text: 'Continue collecting in the stated window', requestId: 'scheduled-follow-up' })
  await ownerBusy.promise
  try {
    context.mock.timers.tick(60000)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls[2], { stage: 'collect-again', at: Date.parse(secondStart) })
  } finally {
    finishOwner.resolve()
  }
  await execution.done
  const saved = store.run(execution.id)
  assert.equal(saved.state, 'completed')
  assert.equal(saved.workflow.waitingUntil, undefined)
  assert.equal(saved.delegations[0].launches, 1)
  assert.deepEqual(calls[1], { stage: 'collect', at: Date.parse(notBefore) })
})

test('Moving a workspace requires current evidence before old task dependencies unlock', { timeout: 5000 }, async context => {
  const moved = mkdtempSync(join(tmpdir(), 'dsh-resume-moved-'))
  const movedArtifact = join(moved, 'product.txt')
  context.after(() => {
    rmSync(movedArtifact, { force: true })
    rmdirSync(moved)
  })
  const calls = []
  let phase = 'original'
  const { coordinator, scene, store, artifact } = fixture(context, async ({ agent, run, stage, readOnly, prompt }) => {
    const entry = incoming(run)
    if (agent.id === 'owner') {
      if (entry.kind === 'initial') return { tasks: [
        task('research', 'worker'), task('build', 'replacement', 'write', ['research']), task('qa', 'qa', 'read', ['build']),
      ] }
      if (entry.kind !== 'report') return { summary: 'Check the current workspace', blocked: 'A required check remains' }
      const assigned = run.delegations.find(item => item.id === entry.taskId)
      if (assigned.state === 'completed') return assigned.id === 'qa'
        ? { acceptTaskIds: ['qa'], complete: true, answer: 'Current outputs verified' } : { acceptTaskIds: [assigned.id] }
      if (phase === 'original' && assigned.id === 'build') return { retryTasks: [{ taskId: 'build' }] }
      return { summary: 'Evidence remains incomplete' }
    }
    calls.push({ phase, stage, readOnly, cwd: run.scene.cwd })
    if (agent.id === 'worker') return delivery(phase === 'original' ? 'Original research' : 'Fresh research')
    if (agent.id === 'replacement') {
      if (!readOnly) {
        assert.equal(phase, 'original', 'A moved workspace cannot write before current read-only verification')
        writeFileSync(artifact, 'original artifact')
        return { summary: 'Write may have completed', status: 'incomplete' }
      }
      if (phase === 'moved') return { summary: 'Current output cannot be verified', recovery: 'blocked' }
      const path = join(run.scene.cwd, 'product.txt')
      return { ...delivery(readFileSync(path, 'utf8')), recovery: 'verified' }
    }
    if (phase === 'original') return { summary: 'Independent verification remains', status: 'incomplete' }
    assert.equal(phase, 'restored')
    assert.match(prompt, /current artifact/)
    assert.doesNotMatch(prompt, /original artifact/)
    return delivery('Checked current output')
  })
  const original = submit(coordinator, scene, 'original-workspace')
  await original.done
  const saved = store.run(original.id)
  assert.equal(saved.state, 'incomplete')
  assert.ok(saved.delegations.slice(0, 2).every(item => item.accepted))
  const previousReportId = saved.delegations[1].messageId
  const snapshot = { scene: { ...scene, cwd: scene.cwd + '/.' }, agents: scene.agents.slice(), workflow: { inbox: [] } }
  coordinator.restoreGraph(snapshot, saved)
  assert.equal(snapshot.delegations[1].messageId, previousReportId, 'Equivalent directory spelling still reuses accepted evidence')

  phase = 'moved'
  const currentScene = store.saveScenario({ ...scene, cwd: moved }, scene.revision)
  const attempted = submit(coordinator, currentScene, 'changed-workspace', original.id)
  await attempted.done
  const blocked = store.run(attempted.id)
  assert.deepEqual(blocked.delegations.map(item => item.id), ['research', 'build', 'qa'])
  assert.equal(blocked.state, 'incomplete')
  assert.equal(blocked.delegations[0].accepted, true)
  assert.equal(blocked.delegations[1].accepted, false)
  assert.equal(blocked.delegations[2].state, 'blocked')
  assert.deepEqual(calls.filter(call => call.phase === 'moved'), [
    { phase: 'moved', stage: 'research', readOnly: true, cwd: moved },
    { phase: 'moved', stage: '接续核验：build', readOnly: true, cwd: moved },
  ])
  assert.equal(store.message(previousReportId).text, 'original artifact', 'Earlier evidence remains traceable to its original run')

  phase = 'restored'
  writeFileSync(movedArtifact, 'current artifact')
  const resumed = submit(coordinator, currentScene, 'recheck-moved-workspace', attempted.id)
  await resumed.done
  assert.equal(store.run(resumed.id).state, 'completed')
  assert.deepEqual(calls.filter(call => call.phase === 'restored'), [
    { phase: 'restored', stage: '接续核验：build', readOnly: true, cwd: moved },
    { phase: 'restored', stage: 'qa', readOnly: true, cwd: moved },
  ])
})

test('Owner can replace dependencies only on a task that has never started', context => {
  const { coordinator, scene } = fixture(context, () => assert.fail('No provider call expected'))
  const source = { ...task('source', 'worker'), state: 'pending' }
  const alternate = { ...task('alternate', 'worker'), state: 'pending' }
  const build = { ...task('build', 'replacement', 'write', ['source']), state: 'pending' }
  const qa = { ...task('qa', 'qa', 'read', ['build']), state: 'pending' }
  const run = { ownerId: scene.ownerId, agents: scene.agents, delegations: [source, alternate, build, qa],
    workflow: { cursor: 0, inbox: [] } }
  const replace = { taskId: 'build', dependencies: ['alternate'], replaceDependencies: true, reason: 'Use the independent reference' }
  const validate = draft => coordinator.decisionActions(run, { retryTasks: [draft] }, [], {})
  assert.deepEqual(validate({ taskId: 'build', dependencies: ['alternate'] }).retries[0].dependencies, ['source', 'alternate'])
  assert.deepEqual(validate(replace).retries[0].dependencies, ['alternate'])
  assert.deepEqual(validate({ ...replace, dependencies: [] }).retries[0].dependencies, [])
  assert.throws(() => validate({ ...replace, reason: '' }), /调整原因/)
  assert.throws(() => validate({ ...replace, dependencies: undefined }), /依赖列表/)
  assert.throws(() => validate({ ...replace, dependencies: ['qa'] }), /依赖循环/)
  assert.throws(() => validate({ ...replace, dependencies: ['missing'] }), /不存在的任务/)
  build.launches = 1
  assert.throws(() => validate(replace), /尚未启动/)
  build.launches = undefined
  build.state = 'working'
  assert.throws(() => validate(replace), /尚未启动/)
  build.state = 'completed'
  build.accepted = true
  assert.throws(() => validate(replace), /尚未启动/)
  assert.deepEqual(build.dependencies, ['source'], 'Validating a decision leaves the running graph untouched')
})

test('Replacing a local prerequisite leaves a required failure in the global finish gate', { timeout: 5000 }, async context => {
  const calls = []
  const reason = 'The build can use a saved reference and live verification remains required for delivery'
  const { coordinator, scene, store } = fixture(context, ({ agent, run, stage, prompt }) => {
    const entry = incoming(run)
    if (agent.id === 'owner') {
      if (entry.kind === 'initial') return { tasks: [
        { ...task('source', 'worker'), required: true },
        task('build', 'replacement', 'write', ['source']),
        task('qa', 'qa', 'read', ['build']),
      ] }
      if (entry.taskId === 'source') {
        assert.match(prompt, /"canReplaceDependencies":true/)
        return { tasks: [task('reference', 'worker')], retryTasks: [
          { taskId: 'build', dependencies: ['reference'], replaceDependencies: true, reason },
        ] }
      }
      if (entry.kind === 'report') return { acceptTaskIds: [entry.taskId], complete: true, answer: 'The local draft is ready' }
      return { complete: true, answer: 'The local draft is ready' }
    }
    calls.push(stage)
    if (stage === 'source') return { summary: 'Live verification is unavailable', status: 'blocked' }
    if (stage === 'build') assert.match(prompt, /Current reference checked/)
    return delivery(stage === 'reference' ? 'Current reference checked' : 'Independent step finished')
  })
  const execution = submit(coordinator, scene, 'replace-blocked-dependency')
  await execution.done
  const saved = store.run(execution.id)
  assert.deepEqual(calls, ['source', 'reference', 'build', 'qa'])
  assert.equal(saved.state, 'incomplete')
  assert.deepEqual(saved.delegations.map(({ id, dependencies, state, required }) => ({ id, dependencies, state, required })), [
    { id: 'source', dependencies: [], state: 'failed', required: true },
    { id: 'build', dependencies: ['reference'], state: 'completed', required: true },
    { id: 'qa', dependencies: ['build'], state: 'completed', required: true },
    { id: 'reference', dependencies: [], state: 'completed', required: true },
  ])
  const changes = store.events(scene.id).filter(event => event.type === 'owner.decision' && event.previousDependencies)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].taskId, 'build')
  assert.deepEqual(changes[0].previousDependencies, ['source'])
  assert.deepEqual(changes[0].dependencies, ['reference'])
  assert.equal(changes[0].reason, reason)
})

test('Independent work fills a released write slot while Owner reads the prior report', { timeout: 5000 }, async context => {
  const firstStarted = Promise.withResolvers()
  const releaseFirst = Promise.withResolvers()
  const ownerReading = Promise.withResolvers()
  const releaseOwner = Promise.withResolvers()
  context.after(() => { releaseFirst.resolve(); releaseOwner.resolve() })
  const stages = []
  let writes = 0
  const { coordinator, scene, store } = fixture(context, async ({ agent, run, stage }) => {
    const entry = incoming(run)
    if (agent.id === 'owner') {
      if (entry.kind === 'initial') return { tasks: [
        task('first', 'worker', 'write'), task('independent', 'replacement', 'write'), task('dependent', 'qa', 'read', ['first']),
      ] }
      if (entry.taskId === 'first') {
        ownerReading.resolve()
        await releaseOwner.promise
      }
      return { acceptTaskIds: [entry.taskId], complete: true, answer: 'All results checked' }
    }
    stages.push(stage)
    if (stage === 'dependent') return delivery(stage)
    assert.equal(writes++, 0, 'Two write stages cannot hold the same workspace slot')
    try {
      if (stage === 'first') { firstStarted.resolve(); await releaseFirst.promise }
      return delivery(stage)
    } finally { writes-- }
  })
  const execution = submit(coordinator, scene, 'fill-released-write-slot')
  await firstStarted.promise
  assert.deepEqual(stages, ['first'])
  releaseFirst.resolve()
  try {
    await ownerReading.promise
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(stages, ['first', 'independent'],
      'The approved independent step starts while the unaccepted dependent remains blocked')
  } finally { releaseOwner.resolve() }
  await execution.done
  assert.deepEqual(stages, ['first', 'independent', 'dependent'])
  assert.equal(store.run(execution.id).state, 'completed')
})

test('An unresolved Owner clarification pauses filling a released slot', { timeout: 5000 }, async context => {
  const releaseFirst = Promise.withResolvers()
  const asking = Promise.withResolvers()
  context.after(() => { releaseFirst.resolve() })
  const stages = []
  const { coordinator, scene, store } = fixture(context, async ({ agent, run, stage, onQuestion }) => {
    const entry = incoming(run)
    if (agent.id === 'owner') {
      if (entry.kind === 'initial') return { tasks: [
        task('first', 'worker', 'write'), task('independent', 'replacement', 'write'), task('check', 'qa'),
      ] }
      if (entry.taskId === 'check') {
        await onQuestion({ questions: [{ id: 'scope', question: 'Which scope should I use?' }] })
      }
      return { acceptTaskIds: [entry.taskId], complete: true, answer: 'All results checked' }
    }
    stages.push(stage)
    if (stage === 'first') await releaseFirst.promise
    return delivery(stage)
  }, event => {
    if (event.type === 'user.question') asking.resolve(event.questionId)
  })
  const execution = submit(coordinator, scene, 'pause-released-slot-during-question')
  const questionId = await asking.promise
  releaseFirst.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(stages.includes('first') && stages.includes('check'))
  assert.equal(stages.includes('independent'), false)
  coordinator.answer(execution.id, questionId, { scope: { answers: ['Continue'] } })
  await execution.done
  assert.ok(stages.includes('independent'))
  assert.equal(store.run(execution.id).state, 'completed')
})

test('Resume replays the consumed legacy failure and waits for a different member', { timeout: 5000 }, async context => {
  let legacyReport
  const calls = []
  const { coordinator, scene, store, artifact } = fixture(context, async ({ agent, run, stage, readOnly }) => {
    const entry = incoming(run)
    if (agent.id === 'owner') {
      if (entry.kind === 'initial') return { tasks: [
        task('build', 'worker', 'write'), task('qa', 'qa', 'read', ['build']),
      ] }
      if (entry.kind !== 'report') return { summary: 'Continue checking', blocked: 'The original member is exhausted' }
      const assigned = run.delegations.find(item => item.id === entry.taskId)
      if (assigned.state === 'completed') return { acceptTaskIds: [entry.taskId], complete: true, answer: 'Current output verified' }
      if (!run.resumeRunId) return assigned.launches < 3 ? { retryTasks: [{ taskId: 'build' }] } : { summary: 'No more attempts' }
      assert.equal(assigned.state, 'failed')
      assert.equal(entry.id, legacyReport.id)
      assert.equal(entry.text, legacyReport.text)
      assert.equal(entry.originRunId, run.resumeRunId)
      assert.equal(assigned.launches, 3)
      return { retryTasks: [{ taskId: 'build', agentId: 'replacement', instruction: 'Verify the written artifact' }] }
    }
    calls.push({ agent: agent.id, stage, readOnly, resumed: Boolean(run.resumeRunId) })
    if (agent.id === 'worker') {
      assert.equal(run.resumeRunId, undefined, 'An exhausted member cannot run again after resume')
      if (!readOnly) {
        writeFileSync(artifact, 'retained artifact')
        throw new Error('The write receipt was not returned')
      }
      return { summary: 'The original member could not verify the artifact', recovery: 'blocked' }
    }
    assert.equal(readOnly, true)
    assert.equal(readFileSync(artifact, 'utf8'), 'retained artifact')
    return { ...delivery(stage), ...(agent.id === 'replacement' ? { recovery: 'verified' } : {}) }
  })
  const first = submit(coordinator, scene, 'initial-exhaustion')
  await first.done
  const exhausted = store.run(first.id)
  const [failedTask] = exhausted.delegations
  assert.equal(exhausted.state, 'incomplete')
  assert.equal(failedTask.state, 'failed')
  assert.equal(failedTask.launches, 3)
  delete failedTask.launchesByAgent
  legacyReport = exhausted.workflow.inbox.findLast(entry => entry.kind === 'report')
  assert.equal(exhausted.workflow.cursor, exhausted.workflow.inbox.length)
  assert.equal(legacyReport.text, failedTask.error)
  Object.assign(legacyReport, { launch: null, messageId: null, originRunId: null })
  store.saveRun(exhausted)
  const snapshot = { scene, agents: scene.agents.slice(), workflow: { inbox: [] } }
  coordinator.restoreGraph(snapshot, { ...exhausted, workflow: { ...exhausted.workflow, inbox: [] } })
  assert.equal(snapshot.workflow.inbox[0].kind, 'report', 'Older data without the original receipt still exposes the failure to Owner')
  assert.equal(snapshot.workflow.inbox[0].text, failedTask.error)

  const unreadRun = structuredClone(exhausted)
  unreadRun.workflow.cursor = unreadRun.workflow.inbox.indexOf(unreadRun.workflow.inbox.findLast(entry => entry.id === legacyReport.id))
  unreadRun.delegations[0].launches = 1
  const unreadRestored = { scene, agents: scene.agents.slice(), workflow: { inbox: [] } }
  coordinator.restoreGraph(unreadRestored, unreadRun)
  assert.equal(unreadRestored.delegations[0].state, 'failed', 'A queued failure can wait for Owner even with attempts left')
  assert.equal(unreadRestored.workflow.inbox[0].id, legacyReport.id)

  const resumed = submit(coordinator, scene, 'continue-exhausted', first.id)
  await resumed.done
  const saved = store.run(resumed.id)
  assert.equal(saved.state, 'completed')
  assert.equal(saved.workflow.inbox.filter(entry => entry.id === legacyReport.id).length, 1)
  assert.deepEqual(saved.delegations[0].launchesByAgent, { worker: 3, replacement: 1 })
  assert.deepEqual(saved.delegations[1].dependencies, ['build'])
  assert.deepEqual(calls.filter(item => item.resumed), [
    { agent: 'replacement', stage: '接续核验：build', readOnly: true, resumed: true },
    { agent: 'qa', stage: 'qa', readOnly: true, resumed: true },
  ])
})

test('Processed user directives survive unrelated reports and resume without replay', { timeout: 5000 }, async context => {
  const planQuestion = Promise.withResolvers()
  const engineQuestion = Promise.withResolvers()
  const ownerCalls = []
  const workerPrompts = []
  const directive = 'Keep the supplemental accounting directive across decisions.'
  const planAnswer = 'Daily bars only for this deliverable.'
  const engineAnswer = 'Preserve the previously exported account.'
  const { coordinator, scene, store } = fixture(context, async ({ agent, run, prompt, contextId, onQuestion }) => {
    if (agent.id !== 'owner') {
      workerPrompts.push(prompt)
      return delivery('Independent evidence')
    }
    const entry = incoming(run)
    ownerCalls.push({ kind: entry.kind, prompt, contextId })
    if (entry.kind === 'initial') return { question: 'Which time resolution is in scope?',
      tasks: [task('first', 'worker'), task('second', 'replacement'), task('third', 'qa')] }
    if (entry.kind === 'report') {
      if (ownerCalls.filter(call => call.kind === 'report').length === 1) {
        await onQuestion({ questions: [{ id: 'engine-scope', question: 'What do we preserve?' }] })
      }
      return { acceptTaskIds: [entry.taskId] }
    }
    if (entry.kind === 'resume') return { complete: true, answer: 'Delivery verified after resuming.' }
    return { summary: 'Input recorded' }
  }, event => {
    if (event.type !== 'user.question') return
    if (event.questions[0].id === 'clarification') planQuestion.resolve(event.questionId)
    if (event.questions[0].id === 'engine-scope') engineQuestion.resolve(event.questionId)
  })
  const first = submit(coordinator, scene, 'retain-user-directives')
  const planQuestionId = await planQuestion.promise
  coordinator.followUp(first.id, { requestId: 'directive', text: directive })
  coordinator.answer(first.id, planQuestionId, { clarification: { answers: [planAnswer] } })
  const engineQuestionId = await engineQuestion.promise
  coordinator.answer(first.id, engineQuestionId, { 'engine-scope': { answers: [engineAnswer] } })
  await first.done
  const run = store.run(first.id)
  assert.equal(run.state, 'incomplete')
  assert.equal(run.workflow.ownerAnswers.length, 1)
  const reportCalls = ownerCalls.filter(call => call.kind === 'report')
  assert.equal(reportCalls.length, 3)
  for (const { prompt } of reportCalls) {
    assert.equal(prompt.split(directive).length, 2)
    assert.equal(prompt.split(planAnswer).length, 2)
  }
  assert.match(reportCalls.at(-1).prompt, /此前已收到的用户补充与回答\n采用 3\/3 条/)
  assert.ok(reportCalls.at(-1).prompt.includes(engineAnswer))
  const items = store.context(reportCalls.at(-1).contextId, scene.id).items
  const supplementId = run.workflow.inbox.find(entry => entry.kind === 'user').messageId
  for (const id of [supplementId, planQuestionId, engineQuestionId]) {
    assert.equal(items.filter(item => item.source?.id === id).length, 1)
  }
  assert.ok(workerPrompts.every(prompt => !prompt.includes(directive) && !prompt.includes(engineAnswer)))

  const resumed = submit(coordinator, scene, 'resume-retained-user-directives', first.id)
  await resumed.done
  const resumedRun = store.run(resumed.id)
  assert.equal(resumedRun.state, 'completed')
  assert.deepEqual(resumedRun.workflow.inbox.map(item => item.kind), ['resume'])
  const prompt = ownerCalls.find(call => call.kind === 'resume').prompt
  for (const text of [directive, planAnswer, engineAnswer]) assert.equal(prompt.split(text).length, 2)
})
