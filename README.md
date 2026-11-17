# DSH Team Chat 场景协作

在 DeepSeek Harness 中让 Codex、DSH 模型供应商及其他已注册 Agent 围绕一个场景持续协作。插件提供原生右侧栏工作区，以及使用同一界面与接口的浏览器入口。

源码仓库为 [ybcbcc/dsh-team-chat](https://github.com/ybcbcc/dsh-team-chat)。内部安装包名保留 `@local/dsh-codex-chat`，兼容已有安装和数据。

完整功能与操作说明见 [场景协作插件完整介绍与使用手册](docs/plugin-guide.html)，按协作、上下文、记忆三章介绍，附截图与完整使用示例。

上下文界面的操作、数字含义和排查示例见 [上下文界面图解使用指南](docs/context-ui-guide.html)（含 7 张实际界面截图，区分真实记录与教学样例）。用浏览器打开，可点击截图放大或打印。

## 场景与工作区

- 场景保存长期项目资料。一个场景可绑定多个 DSH Session，每个 Session 保存自己的需求对话，复用场景与角色记忆。已有单会话场景自动迁移。
- 新会话首次打开时，可以创建场景，或选择已有场景绑定。场景名称描述长期项目，会话名称描述当前需求。内部 Session 编号不再作为手填设置项。
- 在插件顶部点击“新建需求会话”，填写需求名称后创建。新会话由 DSH 创建并自动关联当前场景。场景列表支持打开关联会话，创建请求支持重试去重。
- 新建需求会话使用场景目录对应的 DSH 工作区登记。打开已有会话时，目录匹配的未分组会话会补齐工作区关联。插件顶部显示当前需求名称和资料目录，记忆标签显示场景条数。DSH 原生空会话按宿主规则显示“新会话”，插件使用已保存的需求名称。
- 场景列表逐个展示关联会话的名称、编号及当前会话标记，支持解除绑定和删除场景。解除绑定后可重新选择场景，已有需求记录继续保存在原场景。删除场景会清理插件内的场景设置、记忆及协作记录，并解除全部关联，DSH 原生会话由宿主管理。活动任务结束后可执行这些管理操作。
- 主聊天显示用户任务和团队结论。右侧按参与成员显示独立过程，可单独折叠、全部收起或拖动调整左右宽度。
- 成员完整职责在团队页点击展开，编辑时输入区随内容增高。可独立填写简短职责，并选择是否显示在过程标题；完整职责继续用于角色提示词。成员过程标题显示模型与实际强度，折叠状态按场景与任务轮次保存。
- Owner 的本轮分工和成员过程均可查看下发指令、验收要求与依赖。基础档位显示成员配置的实际思考强度，扩展档位显示对应名称与强度。
- 展开的成员框各自滚动。拖动成员框之间的横向分隔条可调整高度，双击恢复均分，也可聚焦分隔条后使用上下方向键。高度比例按场景保存在当前浏览器，刷新与重新展开后恢复。
- 点击“展开工作区”使用 DSH 官方的全屏右侧栏。发出任务时会自动展开。窄面板通过“主聊天”和“成员过程”切换。
- 团队页设置名称、引擎、角色、真实模型、默认强度和技能，工作区支持原生文件夹选择及浏览器目录选择。
- 每位成员可添加扩展强度档位，继承相同模型、技能和角色记忆，按简单、中等、困难任务选择。Owner 的分工可指定档位；运行中新增档位或调整强度也会用于尚未开始的步骤，可在成员框或待执行任务清单选择。已开始的请求保持启动参数，本轮保留已引用的档位。
- 技能可来自 DSH 目录，也可在成员卡片中新增、编辑场景技能。自定义技能说明保存于场景数据库，保存团队设置后生效。
- 模型和技能目录从当前运行时读取。DSH 模型供应商成员使用 `spawn`，可以选择当前 DSH 配置的任意可用供应商模型，需要关联可恢复的 DSH Session。

## 接入新模型与其他 Agent

新增模型时，先在 DSH 的模型设置中配置对应供应商、模型和授权。在本插件团队页点击“刷新模型与技能”，成员接入方式选择“DSH 模型供应商”，再选择真实模型及其支持的强度。供应商需要相应的 DSH 模型插件支持。

Codex 直接接入从实际启动程序的 `model/list` 获取目录。启动顺序为 `DSH_CODEX_BIN` 显式指定、系统 PATH 中的 Codex、已安装桌面版的 CLI 缓存、profile 内的 `@openai/codex`。手动点击“刷新模型与技能”会立即重新查询模型，普通加载使用五分钟缓存。

新增独立 Agent 时，先在 DSH 安装并启用对应 Agent 接入插件，如 Claude Code、ACP 或自定义 SDK Agent。添加成员，将接入方式设为“其他 Agent · DSH 接入”，从已启用接入中选择，或填写该插件注册的接入名称。保存职责和技能后即可参与两种协作流程。

插件读取 DSH 公共 `subagents.getProvider()`、接入生命周期事件及 Loader 中的接入名称，动态识别可用后端。自定义后端按 DSH 标准 `SubagentProvider` 注册，返回 `SubagentResult`。成员输入已包含角色、场景、记忆与技能，最终结果按提示中的 JSON 合约返回。

后端声明 `capabilities.agentOptions` 时，可以在本插件覆盖模型和思考强度。未声明该能力时，模型、强度与执行权限使用后端自身的 DSH 配置，界面隐藏对应覆盖控件。外部 Agent 当前保存阶段输入和交付结果，细粒度工具与用量记录按后端实际可观测信息展示。

浏览器入口为 `http://127.0.0.1:18401/codex-chat`。端口占用时依次尝试 18402 至 18404，最后由系统分配。`/codex` 命令可以查询实际地址。浏览器入口也可通过 `?dshSession=<id>` 绑定 Session，或通过 `?scenario=<id>` 打开已有场景。

## 协作模式

### 置信模式

成员先独立调研，再交叉审查对方的结论和证据。存在关键分歧时补充核实。交叉验证轮数由用户填写，默认两轮，0 表示持续验证到一致或用户停止，没有三轮上限。需要实际操作的任务交给一个执行成员，随后形成统一稿并交由其他成员审查。

通过审查后返回结论。证据不足、成员失败或仍有分歧时，任务保留相应状态和过程。汇总成员默认 Codex，可以在团队设置中调整。

### 统筹模式

用户选择 Owner，Owner 生成带负责人、依赖和验收要求的分工，成员完成后回报，Owner 检查并向主聊天简短汇报。支持一次返工分配。用户需要补充的信息在主聊天显示，回答后继续执行。

两种模式共用场景、成员与技能设置。置信模式显示交叉验证及汇总成员设置，统筹模式显示 Owner 设置。任务分工位于对话右侧的“本轮分工”。

Codex 在资料读取和审查阶段启动 `read-only` 线程。DSH 原生成员通过 `tools/pre-execute` 限定读取工具。外部 Agent 接收阶段读取要求，实际执行权限由其 DSH 接入配置管理，快照记录权限来源。实际修改阶段沿用执行引擎与用户的既有授权。工作区内的写入阶段按工作区串行调度。

## 成员快捷设置与执行权限

对话底栏显示成员的模型与思考强度。点击成员或“＋N 位”向上展开快捷面板，可切换全部成员，点击“编辑”调整模型、强度和执行权限，保存后应用。团队卡片收起时也显示模型和强度。

Codex 成员支持工作区自动审核、工作区人工审批、完全权限和只读。人工审批通过主聊天展示命令、文件修改或额外权限申请，选择允许本次或拒绝。完全权限用于执行阶段，使用 `danger-full-access` 与 `approvalPolicy: never`。调研和审查阶段继续使用只读配置，成员的只读设置也应用于执行阶段。

DSH 模型成员支持继承宿主权限、操作工具执行前人工审批和只读工具限制。DSH 宿主权限继续生效。其他 Agent 的权限由各自接入插件管理。权限调整用于下一轮任务，强度调整可用于尚未开始的步骤。已有成员默认沿用原有权限行为。

## 场景记忆与上下文

- 明确要求“记住”的用户消息在接收时保存为场景约束，附带原始消息来源。
- 成功任务提出的可复用知识进入待核实记忆，保留任务和证据来源。与已有已确认同名条目冲突的内容标为存在冲突。
- 记忆页支持新增、编辑、固定、停止采用、状态变更、修订历史、恢复版本和移除。
- 记忆分为场景共享与角色专属两层。场景共享保存项目事实和共同约束，角色专属保存方案编写、开发、审查、测试等角色的经验和方法。扩展强度档位共用原角色记忆。
- 自动注入及 DeepSeek 记忆工具都只向成员提供场景共享与自身角色条目。旧条目默认属于场景共享，原始版本和来源保留。
- 旧版 `dsh-memory` 的两个库以共享资料导入，可以将选定条目关联到当前场景。
- DeepSeek 成员的 `memory_list`、`memory_get` 和 `memory_write` 按当前场景注册，读取遵循条目的采用状态，模型写入进入待核实状态。
- 每次模型请求保存插件实际组装的任务、角色、场景、记忆版本、技能、必要历史、协作消息和附件路径。
- 上下文页采用 DSH-Context 的卡片仪表板布局，支持成员筛选、Token 与耗时统计、当前上下文、堆叠趋势、内容浏览器、上下文事件、文件活动和命令执行。
- 趋势支持步骤 / 轮次、总量 / 增量与总览。点击柱形联动浏览器，增量始终与同一成员的上一请求比较。
- 内容浏览器按系统提示词、工具定义、用户消息、注入上下文、技能注入、助手消息和工具结果分组，支持搜索、排序、DNA 顺序浏览、新增材料比较、原文 / 格式化、复制及来源展开。
- DSH 成员通过原生会话事件保存逐请求输入，记录系统提示词、工具 schema、消息和服务商用量。Codex 展示插件组装的阶段输入、实际工具操作及服务商用量。两种记录在范围卡片中分别计数。
- 文件活动支持路径搜索、操作筛选和结果定位。命令卡片展示程序分布、状态、耗时、退出码及按需读取的输出。
- 用量、工具事件和阶段计时持久化保存。窗口容量、耗时或退出码缺失时显示未上报状态。费用需要可核对的模型报价，当前仪表板展示已上报的 Token 用量。
- 类别 token 数是估算。运行时上报数据按其原始口径保存。模型内部额外加入的内容按实际可观测范围记录。

界面布局与交互参考 [DSH-Context 0.84.1](https://github.com/bowenliang123/dsh-context)，包括其 Context 页的卡片分区、分类色彩、趋势与浏览器联动。该插件采用 Apache-2.0 许可证，本项目按自身引擎与存储接口实现。

每个阶段使用一个独立的引擎线程，通过保存的场景资料、历史与交接内容接续任务，阶段结束后释放线程。成员的对话过程和身份保存在场景数据库中。原生请求最多保留 1000 个输入条目，单条正文最多 10 万字符，截取记录带有近似范围提示。仪表板每页最多读取 600 个快照、2000 次工具结果、400 条事件和 400 个文件，完整正文按需加载。

## 数据保存与恢复

运行时文件位于 `~/.dsh/codex-chat/`。

### DSH 会话与插件会话的关系

原生 DSH 会话与插件需求使用同一个会话编号建立关联，一个场景可以关联多个会话。DSH 主聊天读取宿主的消息与事件日志，插件聊天读取自身的协作记录。场景、成员、角色记忆和上下文由插件管理。

| 内容 | 默认位置 |
| --- | --- |
| DSH 原生会话日志 | `~/.dsh/sessions/<工作区编码>/<会话编号>/session.v4.jsonl.zstd` |
| DSH 会话索引缓存 | `~/.dsh/storages/session_projcache/sessions/` |
| 插件场景、会话绑定与协作资料 | `~/.dsh/codex-chat/scenarios.sqlite` |
| 插件上传 | `<工作区>/.dsh-codex-uploads/` |

开发 profile 的 Junction 负责加载源码，运行数据按上述用户目录与工作区路径保存。迁移源码后，需要另外迁移原生会话、插件数据库、附件与引用的项目和技能文件，并映射新机器的工作目录。当前采用手工迁移，统一导出导入及跨系统路径映射待实现。

### 插件数据

| 文件 | 用途 |
| --- | --- |
| `scenarios.sqlite` | 场景、成员配置、任务、消息、事件、记忆修订与上下文快照 |
| `migration-backup-v1/` | 首次导入前保存的旧对话和记忆文件 |
| `conversations.json` | 旧版聊天接口的历史文件 |

首次加载会导入旧对话和两个记忆库。带前缀及省略 `session-` 前缀的 Session 编号会统一绑定，旧场景编号保留别名。旧数据原始文件保留在备份中。

任务使用发送标识去重，配置与记忆编辑使用版本检查。SSE 事件持久化并支持断线补发。重启时将活动任务标为中断，用户可以选择接续，成员会先核对已完成的操作。

上传仍保存在 `<工作区>/.dsh-codex-uploads/`，单文件最多 15 MB，每轮最多十个文件。文件路径随请求明确发送。包含 DeepSeek 成员的图片任务目前需要先提供文字说明或提取内容。

## 新接口

新接口前缀为 `/codex-chat/v2`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/bootstrap` | 通过 Session 或场景编号恢复工作区 |
| POST | `/scenarios/:id/sessions` | 创建 DSH 需求会话并绑定场景，使用 requestId 去重 |
| DELETE | `/scenarios/:id/sessions/:sessionId` | 携带场景 revision 解除会话绑定 |
| POST | `/scenarios/:id/sessions/:sessionId/open` | 核对绑定、恢复原生会话编号并补齐匹配的工作区登记 |
| DELETE | `/scenarios/:id` | 携带 revision 删除场景及插件内记录，解除全部绑定 |
| GET | `/directories?path=...` | 浏览工作区文件夹，供浏览器入口选择目录 |
| GET | `/scenarios` | 场景与活动 Session 列表 |
| GET / PATCH | `/scenarios/:id` | 读取场景、历史与任务，带版本保存配置 |
| GET | `/scenarios/:id/catalog` | Codex 与 DSH 模型、思考强度和技能目录 |
| POST | `/scenarios/:id/runs` | 创建幂等任务 |
| GET | `/scenarios/:id/events?after=<seq>` | SSE 订阅与补发 |
| POST | `/scenarios/:id/upload` | 上传附件 |
| GET | `/scenarios/:id/contexts` | 请求摘要，`detail=<id>` 读取完整快照 |
| GET | `/scenarios/:id/context-insights` | 仪表板摘要与活动，`agent` 筛选成员、`before` 翻页、`detail=<id>` 按需读取输入与工具结果 |
| GET / POST | `/scenarios/:id/memories` | 查询或新增场景记忆 |
| GET | `/runs/:id` | 任务、成员消息与过程事件 |
| POST | `/runs/:id/cancel` | 取消活动任务 |
| POST | `/runs/:id/answers` | 回传用户补充 |
| PATCH | `/runs/:id/profiles` | 调整成员后续步骤或待执行任务的扩展档位 |
| PATCH / DELETE | `/memories/:id` | 版本化修改或移除记忆 |
| GET | `/memories/:id/revisions` | 修订历史 |
| POST | `/memories/:id/import` | 将旧库条目关联到场景 |

## 保留的命令与接口

`/codex <消息>` 使用原有常驻 Codex 通道。`/codex new` 开新线程，`/codex open` 打开浏览器工作区，`/codex` 查询状态与实际地址。

原有 `/new`、`/send`、`/events`、`/state`、`/sessions`、`/options`、`/upload` 和 `/ping` 接口继续服务旧调用者。旧接口前缀为 `/codex-chat`，新工作区使用上述 v2 接口。

## 已核对的协议和注册要求

- Codex 模型传入 `thread/start.model`。
- 思考强度传入 `thread/start.config.model_reasoning_effort`，顶层思考强度字段会被忽略。
- `turn/start` 输入类型包括 `text/image/localImage/audio/localAudio/skill/mention`。
- 普通文件使用 `mention {name,path}` 时，也需要在提示词中明确写出绝对路径。新工作区同时保存附件清单与路径来源。
- 图片通过 `localImage` 传入 Codex。
- Codex 用户输入请求通过 `item/tool/requestUserInput` 接入主聊天中的补充表单。
- DeepSeek 的每成员路由通过 `startActivation.agentOptions` 的 `provider/model/reasoningEffort` 设置。
- 宿主硬依赖为 `commands/workingDirectory/webServer/subagents/agents`。`llm/skills/loader/sessionController/workspaceController/workspaceRegistry` 通过可选注入读取。
- 客户端硬依赖为 `slots/locale/sidebarRightTabs/sidebarRight`。
- 标签类型保留 `codex-chat`，`sidebar.right.pane.tab` 的注册键保留 `@local/dsh-codex-chat`。指南卡片由 `sidebarRightTabs.register` 提供。
- 全屏操作使用 `sidebarRight.commandTarget` 和 `sidebarRight.toggleFullscreen`。

## 开发与生效

源码通过 profile 中的 Junction 加载，修改此目录即可使用。宿主与 package.json 修改后重载插件。客户端注册模块走 HMR，共享界面资源在打开工作区时重新加载。

| 文件 | 职责 |
| --- | --- |
| `index.js` | 原有命令、Codex 传输、模型发现、HTTP 入口 |
| `client.js` | 原生 DSH 标签与全屏操作 |
| `page.js` | 浏览器入口 |
| `workbench.js` / `workbench.css` | 面板与浏览器共享界面 |
| `workbench-views.js` | 团队、分层记忆、场景关联与目录选择界面 |
| `workbench-host.js` | 新接口、引擎适配、工具和流式事件 |
| `coordinator.js` | 两种协作流程、任务状态、提问与记忆沉淀 |
| `context-dashboard.js` | 上下文仪表板、分类浏览、趋势与活动交互 |
| `context-insights.js` | 原生请求采集、用量归一化与活动汇总 |
| `scenario-store.js` | SQLite、迁移、来源快照与版本化记忆 |
| `test/render-smoke.cjs` | 渲染与主要交互冒烟检查 |

运行 `npm run test:render` 需要可用的 Playwright 与 Chromium。可通过 `DSH_PLAYWRIGHT_MODULE` 指定已有 Playwright 包路径，通过 `DSH_SMOKE_SCREENSHOTS` 指定截图目录。脚本使用临时数据库和模拟引擎检查界面与接口衔接。

完整质量验收在功能与界面定稿后集中进行。界面交付前执行渲染冒烟检查。

## 环境与日志

Node 运行时需要支持 `node:sqlite`。当前桌面宿主为 Node 24，已核对该能力。

`DSH_CODEX_BIN`、`DSH_CODEX_NODE`、`DSH_CODEX_MODEL` 保留原有用途。Codex 握手上限为 30 秒。协作阶段持续运行到引擎结束、连接故障或用户停止，执行中暂停空闲回收计时。接续任务携带原分工、已完成成员产物与中断状态，先核验实际文件再推进剩余工作。旧版独立聊天入口保留原有单轮时限。

诊断日志位于 `%TEMP%/dsh-codex-chat.log`。运行时数据和日志均位于源码目录之外。

## Windows 与 macOS 迁移

界面、协作调度与 SQLite 数据层使用跨平台 JavaScript。Codex 启动器会查找 profile 内的 `@openai/codex`，并支持系统 PATH、macOS 常见 Node/Codex 安装路径和 `DSH_CODEX_BIN`。当前已在 Windows 核对，macOS 实机运行仍待验证。

自用可将源码放进 Git 仓库，在 Mac 拉取后通过 DSH 插件管理安装本地目录或 Git 来源。DSH 插件市场读取插件索引，索引可引用 Git 或 npm 版本，发布到市场需要准备可安装来源及索引条目。GitHub 同步源码即可作为当前迁移方式，无需先上市场。

Mac 安装时，在 DSH 插件管理中选择从 Git 安装并填写 `git+https://github.com/ybcbcc/dsh-team-chat.git#main`。需要本地开发时，可先克隆源码。

```sh
git clone https://github.com/ybcbcc/dsh-team-chat.git
cd dsh-team-chat
```

随后通过 DSH 插件管理安装该本地目录。Codex 直接接入需要 Mac 版 Codex CLI；DSH 模型成员使用 Mac 上配置的模型供应商，其他 Agent 使用相应的 Mac 接入与授权。

Mac 需要自己的 Codex 可执行程序、授权和 DSH 模型配置。安装依赖时使用 Mac 对应的版本与架构。DSH 提供统一插件接口，文件路径、命令和外部进程仍使用当前操作系统。

需要迁移知识时，停止 DSH 后备份并复制 `~/.dsh/codex-chat/`。在 Mac 选择新的工作目录，并用当地新建的 DSH 会话绑定已有场景。旧附件路径、历史证据与外部技能路径保留原始来源，需要按 Mac 目录重新提供可用文件。
