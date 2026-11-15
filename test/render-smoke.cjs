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
  const runId = await page.locator('#sc-run').inputValue();
  await page.selectOption('#sc-run', runId);
  await page.waitForFunction(element => !element.isConnected, originalSeparator);
  await page.mouse.move(startX, startY + 80, { steps: 4 });
  await page.mouse.up();
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
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-render-smoke-'));
  const playwright = require(process.env.DSH_PLAYWRIGHT_MODULE || 'playwright');
  const { createWorkbenchHost } = await import(pathToFileURL(path.join(root, 'workbench-host.js')).href);
  const { CHAT_PAGE } = await import(pathToFileURL(path.join(root, 'page.js')).href);
  const events = new Map();
  const cleanups = [];
  const parent = { id: 'session-render-session', session: { id: 'render-session' }, options: { provider: 'test', model: 'dsh-test' } };
  const parents = new Map([[parent.id, parent]]);
  let createdSessions = 0;
  let externalCalls = 0;
  const result = {
    summary: '阶段处理完成，已保留证据。\n' + '这是一条用于检查成员独立滚动的过程记录。\n'.repeat(40), verdict: 'approved', needsExecution: false,
    answer: '工作区和团队协作流程已完成，来源可从上下文查看。', complete: true,
    tasks: [{ id: 'inspect', agentId: 'codex', title: '核对场景资料', instruction: '读取并核对资料', dependencies: [], access: 'read' }],
    memoryCandidates: [{ title: '场景知识', content: '知识内容保留来源与版本。', kind: 'learning' }],
  };
  const ctx = {
    agents: { list: () => [...parents.values()], get: id => parents.get(id) },
    subagents: {
      getProvider: name => ['spawn', 'test-agent'].includes(name)
        ? { name, capabilities: { agentOptions: name === 'spawn' } } : undefined,
      startActivation: async request => {
      if (request.provider === 'test-agent') {
        assert.equal(request.agentOptions, undefined, 'Fixed-model Agents receive no unsupported overrides');
        externalCalls++;
        return { childId: request.childId, dispose: async () => {},
          result: Promise.resolve({ stopReason: 'completed', structured: result, output: [] }) };
      }
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
        message: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      return { childId: request.childId, dispose: async () => {},
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(result) }] }) };
    } },
    on(name, listener) { events.set(name, listener); },
    inject(names, callback) {
      callback({ llm: { listProviders: () => [{ id: 'test', name: 'Test' }], listModels: async () => [{ id: 'dsh-test', name: 'DSH test', reasoning: { efforts: [{ id: 'high' }] } }],
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }] } }) },
      skills: { list: async () => [], get: async () => undefined },
      loader: { entries: () => [{ options: { config: { providerName: 'test-agent' } } }] },
      sessionController: {
        create: async () => {
          const id = `session-created-${++createdSessions}`;
          parents.set(id, { ...parent, id, session: { id } });
          return { sessionId: id };
        },
        rename: async () => ({}),
      },
      effect: operation => { const cleanup = operation(); if (cleanup) cleanups.push(cleanup); } });
    },
  };
  function createChannel(launcher, cwd, model, hooks) {
    return { threadId: 'smoke-thread', model, start: async () => {}, close() {},
      send: async (prompt, signal) => {
        signal.throwIfAborted();
        hooks.onDelta('正在处理请求');
        hooks.onEvent('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 210, outputTokens: 50 } } });
        await new Promise((resolve, reject) => {
          const delay = setTimeout(resolve, 90);
          signal.addEventListener('abort', () => { clearTimeout(delay); reject(new Error('已取消')); }, { once: true });
        });
        return { status: 'completed', answer: JSON.stringify(result) };
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
  let browser;
  let releaseRefresh = () => {};
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/codex-chat?dshSession=render-session`);
    await page.locator('[data-action="new-scene"]').click();
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    await page.fill('#sc-draft', '记住当前场景的输出需要简短');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.locator('.sc-message-assistant').filter({ hasText: '工作区和团队协作流程已完成' }).waitFor();
    assert.equal(await page.locator('.sc-agent').count(), 2);
    await checkMemberScrolling(page);
    await page.setViewportSize({ width: 360, height: 900 });
    await page.locator('[data-action="mobile-process"]').click();
    await checkMemberScrolling(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const savedMemberWeights = await checkMemberResizing(page);
    await page.locator('[data-action="collapse"]').first().click();
    assert.equal(await page.locator('.sc-agent-body:visible').count(), 1);
    await page.locator('[data-action="process-toggle"]').click();
    assert.equal(await page.locator('.sc-processes').count(), 0);
    await page.selectOption('#sc-mode', 'orchestration');
    await page.waitForSelector('#sc-owner');
    await page.selectOption('#sc-owner', 'deepseek');
    await page.waitForTimeout(150);
    await page.fill('#sc-draft', '请安排团队核对场景资料');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sc-message-assistant').length >= 2);
    await page.locator('[data-view="team"]').click();
    assert.equal(await page.locator('.sc-profile').count(), 2);
    await page.locator('[data-action="add-agent"]').click();
    assert.equal(await page.locator('.sc-profile').count(), 3);
    await page.locator('[data-action="save-team"]').click();
    await page.getByText('设置已保存，从下一轮生效', { exact: true }).waitFor();
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
    await page.locator('.cx-category-head[data-value="tools"]').click();
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
    if (process.env.DSH_SMOKE_SCREENSHOTS) {
      fs.mkdirSync(process.env.DSH_SMOKE_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.DSH_SMOKE_SCREENSHOTS, 'workbench-context.png'), fullPage: true });
      await page.locator('[data-view="chat"]').click();
      await page.screenshot({ path: path.join(process.env.DSH_SMOKE_SCREENSHOTS, 'workbench-chat.png'), fullPage: true });
    }
    await page.reload();
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    assert.match(await page.locator('.sc-heading').innerText(), /3 位成员/);
    assert.deepEqual(await page.locator('.sc-agent').evaluateAll(panes => panes.map(pane => pane.style.getPropertyValue('--sc-agent-weight'))), savedMemberWeights,
      'Refreshing restores the scene member height preferences');
    await page.locator('[data-view="team"]').click();
    const extra = page.locator('[data-agent-field="engine"]').last();
    const extraId = await extra.getAttribute('data-agent');
    await extra.selectOption('agent');
    await page.locator(`[data-agent-field="agentProvider"][data-agent="${extraId}"]`).fill('test-agent');
    await page.locator(`[data-agent-field="role"][data-agent="${extraId}"]`).click();
    assert.equal(await page.locator(`[data-agent-field="model"][data-agent="${extraId}"]`).count(), 0);
    await page.locator('[data-action="save-team"]').click();
    await page.getByText('设置已保存，从下一轮生效', { exact: true }).waitFor();
    await page.locator('[data-view="chat"]').click();
    await page.selectOption('#sc-mode', 'confidence');

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
    await page.waitForURL('**dshSession=session-created-1**');
    await page.locator('[data-action="send"]:enabled').waitFor();
    const delayedResponse = page.waitForResponse(response => oldRefresh.test(response.url()));
    releaseRefresh();
    await (await delayedResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.sc-message-user').count(), 0, 'Late refreshes never copy the previous requirement into the new chat');
    const list = await (await page.request.get(`${origin}/codex-chat/v2/scenarios`)).json();
    const sceneId = list.scenes[0].id;
    const repeated = await page.request.post(`${origin}/codex-chat/v2/scenarios/${sceneId}/sessions`, { data: sessionRequest });
    assert.equal(repeated.status(), 200);
    assert.equal(createdSessions, 1, 'Retrying session creation keeps the same DSH Session');
    assert.deepEqual(errors, []);
    console.log('Render smoke passed: modes, member resizing, memory, context, external Agents, new Sessions, creation retries, and late-refresh isolation.');
  } finally {
    releaseRefresh();
    await browser?.close();
    await workbench.dispose();
    cleanups.forEach(cleanup => cleanup());
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(temporary);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('dsh-render-smoke-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
