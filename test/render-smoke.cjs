/** Run with DSH_PLAYWRIGHT_MODULE pointing to an available Playwright package. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function checkMemberScrolling(page) {
  await page.locator('.sc-agent-body').evaluateAll(bodies => bodies.forEach(body => { body.scrollTop = 0; }));
  const geometry = () => page.evaluate(() => {
    const processes = document.querySelector('.sc-processes');
    const agents = [...document.querySelectorAll('.sc-agent')];
    return {
      outerScroll: processes.scrollTop,
      outerOverflow: processes.scrollHeight - processes.clientHeight,
      mainScroll: document.querySelector('.sc-log').scrollTop,
      agents: agents.map(agent => {
        const box = agent.getBoundingClientRect();
        const body = agent.querySelector('.sc-agent-body');
        return { top: box.top, height: box.height, scroll: body.scrollTop, overflow: body.scrollHeight - body.clientHeight };
      }),
    };
  });
  const before = await geometry();
  assert.ok(before.outerOverflow <= 1, 'Member content stays inside the fixed right column');
  assert.ok(before.agents.every(agent => agent.overflow > 300), 'Both members have independently scrollable content');
  assert.ok(Math.abs(before.agents[0].height - before.agents[1].height) <= 1, 'Expanded members share the available height');
  const body = page.locator('.sc-agent-body').first();
  const bounds = await body.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 350);
  await page.waitForFunction(() => document.querySelector('.sc-agent-body').scrollTop > 0);
  const after = await geometry();
  assert.equal(after.outerScroll, before.outerScroll);
  assert.equal(after.mainScroll, before.mainScroll);
  assert.equal(after.agents[1].scroll, 0);
  assert.equal(after.agents[1].top, before.agents[1].top);
  assert.equal(after.agents[1].height, before.agents[1].height);
  await page.locator('[data-action="collapse"]').nth(1).click();
  const collapsed = await geometry();
  assert.ok(collapsed.agents[0].height > before.agents[0].height, 'The expanded member uses the released space');
  assert.equal(collapsed.agents[0].scroll, after.agents[0].scroll, 'Rendering preserves each member scroll position');
  await page.locator('[data-action="collapse"]').nth(1).click();
  assert.equal((await geometry()).agents[0].height, before.agents[0].height);
  await page.locator('[data-action="collapse"]').first().click();
  await page.locator('[data-action="collapse"]').first().click();
  assert.equal((await geometry()).agents[0].scroll, after.agents[0].scroll, 'Collapsing and reopening preserves the reading position');
}

async function checkMemberResizing(page) {
  await page.waitForFunction(() => !document.querySelector('.scw').classList.contains('sc-narrow'));
  const heights = () => page.locator('.sc-agent').evaluateAll(panes => panes.map(pane => pane.getBoundingClientRect().height));
  const weights = () => page.locator('.sc-agent').evaluateAll(panes => panes.map(pane => pane.style.getPropertyValue('--sc-agent-weight')));
  const separator = page.locator('.sc-member-separator');
  const before = await heights();
  const bounds = await separator.boundingBox();
  const originalSeparator = await separator.elementHandle();
  const startX = bounds.x + bounds.width / 2;
  const startY = bounds.y + bounds.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 40, { steps: 4 });
  await page.locator('#sc-model-trigger').dispatchEvent('click');
  await page.waitForFunction(element => !element.isConnected, originalSeparator);
  await page.mouse.move(startX, startY + 80, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  const dragged = await heights();
  assert.ok(dragged[0] > before[0] + 60, 'Dragging increases the upper member height');
  assert.ok(dragged[1] < before[1] - 60, `Dragging releases height from the lower member ${JSON.stringify({ before, dragged })}`);
  assert.equal(await page.locator('.scw.sc-member-resizing').count(), 0);
  await separator.dblclick();
  const reset = await heights();
  assert.ok(Math.abs(reset[0] - reset[1]) <= 1, 'Double-clicking restores equal heights');
  await separator.focus();
  await separator.press('ArrowDown');
  assert.ok((await heights())[0] > reset[0] + 10, 'Keyboard resizing changes the height');
  const saved = await weights();
  await page.locator('[data-action="collapse"]').nth(1).click();
  assert.equal(await separator.count(), 0, 'A single expanded member has no height divider');
  await page.locator('[data-action="collapse"]').nth(1).click();
  assert.deepEqual(await weights(), saved, 'Collapsing preserves the saved proportions');
  assert.ok(await page.locator('.sc-processes').evaluate(element => element.scrollHeight - element.clientHeight <= 1));
  return saved;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-render-smoke-')));
  const playwright = require(process.env.DSH_PLAYWRIGHT_MODULE || 'playwright');
  const { createWorkbenchHost } = await import(pathToFileURL(path.join(root, 'workbench-host.js')).href);
  const { ScenarioStore } = await import(pathToFileURL(path.join(root, 'scenario-store.js')).href);
  const { CHAT_PAGE } = await import(pathToFileURL(path.join(root, 'page.js')).href);
  const events = new Map();
  const cleanups = [];
  const parent = { id: 'session-render-session', session: { id: 'render-session' }, options: { provider: 'test', model: 'dsh-test' } };
  const parents = new Map([[parent.id, parent]]);
  let createdSessions = 0;
  let externalCalls = 0;
  let releaseSecondReview = () => {};
  const secondReviewGate = new Promise(resolve => { releaseSecondReview = resolve; });
  const workspaceSessions = new Set();
  const nativeWorkspace = { id: 'workspace-render', path: temporary, title: '渲染工作区',
    attachSession: async sessionId => { workspaceSessions.add(sessionId); } };
  const result = {
    summary: '阶段处理完成，已保留证据。\n' + '这是一条用于检查成员独立滚动的过程记录。\n'.repeat(40), verdict: 'approved', needsExecution: false,
    answer: '工作区和团队协作流程已完成，来源可从上下文查看。', complete: true,
    evidence: ['场景资料核对记录'],
    memoryCandidates: [{ title: '场景知识', content: '知识内容保留来源与版本。', kind: 'learning' }],
  };
  function resultForPrompt(prompt) {
    if (prompt.startsWith('你是本机插件的记忆整理员')) return { summary: '当前会话已核对场景资料。', candidates: [] };
    const graph = prompt.match(/当前任务图 (\[.*\])。现有成员 /)?.[1];
    if (!graph) return result;
    const tasks = JSON.parse(graph);
    if (!tasks.length) {
      const followOn = prompt.includes('再次核对当前需求');
      const instruction = followOn ? '读取并再次核对当前需求' : '读取并核对场景资料';
      const plan = [{ id: 'inspect', agentId: 'codex', title: '核对场景资料',
        instruction, dependencies: [], access: followOn ? 'write' : 'read', acceptanceCriteria: '给出可核对的场景资料记录' }];
      if (followOn) plan.push(
        { id: 'write-note', agentId: 'codex', title: '写入补充说明', instruction: '追加一段有来源的说明',
          dependencies: [], access: 'write', acceptanceCriteria: '保留说明和对应来源' },
        { id: 'review', agentId: 'codex', title: '确认核对结果', instruction: '核验原材料 <样例> 与结果一致',
          dependencies: ['inspect'], access: 'read', difficulty: 'hard', acceptanceCriteria: '附上逐项核对结果' },
      );
      return { summary: '已安排场景资料核对。', tasks: plan };
    }
    return { ...result, tasks: [], acceptTaskIds: tasks.filter(task => task.state === 'completed').map(task => task.id) };
  }
  const ctx = {
    agents: { list: () => [...parents.values()], get: id => parents.get(id) },
    subagents: {
      getProvider: name => ['spawn', 'test-agent'].includes(name)
        ? { name, capabilities: { agentOptions: name === 'spawn' }, ...(name === 'spawn' ? { prepareContinuable() {} } : {}) } : undefined,
      startActivation: async request => {
      if (request.provider === 'test-agent') {
        assert.equal(request.childId, undefined, 'External Agents receive no reserved child IDs');
        assert.equal(request.agentOptions, undefined, 'Fixed-model Agents receive no unsupported overrides');
        externalCalls++;
        return { childId: request.childId, dispose: async () => {},
          result: Promise.resolve({ stopReason: 'completed', structured: result, output: [] }) };
      }
      const reply = resultForPrompt(request.prompt.map(part => part.text || '').join('\n'));
      let sequence = 0;
      const session = { id: request.childId };
      const emit = (type, data = {}) => events.get('session/event')?.(session, { type, data, seq: sequence++, time: Date.now() });
      emit('request/header', { header: { tools: [{ name: 'read_file', description: '读取场景文件',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] } }],
        config: { model: 'dsh-test', provider: 'test', reasoningEffort: 'high' } } });
      emit('request/context', { contextWindow: 128000 });
      emit('system/message', { message: { content: [{ type: 'text', text: '你是测试团队成员。' }] } });
      emit('user/message', { content: request.prompt });
      emit('step/start');
      emit('assistant/message', { step: 0, turn: 0, usage: { inputTokens: 200, cacheReadTokens: 50, outputTokens: 40 },
        message: { content: [{ type: 'text', text: '先核对资料。' }] } });
      emit('tool/call', { callId: 'read', name: 'read_file', arguments: { path: path.join(temporary, 'scene.md') } });
      emit('tool/result', { message: { source: { callId: 'read' }, content: [{ type: 'text', text: '场景资料已读取。' }] } });
      emit('tool/call', { callId: 'command', name: 'bash', arguments: { command: 'git status --short', cwd: temporary } });
      emit('tool/result', { message: { source: { callId: 'command' }, content: [{ type: 'text', text: 'working tree clean' }] } });
      emit('step/start');
      emit('assistant/message', { step: 1, turn: 0, usage: { inputTokens: 220, cacheReadTokens: 80, outputTokens: 60 },
        message: { content: [{ type: 'text', text: JSON.stringify(reply) }] } });
      return { childId: request.childId, dispose: async () => {},
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(reply) }] }) };
    } },
    on(name, listener) { events.set(name, listener); },
    inject(names, callback) {
      callback({ llm: { listProviders: () => [{ id: 'test', name: 'Test' }], listModels: async () => [{ id: 'dsh-test', name: 'DSH test', reasoning: { efforts: [{ id: 'high' }] } }],
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }] } }) },
      skills: { list: async () => [], get: async () => undefined },
      loader: { entries: () => [{ options: { config: { providerName: 'test-agent' } } }] },
      sessionController: {
        create: async request => {
          assert.deepEqual(request, { workspaceId: nativeWorkspace.id }, 'New requirements join the scene native Workspace');
          const id = `session-created-${++createdSessions}`;
          parents.set(id, { ...parent, id, session: { id }, title: '' });
          workspaceSessions.add(id);
          return { sessionId: id };
        },
        rename: async request => { parents.get(request.sessionId).title = request.title; return {}; },
        list: async () => ({ items: [...parents.values()].map(parent => ({ sessionId: parent.session.id, cwd: temporary, title: parent.title || '' })) }),
      },
      workspaceController: { create: async request => {
        assert.equal(request.path, temporary);
        return { workspace: { workspaceId: nativeWorkspace.id }, created: false };
      } },
      workspaceRegistry: { get: id => id === nativeWorkspace.id ? nativeWorkspace : undefined },
      effect: operation => { const cleanup = operation(); if (cleanup) cleanups.push(cleanup); } });
    },
  };
  function createChannel(launcher, cwd, model, hooks) {
    return { threadId: 'smoke-thread', model, start: async () => {}, close() {},
      send: async (prompt, signal) => {
        signal.throwIfAborted();
        hooks.onDelta('正在处理请求');
        hooks.onEvent('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 210, outputTokens: 50 } } });
        const stage = prompt.match(/当前阶段为 ([^。]+)。/)?.[1];
        if (stage === '独立处理' || stage === '交叉验证 1') {
          hooks.onEvent('item/completed', { item: { id: 'command', type: 'commandExecution',
            command: 'pwd', exitCode: 0, aggregatedOutput: `${stage}的命令结果` } });
        }
        await new Promise((resolve, reject) => {
          const delay = setTimeout(resolve, 90);
          signal.addEventListener('abort', () => { clearTimeout(delay); reject(new Error('已取消')); }, { once: true });
        });
        if (prompt.includes('读取并再次核对当前需求') && !prompt.includes('当前任务图 ')) await secondReviewGate;
        return { status: 'completed', answer: JSON.stringify(resultForPrompt(prompt)) };
      },
    };
  }
  const writeJson = (response, value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const workbench = createWorkbenchHost({ ctx, createChannel, resolveLauncher: () => ({}), defaultCwd: () => temporary,
    availableModels: async () => [{ id: 'codex-test', label: 'Codex test', efforts: ['low', 'high'], isDefault: true }],
    readJsonBody: async request => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString() || '{}');
    }, writeJson, storeUpload: async () => { throw new Error('Upload stub'); }, log: () => {}, dataHome: temporary,
  });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/codex-chat') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(CHAT_PAGE); return; }
    workbench.handle(request, response, url).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } })
      .catch(error => writeJson(response, { ok: false, error: error.message }, 500));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const screenshots = process.env.DSH_SMOKE_SCREENSHOTS;
  let browser;
  let releaseRefresh = () => {};
  try {
    if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/codex-chat?dshSession=render-session`);
    await page.locator('[data-action="new-scene"]').click();
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    const picker = page.getByRole('dialog', { name: '选择模型', exact: true });
    const togglePicker = () => page.getByRole('button', { name: '选择模型', exact: true }).click();
    const done = picker.getByRole('button', { name: '完成', exact: true });
    await togglePicker();
    await picker.locator('[data-model-effort="member:codex"]').selectOption('high');
    await picker.locator('[data-model-effort="member:deepseek"]').selectOption('high');
    await done.click();
    await page.fill('#sc-draft', '记住当前场景的输出需要简短');
    const firstRefresh = page.waitForResponse(response => /\/scenarios\/[^/?]+\?session=session-render-session$/.test(response.url()));
    const firstSend = page.waitForResponse(response => response.request().method() === 'POST' && /\/runs$/.test(response.url()));
    await page.getByRole('button', { name: '发送', exact: true }).click();
    assert.deepEqual((await (await firstSend).json()).run.agents.map(agent => agent.effort), ['high', 'high']);
    await page.locator('.sc-message-assistant').filter({ hasText: '工作区和团队协作流程已完成' }).waitFor();
    await (await firstRefresh).finished();
    const members = page.getByRole('complementary', { name: '成员对话' });
    const originalPane = await members.boundingBox();
    await togglePicker();
    await picker.locator('[data-model-choice="member:deepseek"]').uncheck();
    assert.deepEqual(await members.boundingBox(), originalPane);
    await picker.locator('[data-model-choice="member:codex"]').uncheck();
    assert.deepEqual(await members.boundingBox(), originalPane);
    assert.ok(await done.isDisabled());
    await page.keyboard.press('Escape');
    await togglePicker();
    assert.equal(await picker.locator('[data-model-choice]:checked').count(), 2);
    await picker.locator('[data-model-choice="member:deepseek"]').uncheck();
    await done.click();
    await members.waitFor({ state: 'hidden' });
    await togglePicker();
    await picker.getByRole('button', { name: '恢复默认' }).click();
    await done.click();
    await members.waitFor();
    const layout = await page.locator('.sc-actions').evaluate(row => {
      const bounds = selector => row.querySelector(selector).getBoundingClientRect();
      const composer = row.closest('.sc-composer');
      const arrow = bounds('.sc-send');
      return { inner: composer.getBoundingClientRect().bottom - arrow.bottom,
        outer: composer.closest('.sc-main').getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom,
        model: bounds('.sc-model-trigger').right, mode: bounds('.sc-model-mode').left, send: arrow.left,
        arrowHeight: arrow.height, arrowCenter: arrow.top + arrow.height / 2,
        controls: ['.sc-compose-attach', '.sc-model-trigger', '.sc-model-mode'].map(selector => {
          const { height, top } = bounds(selector);
          return { height, center: top + height / 2 };
        }) };
    });
    assert.equal(layout.inner, 4);
    assert.equal(layout.outer, 8);
    assert.equal(layout.arrowHeight, 28);
    assert.ok(layout.controls.every(control => control.height === 22 && control.center === layout.arrowCenter));
    assert.ok(layout.mode - layout.model < 12 && layout.send - layout.mode < 90, 'Model and mode sit next to send');
    assert.equal(await page.getByText('场景已保存到本机', { exact: true }).count(), 0);
    assert.equal(await page.locator('.sc-agent').count(), 2);
    await page.locator('[data-agent-pane=codex] .sc-message-user').getByText('记住当前场景的输出需要简短', { exact: false }).waitFor();
    assert.ok(await page.locator('[data-agent-pane=codex] .sc-message-assistant').count());
    await checkMemberScrolling(page);
    await page.setViewportSize({ width: 360, height: 900 });
    await page.locator('[data-action="mobile-process"]').click();
    await checkMemberScrolling(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const savedMemberWeights = await checkMemberResizing(page);
    await page.reload();
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    const codexPane = page.locator('[data-agent-pane="codex"]');
    assert.equal(await codexPane.locator('summary').filter({ hasText: 'commandExecution' }).count(), 0);
    for (const stage of ['独立处理', '交叉验证 1']) {
      const answer = codexPane.locator('.sc-message-assistant').filter({ hasText: `Codex · ${stage}` });
      await answer.getByText('查看原始结果与证据', { exact: true }).click();
      await answer.getByText('命令执行 ·', { exact: false }).click();
      await answer.getByText(`${stage}的命令结果`, { exact: true }).waitFor();
      assert.equal(await answer.locator('summary').filter({ hasText: '命令执行 ·' }).count(), 1);
    }
    assert.deepEqual(await page.locator('.sc-agent').evaluateAll(panes => panes.map(pane => pane.style.getPropertyValue('--sc-agent-weight'))), savedMemberWeights,
      'Refreshing restores the session member height preferences in confidence mode');
    await page.locator('[data-action="collapse"]').first().click();
    assert.equal(await page.locator('.sc-agent-body:visible').count(), 1);
    await page.locator('[data-action="process-toggle"]').click();
    assert.equal(await page.locator('.sc-processes').count(), 0);
    const [testScene] = (await (await page.request.get(`${origin}/codex-chat/v2/scenarios`)).json()).scenes;
    const sceneUrl = `${origin}/codex-chat/v2/scenarios/${testScene.id}`;
    const { scene: beforeOrchestration } = await (await page.request.get(sceneUrl)).json();
    assert.ok((await page.request.patch(sceneUrl, { data: {
      revision: beforeOrchestration.revision, mode: 'orchestration', ownerId: 'deepseek',
    } })).ok());
    await page.locator('.sc-model-mode[data-mode=orchestration]').waitFor();
    await page.fill('#sc-draft', '请安排团队核对场景资料');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sc-message-assistant').length >= 2);
    await page.locator('.sc-collaboration .sc-transcript').getByText('读取并核对场景资料', { exact: false }).waitFor();
    assert.equal(await page.locator('.sc-thread-pane').count(), 1, 'Orchestration focuses one transcript by default');
    const { scene: profileScene } = await (await page.request.get(sceneUrl)).json();
    const savedProfiles = await page.request.patch(sceneUrl, { data: {
      revision: profileScene.revision, teamStrategy: 'auto', agents: profileScene.agents.map(agent => agent.id === 'codex'
        ? { ...agent, model: 'codex-test', effort: 'low', variants: [{ id: 'review-profile', name: '审查高档', difficulty: 'hard', effort: 'high' }] }
        : agent),
    } });
    assert.equal(savedProfiles.ok(), true);
    await page.locator('.sc-model-auto').getByText('自动组队', { exact: true }).waitFor();
    await page.fill('#sc-draft', '请让原成员再次核对当前需求');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.locator('.sc-collaboration .sc-transcript').getByText('读取并再次核对当前需求', { exact: false }).waitFor();
    const progress = page.locator('.sc-compose-submit .sc-run-progress[data-state="running"]');
    const progressTrigger = progress.locator('summary');
    await progressTrigger.hover();
    await progress.getByText('1 位成员执行中', { exact: true }).waitFor();
    await progress.locator('li').filter({ hasText: 'Codex' }).getByText('执行中 ·', { exact: false }).waitFor();
    await progress.locator('li').filter({ hasText: 'DeepSeek' }).getByText('阶段已完成', { exact: true }).waitFor();
    assert.equal(await page.locator('.sc-footer .sc-run-progress').count(), 0);
    const mirror = await browser.newPage({ viewport: { width: 360, height: 900 } });
    try {
      await mirror.goto(`${origin}/codex-chat?dshSession=render-session`);
      await mirror.locator('#sc-progress-composer').waitFor();
      await mirror.locator('[data-action="mobile-process"]').click();
      await mirror.locator('#sc-progress-mobile').focus();
      await mirror.locator('.sc-mobile-nav .sc-run-progress').getByText('1 位成员执行中', { exact: true }).waitFor();
    } finally { await mirror.close(); }
    const plan = page.locator('.sc-collab-plan');
    await plan.locator(':scope > summary').click();
    const dependent = plan.locator('li').filter({ hasText: '确认核对结果' });
    await dependent.getByText('等待前置任务：「核对场景资料」', { exact: true }).waitFor();
    assert.match(await dependent.locator('summary').innerText(), /codex-test · 高 · 执行时可自动调整/);
    await dependent.locator('summary').click();
    await dependent.getByText('核验原材料 <样例> 与结果一致', { exact: true }).waitFor();
    await dependent.getByText('附上逐项核对结果', { exact: true }).waitFor();
    const pendingWriter = plan.locator('li').filter({ hasText: '写入补充说明' });
    assert.match(await pendingWriter.locator('summary').innerText(), /codex-test · 低 · 执行时可自动调整/);
    assert.match(await pendingWriter.innerText(), /等待同一成员结束「核对场景资料」/);
    assert.match(await pendingWriter.innerText(), /等待本轮工作区写入名额：「核对场景资料」/);
    assert.doesNotMatch(await page.locator('.sc-transcript').innerText(), /核验原材料 <样例>/, 'A planned instruction is readable before dispatch');
    await dependent.getByRole('combobox').selectOption('');
    await dependent.locator('summary').getByText('Codex · codex-test · 低', { exact: true }).waitFor();
    await plan.locator(':scope > summary').click();
    await page.fill('#sc-draft', '补充：请保留核对证据');
    await page.getByRole('button', { name: '发送补充', exact: true }).click();
    await page.locator('.sc-message-user').getByText('补充：请保留核对证据', { exact: true }).waitFor();
    releaseSecondReview();
    await page.waitForFunction(() => document.querySelectorAll('.sc-message-assistant').length >= 3);
    await page.locator('.sc-run-progress').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    assert.match(await page.locator('.sc-transcript').innerText(), /读取并核对场景资料/, 'A new run keeps earlier exchanges in view');
    const timeline = page.locator('.sc-message-assistant').last().locator('.sc-timeline');
    await timeline.locator('summary').click();
    await timeline.getByText('Owner 开始处理', { exact: true }).first().waitFor();
    await timeline.getByText('Owner 已处理', { exact: true }).first().waitFor();
    const reportDownload = page.waitForEvent('download');
    await timeline.getByRole('button', { name: '导出 Markdown' }).click();
    assert.match((await reportDownload).suggestedFilename(), /^协作时间线-.*\.md$/);
    await page.locator('[data-view="team"]').click();
    assert.equal(await page.locator('.sc-profile').count(), 2);
    await page.locator('[data-action="add-agent"]').click();
    assert.equal(await page.locator('.sc-profile').count(), 3);
    await page.locator('[data-action="save-team"]').click();
    await page.getByText('设置已保存，从下一轮生效', { exact: true }).waitFor();
    await page.locator('[data-view="chat"]').click();
    await page.locator('[data-action="compare-members"]').click();
    await page.locator('#sc-collab-split').waitFor();
    assert.equal(await page.locator('.sc-transcript:visible').count(), 2, 'Optional comparison keeps two independent transcripts');
    await page.locator('#sc-collab-split').press('ArrowDown');
    const savedComparisonWeights = await page.locator('.sc-thread-pane').evaluateAll(panes => panes.map(pane => pane.style.getPropertyValue('--sc-agent-weight')));
    await page.locator('[data-view="memory"]').click();
    await page.locator('.sc-memory-row').first().waitFor();
    await page.locator('[data-action="new-memory"]').click();
    await page.locator('[data-memory-field="title"]').fill('渲染检查记录');
    await page.locator('[data-memory-field="content"]').fill('记忆可编辑并保存版本。');
    await page.locator('[data-action="save-memory"]').click();
    await page.locator('.sc-memory-row').filter({ hasText: '渲染检查记录' }).waitFor();
    await page.locator('[data-action="edit-memory"]').click();
    await page.locator('[data-memory-field="content"]').fill('已修改，保留修订记录。');
    await page.locator('[data-action="save-memory"]').click();
    await page.getByText(/版本 v2/).waitFor();
    await page.locator('[data-action="memory-history"]').click();
    const historyPanel = page.locator('.sc-memory-history');
    const revisedMemory = historyPanel.locator('li').filter({ hasText: '渲染检查记录' });
    await revisedMemory.first().waitFor();
    const memoryNumber = (await revisedMemory.first().locator('strong').textContent()).match(/^#\d+/)[0];
    await historyPanel.getByLabel('按编号查找').fill(memoryNumber);
    await historyPanel.getByRole('button', { name: '查找', exact: true }).click();
    await revisedMemory.first().waitFor();
    assert.equal(await historyPanel.locator('li').count(), 2, 'Stable memory number finds just that memory and both revisions');
    await historyPanel.getByRole('button', { name: '清除筛选' }).click();
    await historyPanel.locator('li').filter({ hasNotText: '渲染检查记录' }).first().waitFor();
    await page.locator('.sc-memory-history [data-action="memory-source"]').first().click();
    await page.locator('[data-view="chat"][aria-selected="true"]').waitFor();
    const sourceText = '补充：请保留核对证据';
    const sourceMessage = page.locator('.sc-message-user').filter({ hasText: sourceText });
    const [sourceRunId, sourceMessageId] = await Promise.all([sourceMessage.getAttribute('data-run'), sourceMessage.getAttribute('data-message-id')]);
    await sourceMessage.getByRole('button', { name: '存为记忆', exact: true }).click();
    const draftSource = page.getByRole('region', { name: '记忆来源', exact: true });
    await draftSource.getByText(sourceText, { exact: true }).waitFor();
    await page.locator('[data-memory-field="title"]').fill('带精确消息来源的记忆');
    await page.locator('[data-memory-field="content"]').fill('已保留核对过程的对应消息。');
    if (screenshots) await page.locator('.sc-memory-detail').screenshot({ path: path.join(screenshots, 'workbench-memory-source.png') });
    const linkedSave = page.waitForResponse(response => response.url() === `${sceneUrl}/memories` && response.request().method() === 'POST');
    await page.locator('[data-action="save-memory"]').click();
    const linkedMemory = await linkedSave;
    assert.equal(linkedMemory.ok(), true);
    const { memory: linked } = await linkedMemory.json();
    assert.deepEqual([linked.origin.sessionId, linked.origin.runId, linked.origin.messageId, linked.origin.excerpt],
      ['session-render-session', sourceRunId, sourceMessageId, sourceText]);
    const provenance = page.locator('.sc-memory-history li').filter({ hasText: '带精确消息来源的记忆' });
    await provenance.getByText('原消息摘录', { exact: true }).click();
    assert.equal(await provenance.locator('blockquote').innerText(), sourceText);
    if (screenshots) {
      await historyPanel.getByLabel('按编号查找').fill(`#${linked.number}`);
      await historyPanel.getByRole('button', { name: '查找', exact: true }).click();
      await provenance.waitFor();
      await historyPanel.getByRole('button', { name: '清除筛选', exact: true }).waitFor();
      await historyPanel.locator('li').nth(1).waitFor({ state: 'hidden' });
      if (!await provenance.locator('blockquote').isVisible()) await provenance.getByText('原消息摘录', { exact: true }).click();
      await historyPanel.screenshot({ path: path.join(screenshots, 'workbench-memory-history.png') });
    }
    await provenance.locator('[data-action="memory-source"]').click();
    await page.waitForFunction(id => document.activeElement?.dataset.messageId === id, sourceMessageId);
    await page.locator('[data-view="context"]').click();
    await page.locator('.sc-usage').waitFor();
    await page.selectOption('#sc-context-agent', 'codex');
    await page.locator('.cx-step-brief').filter({ hasText: '上报输入 210' }).waitFor();
    await page.locator('.cx-category-head[data-value="inject"]').click();
    await page.locator('.sc-context-item').first().click();
    await page.locator('[data-cx="dna"]').click();
    await page.locator('.cx-dna-strip').waitFor();
    await page.locator('[data-cx="dna"]').click();
    await page.selectOption('#sc-context-agent', 'deepseek');
    await page.locator('.cx-step-brief').filter({ hasText: '上报输入 300' }).waitFor();
    const toolCategory = page.locator('.cx-category-head[data-value="tools"]');
    if (await toolCategory.getAttribute('aria-expanded') !== 'true') await toolCategory.click();
    await page.locator('.cx-category-body .cx-item').first().click();
    await page.locator('.cx-schema').waitFor();
    assert.match(await page.locator('.cx-occupancy').innerText(), /128/);
    assert.equal(await page.locator('.cx-category-head').count(), 7);
    await page.locator('[data-cx="trend-mode"][data-value="delta"]').click();
    assert.equal(await page.locator('.cx-delta-plot').count(), 1);
    await page.locator('[data-cx="granularity"][data-value="turn"]').click();
    await page.locator('[data-cx="overview"]').click();
    assert.equal(await page.locator('.cx-overview').count(), 1);
    await page.locator('[data-cx="browser-mode"][data-value="delta"]').click();
    await page.fill('#cx-file-query', 'scene.md');
    assert.ok(await page.locator('#cx-files .cx-log details').count());
    await page.fill('#cx-command-query', 'git');
    const firstCommand = page.locator('.cx-command-list>details').first();
    await firstCommand.locator('summary').click();
    const readOutput = firstCommand.locator('[data-cx="tool-output"]');
    if (await readOutput.count()) await readOutput.click();
    assert.match(await page.locator('.cx-command-list').innerText(), /working tree clean/);
    await page.fill('#cx-file-query', '');
    await page.fill('#cx-command-query', '');
    const summary = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, text: document.body.innerText }));
    assert.equal(summary.overflow, false);
    assert.match(summary.text, /上下文浏览器/);
    for (const width of [360, 760, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['chat', 'team', 'memory', 'context']) {
        await page.locator(`[data-view="${view}"]`).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${view} width ${width}`);
      }
    }
    if (screenshots) {
      await page.screenshot({ path: path.join(screenshots, 'workbench-context.png'), fullPage: true });
      await page.locator('[data-view="chat"]').click();
      await page.screenshot({ path: path.join(screenshots, 'workbench-chat.png'), fullPage: true });
    }
    const historySession = 'session-render-session';
    const historySetup = new ScenarioStore(path.join(temporary, 'codex-chat'));
    try {
      const { runs } = await (await page.request.get(`${sceneUrl}?session=${historySession}`)).json();
      historySetup.transaction(() => {
        for (let number = 1; number <= 101; number++) {
          historySetup.event(testScene.id, runs[0].id, 'handoff.sent', { sessionId: historySession,
            fromAgentId: 'deepseek', toAgentId: 'codex', delivery: 'assignment', text: `成员历史分页记录 ${number}` });
        }
        for (let number = 1; number <= 101; number++) {
          historySetup.event(testScene.id, runs[0].id, 'owner.decision', { sessionId: historySession, text: `Owner 时间线记录 ${number}` });
        }
      });
      const { events: global } = await (await page.request.get(`${sceneUrl}/collaboration?session=${historySession}`)).json();
      assert.equal(global.at(-1).text, 'Owner 时间线记录 101');
      assert.ok(global.every(event => event.type === 'owner.decision'));
    } finally { historySetup.close(); }
    await page.reload();
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    assert.match(await page.locator('.sc-heading').innerText(), /3 位成员/);
    await page.locator('#sc-collab-split').waitFor();
    assert.deepEqual(await page.locator('.sc-thread-pane').evaluateAll(panes => panes.map(pane => pane.style.getPropertyValue('--sc-agent-weight'))), savedComparisonWeights,
      'Refreshing restores the session comparison and pane sizes');
    const memberHistory = page.locator('[data-agent-pane="codex"] .sc-transcript');
    await memberHistory.getByText('成员历史分页记录 101', { exact: true }).waitFor();
    assert.equal(await memberHistory.getByText('成员历史分页记录 1', { exact: true }).count(), 0);
    await memberHistory.getByRole('button', { name: '读取较早消息' }).click();
    await memberHistory.getByText('成员历史分页记录 1', { exact: true }).waitFor();
    await page.locator('[data-view="team"]').click();
    const extra = page.locator('[data-agent-field="engine"]').last();
    const extraId = await extra.getAttribute('data-agent');
    assert.equal(await extra.isDisabled(), true, 'Member settings start locked');
    await page.locator(`details[data-detail="profile-${extraId}"] > summary`).click();
    await page.locator(`[data-action="edit-member"][data-agent="${extraId}"]`).click();
    await extra.selectOption('agent');
    await page.locator(`[data-agent-field="agentProvider"][data-agent="${extraId}"]`).fill('test-agent');
    await page.locator(`details[data-detail="role-${extraId}"] > summary`).click();
    assert.equal(await page.locator(`[data-agent-field="model"][data-agent="${extraId}"]`).count(), 0);
    await page.locator('[data-action="save-team"]').click();
    await page.getByText('设置已保存，从下一轮生效', { exact: true }).waitFor();
    await page.locator('[data-view="chat"]').click();
    const { scene: beforeConfidence } = await (await page.request.get(sceneUrl)).json();
    assert.ok((await page.request.patch(sceneUrl, { data: { revision: beforeConfidence.revision, mode: 'confidence' } })).ok());
    await page.locator('.sc-model-mode[data-mode=confidence]').waitFor();

    let refreshStarted;
    const refreshReady = new Promise(resolve => { refreshStarted = resolve; });
    const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
    const oldRefresh = /\/scenarios\/[^/?]+\?session=session-render-session$/;
    await page.route(oldRefresh, async route => {
      const response = await route.fetch();
      refreshStarted();
      await refreshGate;
      await route.fulfill({ response });
    });
    await page.fill('#sc-draft', '核对扩展 Agent 并准备下一项需求');
    await page.locator('[data-action="send"]').click();
    let refreshDeadline;
    try {
      await Promise.race([refreshReady, new Promise((_, reject) => {
        refreshDeadline = setTimeout(() => reject(new Error('Expected a completed-task refresh')), 8000);
      })]);
    } finally { clearTimeout(refreshDeadline); }
    assert.ok(externalCalls >= 2, 'External Agents participate in analysis and review');
    let sessionRequest;
    page.on('request', request => {
      if (request.method() === 'POST' && /\/sessions$/.test(new URL(request.url()).pathname)) sessionRequest = request.postDataJSON();
    });
    await page.locator('[data-action="new-demand"]').first().click();
    await page.fill('#sc-new-session-title', '下一项独立需求');
    await page.locator('[data-action="create-demand"]').click();
    await page.waitForURL(new RegExp('dshSession=session-created-1'), { timeout: 8000 }).catch(async error => {
      throw new Error(`${error.message}\nCurrent URL: ${page.url()}\n${(await page.locator('.sc-notice').allTextContents()).join('\n')}`, { cause: error });
    });
    await page.locator('[data-action="send"]:enabled').waitFor();
    const delayedResponse = page.waitForResponse(response => oldRefresh.test(response.url()));
    releaseRefresh();
    await (await delayedResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.sc-message-user').count(), 0, 'Late refreshes never copy the previous requirement into the new chat');
    const list = await (await page.request.get(`${origin}/codex-chat/v2/scenarios`)).json();
    const sceneId = list.scenes[0].id;
    assert.ok(workspaceSessions.has('session-created-1'));
    assert.match(await page.locator('.sc-heading').innerText(), /当前需求 · 下一项独立需求/);
    const prepared = await (await page.request.post(`${origin}/codex-chat/v2/scenarios/${sceneId}/sessions/session-render-session/open`, { data: {} })).json();
    assert.equal(prepared.nativeSessionId, 'render-session', 'Opening a legacy binding retains the native identity');
    assert.ok(workspaceSessions.has('render-session'), 'Opening an existing loose session registers its matching Workspace');
    const repeated = await page.request.post(`${origin}/codex-chat/v2/scenarios/${sceneId}/sessions`, { data: sessionRequest });
    assert.equal(repeated.status(), 200);
    assert.equal(createdSessions, 1, 'Retrying session creation keeps the same DSH Session');
    const currentScene = (await (await page.request.get(`${origin}/codex-chat/v2/scenarios/${sceneId}`)).json()).scene;
    await page.request.delete(`${origin}/codex-chat/v2/scenarios/${sceneId}/sessions/session-created-1`, { data: { revision: currentScene.revision } });
    const detachedRetry = await page.request.post(`${origin}/codex-chat/v2/scenarios/${sceneId}/sessions`, { data: sessionRequest });
    assert.equal(detachedRetry.status(), 409, 'Creation retries respect an explicit unbinding');
    await page.request.post(`${origin}/codex-chat/v2/bootstrap`, {
      data: { scenarioId: sceneId, dshSessionId: 'session-created-1', sessionTitle: '下一项独立需求', bind: true },
    });
    await page.reload();
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();

    async function sendSelected(text) {
      await done.click();
      await page.fill('#sc-draft', text);
      const response = page.waitForResponse(item => item.request().method() === 'POST' && item.url() === `${sceneUrl}/runs`);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      const result = await (await response).json();
      assert.ok(result.ok, result.error);
      await page.locator(`.sc-log .sc-message-assistant[data-run="${result.run.id}"]`).waitFor();
      await page.getByRole('button', { name: '发送', exact: true }).waitFor();
      return result.run;
    }
    await togglePicker();
    const nativeModel = picker.getByRole('checkbox', { name: 'DSH test test', exact: true });
    await nativeModel.waitFor();
    const checkedKeys = await picker.locator('input[type=checkbox]:checked').evaluateAll(inputs => inputs.map(input => input.dataset.modelChoice));
    for (const key of checkedKeys) await picker.locator(`input[data-model-choice=${JSON.stringify(key)}]`).uncheck();
    await nativeModel.check();
    const daily = await sendSelected('单模型日常模式验证');
    assert.equal(daily.mode, 'daily');
    assert.deepEqual(daily.agents.map(agent => [agent.model, agent.provider, agent.effort]), [['dsh-test', 'test', '']]);
    await page.reload();
    await page.locator('.sc-model-mode[data-mode=daily]').waitFor();
    await togglePicker();
    assert.ok(await nativeModel.isChecked(), 'Reload restores the demand-specific selection');
    await picker.locator('input[data-model-choice="member:codex"]').check();
    const confidence = await sendSelected('模型多选置信模式验证');
    assert.equal(confidence.mode, 'confidence');
    assert.equal(confidence.agents.length, 2);
    assert.equal(confidence.agents[0].id, daily.agents[0].id, 'Models keep their identity across rounds');
    await togglePicker();
    await picker.getByRole('button', { name: '设为 Owner · DSH test · test' }).click();
    await picker.getByRole('button', { name: '设为 Owner · Codex · codex-test' }).click();
    assert.equal(await picker.locator('[data-action=star-model][aria-pressed=true]').count(), 1);
    await picker.getByRole('button', { name: '设为 Owner · DSH test · test' }).click();
    const orchestration = await sendSelected('点星统筹模式验证');
    assert.equal(orchestration.mode, 'orchestration');
    assert.equal(orchestration.ownerId, daily.agents[0].id);
    assert.equal(orchestration.scene.teamStrategy, 'manual');
    const { scene: afterSelection } = await (await page.request.get(sceneUrl)).json();
    assert.equal(afterSelection.mode, 'confidence');
    assert.ok(!afterSelection.agents.some(agent => agent.id === daily.agents[0].id), 'Per-demand choices do not rewrite the team');

    const sourceSetup = new ScenarioStore(path.join(temporary, 'codex-chat'));
    try {
      sourceSetup.transaction(() => {
        for (let index = 0; index < 81; index++) {
          sourceSetup.addMessage({ scenarioId: sceneId, sessionId: 'session-render-session', role: 'user',
            text: `原会话的后续记录 ${index + 1}` });
        }
      });
      const historical = sourceSetup.saveMemory({ scenarioId: sceneId, title: '历史任务定位检查', content: '核对已解绑的原任务。' },
        undefined, { sessionId: 'session-render-session', runId: sourceRunId });
      parents.delete(parent.id);
      await page.getByRole('tab', { name: '记忆' }).click();
      await page.locator('.sc-memory-row').filter({ hasText: historical.title }).click();
      await page.locator('.sc-memory-detail [data-action="memory-source"]').click();
      const savedSource = page.getByRole('dialog', { name: '历史会话来源' });
      await savedSource.locator(`[data-message-id="${sourceMessageId}"]`).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('dshSession'), 'session-created-1',
        'A retained binding with no native session shows the saved transcript in place');
      await savedSource.getByRole('button', { name: '关闭' }).click();
      parents.set(parent.id, parent);
      sourceSetup.unbindSession(sceneId, 'session-render-session', sourceSetup.scenario(sceneId).revision);
      sourceSetup.saveMemory({ ...historical, content: '在新需求中核对已解绑的原任务。' }, historical.revision,
        { sessionId: 'session-created-1' });
      assert.equal(sourceSetup.memorySource(sceneId, { sessionId: 'session-render-session' })?.available, true,
        'A detached session can still be opened if its saved messages remain');
      assert.equal(sourceSetup.memorySource(sceneId, { sessionId: `local-${sceneId}` })?.available, true,
        'The browser conversation can be used as a manual memory source');
      await page.reload();
      await page.getByRole('tab', { name: '记忆' }).click();
      await page.locator('.sc-memory-row').filter({ hasText: historical.title }).click();
      const detail = page.locator('.sc-memory-detail');
      const firstOrigin = detail.locator('[data-action="memory-source"][data-session="session-render-session"]');
      assert.equal(await detail.locator('[data-action="memory-source"][data-session="session-created-1"]').count(), 1,
        'The newest edit keeps its own session without replacing the initial source');
      await firstOrigin.click();
      await savedSource.locator(`[data-message-id="${sourceMessageId}"]`).waitFor();
      assert.equal(await savedSource.getByText('原会话的后续记录', { exact: false }).count(), 0,
        'The detached source shows its original task after later messages exceed the history page');
      await savedSource.getByRole('button', { name: '关闭' }).click();
      await page.getByRole('tab', { name: '对话' }).click();
    } finally { sourceSetup.close(); }

    const management = await (await page.request.post(`${origin}/codex-chat/v2/bootstrap`, {
      data: { create: true, cwd: temporary, sessionTitle: '会话管理检查' },
    })).json();
    const otherId = management.scene.id;
    await page.request.post(`${origin}/codex-chat/v2/bootstrap`, {
      data: { scenarioId: otherId, dshSessionId: 'management-other', sessionTitle: '另一场景的需求', bind: true },
    });
    await page.locator('[data-action="scenes"]').first().click();
    const otherCard = page.locator(`[data-scene-choice="${otherId}"]`);
    assert.match(await otherCard.innerText(), /另一场景的需求/);
    assert.match(await otherCard.innerText(), /session-management-other/);
    assert.match(await page.locator(`[data-scene-choice="${sceneId}"] [data-bound-session="session-created-1"]`).innerText(), /当前会话/);
    for (const width of [360, 760, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.locator('[aria-label="场景列表"]').evaluate(element => element.scrollWidth > element.clientWidth + 1), false,
        `Scene management fits width ${width}`);
    }
    await otherCard.locator('[data-action="open-demand"]').click();
    await page.waitForURL('**dshSession=session-management-other**');
    await page.locator('.sc-heading').filter({ hasText: '会话管理检查' }).waitFor();
    await page.locator('[data-action="scenes"]').first().click();
    await page.locator(`[data-scene-choice="${otherId}"] [data-action="unbind-session"]`).click();
    await page.getByRole('alertdialog', { name: '解除绑定确认' }).waitFor();
    await page.locator('[data-action="cancel-scene-action"]').click();
    assert.equal((await (await page.request.get(`${origin}/codex-chat/v2/scenarios/${otherId}`)).json()).scene.sessions.length, 1);
    await page.locator(`[data-scene-choice="${otherId}"] [data-action="unbind-session"]`).click();
    await page.locator('[data-action="confirm-scene-action"]').click();
    await page.getByRole('heading', { name: '为当前需求选择场景' }).waitFor();
    const unbound = (await (await page.request.get(`${origin}/codex-chat/v2/scenarios/${otherId}`)).json()).scene;
    assert.equal(unbound.sessions.length, 0);
    assert.equal(unbound.dshSessionId, '', 'Unbinding clears the old resume anchor');
    await page.locator(`[data-scene-choice="${sceneId}"] [data-action="bind-scene"]`).click();
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    await page.locator('[data-action="scenes"]').first().click();

    const inspection = new ScenarioStore(path.join(temporary, 'codex-chat'));
    try {
      const stale = await page.request.delete(`${origin}/codex-chat/v2/scenarios/${otherId}`, { data: { revision: unbound.revision - 1 } });
      assert.equal(stale.status(), 409);
      inspection.saveMemory({ scenarioId: otherId, title: '删除清理检查', content: '仅用于临时场景检查' });
      inspection.saveRun({ id: 'management-active', scenarioId: otherId, requestId: 'management-active',
        createdAt: new Date().toISOString(), state: 'working', sessionId: 'local-management' });
      const active = await page.request.delete(`${origin}/codex-chat/v2/scenarios/${otherId}`, { data: { revision: unbound.revision } });
      assert.equal(active.status(), 409, 'Active work protects the scene from deletion');
      inspection.saveRun({ ...inspection.run('management-active'), state: 'completed' });
      await page.locator(`[data-scene-choice="${otherId}"] [data-action="delete-scene"]`).click();
      await page.getByRole('alertdialog', { name: '删除场景确认' }).waitFor();
      await page.locator('[data-action="confirm-scene-action"]').click();
      await page.locator(`[data-scene-choice="${otherId}"]`).waitFor({ state: 'detached' });
      assert.equal((await page.request.get(`${origin}/codex-chat/v2/scenarios/${otherId}`)).status(), 404);
      assert.equal(inspection.memories(otherId).length, 0);
      assert.equal(inspection.db.prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE id NOT IN (SELECT id FROM memories)').get().count, 0);
      assert.equal(inspection.db.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.ok(parents.has('session-created-1'), 'DSH Sessions retain their native lifetime');
    } finally { inspection.close(); }
    assert.deepEqual(errors, []);
    console.log('Render smoke passed, including per-scene session lists, cross-scene navigation, unbinding, deletion, and active-task protection.');
  } finally {
    releaseSecondReview();
    releaseRefresh();
    await browser?.close();
    await workbench.dispose();
    cleanups.forEach(cleanup => cleanup());
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(temporary);
    if (resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('dsh-render-smoke-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
