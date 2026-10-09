<img width="3078" height="1376" alt="" src="https://github.com/user-attachments/assets/cc06146b-51a2-4b2e-a6c4-41aca0a0fb5e" />

# Auraxis 项目架构与开发文档

相关文档：[TS SDK](../packages/auraxis-sdk/README.md) · [Python SDK](../python/auraxis_sdk/README.md) · [工程规范](../AGENTS.md)

## 一、项目概述

Auraxis v3.5.0 是一款基于 Electron 的桌面端智能体工作台，融合了统一 ReAct 步进引擎、多智能体调度、Code Mode 工具编排、插件扩展和持久化项目记忆。执行语义遵循通用约定（`end_turn` 即回合结束，无剧本/强制门），ReviewArtifact 作为可选验证工具。后端 LLM 默认为 DeepSeek API（兼容 OpenAI / Anthropic 格式），联网搜索默认使用 DeepSeek 官方原生搜索（失败自动降级 DuckDuckGo，另支持 Exa / Perplexity provider）。DeepSeek 官方能力已接入：思考强度 low/high/max 三档、strict tools（Beta）、计划生成 JSON 模式、对话前缀续写（代码块“继续写”）、FIM 补全（Beta）API、流式 usage 与上下文缓存命中展示、user_id 隔离、可配置单次最大输出 tokens（上限 384K）、官方离线 tokenizer 本地计数。

项目采用**论文驱动开发**：已落地 7 篇 arXiv 论文的核心技术——Eywa（溯源长期记忆）、MAP-Graph（多 Agent 共享记忆授权）、AGORA（步骤级上下文压缩）、SWE-Touch（工作区漂移感知）、Oversight Has a Capacity（审批疲劳守卫）、AutoTool（工具使用惯性）、Verifier-as-Gatekeeper（技能库污染门禁）；另落地 4 项缓存方向论文/系统技术——RadixAttention（规范历史重放 / 公共前缀最大化）、Prompt Cache（稳定块组织）、Cache-Aware Prompt Compression（动态内容尾部化）、Byte-Exact Deduplication（记忆块字节级去重）。论文地址、技术映射与落地模块详见「[第五章 研究论文与技术落地](#五研究论文与技术落地)」。产品侧新增本地账户登录、Chat / Work / Code 三模式、思考与联网搜索开关、Agent 执行流程视图、会话事件时间轴、上下文缓存对齐等能力。

- **主进程**：Electron 主进程（`electron/`），负责窗口管理、IPC 通信、工具执行、智能体调度
- **渲染进程**：React 19 + Vite 8（`src/`），负责 UI 渲染、状态管理、用户交互
- **进程通信**：通过 Electron IPC（`contextBridge` + `ipcMain/ipcRenderer`）进行双向通信

### 1.1 v3.5.0 发布亮点

- **评测回归门禁**：评测框架终于有了牙齿。`eval:diff` 把"这次有没有变差"变成退出码
  （逐用例 / 逐检查 / 过程门槛 / 验证等级 / 共同用例上的 token 和）；两次运行不可比时
  （schema 版本、dry vs live、工具 schema 指纹缺失或漂移）**拒绝比较并说明原因**，
  而不是给一个"没有回归"的假安全感。`evals/baseline/` 冻结入库（机器路径与轨迹在冻结时
  被投影掉），CI 另外跑无需 Key 的 `agent-eval --dry` 与工具 schema 指纹检查。
- **修复动态工具装载的真回归**：`selectToolsForTask` 只保留"学习核心集 ∪ 命中分组"，
  而 `mcp__<server>__<tool>` 这类名字落不进任何分组正则、被判为 `misc`，而 `misc`
  永不被选中 —— 装了 MCP，Agent 却看不见自己的工具。现在由显式的保留集兜住来路不明的
  名字（测试用变异验证过）。
- **Agent Activity View**：连续同类**已完成**操作合并成一行（`读取 4 个文件` /
  `检索 3 次 · 命中 14 处` / `运行命令 3 条`），正在跑、失败、被取消与带 ± 的改动
  各占自己的行；长任务只在结束后折最早的段。流式终端尾部（8KB / 200 行，按行边界切，
  ANSI 不截断）、由 `TodoWrite` 生成的真实计划卡、执行行内就地审批、上滚时用
  「有新活动」代替强制回底、行级复制 / 终端 / 查看 Diff，以及让"漏接渲染器"变成
  编译错误的派发注册表。
- **UI 打磨以事实为依据，不以观感**：约 178 处**从未生成任何 CSS** 的 utility 类被恢复
  （此前"次要文字"实际渲染成满对比度正文色、hairline 渲染成实心近黑线）；success /
  warning / danger 三色调整到 WCAG AA；四组 Ant Design 6 选择器覆盖修正、两组指向
  库已不再渲染的类被删除；中英各清掉 40+ 条死 i18n 键；令牌文档与实现对齐
  （`tokens.css` 优先于 `@theme` 块，后者有 5 个值是从未生效的谎话）。
- **右侧工作台面板重做**：清单 → 详情两态导航，`+` 的含义是"给**这个模块**新增一个条目"
  （不是再开一栏）；详情头承载全屏与分栏；产物并入变更（同一批文件，信息更全）；
  删掉重复的第 5 处 Agent 列表；七行全部带快捷键提示，并由用例与全局绑定表交叉守卫。
- **注册 / 登录页围绕品牌视觉重做**：整屏品牌底图（靠左对齐，标记不会被裁切）+
  玻璃表单卡；登录 / 注册改为滑块分段控件（复用应用既有的 radiogroup 实现），注册表单
  按「账户 / 模型接入」分段。这一层**刻意只做深色** —— 就地作用深色调色板并切到 antd
  `darkTheme`，浅色主题下不会出现浅色输入框压在暗底上；不新增任何色值，
  全部由 `color-mix` 从 `tokens.css` 派生。
- **品牌执行标记**：位图 loading GIF 换成 SVG/CSS 的 Axis Mark（倾斜光环 + 巡行弧，
  用 `pathLength=100` 归一化），并遵循 `prefers-reduced-motion` —— 位图做不到这一点。
- **会话**：归档 / 取消归档贯通会话 meta 契约并镜像进投影缓存（`PROJECTION_VERSION` 3），
  启动时的重投影不会再让已归档的会话自己回到列表里。
- **沙箱**：启动失败一律 fail-closed（拒绝执行，绝不降级成无沙箱）。AppContainer 后端在
  验证过程中记录了一条真实的 OS 限制：容器内的 `cmd.exe` 无法派生外部可执行文件
  （`0xC0000142`），而容器直接启动与 cmd 内建命令正常。
- **质量门禁**：325 个测试文件 / 2,739 用例通过（平台/CI 相关跳过不在其中），
  SDK 构建、SDK 真实 runtime 冒烟、E2E、审计与三平台 Release CI 均通过。

### 技术栈

<img width="1462" height="861" alt="" src="https://github.com/user-attachments/assets/7f6f67f1-d32c-4d82-a374-dd5d4174fdcc" />

| 层            | 技术                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 桌面框架      | Electron 44（Node 24，内置 `node:sqlite`），无边框窗口，`contextIsolation: true`                                                  |
| 前端          | React 19 + TypeScript 6 + Vite 8                                                                                                  |
| UI 组件库     | Ant Design 6，自定义深色/浅色主题                                                                                                 |
| 状态管理      | Zustand 5；会话/设置/插件状态以主进程为权威，localStorage 仅作渲染层缓存                                                          |
| 存储与检索    | 会话/Agent 统一 JSONL 事件日志 + SQLite 投影缓存 + FTS5 全文搜索 + 长期记忆（node:sqlite 优先 / better-sqlite3 兜底 / JSON 回退） |
| Markdown 渲染 | react-markdown + remark-gfm + remark-math + rehype-katex + highlight.js + mermaid                                                 |
| AI API        | axios（SSE 流式请求），支持 DeepSeek/OpenAI 格式和 Anthropic 格式；MCP、AGENTS.md、生命周期 hooks 协议                            |
| 测试          | Vitest + @testing-library/react + jsdom（渲染进程），node 环境（主进程）                                                          |
| 构建          | Vite + electron-builder 26（NSIS/DMG/AppImage；`npmRebuild: false` 跳过原生重编译，better-sqlite3 缺失时回退 JSON）               |

### 基础设施

- **headless CLI**：`npm run cli -- --run "<任务>"`（模型/项目/权限/沙箱/JSON 输出），另有 `--sdk` / `--acp` / `--plugin list|scan|enable|disable`
- **对外 SDK**：TypeScript（`packages/auraxis-sdk`，TCP JSON-RPC）与 Python（`python/auraxis_sdk`）
- **Code Mode**：`RunCode` 的 TypeScript 程序在工作线程中 `await tools.Name(args)` 编排工具，子调用回穿完整权限管线（8 路并发重叠、硬超时）
- **图片输入**：`ReadImage` + 内容寻址附件存储，多模态结果自动转 OpenAI `image_url` / Anthropic `image` block；`deepseek-v4-flash-vision-exp` 接收图片块，非视觉 DeepSeek 模型降级为文本
- **后台任务**：`Task*` / `Job*` 统一管理后台 bash、终端任务与子 Agent；`Schedule*` 支持 after/at/every 会话内跟进
- **终端**：底部可拖拽终端抽屉 + `Terminal*` 六件套模型工具 + PTY 持久会话 + SSH
- **原生沙箱**：Windows restricted token / AppContainer、Linux、macOS 四种后端 + worktree 隔离 + read-before-write 观测硬门
- **工作流隔离**：模型编排脚本运行在 worker thread，超时可强杀
- **Work 文档协作**：默认「开工前先澄清」（AskUser 提问）+ 仅文档/非代码文件硬边界；分层 Instructions（全局 → 项目根 → 嵌套文件夹 AGENTS.md）可在设置面板直接维护
- **专业文档技能**：`ReadDocument` / `WriteDocument` / `IngestDocument`（长文档切块收进项目记忆）读写 Word（.docx）、Excel（.xlsx）、PPT（.pptx）、PDF（.pdf），内置 5 个开箱即用技能（Word / Excel / PPT / PDF / 云连接器）
- **云连接器**：Slack（列频道/发消息）、Google Drive（检索/读取）、Notion（搜索/建页），Token 经 safeStorage 加密保存，设置 → 连接器 配置
- **会话标题**：LLM 生成 + 规则回退；**逐消息评分**、**附件画廊/灯箱**、**图片草稿栏**
- **外观设置**：主题模式（跟随系统/浅/深）、中英双语、侧边栏透明度（Windows 11 原生 Acrylic 磨砂透出桌面）；设置面板内置真实测试覆盖率报告（`coverage/coverage-summary.json`）
- **登录与账户**：本地优先账户（密码仅存 scrypt 哈希，不落明文），首启注册 → 登录门 → 头像上传；注册不会自动解锁，“记住我”仅在成功登录后生效；注册流程可直接填写 DeepSeek API Key，也可跳过后在设置面板配置
- **研究驱动模块**：AGORA 步骤级压缩、SWE-Touch 工作区漂移、Oversight 审批疲劳、AutoTool 工具惯性、VaG 技能门禁，统一由 step-engine / agent-loop / tool-runner 等内部消费
- **遥测**：opt-in（`AURAXIS_TELEMETRY_MODE`），严格白名单脱敏，NDJSON 上报

---

## 二、进程模型与目录结构

### 2.1 双进程架构

```
┌─ Electron 主进程 (electron/) ──────────────────────────────┐      ┌─ 渲染进程 (src/) ────────────────────────┐
│ main.ts         窗口创建 / CSP / 单实例锁                │      │ main.tsx → App.tsx                     │
│ preload*.ts     contextBridge API（按域拆分）            │ ◄──► │ React 19 + Ant Design 6                │
│ ipc/index.ts    46 个 register* 装配点                   │  IPC │ Zustand Stores（18 个）                │
│ ipc/            宿主层：查询 / 调度 / 工具 / 记忆        │      │ src/core/         插件 / 技能 / 命令   │
│ agent-runtime/  纯引擎：loop / step-engine / LLM /       │      │ src/components/   chat·input·layout    │
│                 context-manager / tool-runner            │      │                   agent·work·preview   │
│ tool-defs/      71 个内置工具定义                        │      │ @/ 别名           → src/               │
│ 服务端          sdk-server / acp-server / headless       │      │                                        │
└──────────────────────────────────────────────────────────┘      └────────────────────────────────────────┘
```

**引擎边界**：`electron/agent-runtime/` 是纯引擎（loop / step-engine / LLM 适配器 / context-manager / tool-runner / step-compressor），**不得**出现指向 `electron/ipc/**` 的**值**依赖（`import type` 允许）；宿主能力（窗口、存储、设置、记忆、权限）一律经 `agent-runtime/ports.ts` 的 `RuntimePorts` 注入，实现在 `electron/ipc/runtime-ports.ts` 装配，桌面、无头 CLI 与测试共用。守卫：`npm run check:runtime-boundary`（CI 阻塞）。

### 2.2 目录结构

```
Auraxis/
├── electron/                    # 主进程代码（Node.js 环境）
│   ├── main.ts                  # 应用入口：窗口创建、CSP、单实例锁、启动维护
│   ├── preload.ts               # contextBridge 引导（实际桥接见下列领域模块）
│   ├── preload-{platform,core,ai,rest,shared}.ts # 按域拆分的 IPC 桥接模块
│   ├── preload-api.ts           # IPC 桥接组合
│   ├── vite.preload.config.mts  # 沙箱安全 preload 打包（仓库根目录）
│   ├── contracts/               # 跨进程类型单一事实源
│   │   └── core / tools / advanced / session-types / auth / permission / project / update
│   ├── types.ts / advanced-defs.ts # 兼容 re-export（实际类型在 contracts/）
│   ├── tool-defs.ts             # 内置工具定义聚合入口
│   ├── tool-defs/               # 71 个 AI 工具定义（名称、描述、入参 schema）
│   │   └── core / files / network / planning / scheduling / workflows / devtools /
│   │       documents / integrations / terminal / runtime / types
│   ├── tool-capability.ts       # 工具副作用单一矩阵（危险/读写/终端/代码执行/Work 禁区）
│   ├── tool-risk.ts             # 工具风险分级
│   ├── tool-registry.ts         # 工具来源装配与批次执行（builtin / MCP / 插件）
│   ├── tool-provider.ts         # 工具来源统一抽象 ToolProvider（中立叶子，无 electron 依赖）
│   ├── permission-profile.ts    # 权限档案（standard / readonly / sandbox / custom）
│   ├── agent-runtime/           # 纯引擎：不得值依赖 ipc/（宿主能力经 ports.ts 注入）
│   │   ├── step-engine.ts       # 统一 ReAct 步进（step-engine-{contracts,context,tools,tool-results}.ts）
│   │   ├── agent-loop.ts        # Agent 驱动门面（-driver / -core / -planner / -context / -stop /
│   │   │                        #   -inject / -interceptors / -messages / -prepare / -planning / -utils / -types）
│   │   ├── context-manager.ts   # 上下文管理（-compact / -snapshot / -summary / -utils / -types）
│   │   ├── llm-adapter.ts       # LLM 适配（llm-provider-{openai,anthropic,responses,format}.ts、
│   │   │                        #   llm-streams.ts、llm-types.ts）
│   │   ├── llm-adapter-ai-sdk.ts # AI SDK 6 影子适配器（默认不启用，注册阶段零加载）
│   │   ├── tool-runner.ts       # 工具执行编排（+ tool-result-prune.ts 大结果剪枝）
│   │   ├── step-compressor.ts   # AGORA 步骤级压缩
│   │   ├── text-filter.ts       # 模型产物剥离（thinking 标签、零宽字符等）
│   │   └── engine-events.ts / ports.ts # 事件契约与宿主能力端口
│   ├── ipc/                     # 宿主层：IPC 处理器与编排
│   │   ├── index.ts             # registerIpcHandlers() 总入口（46 个 register* 装配点）
│   │   ├── ai-handlers.ts (+ -stream / -utils) # 聊天流、FIM 补全、连接测试
│   │   ├── query-engine.ts      # Work/Code 查询驱动（循环委托 step-engine）
│   │   ├── query-context.ts     # 规范上下文快照（缓存对齐重放 / 记忆去重 / 失效墓碑）
│   │   ├── agent-handlers.ts    # 子 Agent runner + IPC 注册（定义见 agent-defs.ts）
│   │   ├── agent-defs.ts        # 内置 Agent 角色定义（Explore / Plan / general-purpose）
│   │   ├── agent-subagent-registry.ts # 子 Agent 注册表与观察器
│   │   ├── agent-scheduler*.ts  # 调度器：-class-impl / -permission / -support / -types /
│   │   │                        #   -runtime / -snapshot / -query / -queue / -lifecycle / -runner / -cleanup
│   │   ├── agent-iteration-budget.ts # 迭代预算解析（请求 → 设置 → 200，收敛 1–500）
│   │   ├── tool-handlers.ts     # 工具执行兼容 facade（注册表/管线见 tool-handlers/）
│   │   ├── tool-handlers/       # registry / pipeline / internal / bash / file-tools / network /
│   │   │                        #   terminal / integrations / agents / session / runtime / worktree /
│   │   │                        #   lsp / review / execution / backup / path-utils / executor-port /
│   │   │                        #   abort-registry / task-cache
│   │   ├── memory-*.ts          # 溯源记忆：db / db-sqlite-* / evidence / extractor / read /
│   │   │                        #   graph / ipc / signal-rules / signal-llm / belief-validation
│   │   ├── permission-handlers.ts / path-security.ts / trust.ts # 权限、路径边界与来源校验
│   │   ├── mcp-handlers.ts      # MCP 客户端策略层（官方 SDK transport、工具发现、安全验证）
│   │   ├── model-config.ts      # 模型解析（内置 + 环境变量 + 持久化）
│   │   ├── settings-store.ts    # 加密持久化设置（API Key 使用 safeStorage）
│   │   ├── conflict-detector.ts # 多 Agent 文件锁防并发写入冲突
│   │   ├── undo-manager.ts      # 文件级撤销（快照 + 恢复 + 最佳检查点）
│   │   ├── plan-handlers.ts / goal-handlers.ts / cron-handlers.ts # 计划审批、目标与定时任务
│   │   ├── session-log-handlers.ts / chat-log-handlers.ts / title-handlers.ts # 事件日志与标题
│   │   ├── terminal-handlers.ts / task-monitor.ts / shell-executor.ts / pty-tool.ts # 终端与后台任务
│   │   ├── update-handlers.ts   # 自动更新 IPC
│   │   ├── runtime-ports.ts     # RuntimePorts 装配（桌面 / 无头 CLI / 测试共用）
│   │   └── __tests__/           # IPC 层测试（138 个文件）
│   ├── utils/                   # guards.ts / token-counter.ts
│   ├── tokenizer/               # 官方离线 tokenizer 词表（tokenizer.json）
│   ├── __tests__/               # 主进程模块测试（27 个文件）
│   ├── session-store.ts / chat-log.ts / session-log.ts / session-projection-cache.ts / fts.ts
│   ├── code-mode.ts / code-runtime.ts / workflow-engine.ts / lsp-client.ts
│   ├── document-tools.ts / connectors.ts / attachments.ts / spill.ts / mcp-oauth.ts
│   ├── sandbox-runner.ts / sandbox-policy.ts / network-policy.ts / safe-env.ts
│   ├── rules.ts / hooks.ts / work-docs-policy.ts / skill-gate.ts / skill-store.ts
│   ├── workspace-drift.ts / approval-fatigue.ts / tool-inertia.ts / runtime-inspect.ts
│   ├── auth-store.ts / credentials.ts / ssh-store.ts / schedule-store.ts / goal-store.ts
│   ├── agent-instructions.ts / agent-snapshot.ts / api-config.ts / log-retention.ts
│   ├── updater.ts / version-guard.ts / actions.ts / errors.ts / dev-log.ts / text-encoding.ts
│   └── acp-server.ts / sdk-server.ts / headless-run.ts / cli-args.ts / plugin-cli.ts / fork-runner.ts
│
├── src/                         # 渲染进程代码（浏览器环境）
│   ├── main.tsx                 # React 入口
│   ├── App.tsx                  # 根组件：布局、主题、权限对话框、命令面板
│   ├── components/              # UI 组件
│   │   ├── layout/ (36)         # 侧边栏、顶部栏、右侧面板、导航、预览浏览器
│   │   ├── input/ (25)          # 输入 Dock、思考深度滑轨、模式切换器
│   │   ├── settings/ (20)       # 设置面板（含 AccountPane 账户页）
│   │   ├── chat/ (16)           # 消息列表、气泡、Markdown 渲染、工具时间轴
│   │   ├── inspector/ (15)      # 执行详情、上下文清单、时间线
│   │   ├── common/ (16)         # 通用组件与 lucide 图标兼容层
│   │   ├── agent/ (11)          # Agent 管理面板 + 执行流程视图
│   │   ├── work/ (8)            # Work 模式看板 + 执行流程视图
│   │   ├── tools/ (6) / memory/ (3) / auth/ (2) / permissions/ (2) / skills/ (1) / preview/ (1)
│   ├── stores/                  # Zustand 状态管理（18 个 Store + 同目录 helper）
│   │   ├── useChatStore.ts      # 聊天消息、流、重试、项目上下文、记忆注入
│   │   ├── useAuthStore.ts      # 登录状态、账户信息、头像
│   │   ├── useSettingsStore.ts  # API Key、默认模型、通知
│   │   ├── useAppStore.ts       # 主题、侧边栏、右侧面板、导航历史
│   │   ├── useAgentStore.ts     # Agent CRUD、优先级、并发（模块层订阅 agent:event 并 RAF 节流）
│   │   ├── useSessionStore.ts   # 会话保存/加载/删除/导出/分叉（最多 200 个）
│   │   ├── useProjectStore.ts   # 项目注册表、当前项目、工作区排序
│   │   ├── usePluginStore.ts    # 已安装插件、启用/禁用
│   │   ├── useMemoryStore.ts    # 活跃/搜索记忆（从主进程加载）
│   │   ├── useFileTreeStore.ts  # 文件树、展开路径
│   │   ├── useUndoStore.ts      # 撤销条目跟踪
│   │   ├── useInspectorStore.ts # 计划、系统消息、活跃工具计数（数据层）
│   │   ├── useWorktreeStore.ts  # Worktree 沙箱状态（激活/沙箱路径）
│   │   ├── useAdvancedStore.ts  # MCP 服务器、权限规则
│   │   ├── useTerminalTasksStore.ts / useNotificationStore.ts / useMessageFeedbackStore.ts
│   │   ├── useKeybindingsStore.ts # 快捷键覆盖
│   │   └── helpers：chatStoreHelpers / chatSendMessage / chatStreamRuntime / chatActions /
│   │       chatContinueCode / chatRuntime / chatSendEvents / chatStoreSideEffects /
│   │       chatPlanListener / agentStore{Helpers,Actions,Buffers,Events} /
│   │       sessionStore{Helpers,Actions,Types} / sessionModeSwitch /
│   │       settingsStore{Actions,Types} / debouncedStorage
│   ├── core/                    # 插件 / 技能 / 工具与命令注册表（plugin-manager、plugin-loader、
│   │                            #   tool-registry、command-registry、skills、agent-launch）
│   ├── services/                # ai-service.ts（浏览器端回退）、replBridge.ts
│   ├── types/                   # 渲染层类型（advanced/agent 为 contracts 纯再导出）
│   ├── i18n/                    # 中英文案（zh-CN / en-US）
│   ├── utils/                   # 17 个纯函数工具（unifiedDiff、paths、time、slashCommands 等）
│   ├── hooks/                   # useAppRuntimeEffects / useAppShortcuts / useModels 等 6 个
│   ├── constants/               # 快捷键、扩展颜色常量
│   ├── plugins/                 # 内置示例插件（example-timestamp / example-uuid）
│   ├── styles/                  # tokens.css / theme.ts 等主题与样式
│   └── test/ + __tests__/       # 测试环境装配与渲染层跨模块守卫测试
│
├── packages/                    # 对外 TypeScript SDK（TCP JSON-RPC）
├── python/                      # 对外 Python SDK
├── e2e/                         # Playwright 端到端（真实 Electron）
├── .github/workflows/           # CI：三平台构建、单元/覆盖率门禁、文档与格式校验、E2E、原生沙箱作业
├── scripts/                     # 开发与门禁脚本（check-docs / check-cycles / check-runtime-boundary /
│                                #   check-lint-budget / check-preload-bundle / sdk-smoke /
│                                #   smoke-electron / auraxis-mcp-preload / electron-dev）
├── docs/                        # README.md（英文）/ README.zh-CN.md（中文）/ THIRD_PARTY_NOTICES.md
├── package.json
├── tsconfig.json                # 渲染层+主进程共同类型检查（ESNext/bundler, @/* → src/*）
├── tsconfig.node.json           # Vite 配置专用（composite，独立入口）
├── tsconfig.electron.json       # 主进程 TS 配置（CommonJS → dist-electron/, rootDir: electron/）
├── vite.config.mts              # Vite 构建配置
├── vite.preload.config.mts      # 沙箱安全 preload 打包配置
├── vitest.config.mts            # 测试配置（阈值：行/语句/分支/函数 ≥80%）
├── playwright.config.ts         # E2E 配置
├── electron-builder.yml         # 打包配置（NSIS/DMG/AppImage）
└── .env.example                 # 环境变量模板
```

### 2.3 TypeScript 配置要点

根目录有三个 `tsconfig`（另有 SDK 自带的 `packages/auraxis-sdk/tsconfig.json`）：

- `tsconfig.json`：渲染层与主进程共同类型检查（ESNext/bundler，`@/* → src/*`，`include: ["src", "electron"]`）
- `tsconfig.electron.json`：主进程编译（`rootDir: "electron/"`，CommonJS 输出到 `dist-electron/`）
- `tsconfig.node.json`：Vite 配置专用（`composite: true`，独立入口，当前无其它配置引用它）

`rootDir: "electron/"` 意味着主进程不能 import `src/` 的实现，因此**跨进程类型只在 `electron/contracts/`（`core` / `tools` / `advanced` / `session-types` / `auth` / `permission` / `project` / `update`）定义一次**：`electron/types.ts`、`electron/advanced-defs.ts` 与渲染层的 `src/types/{advanced,agent}.ts` 只做 re-export（`src/types/electron-api.ts`、`chat.ts`、`tools.ts` 等是渲染层投影与自有类型，不镜像 contracts）。新增共享类型必须放进 `contracts/`，禁止在 `src/` 再复制一份。

**能力 seam**：`SessionStore`、`ShellExecutor`、`LlmAdapter` 三个接口用于替换实现，换实现走 seam，不直接改消费方。
---

## 三、IPC 通信体系

### 3.1 通信流程

```
渲染进程 (React)                    主进程 (Electron)
─────────────────                   ─────────────────
window.electronAPI.ai.sendQuery()
  → ipcRenderer.invoke()    ──→    ipcMain.handle('ai:sendQuery', ...)
                                      ↓
                                   query-engine.ts 执行 ReAct 循环
                                      ↓
                                   win.webContents.send('ai:queryEvent:${id}', ...)  // win 由 event.sender 解析
  ← ipcRenderer.on()        ←──        ↓
  → callback.onEvent(data)           (每步工具执行、文本块、错误等)
```

### 3.2 IPC 通道命名规范

**格式**：`domain:action`（冒号分隔）。域名为单段小写，复合域用 camelCase（`chatLog` / `sessionLog` / `sessionTitle` / `agentShell` / `pluginState`），动作用 camelCase；主→渲染事件允许 kebab-case（如 `window:maximize-changed`）；`terminal:tasks:*` 为三段式例外。

### 3.3 IPC 响应规范

业务域处理程序统一返回（定义见 `electron/contracts/core.ts`）：

```typescript
interface IpcResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
```

例外：窗口控制类返回裸值或不返回（`window:isMaximized` → boolean、`window:zoom` → number、`window:minimize` / `maximize` / `close` → void），`ai:abortStream` / `ai:abortQuery` 同样返回 void。

### 3.4 流式通信

流请求使用**独立的事件通道**：

- 聊天流：`ai:chunk:${requestId}`
- 查询流：`ai:queryEvent:${requestId}`
- Agent 事件：`agent:event:${agentId}`

`ai:chunk:*` / `ai:queryEvent:*` 在请求创建时注册监听器，在收到 `done`/`error` 事件或调用 `abort` 时自动清理；`agent:event:${agentId}` 在事件订阅建立时注册，订阅只返回 unsubscribe，Agent 结束后由渲染层延迟释放。

### 3.5 完整 IPC 通道表

下表按域列出**全部**已注册通道：渲染→主为 `invoke` 通道（统一经 `electron/ipc/trust.ts` 的 `secureHandle` 包装 `ipcMain.handle` 并校验来源），主→渲染为 `webContents.send` 事件通道；`—` 表示该域没有事件通道。通道名可用 `grep -rho "secureHandle('[^']*'" electron` 重新生成核对。

| 域               | 渲染→主（invoke）                                                                                                                                                                                                                                                                                                               | 主→渲染（事件）                                                               | 说明                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| **window**       | `window:minimize` / `window:maximize` / `window:close` / `window:focus` / `window:isMaximized` / `window:zoom` / `window:glassState` / `window:setBackgroundMaterial` / `window:backgroundMaterialSupported`                                                                                                                    | `window:maximize-changed`                                                     | 窗口控制、缩放与 Windows 11 Acrylic 磨砂材质              |
| **shell**        | `shell:openExternal` / `shell:openPath` / `shell:openInVSCode` / `shell:openFileInVSCode` / `shell:openSkillsDirectory`                                                                                                                                                                                                         | —                                                                             | 外部链接/路径打开与 VS Code 集成                          |
| **file**         | `file:open` / `file:read` / `file:readPreview` / `file:write` / `file:search` / `file:estimateTokens` / `file:delete` / `file:rename` / `file:createFolder` / `file:createFile`                                                                                                                                                 | —                                                                             | 文件读写、预览、增删改名与 token 估算                     |
| **project**      | `project:getTree` / `project:applyCode` / `project:previewCode` / `project:selectDirectory` / `project:loadGlobalState` / `project:saveGlobalState`                                                                                                                                                                             | —                                                                             | 项目文件树、代码应用/预览与全局项目状态                   |
| **context**      | `context:getProjectContext` / `context:getFileStructure` / `context:readFile` / `context:compact`                                                                                                                                                                                                                               | —                                                                             | 项目上下文、文件结构与手动压缩                            |
| **ai**           | `ai:chatStream` / `ai:sendQuery` / `ai:testConnection` / `ai:fim` / `ai:abortStream` / `ai:abortQuery` / `ai:abortTool` / `ai:retryTool` / `ai:clearQueryContext`                                                                                                                                                               | `ai:chunk:${requestId}` / `ai:queryEvent:${requestId}`                        | 聊天流、Work/Code 查询、FIM 补全、中止重试与快照作废      |
| **memory**       | `memory:extract` / `memory:getByProject` / `memory:getByType` / `memory:search` / `memory:archive` / `memory:delete` / `memory:evidenceList` / `memory:evidenceDetail` / `memory:readForQuery` / `memory:readTrace` / `memory:beliefAudit` / `memory:rejections` / `memory:erase` / `memory:reindex` / `memory:graph`           | —                                                                             | 记忆 CRUD、证据/信念审计、确定性检索与级联擦除（Eywa/M5） |
| **agent**        | `agent:start` / `agent:sendMessage` / `agent:continue` / `agent:pause` / `agent:resume` / `agent:schedulerStop` / `agent:schedulerRemove` / `agent:approveDelivery` / `agent:setPriority` / `agent:setMaxConcurrent` / `agent:getQueue` / `agent:getAll` / `agent:getState` / `agent:remove` / `agent:clear` / `agent:clearAll` | `agent:updated` / `agent:event:${agentId}` / `agent:message` / `agent:report` | 调度器生命周期、续跑、队列并发与子 Agent 消息             |
| **agentShell**   | `agentShell:attach` / `agentShell:detach` / `agentShell:write`                                                                                                                                                                                                                                                                  | —                                                                             | Agent 终端壳的挂载/写入/卸载                              |
| **mcp**          | `mcp:getServers` / `mcp:setServers` / `mcp:connect` / `mcp:disconnect` / `mcp:getStatuses` / `mcp:listTools` / `mcp:callTool`                                                                                                                                                                                                   | —                                                                             | MCP 服务器配置、连接与工具发现/调用                       |
| **permission**   | `permission:respond` / `permission:addRule` / `permission:removeRule` / `permission:getRules` / `permission:clearRules` / `permission:listProfiles` / `permission:listProjectProfiles` / `permission:setProjectProfile` / `permission:moveProjectProfile` / `permission:saveProfiles`                                           | `permission:request`                                                          | 权限响应、规则与权限 profile 管理                         |
| **plan**         | `plan:approve` / `plan:reject` / `plan:list`                                                                                                                                                                                                                                                                                    | `plan:generated`                                                              | 计划审批与计划列表                                        |
| **undo**         | `undo:getHistory` / `undo:getList` / `undo:execute` / `undo:revert` / `undo:revertLast` / `undo:getSessionDiffs` / `undo:revertSessionFile` / `undo:revertSessions` / `undo:markBest` / `undo:restoreBest` / `undo:listBest`                                                                                                    | —                                                                             | 撤销/恢复、最佳检查点与会话级文件回滚（右舱「变更」）     |
| **conflict**     | `conflict:getConflicts` / `conflict:getFileHistory`                                                                                                                                                                                                                                                                             | —                                                                             | 并发写入冲突与文件修改历史                                |
| **snapshot**     | `snapshot:create` / `snapshot:list` / `snapshot:restore` / `snapshot:delete`                                                                                                                                                                                                                                                    | —                                                                             | 命名快照管理                                              |
| **system**       | `system:getStats` / `system:getGitBranches` / `system:getVersion` / `system:getAccountInfo`                                                                                                                                                                                                                                     | —                                                                             | 系统统计、Git 分支、版本与 DeepSeek 余额（/user/balance） |
| **settings**     | `settings:get` / `settings:set`（含 permissionPreset / sandboxMode 统一运行权限持久化） / `settings:getApiKeyStatus`                                                                                                                                                                                                            | —                                                                             | 设置读写与 API Key 配置状态                               |
| **api**          | `api:setKey`                                                                                                                                                                                                                                                                                                                    | —                                                                             | API Key 写入                                              |
| **coverage**     | `coverage:get`                                                                                                                                                                                                                                                                                                                  | —                                                                             | 读取测试覆盖率报告（coverage/coverage-summary.json）      |
| **auth**         | `auth:status` / `auth:setup` / `auth:login` / `auth:logout` / `auth:changePassword` / `auth:changeName` / `auth:setAvatar` / `auth:reset`                                                                                                                                                                                       | —                                                                             | 本地账户注册/登录/改密/改昵称/头像/重置                   |
| **model**        | `model:getAll`                                                                                                                                                                                                                                                                                                                  | —                                                                             | 获取所有可用模型                                          |
| **app**          | —                                                                                                                                                                                                                                                                                                                               | `app:error`                                                                   | 未捕获异常/未处理 Promise 拒绝                            |
| **cron**         | `cron:create` / `cron:delete` / `cron:list`                                                                                                                                                                                                                                                                                     | —                                                                             | 应用内定时任务的创建/删除/列出                            |
| **worktree**     | `worktree:getStatus`                                                                                                                                                                                                                                                                                                            | `worktree:changed`                                                            | Agent worktree 沙箱状态与激活事件                         |
| **update**       | `update:getState` / `update:check` / `update:download` / `update:install`                                                                                                                                                                                                                                                       | `update:state`                                                                | 自动更新状态机（electron/updater.ts）                     |
| **pluginState**  | `pluginState:get` / `pluginState:set`                                                                                                                                                                                                                                                                                           | —                                                                             | 插件启用状态读写                                          |
| **skills**       | `skills:list` / `skills:read`                                                                                                                                                                                                                                                                                                   | —                                                                             | 本地技能列表与读取                                        |
| **stats**        | `stats:get` / `stats:reset`                                                                                                                                                                                                                                                                                                     | —                                                                             | 运行统计                                                  |
| **workflow**     | `workflow:list` / `workflow:get` / `workflow:run` / `workflow:runs`                                                                                                                                                                                                                                                             | —                                                                             | 工作流列表与运行记录                                      |
| **fts**          | `fts:search` / `fts:rebuild`                                                                                                                                                                                                                                                                                                    | —                                                                             | 全文检索与索引重建                                        |
| **chatLog**      | `chatLog:append` / `chatLog:read` / `chatLog:list` / `chatLog:project` / `chatLog:delete` / `chatLog:fork` / `chatLog:meta`                                                                                                                                                                                                     | —                                                                             | 聊天 JSONL 事件日志读写、投影与分叉                       |
| **sessionLog**   | `sessionLog:read` / `sessionLog:project`                                                                                                                                                                                                                                                                                        | —                                                                             | Agent 会话日志读取与投影                                  |
| **sessionTitle** | `sessionTitle:generate`                                                                                                                                                                                                                                                                                                         | —                                                                             | 会话标题生成（LLM + 规则回退）                            |
| **goal**         | `goal:get` / `goal:create` / `goal:edit` / `goal:pause` / `goal:resume` / `goal:complete` / `goal:block` / `goal:clear` / `goal:round`                                                                                                                                                                                          | —                                                                             | 持久目标生命周期                                          |
| **credentials**  | `credentials:describe` / `credentials:set` / `credentials:unset`                                                                                                                                                                                                                                                                | —                                                                             | 凭据描述/写入/删除                                        |
| **connector**    | `connector:status` / `connector:setToken` / `connector:getLark` / `connector:setLark` / `connector:test`                                                                                                                                                                                                                        | —                                                                             | 云连接器（Slack / Drive / Notion / Lark）状态与 Token     |
| **instructions** | `instructions:getGlobal` / `instructions:setGlobal` / `instructions:listProject` / `instructions:get` / `instructions:set`                                                                                                                                                                                                      | —                                                                             | 分层 Instructions（全局/项目）读写                        |
| **actions**      | `actions:list`                                                                                                                                                                                                                                                                                                                  | —                                                                             | 可用动作清单                                              |
| **ask**          | `ask:respond`                                                                                                                                                                                                                                                                                                                   | `ask:request`                                                                 | AskUser 提问的响应与请求                                  |
| **runtime**      | `runtime:syncPlugins`                                                                                                                                                                                                                                                                                                           | —                                                                             | 运行时插件同步                                            |
| **tokenizer**    | `tokenizer:count`                                                                                                                                                                                                                                                                                                               | —                                                                             | 官方离线 tokenizer 计数                                   |
| **lint**         | `lint:fix`                                                                                                                                                                                                                                                                                                                      | —                                                                             | 代码检查与修复                                            |
| **ssh**          | `ssh:list` / `ssh:save` / `ssh:remove` / `ssh:test` / `ssh:exec`                                                                                                                                                                                                                                                                | —                                                                             | SSH 配置与远程执行                                        |
| **rules**        | `rules:list`                                                                                                                                                                                                                                                                                                                    | —                                                                             | 项目规则文件读取                                          |
| **feedback**     | `feedback:submit` / `feedback:message` / `feedback:messageList`                                                                                                                                                                                                                                                                 | —                                                                             | 逐消息评分与反馈                                          |
| **terminal**     | `terminal:create` / `terminal:input` / `terminal:resize` / `terminal:kill` / `terminal:tasks:list` / `terminal:tasks:stop` / `terminal:tasks:clear`                                                                                                                                                                             | `terminal:event:${id}` / `terminal:tasks:changed`                             | PTY 终端会话与后台任务监控                                |

> 共 205 个 invoke 通道 + 15 个事件通道。`ai:chunk:*` / `ai:queryEvent:*` / `agent:event:*` / `terminal:event:*` 按请求或会话动态拼接，其余为固定名。

---

## 四、AI 核心系统

### 4.1 三条执行路径

Auraxis 是**三条驱动、一套循环**：查询引擎与子 Agent 的每次 LLM 步进都委托给统一的 `agent-runtime/step-engine.ts`（重试、工具批处理、停止策略、压缩全部收敛于此），Code Mode 复用同一条 `executeToolCall` 权限管线；三条驱动只保留各自的编排职责（查询直接执行；Agent 增加规划/审批/偏差检测/暂停恢复；Code Mode 在 worker 线程做工具编排）。

#### 路径 A：Work/Code 查询（query-engine.ts）

用于 Work / Code surface 的完整 ReAct 查询；Chat 模式的普通对话走 `ai:chatStream`，主进程会显式拒绝 `surface === 'chat'` 的查询请求。流程：

```
用户输入 → runQuery() →（命中快照则 tryReplayStoredContext() 重放，否则 prepareCacheAlignedMessages() 组装）
    ↓
ReAct 循环（业务上限默认 200，可在 1–500 内配置；安全硬上限 500）：
    1. LLM 调用（llmClientInvoke：429/5xx/网络错误最多重试 2 次、共 3 次尝试，查询路径退避 2s/4s；主模型耗尽后切换降级模型）
    2. 如果无工具调用 → 视为完成（<FINAL_ANSWER> 为次级确认信号）→ 停止
    3. 如果有工具调用 → executeToolCall() → 结构化 summary → 追加结果 → 返回步骤 1
    4. 上下文压缩（估计 token 超过阈值 100K 的 90%，即约 90K 时触发）
    5. 停止策略评估（stopPolicyEvaluate）
    6. 迭代摘要 emit（toolsThisIteration, llmLatencyMs）
    ↓
返回结果给聊天 UI
```

**特点**：

- **无规划阶段**：直接执行 ReAct 循环
- **API 重试**：429/5xx/网络错误最多重试 2 次（共 3 次尝试），指数退避 2s/4s，主模型耗尽后切换降级模型
- **上下文压缩**：LLM 摘要（`deepseek-flash`）优先，失败回退规则摘要；按估计 token 超阈值 90% 触发
- **停止信号**：无工具调用的纯文本回复即结束回合，`<FINAL_ANSWER>` 为次级确认信号；查询路径不设强制质量门（ReviewArtifact 为可选验证工具）
- **迭代预算**：按「请求 → `agentMaxIterations` 设置 → 默认 200」解析并收敛到 1–500（`electron/ipc/agent-iteration-budget.ts`），安全硬上限 500；预算耗尽时任务优雅收尾
- **结构化摘要**：工具输出携带 `summary` 供前端类型化卡片渲染
- **暴露方式**：`ai:sendQuery` IPC

#### 路径 B：子 Agent（agent-runtime/agent-loop.ts → ipc/agent-handlers.ts）

用于侧边栏 Agent 和 `Agent` 工具。流程：

```
Agent 创建 → 获取任务描述
    ↓
规划阶段（可选）：
    LLM 生成 JSON 任务计划（TaskPlan），包含依赖关系
    ↓
Agent 驱动（agentLoopRun，步进委托 step-engine）：
    1. LLM 调用
    2. 工具执行（executeToolCall）
    3. 偏差检测（DevianceDetector，两级）：
       - 同一计划任务连续失败 2 次 → 标记 blocked 并提示换策略
       - 模型调用 Replan 工具 → LLM 生成新的剩余子计划
    4. 上下文管理（ContextManager）：按 token 阈值压缩
    5. 停止策略评估
    ↓
返回结果
```

**特点**：

- **完整规划能力**：LLM 生成结构化 JSON 任务计划（含依赖关系 + 关键词匹配）
- **计划审批**：`plan` 模式生成计划后等待用户审批（5 分钟超时），仅执行已批准步骤
- **质量验证（按路径分述）**：查询路径不设强制质量门；Agent 循环在 auto 档（未开 `autoApprove`）下，ReviewArtifact 返回 `passed:false` 会升起 review gate 暂停并等待人工确认（完全访问档除外）
- **偏差检测**：两级检测（计划任务连续失败 → blocked、Replan → 新子计划）
- **上下文管理**：支持 LLM 摘要和基于规则的回退
- **新项目检测**：自动检测空目录/无 package.json，注入初始化指引
- **暂停/恢复**：完整状态捕获（messages/plan/iteration/toolCallCount），满容量自动重入队列
- **预算耗尽后继续**：在输入框发送任意消息即可接着同一任务续跑（同一份执行记录，不新建任务）；调度器会批出一个新窗口并以 500 硬上限封顶，因此续跑不会在第一步就再次停下。输入框在可续写时会显示「在「任务名」基础上继续…」
- **最大递归深度**：3（Agent 工具可嵌套调用子 Agent，记录父子关系）
- **暴露方式**：`agent:start` IPC（经调度器创建侧栏 Agent，旧的 `agent:create` / `stop` / `list` / `get` 已移除）和 `runSubAgent()` 函数

#### 路径 C：Code Mode（code-mode.ts）

`RunCode` 工具在 `language=typescript` 时把程序体放进 worker thread 执行，`await tools.Name(args)` 的每个子调用都回穿 `executeToolCall` 全权限管线；并发安全工具最多 8 路重叠、变异工具串行，硬超时与中止可终止 worker。只有 print/return 的内容返回给模型。Code Mode **默认关闭（fail-closed）**：仅未打包且显式设置 `AURAXIS_ALLOW_UNSAFE_CODE=1` 时才可用，否则 `RunCode` 直接返回禁用提示。子代理分叉后端（`Agent` 的 `backend=fork`）另见 `fork-runner.ts`（无头子进程 one-shot）。

### 4.2 系统提示词构建

系统提示词是 `agent-runtime/context-manager.ts` 里的静态常量 `STATIC_SYSTEM_PROMPT`（作为缓存友好的稳定前缀，由 `query-engine.ts` 装配为 system 消息），其后紧跟一条 session preamble 用户消息，两者共同构成每轮上下文：

- **静态 system prompt**：工具使用能力声明、技能使用约定、工作方式（修改类任务先按需探索 Read / Grep / Glob，再修改、验证）与关键规则
- **session preamble（user 消息）**：平台感知的 Shell 提示（Windows → Git Bash，macOS/Linux → 标准 Unix）、项目根、深度思考提示（`isDeepThink`）与 work guide
- **任务完成信号**：模型输出中的 `<FINAL_ANSWER>`（大小写不敏感、位置不限；仅当该轮没有工具调用时才生效）
- **思考强度**：`isDeepThink` 同时映射为请求参数 `thinking.type` 与 `reasoning_effort`，提示词侧只补一句「你正在使用深度思考模式。」

### 4.3 工具系统

工具定义在 `electron/tool-defs/`（11 个能力族文件，[`electron/tool-defs.ts`](../electron/tool-defs.ts) 为聚合入口），共 **71 个内置工具**。三个来源（内置 / MCP / 插件）统一经 `electron/tool-provider.ts` 的 `ToolProvider` 抽象装配：`listAllToolDefs()` 按注册顺序给出模型可见清单（超 96 个截断），`resolveToolProvider()` 判定某个工具名归谁，`executeViaProviders()` 负责分派——Agent 侧不需要知道工具来自哪里。下表列出核心 24 个，其余 47 个按能力族补充在表后：

| #   | 工具               | 类别 | 说明                                                                                                                |
| --- | ------------------ | ---- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | **Bash**           | 危险 | 在项目目录执行 Shell 命令。默认超时 600s（10 分钟），上限同为 600s。Windows 支持 Git Bash/cmd/PowerShell            |
| 2   | **Read**           | 安全 | 读取文件内容，支持行偏移/限制，路径穿越检查。输出含 `summary`（文件路径、行数、大小）                               |
| 3   | **Write**          | 危险 | 创建/覆盖文件，扩展名白名单，Windows 保留名称检查，撤销前备份。输出含 `summary`（路径、字节数）                     |
| 4   | **Edit**           | 危险 | 文件内查找替换，需唯一匹配，撤销前备份                                                                              |
| 5   | **Delete**         | 危险 | 删除文件或目录（递归需确认），路径穿越检查，撤销前备份                                                              |
| 6   | **Grep**           | 安全 | 正则搜索（最大深度 5 层，最多 50 结果）。输出含 `summary`（匹配数）                                                 |
| 7   | **Glob**           | 安全 | 文件模式匹配（最大深度 6 层，最多 100 文件）。输出含 `summary`（匹配数）                                            |
| 8   | **WebFetch**       | 危险 | URL 内容获取（15s 超时），拦截本地/内网地址                                                                         |
| 9   | **WebSearch**      | 危险 | 默认走 DeepSeek 官方原生搜索（可配 exa / perplexity），失败自动降级 DuckDuckGo HTML（无需 Key）                     |
| 10  | **TodoWrite**      | 安全 | 任务清单管理（pending/in_progress/completed），同一时间仅一个 in_progress                                           |
| 11  | **Agent**          | 危险 | 启动子 Agent（Explore/Plan/general-purpose），递归深度限制 3，记录父子关系                                          |
| 12  | **Replan**         | 安全 | 生成新子计划（仅 Agent 循环可用，查询引擎会跳过）                                                                   |
| 13  | **CronCreate**     | 危险 | 创建周期/一次性定时任务（5 字段 cron），应用运行时触发                                                              |
| 14  | **CronDelete**     | 危险 | 按 ID 取消定时任务（属运行时变更工具，同样触发权限对话框）                                                          |
| 15  | **CronList**       | 安全 | 列出所有活跃定时任务                                                                                                |
| 16  | **TaskOutput**     | 安全 | 读取后台任务/子 Agent 的累积输出（不阻塞）                                                                          |
| 17  | **TaskStop**       | 危险 | 按 ID 停止运行中的工具/子 Agent                                                                                     |
| 18  | **EnterPlanMode**  | 安全 | 进入计划模式，生成实现计划交用户审批                                                                                |
| 19  | **ExitPlanMode**   | 安全 | 用户批准后退出计划模式，开始实现                                                                                    |
| 20  | **NotebookEdit**   | 危险 | 读/写/插入/删除 Jupyter Notebook（.ipynb）单元格                                                                    |
| 21  | **EnterWorktree**  | 危险 | 创建隔离的 Git worktree 沙箱，后续工具调用自动重定向到沙箱路径                                                      |
| 22  | **LSP**            | 安全 | 代码智能：definition / references / implementation / hover / diagnostics（优先语言服务器，回退正则 + tsc --noEmit） |
| 23  | **ReviewArtifact** | 危险 | 可选验证工具：运行 build/test/typecheck/lint                                                                        |
| 24  | **GitCommit**      | 危险 | 暂存所有变更并创建 Git 提交，返回 commit hash                                                                       |

> 上表「类别」为按行为的直观归类；某工具是否实际触发权限对话框，以 `electron/tool-capability.ts` 的 `DANGEROUS_TOOLS`（以及 `isDangerousTool()` 对一切 `mcp__*` 的判定）为准。

**其余 47 个工具（按能力族）**：

- **代码执行 / 工作流**：RunCode、RunWorkflow
- **技能**：ListSkills / ReadSkill / WriteSkill
- **文件编辑与读图**：StrReplaceEditor（view/create/str_replace/insert）、ReadImage
- **用户交互**：AskUser（Work 模式开工前澄清）
- **本地 Shell**：Pwsh
- **后台任务**：TaskList、JobList / JobOutput / JobKill
- **会话内调度**：ScheduleCreate / ScheduleDelete / ScheduleList
- **持久终端**：Pty、TerminalOpen / TerminalList / TerminalRead / TerminalSend / TerminalSignal / TerminalClose
- **目标与多 Agent 协作**：ListAgents / SendMessage / InterruptAgent / Report、GetGoal / CreateGoal / UpdateGoal、Ralph
- **运行时自省 / 插件**：InspectRuntime、MountPlugin / UnmountPlugin
- **会话检索**：SessionQuery、SessionEventSearch / SessionEventRead / SessionTrace（含事件级 lineage）、ReadSpill
- **专业文档**：ReadDocument（.docx/.xlsx/.pptx/.pdf 文本与结构化读取）、WriteDocument（Word/Excel/PPT/PDF 生成，PDF 自动嵌入中文字体）、IngestDocument（长文档切块入库，见 §5.11）
- **云连接器**：SlackListChannels / SlackPostMessage、DriveList / DriveRead、NotionSearch / NotionCreatePage

> 飞书 / Lark 不属于内置工具：它是官方 OpenAPI MCP 预设，在 MCP 设置中添加并连接后才会动态出现 `mcp__lark-mcp__*` 工具。

**工具分类**（权威定义见 `electron/tool-capability.ts`）：

- **危险工具集合 `DANGEROUS_TOOLS`（39 个，外加一切 `mcp__*`）**：Bash、Pwsh、Pty、TerminalOpen / TerminalList / TerminalRead / TerminalSend / TerminalSignal / TerminalClose、RunCode、RunWorkflow、MountPlugin、UnmountPlugin、CronCreate、CronDelete、ScheduleCreate、ScheduleDelete、TaskStop、JobKill、EnterWorktree、WriteSkill、SendMessage、InterruptAgent、Agent、Ralph、Write、Edit、StrReplaceEditor、NotebookEdit、Delete、WriteDocument、WebFetch、WebSearch、ReviewArtifact、GitCommit、SlackPostMessage、NotionCreatePage、CreateGoal、UpdateGoal — 触发权限对话框
- **文件修改工具 `FILE_MODIFY_TOOLS`（4 个）**：`['Write', 'Edit', 'NotebookEdit', 'Delete']` — 触发撤销备份与冲突检测文件锁（WriteDocument 只按中等风险审批）
- **只读工具 `SAFE_READONLY_TOOLS`**：`['Read', 'Grep', 'Glob', 'ReadDocument', 'SlackListChannels', 'DriveList', 'DriveRead', 'NotionSearch']` — 在 `ask` 和 `plan` 模式下自动批准

`Replan` 工具在聊天查询路径中不可用（查询引擎会跳过），仅在 Agent 循环中可用。

### 4.4 权限系统

审批策略（单一事实源 `electron/contracts/core.ts`，经 `electron/types.ts` 与 `src/types/` re-export）：

| 策略             | 行为                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask`（默认）    | 每次危险工具调用弹出权限对话框。只读工具（Read/Grep/Glob）自动批准                                                                                                                |
| `plan`           | 计划获批准（`approvedPlanSteps` 非空）即授权本次运行的全部工具；计划被拒或超时则降级为逐次 `ask`                                                                                  |
| `auto`（全自动） | 工作区内自动执行全部工具，安全检查仍执行（路径检查、扩展名白名单、被拦截 URL）；但质量门失败（ReviewArtifact `passed:false`）时会暂停等待确认，完全不弹对话框的只有「完全访问」档 |

Composer 的「运行权限」四档预设（每次确认 / 自动代批 / 完全访问 / 只读）分别展开为审批策略 + 沙箱模式（read / workspace-write / full）+ autoApprove + 内置权限档案（standard / readonly），见 `electron/contracts/permission.ts`；预设不涉及 `plan`。

权限规则存储在 `permission-handlers.ts` 中，作用域分为：

- `once` — 命中一次后即从内存删除
- `session` / `always` — 均持久化到设置并在重启后恢复（当前实现未区分两者，「当前会话」只是设置页标签）

> **审批疲劳守卫（Oversight）**：权限链路调用 `approval-fatigue.ts` 的 `record()`，把自动放行与人工批准/拒绝计入疲劳统计（自动放行不占人工注意力）；守卫另有 `suggest()` 输出 escalate / auto / balanced 建议，但**当前没有生产调用方**，是否放行仍由权限档位决定（详见第五章 5.6）。

### 4.5 上下文压缩

`ContextManager`（`agent-runtime/agent-loop-context.ts` 与 `agent-runtime/context-manager*.ts`）与 `agent-runtime/step-compressor.ts` 提供两档压缩策略：

- **snip（聊天 / 手动压缩默认）**：按估计 token 触发（查询路径阈值 100K 的 90%）+ 原子组整组截断（保留预算默认 60K）+ LLM 摘要（`deepseek-flash`），失败回退规则摘要；回合数触发钩子存在但主路径未接线
- **step（AGORA，Agent 循环默认）**：免推理步骤级压缩——整步保留 / 整步丢弃，永不拆分工具调用与其结果（详见第五章 5.4）；压缩前先做 `pruneToolResults` 大结果剪枝，再按 always-keep floor 保留最近 6 步与计划关键步骤

### 4.6 停止策略

`stopPolicyEvaluate()` 函数评估是否应停止执行：

- **质量验证**：ReviewArtifact 供模型在需要时运行验证命令；查询路径不设质量门，Agent 循环 auto 档下失败会升起 review gate 并暂停等待人工确认
- **主要检查**：无工具调用的纯文本回复即视为完成并结束回合；`<FINAL_ANSWER>` 为次级确认信号（被 max_tokens 截断时不算）
- **max_tokens 保护**：当 API 返回 `stop_reason: 'max_tokens'` 时强制继续
- **计划完成检查（仅提示）**：计划未完成不影响停止，plan 状态只做展示与 UI 追踪
- **连续截断保护**：连续 5 轮纯文本且均被 max_tokens 截断时强制中止
- **空响应检测**：连续 2 次空响应停止

### 4.7 上下文缓存对齐（规范快照重放）

Work/Code 统一引擎（`electron/ipc/query-engine.ts` → `electron/agent-runtime/step-engine.ts`）为 DeepSeek 前缀缓存做了客户端侧对齐（详见第五章 5.9）：

- 每轮自然结束后把完整规范消息快照写入会话 chat-log（`llm_context_v1` system 事件）；下一轮优先重放快照，仅追加新记忆与新用户消息
- 快照头部校验：`storedHeadIsCurrent` 逐字节比对快照头部的 system prompt / 会话 preamble / work guide 与当前组装值，不一致即回退 fresh 组装（防升级、换项目、切思考档后沿用旧指令）
- 记忆作为 `memoryContext` 独立字段走 IPC，后端插入请求尾部；重放时与快照最后一条记忆做字节级去重
- 渲染层编辑 / 删除 / 重新生成 / 撤销时通过 `ai:clearQueryContext` 作废快照
- 快照读写为 best-effort：失败只告警并降级为 fresh，不中断已成功的回复

涉及文件：`electron/ipc/query-context.ts`、`electron/ipc/query-engine.ts`、`electron/ipc/ai-handlers.ts`、`electron/preload-ai.ts`（`ai:clearQueryContext` 桥接）、`src/stores/useChatStore.ts`、`src/stores/chatActions.ts`（编辑/删除/重新生成/撤销时作废快照）。

---

## 五、研究论文与技术落地

> 以下 11 篇论文/系统均为项目「论文驱动开发」的来源；实现均为自研（借鉴算法思想，未复制论文代码）。缓存方向的技术基于 DeepSeek API 的官方前缀缓存机制做**客户端侧适配**（服务端算法如 radix tree / KV 融合无法在托管 API 上直接调用）。

### 5.1 论文总览

| #   | 论文（arXiv 链接）                                                                                                                           | arXiv ID                   | 核心洞察                                                        | 落地模块                                                                                   | 状态                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------- |
| 1   | [Eywa: Provenance-Grounded Long-Term Memory for AI Agents](https://arxiv.org/abs/2605.30771)                                                 | 2605.30771（2026-05）      | 证据先于信念；检索零 LLM；答案策略与上下文分离                  | memory-evidence / signal-rules / belief-validation / memory-read / memory-db / MemoryPanel | ✅ 已落地 v1.0                |
| 2   | [MAP-Graph: Provenance-Aware Shared Memory for Multi-Agent Workflows](https://arxiv.org/abs/2608.10509)                                      | 2608.10509（2026-08）      | 多 Agent 共享记忆的授权、信任与血缘                             | memory-graph / agent-loop / tool-runner / agent-scheduler                                  | ✅ 已落地（M5，opt-in）       |
| 3   | [AGORA: Adapter-Grounded Observation-Action Retention for Inference-Free Prompt Compression in LLM Agents](https://arxiv.org/abs/2605.26596) | 2605.26596（2026-05）      | 步骤级免推理压缩，保护 action grammar                           | step-compressor / context-manager / agent-loop / step-engine                               | ✅ 已落地（Agent 循环默认）   |
| 4   | [SWE-Touch: Benchmarking Coding Agents When Users Touch the Code](https://arxiv.org/abs/2608.02499)                                          | 2608.02499（2026-08）      | 共享工作区漂移感知与定向验证                                    | workspace-drift / agent-loop / tool-handlers                                               | ✅ 已落地                     |
| 5   | [Oversight Has a Capacity: Calibrating Agent Guards to a Subjective, Fatiguing Human](https://arxiv.org/abs/2606.08919)                      | 2606.08919（2026-06）      | 人工监督存在容量上限，安全与审批率呈倒 U 型                     | approval-fatigue / permission-handlers                                                     | ✅ 已落地（建议层）           |
| 6   | [AutoTool: Efficient Tool Selection for Large Language Model Agents](https://arxiv.org/abs/2511.14650)                                       | 2511.14650（AAAI 2026）    | 工具调用惯性 → 有向图预测，节省推理开销                         | tool-inertia / tool-runner                                                                 | ✅ 已落地（观测 + 预测层）    |
| 7   | [When Self-Evolution Backfires: Pre-Commit Gating against Skill Contamination in LLM Agents](https://arxiv.org/abs/2608.05810)               | 2608.05810（2026-08）      | 技能污染结构性不可逆，入库须 pre-commit 门禁                    | skill-gate / tool-handlers（WriteSkill）                                                   | ✅ 已落地                     |
| 8   | [SGLang: Efficient Execution of Structured Language Model Programs（RadixAttention）](https://arxiv.org/abs/2312.07104)                      | 2312.07104（NeurIPS 2024） | 前缀树 KV 复用；客户端侧取「公共前缀最长化 + 规范历史重放」前提 | query-context / query-engine / useChatStore                                                | ✅ 已落地（API 侧客户端适配） |
| 9   | [Prompt Cache: Modular Attention Reuse for Low-Latency Inference](https://arxiv.org/abs/2311.04934)                                          | 2311.04934（MLSys 2024）   | 可复用内容做成连续稳定块，动态内容不插入稳定块                  | context-manager / query-context                                                            | ✅ 已落地                     |
| 10  | [Cache-Aware Prompt Compression: A Two-Tier Cost Model for LLM API Caching](https://arxiv.org/abs/2607.15516)                                | 2607.15516（2026-07）      | 按变更频率决定前缀/尾部边界，动态内容尾部化                     | query-context / query-engine / useChatStore                                                | ✅ 已落地                     |
| 11  | [Byte-Exact Deduplication in Retrieval-Augmented Generation](https://arxiv.org/abs/2605.09611)                                               | 2605.09611（2026-05）      | 检索上下文字节级去重，避免重复内容膨胀                          | query-context（记忆块去重）                                                                | ✅ 已落地（去重思路）         |

### 5.2 Eywa — 溯源长期记忆（M1–M4）

**核心洞察**：LLM 抽取出的“记忆”只是可修订的索引；原始会话证据必须不可变保存，信念必须可追溯、可审计，每个答案都能回答「错在哪一层」。

- **M1 证据地基**：`memory-evidence.ts` 把用户消息、工具观测与用户纠错反馈捕获为不可变 Evidence（sha256 内容哈希去重，SQLite / JSON 双后端；证据 role 只有 user / assistant / tool / system）；`chat-log.ts` / `session-log.ts` 写入后实时挂接 best-effort 捕获
- **M2 信号与信念**：`signal-rules.ts` 规则化检测日期 / 实体 / URL / 版本 / 决策 / 纠错 / 批准 / 拒绝八类信号，作为 evidence 上的类型化索引，由 `memory:reindex` 统一回填（默认零 LLM；`AURAXIS_MEMORY_LLM_SIGNALS=1` 时改走 LLM 语义检测并静默回退规则）；`belief-validation.ts` 硬锚点验证（evidence 必须存在、关键实体与数值归一化匹配、纠错需双证据）；状态机 `draft → promoted → active → superseded / rejected / deleted`
- **M3 确定性读路径**：`memory-read.ts` 四路检索 R1 关键词（走 `memory-fts.ts` 的 FTS5：trigram 外部内容表索引 `beliefs`/`evidence`，触发器自动同步，按 bm25 排序；不足 3 字符的查询因 trigram 的 `MATCH` 限制回退 `LIKE`）/ R2 实体时间 / R3 观测流 / R4 本地向量（`AURAXIS_MEMORY_EMBEDDINGS=1` 可选；走 `EmbeddingProvider` 接缝、向量以 SQLite BLOB 缓存、仅在身份不符时重算 —— 见 §5.11），**零 LLM、零随机**；`memory:readForQuery` 返回 context + policy + facts + diagnostics，聊天注入已替换
- **M4 审计与归因**：`memory:beliefAudit` / `readTrace` / `erase`（擦除留审计事件）；MemoryPanel 展示证据链、支持强度、修订历史与读路径诊断；五层失败归因测试（缺证据 / 抽取失真 / 状态过期 / 检索丢失 / 模型行为）

### 5.3 MAP-Graph — 多 Agent 共享记忆授权（M5）

**核心洞察**：共享记忆只有向量检索会丢失权限、来源与信任信息，可能导致「无权证据驱动高风险动作」。

- `memory-graph.ts` 类型化执行图：agents / sources / memories / claims / actions 节点 + 血缘边
- 授权过滤：按 Agent 角色（Explore / Plan / general-purpose）与动作类型决定证据可读性；硬授权与分级信任分离
- 路径信任：来源可信度 × 派生路径的乘法信任评分，供 opt-in 风险门控（`AURAXIS_MEMORY_RISK_GATE=1`）使用，**不参与检索结果重排**
- 风险门控：高危险动作（Write/Edit/Bash 等）要求更高证据标准与来源信任，挂在 step-engine 的工具执行钩子（`riskGate`）上，经 `runtime-ports.ts` 绑定 memory-graph 的信任评估；运行时由 scheduler / sub-agent 自动绑定 agentName（`AURAXIS_MEMORY_RISK_GATE=1` 启用）

### 5.4 AGORA — 步骤级上下文压缩

**核心洞察**：token 级抽取式压缩会破坏 agent 的 action grammar（工具名 / 标识符 / 括号被抽掉后环境直接拒绝），压缩只能按完整步骤进行。

- `step-compressor.ts` 免推理实现：结构解析 + always-keep floor（系统 / 前导 / 最近 K=6 步 / 计划相关关键步骤）+ 确定性启发式评分，不调用 LLM
- 永不拆分工具调用与其结果；`context-manager.ts` 压缩前先 `pruneToolResults` 剪枝大结果
- Agent 循环默认 `compressMode='step'`（`agent-loop.ts` / `step-engine.ts`）；聊天与手动压缩保持 `snip` 摘要管线

### 5.5 SWE-Touch — 共享工作区漂移感知

**核心洞察**：用户或其它进程在任务执行期间修改同一工作区时，agent 必须感知「外部漂移」并重新检查被改区域。

- `workspace-drift.ts` 在 Read / ReadImage / Write / Edit / StrReplaceEditor 成功后登记基线（stat + sha256，>2MB 仅 mtime/size），不监听文件系统事件
- 每个 agent 迭代开始前 `takeDrift(projectRoot)` 检测，发现漂移即注入上下文消息（`context_injected / workspace` 事件），要求模型定向验证
- 由 agent-loop 内部消费；含 workspace-drift 单元测试，agent-loop 侧以 `takeDrift` 桩验证漂移注入事件流

### 5.6 Oversight Has a Capacity — 审批疲劳守卫

**核心洞察**：人工审查者不是完美 oracle，过度升级反而降低系统安全（疲劳 + 「审批洪水」攻击）；是否升级人工应作为资源分配问题。

- `approval-fatigue.ts` 记录每个 scope 的审批决策（approved / rejected / auto），20 次决策滑动窗口 + 疲劳分数
- 输出建议 `escalate / auto / balanced`；`permission-handlers.ts` 自动放行计入统计（不占人工注意力）
- 守卫不自行改变权限模式，只记录决策并对外暴露 `state()` / `suggest()` 建议接口；当前权限链路只写统计，尚未消费建议

### 5.7 AutoTool — 工具使用惯性

**核心洞察**：工具调用序列具有可预测的低熵惯性；用历史轨迹构建有向图可在 LLM 决策前预测下一步工具，最多节省约 30% 推理开销。

- `tool-inertia.ts` 构建 Tool Inertia Graph（TIG）：工具节点 + 转移概率；`tool-runner.ts` 每批工具执行后自动登记序列（含跨批次衔接）
- `suggestNext(scope, history, { minProbability })` 返回候选工具 + 置信度（high / medium / low），供上层旁路开关使用
- 由 tool-runner 内部消费；参数级填充暂未实现

### 5.8 Verifier-as-Gatekeeper — 技能库门禁

**核心洞察**：技能池超过临界规模后新增技能会污染后续蒸馏链，且污染结构性不可逆；技能入库必须是 pre-commit 门禁而非事后回滚。

- `skill-gate.ts` 三道异构批评：结构有效性（frontmatter / 名称 / 正文长度）、行为无害性（危险命令模式）、语义一致性（占位符描述 / 名称相符）
- 边际增益子集选择：去重 + 多样性 + 新鲜度
- `WriteSkill` 工具入库前调用 `validateSkill`，blocking 拒绝、warnings 提示

### 5.9 缓存对齐上下文管理（RadixAttention / Prompt Cache / Cache-Aware Prompt Compression）

**核心洞察**：DeepSeek 官方上下文缓存只按「从第 0 个 token 开始的完整前缀单元」命中；因此客户端唯一能做的是让请求开头尽量长地保持字节稳定，并把每轮会变化的内容推到尾部。

- **规范历史重放（RadixAttention 前提的客户端适配）**：`query-context.ts` 把每轮实际发给 LLM 的完整消息数组（含 assistant `tool_calls`、`tool` 结果、`reasoning_content`）以 `llm_context_v1` system 事件写入会话 chat-log；下一轮 `runQuery` 直接重放快照并追加新记忆 + 新用户消息，请求前缀与上一轮逐字节一致，工具历史不再丢失
- **稳定块组织（Prompt Cache）**：静态 system prompt + 工具定义 + AGENTS.md + 模式提示作为稳定块，仅在内容真实变化时原位替换；`storedHeadIsCurrent` 逐字节比对快照头部与当前组装值（system prompt / session preamble / work guide），升级、换项目、切思考档时自动回退 fresh 组装
- **动态内容尾部化（Cache-Aware Prompt Compression）**：跨会话记忆不再 `unshift` 到对话头部，而是作为独立 `memoryContext` 字段由后端插到当前用户消息之前（fresh）或快照尾部（重放）
- **字节级去重（Byte-Exact Deduplication）**：重放时若新记忆块与快照内最后一条记忆逐字节相同则跳过追加，避免相同检索内容每轮重复累积
- **失效路径**：编辑 / 删除 / 重新生成 / 重试最后一条 / 撤销恢复时渲染层调用 `ai:clearQueryContext` 写 `llm_context_clear` 墓碑；快照读写失败仅降级告警，不中断对话

局限：Chat 模式（`ai:chatStream`）尚未套静态前缀；官方 API 不暴露 TTL/keepalive 接口，不做保温请求。

### 5.10 新增功能清单

| 功能                         | 说明                                                                                                                                | 主要模块                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 本地账户系统                 | 首启注册 → 登录门 → 登出/改密；密码仅存 scrypt 哈希；`AURAXIS_AUTH_DISABLED=1` 仅供测试绕过登录门                                   | auth-store / auth-handlers / AuthGate / AccountPane |
| DeepSeek API Key 注册时填写  | 注册流程可直接填 Key 并测试连接，也可跳过到设置面板配置                                                                             | AuthGate / settings / ai-handlers                   |
| 头像与账户展示               | 顶部栏账户显示在设置按钮左侧，头像支持上传（居中裁剪为 PNG data URL），设置面板可改密                                               | Avatar / AccountPane / auth:setAvatar               |
| Chat / Work / Code 三模式    | 统一 ReAct 引擎下的三种产品形态：Chat 对话、Work 任务执行、Code 代码编程；模式切换不污染彼此状态                                    | useAppStore / useChatStore / code-mode              |
| Work 模式 Agent 执行流程视图 | 输入区居中 + 任务看板 + 执行流程（回合、工具行、交付物、状态）                                                                      | ChatArea / WorkExecutionFlow / WorkItemView         |
| 思考开关与思考深度           | Chat 为 DeepSeek 风格：仅思考开关（开启默认 high，无强度选择）；Work/Code 默认思考开启并保留 low/medium/high 滑轨                   | ChatInput / ThinkingDepthSelector / ModeToggler     |
| 联网搜索                     | Chat 有独立联网按钮；Work/Code 不显示开关，任务中由模型自主调用 WebSearch/WebFetch；默认 DeepSeek 官方原生搜索，失败降级 DuckDuckGo | ChatInput / tool-handlers                           |
| 每模式状态快照               | 思考开关 / 强度 / 联网状态按模式保存（modeThinkingPrefs），切回时还原                                                               | useChatStore                                        |
| 溯源记忆                     | 证据先于信念、确定性读路径、证据链 UI、五层失败归因                                                                                 | memory-* / MemoryPanel                              |
| Agent 执行活动视图           | 一轮执行 = 一个 Run 头 + 一份有序 Activity 列表，直接由真实引擎事件派生                                                             | core/activity / components/activity / AgentRun      |
| 会话事件时间轴               | 右侧时间轴展示会话事件与工具调用，支持追溯 / 重放                                                                                   | TimelineRows / session-log                          |
| 浏览器工具                   | Agent 驱动用户已打开的预览面板（打开 / 读文本 / 截图）；仅 http(s)，绝不悄悄换目标                                                  | browser-target / tool-defs/browser / PreviewBrowser |
| 实时 diff 与变更回滚         | 右舱「变更」视图按会话查看文件变更并回滚                                                                                            | undo-manager / undo:getSessionDiffs                 |
| 测试覆盖率面板               | 设置面板实时读取 coverage-summary.json 展示行 / 分支 / 函数覆盖率                                                                   | coverage-handlers / settings                        |

---

### 5.11 检索与 LLM 网关升级

**核心洞察**：决定「模型看到什么」与「花了多少」的那几处，此前都是**能用但写死**的实现——向量是固定的 64 维哈希、融合是三组拍定的权重、而每次 LLM 调用都经过的那个唯一出口上没有任何计量。

- **embedding 接缝**（`ipc/embedding-provider.ts`）：R4 向量路不再写死特征哈希实现。`EmbeddingProvider`（id / 维度 / 版本 + 异步 `embed`）可替换；本地哈希仍是默认实现，且与旧算法**逐位一致**。记录**身份**才是重点：不记身份时，换模型会拿另一个空间的向量排序，而且什么都不报。
- **向量落库**（`ipc/memory-vectors.ts`）：向量存在 SQLite BLOB 列里，显式小端 float64 —— float32 往返有损，会让「缓存命中」与「未命中」给出不同排序，而这条读路径自称确定性。身份**行内存储**：身份不符的行直接当作缺失、由下一次写入覆盖，没有第二处状态要同步。读路径只算缺失的那些信念，且一次批量送。`eraseScope` 连向量一起清。没有 SQLite 的后端报告「没有向量存储」并每次重算 —— 结果完全一致，只是没有缓存。
- **文档入库**（`ipc/document-ingest.ts` 与 `IngestDocument` 工具）：把 .docx / .xlsx / .pptx / .pdf 切块收进项目记忆。每块写一行 Evidence —— 于是既有的 FTS5 索引、级联擦除与审计**零新代码**即刻生效 —— 再加一条锚定它的 `kind: 'reference'` 信念（只写 Evidence 没用：它只参与路由，注入的 `context` 里装的是信念）。确定性、零 LLM。重复入库按内容哈希推出的 id 替换旧一代，不需要任何清单表。它**刻意不在** `SAFE_READONLY_TOOLS` 里：只读文件，但会持续写入内容，因此保留一次审批。
- **语义缓存**（`ipc/semantic-cache.ts`，默认关闭）：embedding 召回 + 相似度阈值，只接了一个调用方 —— 会话标题生成。**刻意不接** Agent 循环：在「相似」的问题之间复用答案，会给出与当前工作区矛盾的结论且不报错。默认哈希实现下阈值表达的是「近乎同措辞」；注册真正的 embedding 之后才名副其实。
- **LLM 网关**（`agent-runtime/llm-gateway.ts`）：限流（默认关闭；只会等不会失败，桶容量为 1，所以 `RPM=600` 不会突发）、按模型 × 会话分解的成本账本（价目表精确匹配，未收录的模型报**未计价**而不是猜一个数）、provider 健康。三者都挂在 `invokeLlm` —— 全应用唯一的 LLM 出口 —— 没有任何调用方绕得过去。健康只记不外推：引擎已经有重试 + `fallbackModel`，再叠一套自动降级会让「为什么这次没调用」无法回答。调度器的用量现在也进统计页，快照经 `stats:get` 暴露。
- **语义判分**（`agent-eval/judge.ts`）：`answer_judge` 检查把 LLM-as-judge 叠进既有评测，覆盖结构化断言看不见的标准（「说明了为什么」「指出了风险」）。带 `literal` 的条目走确定性判定、不调模型；所有失败模式 —— 没有判分器、输出无法解析、「通过」却给不出原文引用 —— 一律判失败。理由与引用留在报告里供人复核：判分器是第二个模型的意见，不是真值。
- **提示词变体**（`AURAXIS_PROMPT_VARIANT_FILE`、`scripts/prompt-ab.cjs`）：候选放在 `evals/prompts/*.txt`，追加在缓存前缀之后（绝不进 `STATIC_SYSTEM_PROMPT`），生效时打日志，按臂各跑一遍评测做 A/B。**不自动采纳** —— 十来个用例分不清信号与噪声。

### 5.12 Agent Activity View —— 一轮执行，一份有序步骤

**核心洞察**：一轮 assistant 执行从前在视觉上是碎片的 —— 工具活动在气泡里，而计划 / 上下文注入 / 压缩 / 权限请求各自是一条独立合成消息，交付物与回滚入口又挂在气泡外。同一批工具事件还在四个地方各渲染了一遍，每处都自带一张工具名 → 文案的表。

- **派生优先，不是第二份 store**：`src/core/activity/model.ts` 把一条 assistant 消息（加上由 `segments.ts` 归属的合成消息）投影成 `ActivityRun`。Activity 是**既有状态的纯函数**（`messages[].toolCalls`），所以刷新不需要任何重建路径 —— `localStorage` 恢复消息，同一个函数重新派生视图。再存一份的话，就要在约 10 个会改消息的入口（发送 / 重试 / 编辑 / 删除 / 重新生成 / 切会话 / 清空 / fork / 回滚 / 水合）上一一同步，漏一处就表现为"Run 还在但步骤没了"。
- **唯一一张展示表**：`src/core/activity/presentation.ts` 用 `Record<BuiltInToolName, ActivityType>` 把**每一个**内置工具映射到语义类型 —— 新增工具却忘了归类会**编译失败**，而不是在界面上悄悄退化成一行裸工具名。它还负责渲染引擎**早就算好**的 `buildToolSummary` 事实（`读取 120 行 / 8KB`、`exit 0 · out 1.2KB`）：这些数据一直存在却没有任何消费者，UI 反而在四个地方从入参重推了更弱的摘要。
- **唯一一份提取层与唯一一个渲染件**：`src/core/activity/agentCards.ts` 把工具结果提取成带类型的卡片模型（读取 / 检索 / 网页 / 代码 / diff / 终端），`src/components/agent/ToolOutputCard.tsx` 负责渲染。聊天区执行视图、Agent 会话、右面板轨迹三处都只调这两个 —— 三份手写副本（`AgentConversationRender.tsx` 的 `readCardProps` 一族、`TimelineRows.tsx` 的 `ReadDetail`/`GrepDetail`/`WebDetail`/`RunCodeDetail`）已删除，`TimelineUtils.toolSummary` 与 `AgentConversationUtils.summarizeInput` 也改为委托同一个 `summaryFromInput`。提取层搬进 `src/core/` 顺带进了覆盖率门禁。两个如实的结果：抓取到的**页面正文**现在会显示（WebFetch 返回 `{url, content_type, content}`，而这份正文此前全仓库没有任何界面渲染过）；失败但没有退出码的命令不再伪造 `exitCode: 1`。
- **`agent:event:*` 是有判别式的联合**：`electron/contracts/agent-events.ts` 从引擎自己的 `AgentLoopEvent` 推导负载类型（外加两个通道自有事件 `plan` 与 `user_message`），preload 与渲染层共用同一份。从前渲染层是 `Record<string, unknown> & { type: string }`、preload 是 `{ type: string } & Record<string, unknown>`，字段名写错只会静默读到 `undefined` —— `event.maxIterations` 就是这么躺了很久。`src/stores/__tests__/agent-event-types.test.ts` 在编译期双向断言：引擎新增一个事件而渲染层不认识，`tsc6` 会直接失败，而不是界面上悄悄少点东西。预算现在是一个真实字段：引擎把 `config.maxIterations` 带进 `StepEngineConfig` 并在 `iteration_start` 上发出（宿主解析不出时**省略**，绝不补默认值），界面在该轮确实在跑时显示 `第 3/42 轮`。
- **常驻终端也有卡片**：`Pty` / `TerminalOpen|List|Read|Send|Signal|Close` 每个动作的返回形状都不同。`TerminalRead` 的负载是**带 ANSI 转义的终端文本**，从前被 `JSON.stringify` 成 `{"output":"\u001b[32m…"}`，等于看不了。`ptyCardModel` 把每个动作映射到真实字段（会话列表、发送字符数、信号名、关掉几个会话），read 动作交给 `TerminalBlock` 渲染。
- **状态机**：`pending / running / completed / failed / cancelled / waiting / skipped`，每个转移对应一个真实引擎事件。这修掉了两个线上缺陷：`tool_aborted` 从前被记成 `done` + 一段错误文本，于是用户自己取消的步骤显示成"已完成"；被用户停掉的一轮与正常完成无法区分，因为 `stopStreaming` 只清 `isStreaming` —— 现在由 store 记下真实终态（`stopped` / `timeout` / `disconnected`）。
- **原地更新**：工具事件复用同一个 item id（`toolCallId`），所以流式终端是在刷新同一行，而不是不断追加新行。实时输出直接取自 `ToolCall.streamOutput`。
- **真实 Diff 与真实 ±**：Write/Edit 的输出本来就带 `oldContent`/`newContent`，`countDiffChanges` 据此产出 `+N −M` 芯片。超过尺寸上限时**不算行数而不是估算**（`lcsDiff` 的时间与内存都是 O(n·m)），并在界面上如实说明。
- **两层聚合**：顶层不再有"批次"分组（那是同一轮并行派发的实现细节）。`core/activity/aggregate.ts` 改为合并**连续同类且已完成**的操作（`读取 4 个文件`、`检索 3 次 · 命中 14 处`、`运行命令 3 条`）；正在跑、失败、被取消、以及带 ± 的改动一律留在自己那一行 —— 那才是用户当下要看的东西。展开聚合行看到的是**同一批 `ActivityItem` 对象**（用例按引用断言），所以下钻永远能到真实那一步。段数超过 24 的长任务把最早的折成一行 `已折叠较早的 19 项`，且只在**已结束**后折，运行中绝不折叠。
- **流式终端真的会显示输出**：`tool_progress` 一直有采进 `ToolCall.streamOutput`，但 `TerminalBlock` 把输出区门控在 `!running` —— 长时间构建期间用户只看到转圈。现在运行中的卡片渲染**只保留尾部**的窗口（`core/activity/liveOutput.ts`：8KB / 200 行，按行边界切，不会切断 ANSI 序列），并且**只在用户本来就贴着底时**跟随滚动；被省略的行数如实标注，而不是假装那就是全部。
- **计划是清单，不是 JSON**：`TodoWrite` 从前展开是 `{"todos":[…]}`。`planCardModel` 把真实的 `input.todos` 映射成紧凑清单与真实进度 `2/4`，走共享卡片层（Agent 会话与轨迹面板同时受益）。
- **权限审批就在执行流程里**：审批卡片渲染在**那一行内部**，决策让该行原地翻转（`◐ 等待确认` → `✓ 已授权`），并记进 `useActivityStore.approvals`。对抗验证逼出两道守卫：未决策的请求只在**这一轮确实在跑**时才算 `waiting`（刷新后重开会话不会再挂出一张会立刻自判"已拒绝"的卡片）；`resetForSession` 不再清 `runTerminal`/`approvals`（它们是"这一轮被停过 / 这个请求被批过"的唯一记录，且键全局唯一）。
- **嵌套**：`sub_agent` 项内联渲染子代理的步骤，数据来自**真实的**子代理事件流（`useAgentStore` 的日志），通过注入的 `_agentId` 关联，走同一套类型与文案层。
- **持久化**：会话日志补齐了视图需要的东西 —— `summary` / `stepGroupId` / `durationMs` 从前写了盘却被投影丢掉，`aborted` 动作投影也不认识（重放时被取消的工具会永远停在 running）。

## 六、多 Agent 调度系统

### 6.1 三层架构

```
Agent 管理 (ipc/agent-scheduler.ts 注册 IPC；角色定义见 ipc/agent-defs.ts)
    ↓ 创建/配置
Agent 调度器 (单例实现在 ipc/agent-scheduler-class-impl.ts)
    ↓ 调度执行
Agent 循环 (agent-runtime/agent-loop-driver.ts) — agentLoopRun()
    ↓ 执行中
工具执行 (ipc/tool-handlers/*) / 子 Agent (递归)
```

### 6.2 Agent 类型

定义在 `agent-defs.ts`（[查看文件](../electron/ipc/agent-defs.ts)），三种内置类型：

| 类型                | 能力                                                                                         | 禁用工具                                                             |
| ------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Explore**         | 只读探索：搜索文件、阅读代码、Web 获取/搜索、只读 Bash（ls/git status/log/diff/find/cat 等） | Write, Edit, Agent                                                   |
| **Plan**            | 只读架构师：设计实现方案，输出结构化计划                                                     | Write, Edit, Agent（Bash 由系统提示约束为只读）                      |
| **general-purpose** | 全能力：编码、调试、重构                                                                     | 无限制（内置 71 个工具全可用；叠加 MCP 与动态挂载插件工具后上限 96） |

### 6.3 AgentScheduler 调度器

单例 `AgentScheduler`（`agent-scheduler.ts`）管理多 Agent 的并行执行：

- **优先级队列**：high（权重 3）> normal（2）> low（1）
- **默认最大并发数**：3（可通过 `agent:setMaxConcurrent` IPC 调节）
- **Agent 状态机**：`idle → queued → running → completed/error/stopped/paused/review`（Work 非全自动档先进入 `review` 交付验收态，需 `agent:approveDelivery` 才转 `completed`）
- **实时通知**：每次状态变更通过 `agent:updated` 频道广播给前端
- **宿主解耦**：状态广播与审批弹窗一律经 `SchedulerNotifier` 端口下发（`send` / `isAlive`），`agent-scheduler-notifier.ts` 是调度器相关模块里唯一 import `electron` 的地方，因此调度器核心可在无头 / SDK / 测试环境复用
- **迭代预算**：每次运行默认 200 次（设置 → Agent 运行时 → `agentMaxIterations`，收敛 1–500）；预算耗尽的任务在下一次输入框发送时续跑并获得新窗口，累计迭代数以 500 硬上限封顶

### 6.4 工作区隔离

工作区隔离在 `electron/ipc/tool-handlers/worktree.ts`（`worktreeSessions`）中实现：

- **仅 Git 仓库**：`EnterWorktree` 用 `git worktree` 在**项目根的同级目录** `../.auraxis-sandbox/task-<id>` 创建隔离分支 `auraxis-task-<id>`（非 Git 目录会直接拒绝）
- **路径重定向**：进入 worktree 后，后续文件/命令工具自动重定向到沙箱路径
- **沙箱回收**：同一 task_id 重新进入时先 `git worktree remove --force` 并删除旧沙箱目录（当前**没有**启动时的孤儿目录扫描）
- **原生沙箱**：命令级隔离另由 `sandbox-runner.ts` 提供（Windows restricted token / AppContainer、Linux、macOS 四后端）

### 6.5 冲突检测

`conflict-detector.ts` 防止多 Agent 并发写入同一文件：

- 在 Write / Edit / NotebookEdit / Delete 操作前获取文件锁（仅当工具运行在 Agent 任务上下文中，即 `ctx.agentId` 存在时）
- 跟踪文件修改历史（哪个 Agent、何时修改）；同一文件被其他 Agent 持锁时本次写入被拒绝并返回冲突提示（锁 5 分钟自动过期）
- 通过 `conflict:getConflicts` 暴露冲突信息给前端

---

## 七、MCP 协议支持

`mcp-handlers.ts` 实现 MCP（Model Context Protocol）客户端的**策略层**，协议实现委托给官方 `@modelcontextprotocol/sdk`：

- **通信协议**：官方 SDK 的 stdio transport（`StdioClientTransport`）与远程 **Streamable HTTP**（`StreamableHTTPClientTransport`）；握手、能力协商、请求超时与通知由 SDK 负责，协议版本由 SDK 协商（当前 SDK 1.31.0 → `2025-11-25`，此前为手写 JSON-RPC 固定 `2024-11-05`）
- **传输选择**：配置里给 `url` 即走 HTTP、给 `command` 即走 stdio；`transport` 字段可显式覆盖（缺省按是否提供 `url` 推断）
- **远程端点策略**：默认只允许 `https`（`http://localhost` / `127.0.0.1` / `::1` 回环例外）；拒绝云元数据与链路本地地址（SSRF 防护）；私网默认拒绝，`AURAXIS_MCP_ALLOW_PRIVATE_HOSTS=1` 显式放行；`AURAXIS_MCP_ALLOWED_HOSTS` 可配置出口白名单（`example.com` 匹配自身与子域、`.example.com` 仅子域、IP 精确匹配）；禁止在 URL 中内嵌凭据
- **凭据与授权**：静态令牌二选一——`headers` 里自定义，或用界面上的访问令牌（存进 safeStorage 加密凭据库，配置里只留 serverId）。服务端要求授权时可启用 **OAuth（授权码 + PKCE + 动态客户端注册）**：连接会打开系统浏览器，授权码经 `127.0.0.1` 回环回调交给 SDK 的 `finishAuth()`，令牌 / 客户端注册信息 / PKCE verifier 全部加密持久化，服务端声明凭据失效时由 `invalidateCredentials` 自动清理
- **超时**：首次握手 180 秒（npx 冷启动放宽），常规 `tools/list` / `tools/call` 30 秒
- **安全命令验证**：连接前校验服务器命令与参数（命令白名单 + 拒绝代码执行/交互参数）
- **工具发现**：`mcp:listTools` 列出远程 MCP 服务器的工具
- **工具调用**：`mcp:callTool` 调用远程工具（`mcp__serverId__toolName`）；来自 Agent 工具管线的调用会把宿主的 `ToolContext.abortSignal` 带进 SDK 请求选项，中止运行会立刻拒绝在途请求并由 SDK 上发 `notifications/cancelled`（否则长跑工具只能等 30 秒超时兜底）
- **状态管理**：`mcp:connect` / `mcp:disconnect` / `mcp:getStatuses`；子进程退出或出错时（`client.onclose` / `onerror`）立即清空该服务器的工具来源
- **DeepSeek Harness 预设**：设置 → MCP 可一键添加 `deepseek-harness`，首次连接经 `deepseek-harness-mcp` 桥启动本地 Harness Web（该包内部会调用 `npx`）；Windows 下额外注入 `scripts/auraxis-mcp-preload.cjs`（经 `NODE_OPTIONS=--require`），把子进程内嵌的 `.cmd` / `.bat` 经 `cmd.exe` 转发以兼容 `npx.cmd`。

---

## 八、插件系统

> 仓库里有**两套插件机制**，扩展点不同：渲染层的 `src/core/plugin-{manager,loader}.ts`（示例插件、源码扫描、confirm 安装，8.1–8.3 描述的就是它；**只提供命令、生命周期钩子与 UI**）与主进程的 `electron/ipc/dynamic-plugin.ts`（模型经 `MountPlugin` / `UnmountPlugin` 工具在运行时挂载插件，执行时回穿 `executeToolCall` 全权限管线）。**只有主进程机制能提供工具**——工具必须过权限 / 沙箱 / 审批门禁，渲染层插件无法暴露工具；在那里声明的 `tools` 字段会被忽略并由 `loadPlugin` 告警。

### 8.1 扩展点

插件（`src/core/plugin-manager.ts`）提供以下扩展点：

| 扩展点       | 说明                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **commands** | 斜杠命令（`/example`），可操作聊天输入                                                                                      |
| **hooks**    | 生命周期钩子：`afterAgentStart`, `beforeToolExecute`, `afterSessionEnd`, `onAppReady`（接口已定义并收集，事件派发尚未接线） |
| **ui**       | UI 扩展：`settingsComponent`（渲染在设置面板的插件页）                                                                      |

### 8.2 安全模型

插件运行在渲染进程中，安装流程包含多层安全检查：

1. **源代码扫描**（`plugin-loader.ts`）：检测 8 种危险模式
   - `eval()`、`new Function()` — 任意代码执行
   - `require('child_process')` — 系统进程
   - `require('fs')` — 文件系统访问
   - `fetch()` 到非本地地址 — 网络请求
   - `require('net')`、`require('os')`、`require('path')`
2. **结构验证**：检查必填字段（id, name, version, description），工具 schema 验证
3. **路径白名单**：`loadPlugin` 只接受路径中包含 `plugins` 目录段的模块（严格模式可传 `allowedRoots` 限定为具体目录）；两个内置示例插件是打包模块，经 `installBuiltin` 静默装配，不走该校验
4. **用户确认**：安装时展示能力清单与扫描到的风险并等待 confirm（源码扫描为 best-effort，读取失败时风险清单可能为空）
5. **API Key 隔离**：插件无法访问 `safeStorage` 中加密的 API 密钥
6. **权限遵循**：插件工具执行与内置工具遵循相同的权限弹窗检查

### 8.3 内置示例插件

- `src/plugins/example-timestamp.ts` — `/timestamp` 命令，插入 ISO 时间戳
- `src/plugins/example-uuid.ts` — `/uuid` 命令 + `afterSessionEnd` 钩子

---

## 九、持久化系统

### 9.1 Zustand Store 持久化

使用 `zustand/middleware/persist` 中间件，存储至 `localStorage`：

| Store               | localStorage Key           | 持久化内容                                          |
| ------------------- | -------------------------- | --------------------------------------------------- |
| useChatStore        | `auraxis-chat-storage`     | 最近 40 条消息                                      |
| useSettingsStore    | `auraxis-settings-storage` | API Key、默认模型、项目路径、通知设置、侧边栏透明度 |
| useAppStore         | `auraxis-app-storage`      | 主题、侧边栏状态、面板宽度、右侧面板视图            |
| useAgentStore       | `auraxis-agent-storage`    | Agent 列表、优先级、并发设置                        |
| useSessionStore     | `auraxis-session-storage`  | 会话列表（最多 200 个）                             |
| usePluginStore      | `auraxis-plugin-storage`   | 已安装插件、启用状态                                |
| useAdvancedStore    | `auraxis-advanced-storage` | MCP 服务器、权限规则（permissionRules）             |
| useKeybindingsStore | `auraxis_keybindings`      | 快捷键覆盖                                          |
| useI18nStore        | `auraxis-locale`           | 界面语言（中 / 英）                                 |

> **注意**：localStorage key 使用 `auraxis-` 统一前缀，`auraxis_keybindings` 例外。
>
> **不在 localStorage 的持久化**：`useProjectStore` 已改为磁盘持久化（userData 下的 `auraxis-global-state.json`，经 `project:loadGlobalState` / `project:saveGlobalState`），启动时会把遗留的 `auraxis-projects` 键合并后删除；聊天 store 经 `debouncedStorage` 以 1s 防抖写入，流式期间不是逐条落盘；预览浏览器历史直接读写 `auraxis-browser-history`（非 zustand persist）。

### 9.2 长期记忆（Memory）

长期记忆已升级为 **证据先于信念（evidence before belief）的溯源记忆**（Eywa + MAP-Graph，完整方案见第五章 5.2/5.3）：

- **三层数据模型**：Evidence（不可变源证据，SQLite/JSON 双后端）→ Signal（规则优先的类型化信号）→ Belief（LLM 派生 + 硬锚点验证，支持 / 不支持 / 引用不存在三态）
- **实时证据钩子**：`chat-log.ts` / `session-log.ts` 写入后 best-effort 捕获用户消息与工具终态证据
- **确定性读路径**：R1 关键词（FTS5 trigram 索引；不足 3 字符回退 `LIKE`）/ R2 实体时间 / R3 观测流 / R4 本地向量（可选；`EmbeddingProvider` 接缝 + 向量落库，见 §5.11），零 LLM；`memory:readForQuery` 返回 context + policy + facts + diagnostics，聊天注入已切换
- **审计与归因**：beliefAudit / readTrace / erase（擦除留审计事件）；MemoryPanel 展示证据链、支持强度、修订历史与读路径诊断；五层失败归因测试
- **多 Agent 授权（M5）**：`AURAXIS_MEMORY_RISK_GATE=1` 启用 memory-graph 类型化执行图，按 Agent 角色授权、路径信任、高风险动作门控
- **兼容**：旧 `memory:getByProject` / `getByType` / `search` 等通道映射到新模型；legacy 记忆标记 `legacy=1`，不静默视为已验证

### 9.3 会话管理

`useSessionStore.ts` 管理对话会话：

- **自动保存**：流式完成后通过 `saveSession()` 自动保存
- **容量限制**：最多保存 200 个会话（每个会话最多保留最近 200 条消息）
- **操作**：保存、加载、删除、导出、分叉（fork）

### 9.4 加密设置存储

`settings-store.ts` 使用 Electron `safeStorage` API 加密存储 API Key：

- 设置文件：用户数据目录下的 JSON 文件
- API Key：使用 `safeStorage.encryptString()` → Base64 编码
- 读取时自动解密：`safeStorage.decryptString()`
- API Key 不会在 `settings:get` 返回中暴露
- 旧版明文 Key 首次启动读取时自动迁移为加密存储（一次性、写回后删除明文）
- 加密不可用时**丢弃**该 Key（绝不落明文，自定义模型的内嵌 apiKey 同样处理）；解密失败时同样丢弃该 Key 而不是暴露损坏数据

### 9.5 日志保留与缓存清理

桌面端 GUI 启动时执行 best-effort 维护（`log-retention.ts` + 各 store 的 `prune()`；SDK / ACP / `--run` 无头模式会提前返回，不执行该维护）：

- **日志保留**：聊天/Agent JSONL 日志默认保留 180 天或 256MB，可通过 `AURAXIS_LOG_RETENTION_DAYS` / `AURAXIS_LOG_MAX_FILE_MB` 覆盖
- **投影缓存清理**：删除没有对应 JSONL 日志的 `session-cache` 孤儿行（SQLite 后端）
- **FTS 重建**：启动时全量重建索引，之后每次追加日志按会话 600ms 防抖增量刷新
- **规范上下文快照**：Work/Code 每轮以 `llm_context_v1` system 事件写入 chat-log（用于缓存对齐重放），编辑/删除/重生成/撤销时追加 `llm_context_clear` 墓碑；两者随日志保留策略一并清理

SQLite 投影缓存与 FTS 索引均带 `PRAGMA user_version = 1`，后续结构变更可走版本迁移。

### 9.6 文件撤销

`undo-manager.ts` 实现文件级撤销：

- **触发**：Write / Edit / NotebookEdit / Delete 工具执行前自动备份
- **快照存储**：`.auraxis-snapshots/` 目录
- **操作**：撤销（undo）、恢复（revert）、获取历史

---

## 十、模型配置

### 10.1 模型解析链路

`model-config.ts` 中的 `getAllModels()` 函数按以下优先顺序解析（内置模型定义在 `electron/contracts/core.ts` 的 `BUILT_IN_MODELS`）：

```
1. 内置模型 (deepseek-flash = V4.1 Flash、deepseek-v4-pro；已下线旧名不再列出，仅由 resolveModelId() 作为兼容别名路由到 V4.1 Flash)
   ↓
2. AURAXIS_MODELS 环境变量（JSON 数组）
   ↓
3. 持久化自定义模型（用户通过 UI 添加的）
```

### 10.2 环境变量

参见 `.env.example`（[查看文件](../.env.example)）：

| 变量                                                                        | 说明                                                                                                                                                                                      | 默认值                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `DEEPSEEK_API_KEY`                                                          | DeepSeek API 密钥                                                                                                                                                                         | 无（必填）                                        |
| `DEEPSEEK_BASE_URL`                                                         | OpenAI 兼容端点                                                                                                                                                                           | `https://api.deepseek.com/beta/chat/completions`  |
| `DEEPSEEK_ANTHROPIC_BASE_URL`                                               | Anthropic 格式端点（**当前仅预留**：无调用方，不参与端点选择）                                                                                                                            | `https://api.deepseek.com/anthropic/v1/messages`  |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`                                  | 占位变量，当前版本未读取                                                                                                                                                                  | 无 / `https://api.anthropic.com/v1/messages`      |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL`                                        | 占位变量，当前版本未读取                                                                                                                                                                  | 无 / `https://api.openai.com/v1/chat/completions` |
| `AURAXIS_MODELS`                                                            | 自定义模型（JSON 数组）                                                                                                                                                                   | 无                                                |
| `AURAXIS_ALLOW_UNSAFE_CODE`                                                 | 仅受信开发环境：允许 RunCode / 动态插件 / 内联工作流执行任意代码                                                                                                                          | 默认关闭                                          |
| `AURAXIS_TRUST_PROJECT_RULES` / `AURAXIS_TRUST_PROJECT_HOOKS`               | 信任并加载项目目录 `.auraxis/rules/*.rules` / `.auraxis/hooks.json`                                                                                                                       | 默认关闭                                          |
| `AURAXIS_UNATTENDED_AUTOAPPROVE`                                            | 允许 cron / 跟进任务 / 工作流以全自动全权限执行                                                                                                                                           | 默认关闭（走 ask 审批）                           |
| `AURAXIS_SDK_TOKEN` / `AURAXIS_SDK_AUTOAPPROVE` / `AURAXIS_ACP_AUTOAPPROVE` | SDK / ACP 服务令牌与全自动开关（未设 token 时自动生成并告知客户端）                                                                                                                       | 随机 token / 关闭                                 |
| `AURAXIS_SANDBOX_MODE` / `AURAXIS_SANDBOX_BACKEND`                          | 强制沙箱模式（read / workspace-write / full）与原生后端                                                                                                                                   | 按权限预设解析                                    |
| `AURAXIS_MCP_ALLOW_PRIVATE_HOSTS`                                           | 允许远程 MCP 连接内网地址（默认拒绝，防 SSRF）                                                                                                                                            | 默认关闭                                          |
| `AURAXIS_MCP_ALLOWED_HOSTS`                                                 | 远程 MCP 出口主机白名单（逗号分隔；`example.com` 含子域、`.example.com` 仅子域）                                                                                                          | 未设置时不限制主机                                |
| `AURAXIS_MEMORY_RISK_GATE`                                                  | 启用 MAP-Graph 记忆风险门控（M5）                                                                                                                                                         | `1` 时启用，默认关闭                              |
| `AURAXIS_MEMORY_EMBEDDINGS`                                                 | 启用 R4 本地确定性向量路由                                                                                                                                                                | 默认关闭                                          |
| `AURAXIS_MEMORY_LLM_SIGNALS`                                                | 在规则信号之外追加 LLM 信号检测                                                                                                                                                           | 默认关闭                                          |
| `AURAXIS_AUTH_DISABLED`                                                     | 测试/CI 环境跳过登录门（正常桌面使用勿设）                                                                                                                                                | 默认关闭                                          |
| `AURAXIS_USER_DATA_DIR`                                                     | 覆盖 userData 目录（账户/设置隔离，测试用）                                                                                                                                               | 默认无                                            |
| `AURAXIS_TELEMETRY_MODE`                                                    | 遥测开关（opt-in，取值 off / feedback-only / full）                                                                                                                                       | 默认关闭                                          |
| `AURAXIS_LLM_GATEWAY`                                                       | 强制指定 LLM 网关。不设置时：OpenAI 兼容线（`/chat/completions`）走官方 Vercel AI SDK，Anthropic Messages / Responses 仍走内置适配器；设为 `builtin` 则整体回退到仓库自研实现（应急开关） | OpenAI 兼容线走 `ai-sdk`，其余走 `builtin`        |
| `AURAXIS_OTLP_ENDPOINT`                                                     | 把 Agent 轨迹导出为 OTLP/HTTP JSON span（run / turn / tool / subagent；审批作为根 span 属性）。Agent 终止时与 headless 运行结束后触发；投递失败只记日志，不影响运行                       | 未设置则完全不导出                                |
| `AURAXIS_OTLP_SERVICE_NAME` / `AURAXIS_OTLP_HEADERS`                        | `service.name` resource 属性 / 额外请求头（`k=v,k2=v2`）                                                                                                                                  | `auraxis` / 无                                    |
| `AURAXIS_LOG_RETENTION_DAYS` / `AURAXIS_LOG_MAX_FILE_MB`                    | 日志保留天数 / 单文件上限                                                                                                                                                                 | 180 / 256                                         |

### 10.3 自定义模型格式

```json
[
  {
    "id": "my-model",
    "name": "My Custom Model",
    "apiBase": "https://my-api.example.com/v1/chat/completions",
    "apiKey": "sk-xxx",
    "protocol": "anthropic-messages"
  }
]
```

`protocol` 可选，取值为 `openai-chat`（默认）/ `anthropic-messages` / `openai-responses`；端点路径不规整时显式声明它，就不必依赖 URL 特征来猜协议。

### 10.4 双 API 格式支持

协议判定收敛在 `electron/contracts/core.ts` 的 `resolveModelProtocol()`，优先级为：**调用方显式传入的 `protocol`** → **模型在设置 / `AURAXIS_MODELS` 里声明的 `protocol`** → **按 `apiBase` 形状推断**（以 `/responses` 结尾 → 官方原生 **Responses API**（Codex 类客户端格式）；含 `/messages` 或 `/anthropic/` → Anthropic Messages；否则 OpenAI 兼容）。

端点本身来自 `resolveModelApiBase()`（`AURAXIS_MODELS` → 设置里的自定义模型 `apiBase` → 否则 `DEEPSEEK_BASE_URL`）。模型能力（`tools` / `vision` / `reasoning`）同样由 `modelCapabilities()` 统一给出，provider 内不再做字符串判断；`DEEPSEEK_ANTHROPIC_BASE_URL` 目前预留、不参与路由。

### 10.5 DeepSeek 官方能力与接口

- **思考强度**：`low / high / max` 三档（`reasoning_effort`）；Chat 模式按 DeepSeek 风格固定 high 并由思考开关控制，Work/Code 保留滑轨选择。Agent 引擎链路每次请求都显式发送 `thinking: enabled|disabled`（思考态不发送 temperature）；Chat 流式链路仅在开启思考时发送 `enabled`
- **V4.1 Flash（`deepseek-flash`）**：原生多模态——`user` 消息可携带图片（JPEG/PNG/GIF/WebP），ReadImage 结果以图片内容块下发；已下线的旧名（`deepseek-v4-flash-vision-exp`、`deepseek-v4-flash`）仍会解析到该模型
- **strict tools（Beta）**：严格工具模式，空 schema 工具自动兼容处理，避免「对象不能为空」类 400 错误
- **计划生成 JSON 模式**：Agent 规划阶段用 JSON 模式生成 TaskPlan
- **对话前缀续写**：代码块「继续写」走对话前缀（prefix）续写
- **FIM 补全（Beta）**：代码补全接口
- **流式 usage 与上下文缓存命中展示**：流式事件携带 usage / cache 命中，UI 内联展示
- **上下文缓存对齐**：Work/Code 按会话保存规范消息快照并逐轮重放，动态内容（记忆、新问题）尾部化，编辑历史时作废旧快照（详见第五章 5.9 与第四章 4.7）
- **user_id 隔离**：按本地账户派生 DeepSeek user_id（auth-store → ai-handlers）
- **单次最大输出 tokens**：可配置，上限 384K
- **官方离线 tokenizer**：本地 token 计数，不依赖网络
- **原生搜索**：DeepSeek 官方搜索为默认联网 provider，失败自动降级 DuckDuckGo，另支持 Exa / Perplexity
- **影子适配器（AI SDK）**：`llm-adapter-ai-sdk.ts` 经 `registerLlmAdapter('ai-sdk', …)` 接入 Vercel AI SDK 6（`ai@^6.0.296`，自带 Custom Provider，无需 `@ai-sdk/*` 包）。**默认不启用、不参与生产请求路径**，注册阶段零加载（懒加载 `ai`），仅用于验证 adapter seam 与后续迁移探路；同一份 SSE 在两条路径上的输出由测试逐字段比对

---

## 十一、主窗口配置

`main.ts`（[查看文件](../electron/main.ts)）配置：

- **窗口**：1200×800，最小 600×500，无边框（`frame: false`），macOS 隐藏标题栏
- **CSP（内容安全策略）**：
  - 开发模式：script-src 允许 `unsafe-inline`（Vite HMR 需求），`connect-src` 追加 `http://localhost:*` 与 `ws://localhost:*`
  - 生产模式：script-src 收紧为 `'self'`；style-src 仍允许 `'unsafe-inline'` 与 Google Fonts，img-src 允许 `'self' data: https: http:`，frame-src 允许 `http://localhost:*` / `http://127.0.0.1:*` / `https:`（内部预览浏览器）
  - `connect-src` 白名单是 9 个显式来源：`api.deepseek.com`、`html.duckduckgo.com`、`api.exa.ai`、`api.perplexity.ai`、`slack.com`、`www.googleapis.com`、`api.notion.com`、`fonts.googleapis.com`、`fonts.gstatic.com`（见 `electron/network-policy.ts`；**没有** `https://*` 通配）
- **单实例锁**：`app.requestSingleInstanceLock()` 防止多开
- **全局错误处理**：`uncaughtException` 和 `unhandledRejection` 通过 `app:error` 频道发送到渲染进程
- **安全**：仅允许 `https://` / `http://` 外部链接

---

## 十二、构建与部署

### 12.1 构建流程

```
源代码
  ├── electron/ ─────────→ tsc6 (tsconfig.electron.json) ─────────→ dist-electron/
  ├── electron/preload.ts → vite build (vite.preload.config.mts) ─→ dist-electron/preload.js
  └── src/ ──────────────→ Vite build ───────────────────────────→ dist/

dist-electron/ + dist/ ──→ electron-builder ──→ release/
```

### 12.2 打包配置

`electron-builder.yml` 支持三个平台：

- **Windows**：NSIS 安装程序
- **macOS**：DMG（x64 + arm64）
- **Linux**：AppImage

### 12.3 自动更新与签名

- **更新通道**：打包版本通过 `electron-updater` 读取 Release 里的 `latest*.yml` 元数据（`app-update.yml` 由 electron-builder 写入应用 resources）。设置 → 关于页可手动检查 / 下载 / 重启安装；启动 15 秒后还会自动检查一次，`autoDownload = false`，不会在后台偷跑几百 MB 流量。
- **签名与公证**：CI 读取 `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`（Developer ID 证书）、`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`（公证）、`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`（Windows 代码签名）；缺少某个 secret 时自动跳过该步骤，仍然产出可运行的未签名产物。
- **本地验证**：`npx electron-builder --win --dir` 只打包目录（不生成安装包，也不生成 `app-update.yml`）；要验证更新链路需在对应平台执行真实目标构建。
- **Python SDK 发布**：`.github/workflows/publish-pypi.yml` 在 `v*` 标签上把 `python/auraxis_sdk` 构建为 sdist + wheel（`python -m build` + `twine check`）并上传 PyPI。发布前先断言 `pyproject.toml` 版本与 `package.json` 一致；未配置 `PYPI_API_TOKEN` 时只构建并告警——与签名 secrets 缺失时跳过的处理一致。开发工具链（ruff / pytest）钉在 `dev` extra 里；本地 `npm run sdk:check:py` 一次跑 ruff + pyright + unittest。

### 12.4 环境变量加载

应用使用内置 `.env` 解析器从项目根目录加载环境变量（无第三方 `dotenv` 依赖）。运行 `npm run electron:dev` 前需创建 `.env` 文件（参考 `.env.example`）。

---

## 十三、开发约定与注意事项

### 13.1 代码风格

- **语言**：用户界面文本、内联注释、文档使用**中文**
- **IPC 处理程序**：全部异步，返回 `IpcResponse<T>` 格式
- **状态管理**：全局状态仅使用 Zustand Store，不使用 Redux 或 React Context
- **组件**：功能组件 + Hooks，UI 组件库统一使用 Ant Design 6

### 13.2 测试

- **测试框架**：Vitest（`describe`, `it`, `expect`, `vi` 通过 globals 注入）
- **主进程测试**：`electron/**/__tests__/`，node 环境，依赖 `electron` 的模块用 `vi.mock('electron', ...)` 隔离
- **渲染进程测试**：`src/**/__tests__/`，jsdom 环境（@testing-library/react）
- **测试总数**：325 个测试文件 / 2,739 个用例通过（平台/CI 相关跳过不在其中）
- **覆盖率口径**：门槛统计范围包括 `electron/**`、`src/stores/**`、`src/core/**`；UI 组件（`src/components/`）与主进程入口（`main.ts` / `preload*.ts` 等）不计入该门槛，另有组件级测试与 Playwright 端到端测试（`npm run test:e2e`）覆盖
- **覆盖率阈值**：行/语句 ≥ 80%，分支 ≥ 80%，函数 ≥ 80%（最近一次全仓库分支门禁报告为 89.86% statements / 92.25% lines / 81.36% branches / 89.00% functions，四项均已达标；Electron 主入口与 preload 桥由真实 E2E、SDK smoke 与 headless CLI 验证，Linux CI 默认执行覆盖率门禁，`check-doc-stats` 允许 ≤0.6pp 的平台差异）
- **覆盖率报告**：`npm run test:coverage` 同时输出 `coverage/coverage-summary.json`（gitignore 的开发期产物）；设置面板「测试覆盖率」页经 `coverage:get` IPC 实时读取，纯浏览器 dev 由 Vite 中间件提供同一路径，生产构建将其拷入 `dist/coverage/`。报告缺失时面板提示运行命令，不显示伪造数字。
- **端到端测试**：16 条 Playwright UI 链路通过（真实 Electron，含本地注册 → 登录 → 记住我持久化）
- **实战验收（DeepSeek 真实 API）**：Chat 流式回答、Code 自动代批 Bash、Code「每次确认」权限卡（允许一次后写入文件）、Work 智能放行执行流、Work 计划审批面板均跑通；`deepseek-flash`（V4.1）另完成图片输入（色块识别正确）、思考开/关、多轮工具链、三种能力面门禁（chat 零工具调用）与全新零依赖 CommonJS + `node:test` 项目的创建与 `npm test` 真实验证；内联 `RunWorkflow` 保持 fail-closed。将 `agentMaxIterations` 设为 3 的实测中，任务恰好在预算处收尾且已写文件真实落盘，随后在输入框发送消息即可续跑。宿主无法创建受限令牌时，Windows 原生沙箱会拒绝执行而非降级为非沙箱运行（`electron/sandbox-runner.ts`）。
- **压力测试（本地 mock LLM + 真实 Electron）**：200 会话冷启动约 1.4s、会话切换约 155ms、FTS 重建约 178ms；18 个 Agent（6 并发）与 30 个 Agent（8 并发）全部完成、无失败；极端负载（30 个任务 + 200 行侧栏同时渲染）下快速模式切换偶发 8–11s 卡顿并有一次超过 15s，负载结束后自动恢复；默认 3 并发下无此现象。
- **环境**：本机 Python 3.10.x（当前实测 3.10.9；PATH 上的 `python` 是 Microsoft Store 占位，需用 `py -3`）；`npm run sdk:test:py` 7 个用例通过，`npm run sdk:smoke` 已验证真实无头 runtime。
- **运行命令**：`npm test`（全量）、`npm run test:backend`（IPC 层：electron/ipc）、`npm run test:frontend`（渲染进程）、`npm run test:coverage`（覆盖率报告）、`npm run check:docs`（文档与版本统计校验）、`node scripts/ui-preview.mjs`（一次性 UI 截图工具：用系统 Chrome 跑渲染层，需先 `npm run dev`；仅供开发，不进 CI）

### 13.3 类型契约

跨进程共享类型只定义在 `electron/contracts/`，`electron/types.ts`、`electron/advanced-defs.ts` 与 `src/types/{advanced,agent}.ts` 一律 re-export，禁止在渲染层再镜像一份（`src/types/electron-api.ts`、`chat.ts`、`tools.ts` 等是渲染层投影与自有类型）。

### 13.4 前端布局架构

主界面为 **Chat / Work / Code 三模式**（侧边栏切换，各模式独立保持状态，无 split/fullscreen 切换）：

```
┌─ Top Bar (标题栏 + 窗口控制) ──────────────────────────────┐
├─ Tab Bar (多 tab 时显示) ──────────────────────────────────┤
├─────────────────────────────────────────────────────────────┤
│ Sider │ 浮动头栏（模式切换 / 压缩 / 分叉 / 会话日志）        │
│ (Nav) │ ─────────────────────────────────────────────────── │
│       │ 消息区（占满整个主聊天区，上下延伸到悬浮层背后）    │
│       │                                                    │
│       │ [悬浮输入 Dock：context 行 + 输入框 + 工具栏]       │
└───────┴────────────────────────────────────────────────────┘
```

- **三模式**：Chat（对话）/ Work（任务执行）/ Code（代码编程）由侧边栏切换；思考开关与思考强度按模式保存（`modeThinkingPrefs`），切换回来时还原（联网开关是全局状态，不做 per-mode 快照）
- **登录与账户**：AuthGate 登录门（首启注册、可跳过）；顶部栏账户与头像显示在设置按钮左侧；设置面板 AccountPane 支持改密与头像上传
- **输入 Dock**：Chat 显示思考开关 + 联网搜索按钮（紧邻，DeepSeek 风格），无思考深度选择；Work/Code 默认思考开启并保留思考深度滑轨（low/medium/high，磁吸流式特效）；输入框圆角、无聚焦光效
- **Work 模式**：输入区居中，任务看板 + Agent 执行流程视图（回合 / 工具行 / 交付物 / 状态）；**仅文档边界**——Work 任务只能写文档/非代码文件，代码文件写入由 `electron/work-docs-policy.ts` 硬拒绝，输入区显示「仅文档」标识
- **右侧面板**：通过工作台下拉菜单打开，不覆盖主内容；缩到最小限度时无关闭按钮（仅可缩回）；每个功能（变更 / 文件 / 执行详情 / 时间线 / 预览）都带「新建」，在新的一栏打开，分栏为**左右并排**
- **主区固定对话**：顶部 tab 栏已移除，文件 / 变更 / 预览等辅助视图统一收进右侧面板；头栏的导航历史随之不再随标签切换变化
- **消息区满幅 + 悬浮层**：输入 Dock 与顶部头栏都是悬浮层，消息从上下穿过时经渐变淡出；列表首尾垫出与悬浮层等高的滚动空间
- **顶部分隔线**：对话执行中显示，窗口最大化时隐藏
- **Token/Model 状态**内联在输入 Dock 上方，无独立 Inspector 面板

### 13.5 已知限制

- **持久化 key 前缀**：已统一为 `auraxis-`，`auraxis_keybindings` 例外
- **硬编码限制**：
  - Agent 业务迭代上限 200 次（可配置），安全硬上限 500 次
  - 调度器最大并发数 3
  - 会话列表最多保留 200 个（每个会话最多 200 条消息）
  - Agent 日志最多 500 条
  - 会话消息持久化仅保留最后 40 条（`useChatStore`）
  - 语音输入在 Electron 环境通常不可用（`webkitSpeechRecognition` 受限）

### 13.6 设计系统

Aura 设计系统 —「Black is the Axis，White is the Structure，Purple is the Aura」：

- **品牌色**：Auraxis Black `#111216`（深底）/ Ivory `#F1F1EE`（浅底文字）+ Aura 紫灰 `#8C8AA8` 仅作约 3% 强调；**禁止蓝色与大面积彩色渐变**
- **圆角六档**：5 / 6 / 8 / 12 / 14 / 9999，禁用 3/4/7/9/10px 碎角
- **hairline 边框**：`--color-border-dim` 统一发丝线，不加深色实线、不加硬阴影堆叠
- **零位移动画**：按钮/弹窗无 hover 位移缩放与开合动画，只保留功能性旋转与数据驱动动画
- **选中态**：背景高亮（`bg-primary-soft`），**禁止左侧色条**
- **字重**：正文 400 / 条目按钮 500 / 标题激活 600；控件统一 36px 高；内容宽度 748px
- **图标**：`lucide-react` 经 `src/components/common/icons.tsx` 兼容层；**禁用 AntD 图标与 @phosphor-icons/react**
- **字体**：Latin 用随包 Inter Variable，CJK 回退系统栈（Segoe UI / PingFang SC / Microsoft YaHei）；等宽栈 `SF Mono, JetBrains Mono, Fira Code, Cascadia Code, Consolas`
- **动画**：`prefers-reduced-motion` 适配；执行等待用 **Auraxis 运行标记**（矢量：轴 + 光环 + 沿轨道巡行的弧，`src/components/common/ExecutingIndicator.tsx`）+ 渐变流光文字；思考深度滑轨为数据驱动磁吸动画（特效随深度递增、磁吸力递减）
- **侧边栏透明度**：设置 → 外观 → 侧边栏透明度（0–100%）；仅 Windows 11 启用原生 Acrylic（`backgroundMaterial: 'acrylic'`），非 Win11 自动禁用滑杆；最透明保留约 12% 底色保证文字可读，顶部栏保持不透明。

### 13.7 IDE 别名

Vite 和 TypeScript 均配置 `@/` 别名映射到 `src/`：

```typescript
// 等价于 src/components/chat/MessageBubble.tsx
import { MessageBubble } from '@/components/chat/MessageBubble';
```

---

## 附录：快速参考

### 常用命令

```bash
npm run electron:dev     # 完整开发环境
npm run dev              # 仅前端（Vite HMR，无 Electron）
npm run electron:compile # 编译主进程 + 打包 preload 桥
npm test                 # 运行所有测试
npm run test:backend     # 后端测试
npm run test:frontend    # 前端测试
npm run test:coverage    # 覆盖率测试
npm run build            # 生产构建
```

### 关键文件索引

| 文件                                                                                                | 职责                                                 |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [electron/main.ts](../electron/main.ts)                                                             | 应用入口                                             |
| [electron/preload.ts](../electron/preload.ts)                                                       | IPC 桥接                                             |
| [electron/preload-api.ts](../electron/preload-api.ts)                                               | IPC 桥接组合                                         |
| [vite.preload.config.mts](../vite.preload.config.mts)                                               | 沙箱安全 preload 打包                                |
| [electron/ipc/index.ts](../electron/ipc/index.ts)                                                   | IPC 注册总入口                                       |
| [electron/tool-defs.ts](../electron/tool-defs.ts)                                                   | 工具定义                                             |
| [electron/tool-defs/](../electron/tool-defs/)                                                       | 工具定义（按能力族拆分）                             |
| [electron/agent-runtime/step-engine.ts](../electron/agent-runtime/step-engine.ts)                   | 统一 ReAct 步进引擎                                  |
| [electron/ipc/query-engine.ts](../electron/ipc/query-engine.ts)                                     | Work/Code 查询驱动                                   |
| [electron/ipc/query-context.ts](../electron/ipc/query-context.ts)                                   | 规范上下文快照（缓存对齐重放 / 记忆去重 / 失效墓碑） |
| [electron/agent-runtime/agent-loop.ts](../electron/agent-runtime/agent-loop.ts)                     | Agent 驱动（规划/审批/偏差/停止策略）                |
| [electron/ipc/agent-scheduler.ts](../electron/ipc/agent-scheduler.ts)                               | 多 Agent 调度                                        |
| [electron/ipc/tool-handlers.ts](../electron/ipc/tool-handlers.ts)                                   | 工具执行门面（注册表/管线见 tool-handlers/）         |
| [electron/ipc/tool-handlers/runtime.ts](../electron/ipc/tool-handlers/runtime.ts)                   | Cron / 跟进 / 任务 / Job 工具                        |
| [electron/ipc/tool-handlers/lsp.ts](../electron/ipc/tool-handlers/lsp.ts)                           | LSP 代码智能                                         |
| [electron/ipc/tool-handlers/review.ts](../electron/ipc/tool-handlers/review.ts)                     | ReviewArtifact 质量门                                |
| [electron/ipc/tool-handlers/execution.ts](../electron/ipc/tool-handlers/execution.ts)               | 插件 / 技能 / 工作流 / 代码 / PowerShell 工具        |
| [electron/ipc/tool-handlers/worktree.ts](../electron/ipc/tool-handlers/worktree.ts)                 | Git 工作树沙箱会话工具                               |
| [electron/ipc/agent-scheduler-class-impl.ts](../electron/ipc/agent-scheduler-class-impl.ts)         | 多 Agent 调度器实现（-class.ts 为兼容入口）          |
| [electron/ipc/agent-scheduler-types.ts](../electron/ipc/agent-scheduler-types.ts)                   | 调度契约 + 计划映射                                  |
| [electron/ipc/permission-handlers.ts](../electron/ipc/permission-handlers.ts)                       | 权限控制                                             |
| [electron/code-mode.ts](../electron/code-mode.ts)                                                   | Code Mode（TS 工具编排）                             |
| [electron/agent-runtime/step-compressor.ts](../electron/agent-runtime/step-compressor.ts)           | AGORA 步骤级压缩                                     |
| [electron/workspace-drift.ts](../electron/workspace-drift.ts)                                       | SWE-Touch 工作区漂移                                 |
| [electron/approval-fatigue.ts](../electron/approval-fatigue.ts)                                     | Oversight 审批疲劳                                   |
| [electron/tool-inertia.ts](../electron/tool-inertia.ts)                                             | AutoTool 工具惯性                                    |
| [electron/skill-gate.ts](../electron/skill-gate.ts)                                                 | VaG 技能门禁                                         |
| [electron/auth-store.ts](../electron/auth-store.ts)                                                 | 本地账户（注册/登录/头像）                           |
| [electron/ipc/memory-read.ts](../electron/ipc/memory-read.ts)                                       | Eywa 确定性读路径                                    |
| [electron/ipc/memory-graph.ts](../electron/ipc/memory-graph.ts)                                     | MAP-Graph 授权门控                                   |
| [electron/contracts/](../electron/contracts/)                                                       | 跨进程类型契约                                       |
| [electron/session-store.ts](../electron/session-store.ts)                                           | 统一事件日志                                         |
| [src/App.tsx](../src/App.tsx)                                                                       | React 根组件                                         |
| [src/stores/useChatStore.ts](../src/stores/useChatStore.ts)                                         | 聊天状态                                             |
| [src/components/auth/AuthGate.tsx](../src/components/auth/AuthGate.tsx)                             | 登录门                                               |
| [src/components/work/WorkExecutionFlow.tsx](../src/components/work/WorkExecutionFlow.tsx)           | Work 执行流程视图                                    |
| [src/components/input/ThinkingDepthSelector.tsx](../src/components/input/ThinkingDepthSelector.tsx) | 思考深度滑轨（磁吸流式特效）                         |
| [src/core/plugin-manager.ts](../src/core/plugin-manager.ts)                                         | 插件管理                                             |
| [src/styles/theme.ts](../src/styles/theme.ts)                                                       | 主题配置                                             |
