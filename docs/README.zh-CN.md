<img width="3078" height="1376" alt="" src="https://github.com/user-attachments/assets/cc06146b-51a2-4b2e-a6c4-41aca0a0fb5e" />

# Auraxis 项目架构与开发文档

相关文档：[TS SDK](../packages/auraxis-sdk/README.md) · [Python SDK](../python/auraxis_sdk/README.md) · [工程规范](../AGENTS.md)

## 一、项目概述

Auraxis v3.2.0 是一款基于 Electron 的桌面端智能体工作台，融合了统一 ReAct 步进引擎、多智能体调度、Code Mode 工具编排、插件扩展和持久化项目记忆。执行语义遵循通用约定（`end_turn` 即回合结束，无剧本/强制门），ReviewArtifact 作为可选验证工具。后端 LLM 默认为 DeepSeek API（兼容 OpenAI / Anthropic 格式），联网搜索默认使用 DeepSeek 官方原生搜索（失败自动降级 DuckDuckGo，另支持 Exa / Perplexity provider）。DeepSeek 官方能力已接入：思考强度 low/high/max 三档、strict tools（Beta）、计划生成 JSON 模式、对话前缀续写（代码块“继续写”）、FIM 补全（Beta）API、流式 usage 与上下文缓存命中展示、user_id 隔离、可配置单次最大输出 tokens（上限 384K）、官方离线 tokenizer 本地计数。

项目采用**论文驱动开发**：已落地 7 篇 arXiv 论文的核心技术——Eywa（溯源长期记忆）、MAP-Graph（多 Agent 共享记忆授权）、AGORA（步骤级上下文压缩）、SWE-Touch（工作区漂移感知）、Oversight Has a Capacity（审批疲劳守卫）、AutoTool（工具使用惯性）、Verifier-as-Gatekeeper（技能库污染门禁）；另落地 4 项缓存方向论文/系统技术——RadixAttention（规范历史重放 / 公共前缀最大化）、Prompt Cache（稳定块组织）、Cache-Aware Prompt Compression（动态内容尾部化）、Byte-Exact Deduplication（记忆块字节级去重）。论文地址、技术映射与落地模块详见「[第五章 研究论文与技术落地](#五研究论文与技术落地)」。产品侧新增本地账户登录、Chat / Work / Code 三模式、思考与联网搜索开关、Agent 执行流程视图、会话事件时间轴、上下文缓存对齐等能力。

- **主进程**：Electron 主进程（`electron/`），负责窗口管理、IPC 通信、工具执行、智能体调度
- **渲染进程**：React 18 + Vite（`src/`），负责 UI 渲染、状态管理、用户交互
- **进程通信**：通过 Electron IPC（`contextBridge` + `ipcMain/ipcRenderer`）进行双向通信

### 技术栈

<img width="1462" height="861" alt="" src="https://github.com/user-attachments/assets/7f6f67f1-d32c-4d82-a374-dd5d4174fdcc" />

| 层            | 技术                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| 桌面框架      | Electron 43（Node 24，内置 `node:sqlite`），无边框窗口，`contextIsolation: true`                         |
| 前端          | React 18 + TypeScript 5.5 + Vite 7                                                                       |
| UI 组件库     | Ant Design 5，自定义深色/浅色主题                                                                        |
| 状态管理      | Zustand 4；会话/设置/插件状态以主进程为权威，localStorage 仅作渲染层缓存                                 |
| 存储与检索    | 会话/Agent 统一 JSONL 事件日志 + SQLite 投影缓存 + FTS5 全文搜索 + 长期记忆（better-sqlite3，JSON 回退） |
| Markdown 渲染 | react-markdown + remark-gfm + rehype-highlight + rehype-katex + mermaid                                  |
| AI API        | axios（SSE 流式请求），支持 DeepSeek/OpenAI 格式和 Anthropic 格式；MCP、AGENTS.md、生命周期 hooks 协议   |
| 测试          | Vitest + @testing-library/react + jsdom（渲染进程），node 环境（主进程）                                 |
| 构建          | Vite + electron-builder 26（NSIS/DMG/AppImage；原生依赖需 Python/VS 环境重编译）                         |

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
- **专业文档技能**：`ReadDocument` / `WriteDocument` 读写 Word（.docx）、Excel（.xlsx）、PPT（.pptx）、PDF（.pdf），内置 5 个开箱即用技能（Word / Excel / PPT / PDF / 云连接器）
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
Electron Main Process (electron/)            Renderer Process (src/)
┌──────────────────────────────────┐    ┌──────────────────────────────┐
│ main.ts — 窗口创建, CSP, 单实例锁  │    │ main.tsx → App.tsx            │
│ preload.ts — contextBridge API   │◄──►│ React 18 + Ant Design 5       │
│                                      │    │                              │
│ ipc/index.ts — 注册 30+ 模块处理器 │IPC │ Zustand Stores (18个)         │
│ ipc/step-engine.ts — 统一ReAct步进 │    │                              │
│ ipc/query-engine.ts — 聊天驱动     │    │ src/core/ — 插件管理器        │
│ ipc/agent-loop.ts — Agent 驱动     │    │   工具/命令注册表              │
│ ipc/agent-scheduler.ts — 调度器    │    │   工具/命令注册表              │
│ ipc/agent-handlers.ts — Agent CRUD │   │                              │
│ ipc/tool-handlers.ts — 71个工具执行│   │ src/components/ — UI 组件     │
 │ tool-defs.ts — 71 个工具定义     │    │    chat/, input/, layout/,    │
│ ipc/permission-*.ts — 权限系统    │    │    settings/, agent/,         │
│ ipc/mcp-handlers.ts — MCP 协议    │    │    permissions/, preview/     │
│ ipc/memory-*.ts — 溯源记忆        │    │                              │
│ ipc/model-config.ts — 模型配置    │    │ @/ 别名 → src/               │
│ ipc/settings-store.ts — 加密存储   │    │                              │
│ ipc/conflict-detector.ts — 冲突检测│    │                              │
│ ipc/undo-manager.ts — 撤销管理    │    │                              │
│ ipc/plan-handlers.ts — 计划审批    │    │                              │
│ code-mode.ts — Code Mode 程序执行 │    │                              │
│ step-compressor.ts — AGORA 压缩     │    │                              │
│ workspace-drift.ts — SWE-Touch      │    │                              │
│ approval-fatigue.ts — Oversight     │    │                              │
│ tool-inertia.ts — AutoTool          │    │                              │
│ skill-gate.ts — VaG 技能门禁        │    │                              │
│ attachments.ts — 内容寻址附件     │    │                              │
│ session-store.ts — 统一事件日志   │    │                              │
│ sandbox-runner.ts — 原生沙箱      │    │                              │
│ sdk-server / acp-server / headless │   │                              │
└──────────────────────────────────┘    └──────────────────────────────┘
```

### 2.2 目录结构

```
Auraxis/
├── electron/                    # 主进程代码（Node.js 环境）
│   ├── main.ts                  # 应用入口：窗口创建、CSP、单实例锁
│   ├── preload.ts               # contextBridge 暴露 API 给渲染进程
│   ├── types.ts                 # 共享类型（ApprovalPolicy, IpcResponse, ModelDefinition 等）
│   ├── tool-defs.ts             # 71 个 AI 工具的定义（名称、描述、入参 schema）
│   ├── contracts/               # 跨进程类型单一事实源（core/tools/advanced/session-types）
│   ├── advanced-defs.ts         # MCP/Agent/Permission 高级类型
│   └── ipc/                     # IPC 处理器模块
│       ├── index.ts             # registerIpcHandlers() 总入口
│       ├── ai-handlers.ts       # 聊天流、查询引擎、中断、测试连接
│       ├── query-engine.ts      # 聊天模式的 ReAct 循环（含 3 次 API 重试）
│       ├── step-engine.ts       # 统一 ReAct 步进（聊天与 Agent 共用，策略钩子注入）
│       ├── agent-loop.ts        # Agent 驱动（规划/偏差检测/上下文压缩/停止策略）
│       ├── agent-handlers.ts    # Agent CRUD + 3 个内置 Agent 定义 + 子 Agent 父子关系
│       ├── agent-scheduler.ts   # 多 Agent 并发调度器（优先级队列、并发控制、暂停/恢复）
│       ├── tool-handlers.ts     # 71 个工具的实际执行逻辑 + 权限守卫 + 结构化输出摘要
│       ├── permission-handlers.ts # 权限检查、规则管理、对话框请求
│       ├── mcp-handlers.ts      # MCP 协议客户端（JSON-RPC、工具发现、安全验证）
│       ├── model-config.ts      # 模型解析（内置 + 环境变量 + 持久化）
│       ├── memory-db.ts         # 溯源记忆存储（Evidence/Signal/Belief，SQLite + JSON 后备）
│       ├── memory-extractor.ts  # LLM 驱动的信念提取（硬锚点验证）
│       ├── memory-ipc.ts        # 记忆 CRUD 的 IPC 桥接
│       ├── memory-evidence.ts   # Eywa M1：不可变证据捕获（证据先于信念）
│       ├── memory-read.ts       # Eywa M3：确定性多路检索（零 LLM）
│       ├── memory-graph.ts      # MAP-Graph M5：角色授权 / 路径信任 / 风险门控
│       ├── belief-validation.ts # Eywa M2：信念硬锚点验证
│       ├── signal-rules.ts      # Eywa M2：规则化信号检测
│       ├── context-handlers.ts  # 项目上下文（项目指令文件、文件树、package.json）
│       ├── file-handlers.ts     # 文件操作（打开/读取/写入/搜索）
│       ├── project-handlers.ts  # 项目操作（文件树、目录选择、代码应用/预览）
│       ├── system-handlers.ts   # 系统信息（统计、Git 分支、版本）
│       ├── settings-store.ts    # 加密持久化设置（API Key 使用 safeStorage）
│       ├── coverage-handlers.ts # 测试覆盖率报告读取（coverage/coverage-summary.json）
│       ├── conflict-detector.ts # 多 Agent 文件锁防并发写入冲突
│       ├── undo-manager.ts      # 文件级撤销（快照 + 恢复）
│       ├── plan-handlers.ts     # 计划审批流（发送→前端→等待用户确认→超时）
│       ├── shared.ts            # 路径验证、安全扩展名、排除目录
│       ├── text-filter.ts       # 模型产物剥离（thinking 标签、零宽字符等）
│       ├── code-mode.ts         # Code Mode：TS 程序 + 工具绑定 + 并发子调用（worker）
│       ├── step-compressor.ts   # AGORA 步骤级压缩（免推理，整步保留/丢弃）
│       ├── workspace-drift.ts   # SWE-Touch 共享工作区漂移感知
│       ├── approval-fatigue.ts  # Oversight 审批疲劳守卫（倒 U 型监督）
│       ├── tool-inertia.ts      # AutoTool 工具惯性图（TIG）
│       ├── skill-gate.ts        # VaG 技能入库门禁（pre-commit）
│       ├── auth-store.ts        # 本地账户（注册/登录/头像，scrypt）
│       ├── attachments.ts       # 内容寻址附件存储（ReadImage 底层）
│       ├── fork-runner.ts       # one-shot 分叉子代理（无头子进程）
│       ├── schedule-store.ts    # 会话内跟进任务（after/at/every）
│       ├── session-store.ts     # 聊天/Agent 统一 JSONL 事件日志
│       ├── sandbox-runner.ts    # 原生沙箱调度（restricted/AppContainer/linux/macos）
│       ├── acp-server.ts / sdk-server.ts / headless-run.ts  # ACP / JSON-RPC SDK / 无头执行
 │       └── __tests__/           # 主进程测试（全仓 245 个测试文件 / 1789 用例）
│
├── src/                         # 渲染进程代码（浏览器环境）
│   ├── main.tsx                 # React 入口
│   ├── App.tsx                  # 根组件：布局、主题、权限对话框、命令面板
│   ├── components/              # UI 组件
│   │   ├── chat/                # 聊天相关（消息列表、消息气泡、Markdown 渲染、输入框）
│   │   ├── layout/              # 布局组件（侧边栏、顶部栏、右侧面板、导航）
│   │   ├── settings/            # 设置面板
│   │   ├── permissions/         # 权限对话框
│   │   ├── agent/               # Agent 管理面板 + 执行流程视图 + 图式工作流可视化
│   │   ├── memory/              # 记忆管理面板
│   │   ├── auth/                # 登录门（AuthGate）、头像（Avatar）
│   │   ├── work/                # Work 模式看板 + Agent 执行流程视图
│   │   ├── input/               # 输入 Dock、思考深度滑轨、模式切换器
│   │   ├── skills/              # 技能相关 UI
│   │   ├── tools/               # 工具相关 UI
│   │   ├── inspector/           # 计划 / 检查器面板
│   │   ├── preview/             # 文件树面板、预览浏览器
│   │   └── common/              # 通用组件
│   ├── stores/                  # Zustand 状态管理（18 个 Store）
│   │   ├── useChatStore.ts      # 聊天消息、流、重试、项目上下文、记忆注入
│   │   ├── useAuthStore.ts      # 登录状态、账户信息、头像
│   │   ├── useSettingsStore.ts   # API Key、默认模型、通知
│   │   ├── useAppStore.ts       # 主题、侧边栏、右侧面板、导航历史
│   │   ├── useAgentStore.ts     # Agent CRUD、优先级、并发（持久化，模块层订阅 agent:event 流并做 RAF 节流）
│   │   ├── useSessionStore.ts   # 会话保存/加载/删除/导出/分叉（最多 40 个）
 │   │   ├── useProjectStore.ts   # 项目注册表、当前项目、工作区排序
│   │   ├── usePluginStore.ts    # 已安装插件、启用/禁用
│   │   ├── useMemoryStore.ts    # 活跃/搜索记忆（从主进程加载）
│   │   ├── useFileTreeStore.ts  # 文件树、展开路径
│   │   ├── useUndoStore.ts      # 撤销条目跟踪
│   │   ├── useInspectorStore.ts # 计划、系统消息、活跃工具计数（数据层，无独立 UI）
│   │   ├── useWorktreeStore.ts  # Worktree 沙箱状态（激活/沙箱路径）
│   │   ├── useAdvancedStore.ts  # MCP 服务器、Agent 旧设置
│   │   ├── useTerminalTasksStore.ts # 终端任务列表（后台 bash 运行状态）
│   │   ├── useNotificationStore.ts  # 通知列表/未读计数
│   │   ├── useMessageFeedbackStore.ts # 逐消息评分持久化
│   │   └── useKeybindingsStore.ts # 快捷键覆盖
│   ├── core/                    # 核心逻辑
│   │   ├── plugin-manager.ts    # 插件安装/卸载/启用/禁用
│   │   ├── plugin-loader.ts     # 动态加载 + 安全扫描
│   │   ├── tool-registry.ts     # 插件工具注册表
│   │   ├── command-registry.ts  # 插件命令注册表
│   │   └── __tests__/           # 核心逻辑测试（4 个测试文件：plugin-manager、plugin-loader、tool-registry、command-registry）
│   ├── services/                # AI 服务（浏览器端回退方案）
│   ├── types/                   # 渲染进程类型（re-export electron/contracts）
│   ├── plugins/                 # 内置示例插件
│   ├── styles/                  # 主题配置（深色/浅色）
│   ├── hooks/                   # 自定义 React Hooks
│   └── constants/               # 快捷键、扩展颜色常量
│
├── scripts/                     # 开发脚本
│   └── electron-dev.js          # 清除 ELECTRON_RUN_AS_NODE 后启动 Electron
├── docs/                        # 文档
│   └── README.md                # 项目架构与开发文档
├── package.json
├── tsconfig.json                # 渲染进程 TS 配置（ESNext/bundler, @/* → src/*）
├── tsconfig.node.json           # Vite 配置专用（composite project reference）
├── tsconfig.electron.json       # 主进程 TS 配置（CommonJS → dist-electron/, rootDir: electron/）
├── vite.config.mts              # Vite 构建配置
├── vitest.config.ts             # 测试配置（覆盖率阈值：80% 行 / 70% 分支 / 80% 函数）
├── electron-builder.yml         # 打包配置（NSIS/DMG/AppImage）
└── .env.example                 # 环境变量模板
```

### 2.3 TypeScript 配置要点

项目有三个 `tsconfig` 文件，其中 `tsconfig.electron.json` 设置 `rootDir: "electron/"`，这导致主进程代码**无法 import 来自 `src/` 的类型**。因此需要在两处重复定义中间类型：

- **跨进程契约单一事实源**：`electron/contracts/`（`core.ts` / `tools.ts` / `advanced.ts` / `session-types.ts`）是唯一定义处；`electron/types.ts`、`electron/advanced-defs.ts`、`src/types/*` 全部 re-export，**不再双向镜像维护**。

`tsconfig.electron.json` 仍保持 `rootDir: "electron/"`（CommonJS 输出到 `dist-electron/`），新增共享类型必须放进 `contracts/` 并让两端 re-export，禁止把类型再复制到 `src/`。

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
                                   mainWindow.webContents.send('ai:queryEvent:${id}', ...)
  ← ipcRenderer.on()        ←──        ↓
  → callback.onEvent(data)           (每步工具执行、文本块、错误等)
```

### 3.2 IPC 通道命名规范

**格式**：`domain:action`（kebab-case 命名空间 + 冒号分隔符）

### 3.3 IPC 响应规范

所有处理程序统一返回：

```typescript
interface IpcResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
```

### 3.4 流式通信

流请求使用**独立的事件通道**：

- 聊天流：`ai:chunk:${requestId}`
- 查询流：`ai:queryEvent:${requestId}`
- Agent 事件：`agent:event:${agentId}`

每个通道在请求创建时注册监听器，在收到 `done`/`error` 事件或调用 `abort` 时自动清理。

### 3.5 完整 IPC 通道表

| 域             | 通道                                                                      | 方向    | 说明                                                                   |
| -------------- | ------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| **window**     | `window:minimize`                                                         | 渲染→主 | 最小化窗口                                                             |
|                | `window:maximize`                                                         | 渲染→主 | 最大化/还原窗口                                                        |
|                | `window:close`                                                            | 渲染→主 | 关闭窗口                                                               |
|                | `window:focus`                                                            | 渲染→主 | 聚焦窗口（通知点击）                                                   |
|                | `window:isMaximized`                                                      | 渲染→主 | 查询最大化状态                                                         |
|                | `window:maximize-changed`                                                 | 主→渲染 | 最大化状态变更事件                                                     |
|                | `window:setBackgroundMaterial` / `window:backgroundMaterialSupported`     | 渲染→主 | 侧边栏 Acrylic 磨砂材质切换与支持检测（Windows 11）                    |
| **shell**      | `shell:openExternal`                                                      | 渲染→主 | 在默认浏览器打开 URL（仅 http/https）                                  |
|                | `shell:openInVSCode`                                                      | 渲染→主 | 在 VS Code 中打开项目                                                  |
| **file**       | `file:open`                                                               | 渲染→主 | 打开文件对话框                                                         |
|                | `file:read`                                                               | 渲染→主 | 读取文件内容                                                           |
|                | `file:write`                                                              | 渲染→主 | 写入文件                                                               |
|                | `file:search`                                                             | 渲染→主 | 按关键词搜索文件                                                       |
| **project**    | `project:getTree`                                                         | 渲染→主 | 获取项目文件树                                                         |
|                | `project:applyCode`                                                       | 渲染→主 | 应用代码到文件                                                         |
|                | `project:previewCode`                                                     | 渲染→主 | 预览代码（HTML/图片等）                                                |
|                | `project:selectDirectory`                                                 | 渲染→主 | 选择项目目录                                                           |
| **context**    | `context:getProjectContext`                                               | 渲染→主 | 获取项目上下文（指令文件、文件树、package.json）                       |
|                | `context:getFileStructure`                                                | 渲染→主 | 获取文件结构概览                                                       |
|                | `context:readFile`                                                        | 渲染→主 | 读取文件（上下文用）                                                   |
| **ai**         | `ai:chatStream`                                                           | 渲染→主 | 发起聊天流（纯对话，无工具）                                           |
|                | `ai:sendQuery`                                                            | 渲染→主 | 发起查询（完整的 ReAct 循环）                                          |
|                | `ai:testConnection`                                                       | 渲染→主 | 测试 API 连接                                                          |
|                | `ai:abortStream` / `ai:abortQuery`                                        | 渲染→主 | 中止流/查询                                                            |
|                | `ai:abortTool`                                                            | 渲染→主 | 中止单个工具执行                                                       |
|                | `ai:retryTool`                                                            | 渲染→主 | 重试工具执行                                                           |
|                | `ai:chunk:${requestId}`                                                   | 主→渲染 | 聊天流的文本块事件                                                     |
|                | `ai:queryEvent:${requestId}`                                              | 主→渲染 | 查询流的所有事件（工具开始/结束/文本等）                               |
| **memory**     | `memory:extract`                                                          | 渲染→主 | 从对话提取记忆                                                         |
|                | `memory:getByProject`                                                     | 渲染→主 | 按项目获取记忆                                                         |
|                | `memory:getByType`                                                        | 渲染→主 | 按类型获取记忆                                                         |
|                | `memory:search`                                                           | 渲染→主 | 搜索记忆                                                               |
|                | `memory:archive` / `memory:delete`                                        | 渲染→主 | 归档/删除记忆                                                          |
|                | `memory:evidenceList` / `memory:evidenceDetail`                           | 渲染→主 | 列出/查看不可变证据（Eywa M1）                                         |
|                | `memory:readForQuery`                                                     | 渲染→主 | 确定性多路检索，返回 context + policy + facts + diagnostics（Eywa M3） |
|                | `memory:beliefAudit`                                                      | 渲染→主 | 信念的证据链、信号与修订历史（Eywa M4）                                |
|                | `memory:readTrace`                                                        | 渲染→主 | 按 read_run 返回逐路检索结果                                           |
|                | `memory:erase`                                                            | 渲染→主 | 按 scope 级联擦除证据/信念/读轨迹并留下审计事件                        |
|                | `memory:reindex`                                                          | 渲染→主 | 从已有证据重建 signals/beliefs                                         |
|                | `memory:graph`                                                            | 渲染→主 | MAP-Graph 类型化执行图（角色授权/血缘）                                |
| **agent**      | `agent:create` / `agent:start`                                            | 渲染→主 | 创建/启动 Agent                                                        |
|                | `agent:stop` / `agent:schedulerStop`                                      | 渲染→主 | 停止 Agent                                                             |
|                | `agent:pause` / `agent:resume`                                            | 渲染→主 | 暂停/恢复 Agent                                                        |
|                | `agent:setPriority`                                                       | 渲染→主 | 设置优先级                                                             |
|                | `agent:getQueue`                                                          | 渲染→主 | 获取待执行队列                                                         |
|                | `agent:setMaxConcurrent`                                                  | 渲染→主 | 设置最大并发数                                                         |
|                | `agent:getAll` / `agent:list` / `agent:get`                               | 渲染→主 | 查询 Agent 列表/详情                                                   |
|                | `agent:remove` / `agent:clear`                                            | 渲染→主 | 移除/清空 Agent                                                        |
|                | `agent:updated`                                                           | 主→渲染 | Agent 状态更新事件                                                     |
|                | `agent:event:${agentId}`                                                  | 主→渲染 | Agent 执行事件（工具调用等）                                           |
| **mcp**        | `mcp:getServers` / `mcp:setServers`                                       | 渲染→主 | MCP 服务器配置                                                         |
|                | `mcp:connect` / `mcp:disconnect`                                          | 渲染→主 | 连接/断开 MCP 服务器                                                   |
|                | `mcp:getStatuses`                                                         | 渲染→主 | 获取所有服务器状态                                                     |
|                | `mcp:listTools` / `mcp:callTool`                                          | 渲染→主 | 列出/调用 MCP 工具                                                     |
| **permission** | `permission:respond`                                                      | 渲染→主 | 用户对权限请求的回复                                                   |
|                | `permission:addRule`                                                      | 渲染→主 | 添加权限规则                                                           |
|                | `permission:getRules`                                                     | 渲染→主 | 获取所有规则                                                           |
|                | `permission:request`                                                      | 主→渲染 | 权限请求事件                                                           |
| **plan**       | `plan:approve` / `plan:reject`                                            | 渲染→主 | 批准/拒绝计划                                                          |
|                | `plan:generated`                                                          | 主→渲染 | 计划生成事件                                                           |
| **undo**       | `undo:getHistory` / `undo:getList`                                        | 渲染→主 | 获取撤销历史                                                           |
|                | `undo:execute` / `undo:revert` / `undo:revertLast`                        | 渲染→主 | 执行撤销/恢复                                                          |
|                | `undo:getSessionDiffs` / `undo:revertSessionFile` / `undo:revertSessions` | 渲染→主 | 按会话查看/回滚文件变更（右舱「变更」视图）                            |
| **conflict**   | `conflict:getConflicts`                                                   | 渲染→主 | 获取冲突列表                                                           |
|                | `conflict:getFileHistory`                                                 | 渲染→主 | 获取文件修改历史                                                       |
| **snapshot**   | `snapshot:create` / `list` / `restore` / `delete`                         | 渲染→主 | 命名快照管理                                                           |
| **system**     | `system:getStats`                                                         | 渲染→主 | 获取系统统计                                                           |
|                | `system:getGitBranches`                                                   | 渲染→主 | 获取 Git 分支列表                                                      |
|                | `system:getVersion`                                                       | 渲染→主 | 获取应用版本                                                           |
|                | `system:getAccountInfo`                                                   | 渲染→主 | 查询 DeepSeek 账户余额（/user/balance）                                |
| **settings**   | `settings:get` / `settings:set`                                           | 渲染→主 | 读写设置                                                               |
|                | `settings:getApiKey` / `api:setKey`                                       | 渲染→主 | API Key 管理                                                           |
|                | `settings:set`（permissionPreset / sandboxMode）                          | 渲染→主 | 统一运行权限持久化                                                     |
| **coverage**   | `coverage:get`                                                            | 渲染→主 | 读取测试覆盖率报告（coverage/coverage-summary.json）                   |
| **auth**       | `auth:status` / `auth:setup`                                              | 渲染→主 | 查询登录阶段 / 首次注册账户                                            |
|                | `auth:login` / `auth:logout`                                              | 渲染→主 | 登录 / 登出                                                            |
|                | `auth:changePassword`                                                     | 渲染→主 | 修改账户密码                                                           |
|                | `auth:setAvatar`                                                          | 渲染→主 | 设置头像（PNG data URL）                                               |
| **model**      | `model:getAll`                                                            | 渲染→主 | 获取所有可用模型                                                       |
| **app**        | `app:error`                                                               | 主→渲染 | 未捕获异常/未处理 Promise 拒绝                                         |
| **cron**       | `cron:create` / `cron:delete` / `cron:list`                               | 渲染→主 | 定时任务的创建/删除/列出                                               |
| **worktree**   | `worktree:getStatus`                                                      | 渲染→主 | 查询 Agent worktree 沙箱状态                                           |
|                | `worktree:changed`                                                        | 主→渲染 | worktree 激活/失活事件                                                 |

---

## 四、AI 核心系统

### 4.1 两条执行路径

Auraxis 有**两条驱动、一套循环**：聊天与 Agent 的每次 LLM 步进都委托给统一的 `step-engine.ts`（重试、工具批处理、停止策略、压缩全部收敛于此），两条驱动只保留各自的编排职责（聊天直接执行；Agent 增加规划/审批/偏差检测/暂停恢复）。

#### 路径 A：聊天查询（query-engine.ts）

用于主聊天 UI。流程：

```
用户输入 → buildSystemPrompt() → prepareMessages()
    ↓
ReAct 循环（最多 500 次迭代，业务上限 200 + 安全硬上限 500）：
    1. LLM 调用（llmClientInvoke，3 次重试，指数退避 2s/4s/8s/16s max）
    2. 如果无工具调用 → 检查 <FINAL_ANSWER> → 停止
    3. 如果有工具调用 → executeToolCall() → 结构化 summary → 追加结果 → 返回步骤 1
    4. 上下文压缩（token > 100K 时触发）
    5. 停止策略评估（stopPolicyEvaluate）
    6. 迭代摘要 emit（toolsThisIteration, llmLatencyMs）
    ↓
返回结果给聊天 UI
```

**特点**：

- **无规划阶段**：直接执行 ReAct 循环
- **API 重试**：429/5xx/网络错误自动重试 3 次指数退避
- **上下文压缩**：基于规则的压缩，token 阈值约 100K
- **停止信号**：`<FINAL_ANSWER>` + `stop_reason` 检查；ReviewArtifact 是可选验证工具，不设强制质量门
- **业务迭代上限**：200 次（可配置），安全硬上限：500 次
- **结构化摘要**：9 种工具输出携带 `summary` 供前端类型化卡片渲染
- **暴露方式**：`ai:sendQuery` IPC

#### 路径 B：子 Agent（agent-loop.ts → agent-handlers.ts）

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
    3. 偏差检测（DevianceDetector）：
       - L1: 工具执行失败 → 标记 blocked
       - L2: 连续停滞 → 建议重规划
       - L3: 触发 Replan 工具 → LLM 生成新子计划
    4. 上下文管理（ContextManager）：基于回合/Token 的压缩
    5. 停止策略评估
    ↓
返回结果
```

**特点**：

- **完整规划能力**：LLM 生成结构化 JSON 任务计划（含依赖关系 + 关键词匹配）
- **计划审批**：`plan` 模式生成计划后等待用户审批（5 分钟超时），仅执行已批准步骤
- **质量验证（可选）**：ReviewArtifact 可按需运行 build/test/typecheck/lint
- **偏差检测**：三级检测（工具失败 L1、停滞 L2、重规划 L3）
- **上下文管理**：支持 LLM 摘要和基于规则的回退
- **新项目检测**：自动检测空目录/无 package.json，注入初始化指引
- **暂停/恢复**：完整状态捕获（messages/plan/iteration/toolCallCount），满容量自动重入队列
- **最大递归深度**：3（Agent 工具可嵌套调用子 Agent，记录父子关系）
- **暴露方式**：`agent:create` IPC 和 `runSubAgent()` 函数

#### 路径 C：Code Mode（code-mode.ts）

`RunCode` 工具在 `language=typescript` 时把程序体放进 worker thread 执行，`await tools.Name(args)` 的每个子调用都回穿 `executeToolCall` 全权限管线；并发安全工具最多 8 路重叠、变异工具串行，硬超时与中止可终止 worker。只有 print/return 的内容返回给模型。子代理分叉后端（`Agent` 的 `backend=fork`）另见 `fork-runner.ts`（无头子进程 one-shot）。

### 4.2 系统提示词构建

`query-engine.ts` 中的 `buildSystemPrompt()` 函数构建中文系统提示词，包含：

- 工具使用能力声明
- **任务完成信号**：`<FINAL_ANSWER>` 标记（必须大写，必须在最后一行）
- **两阶段工作流**：阶段 1 探索（Glob/Grep/Read）→ 阶段 2 执行（Write/Edit/Bash）
- 平台感知的 Shell 提示（Windows → Git Bash，macOS/Linux → 标准 Unix）
- 深度思考模式（`isDeepThink`）时追加思考指令

### 4.3 工具系统

工具定义在 `electron/tool-defs.ts`（[查看文件](../electron/tool-defs.ts)），共 **71 个内置工具**。下表列出核心 24 个，其余按能力族补充在表后：

| #   | 工具               | 类别 | 说明                                                                                            |
| --- | ------------------ | ---- | ----------------------------------------------------------------------------------------------- |
| 1   | **Bash**           | 危险 | 在项目目录执行 Shell 命令。默认超时 120s，最大 600s。Windows 支持 Git Bash/cmd/PowerShell       |
| 2   | **Read**           | 安全 | 读取文件内容，支持行偏移/限制，路径穿越检查。输出含 `summary`（文件路径、行数、大小）           |
| 3   | **Write**          | 危险 | 创建/覆盖文件，扩展名白名单，Windows 保留名称检查，撤销前备份。输出含 `summary`（路径、字节数） |
| 4   | **Edit**           | 危险 | 文件内查找替换，需唯一匹配，撤销前备份                                                          |
| 5   | **Delete**         | 危险 | 删除文件或目录（递归需确认），路径穿越检查，撤销前备份                                          |
| 6   | **Grep**           | 安全 | 正则搜索（最大深度 5 层，最多 50 结果）。输出含 `summary`（匹配数）                             |
| 7   | **Glob**           | 安全 | 文件模式匹配（最大深度 6 层，最多 100 文件）。输出含 `summary`（匹配数）                        |
| 8   | **WebFetch**       | 危险 | URL 内容获取（15s 超时），拦截本地/内网地址                                                     |
| 9   | **WebSearch**      | 危险 | 通过 DuckDuckGo HTML 搜索（无需 API Key）                                                       |
| 10  | **TodoWrite**      | 安全 | 任务清单管理（pending/in_progress/completed），同一时间仅一个 in_progress                       |
| 11  | **Agent**          | 危险 | 启动子 Agent（Explore/Plan/general-purpose），递归深度限制 3，记录父子关系                      |
| 12  | **Replan**         | 安全 | 生成新子计划（仅 Agent 循环可用，查询引擎会跳过）                                               |
| 13  | **CronCreate**     | 危险 | 创建周期/一次性定时任务（5 字段 cron），应用运行时触发                                          |
| 14  | **CronDelete**     | 安全 | 按 ID 取消定时任务                                                                              |
| 15  | **CronList**       | 安全 | 列出所有活跃定时任务                                                                            |
| 16  | **TaskOutput**     | 安全 | 读取后台任务/子 Agent 的累积输出（不阻塞）                                                      |
| 17  | **TaskStop**       | 危险 | 按 ID 停止运行中的工具/子 Agent                                                                 |
| 18  | **EnterPlanMode**  | 安全 | 进入计划模式，生成实现计划交用户审批                                                            |
| 19  | **ExitPlanMode**   | 安全 | 用户批准后退出计划模式，开始实现                                                                |
| 20  | **NotebookEdit**   | 危险 | 读/写/插入/删除 Jupyter Notebook（.ipynb）单元格                                                |
| 21  | **EnterWorktree**  | 危险 | 创建隔离的 Git worktree 沙箱，后续工具调用自动重定向到沙箱路径                                  |
| 22  | **LSP**            | 安全 | 代码智能：definition / references / diagnostics（tsc --noEmit）                                 |
| 23  | **ReviewArtifact** | 危险 | 可选验证工具：运行 build/test/typecheck/lint                                                    |
| 24  | **GitCommit**      | 危险 | 暂存所有变更并创建 Git 提交，返回 commit hash                                                   |

> 上表「类别」为按行为的直观归类；某工具是否实际触发权限对话框，以 `tool-handlers.ts` 中的危险工具集合为准。

**其余 47 个工具（按能力族）**：

- **编排/自省**：RunWorkflow、Ralph、ListAgents / SendMessage / InterruptAgent / Report、GetGoal / CreateGoal / UpdateGoal、InspectRuntime、MountPlugin / UnmountPlugin
- **文件**：StrReplaceEditor（view/create/str_replace/insert）、ReadImage、NotebookEdit 相关
- **终端**：TerminalOpen / TerminalList / TerminalRead / TerminalSend / TerminalSignal / TerminalClose、Pty、Pwsh
- **后台/调度**：JobList / JobOutput / JobKill、ScheduleCreate / ScheduleDelete / ScheduleList
- **会话检索**：SessionQuery、SessionEventSearch / SessionEventRead / SessionTrace（含事件级 lineage）、ReadSpill
- **能力加载**：ListSkills / ReadSkill / WriteSkill、LSP、ReviewArtifact、GitCommit、EnterWorktree
- **专业文档**：ReadDocument（.docx/.xlsx/.pptx/.pdf 文本与结构化读取）、WriteDocument（Word/Excel/PPT/PDF 生成，PDF 自动嵌入中文字体）
- **云连接器**：SlackListChannels / SlackPostMessage、DriveList / DriveRead、NotionSearch / NotionCreatePage
- **飞书/Lark**：官方 OpenAPI MCP（`mcp__lark-mcp__*`），覆盖消息、群组、文档、多维表格、日历等能力

**工具分类**：

- **危险工具集合**：`['Bash', 'Write', 'Edit', 'Delete', 'WebFetch', 'WebSearch', 'CronCreate', 'TaskStop', 'EnterWorktree', 'ReviewArtifact', 'GitCommit', 'WriteDocument', 'SlackPostMessage', 'NotionCreatePage']` — 触发权限对话框
- **文件修改工具**：`['Write', 'Edit', 'NotebookEdit', 'Delete', 'WriteDocument']` — 触发撤销备份和冲突检测文件锁
- **只读工具**：`['Read', 'Grep', 'Glob', 'ReadDocument', 'SlackListChannels', 'DriveList', 'DriveRead', 'NotionSearch']` — 在 `ask` 和 `plan` 模式下自动批准

`Replan` 工具在聊天查询路径中不可用（查询引擎会跳过），仅在 Agent 循环中可用。

### 4.4 权限系统

审批策略（`electron/types.ts` → `src/types/`）：

| 策略             | 行为                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `ask`（默认）    | 每次危险工具调用弹出权限对话框。只读工具（Read/Grep/Glob）自动批准                         |
| `plan`           | 计划审批步骤中明确批准的工具自动执行。不在计划内的工具按 `ask` 模式处理                    |
| `auto`（全自动） | 无需确认批准所有工具。安全检查仍执行（路径检查、扩展名白名单、被拦截 URL），但不显示对话框 |

Composer 的「运行权限」四档预设（每次确认 / 自动代批 / 完全访问 / 只读）映射到上述策略 + 沙箱模式 + autoApprove，见 `electron/contracts/permission.ts`。

权限规则存储在 `permission-handlers.ts` 中，作用域分为：

- `once` — 仅本次有效
- `session` — 当前会话有效
- `always` — 永久有效

> **审批疲劳守卫（Oversight）**：权限链路接入 `approval-fatigue.ts` 策略层，自动放行计入疲劳统计（不占人工注意力）；高负载 + 近期低拒绝率时，建议低/中风险操作自动放行，避免“审批洪水”拖垮人工审查（详见第五章 5.6）。

### 4.5 上下文压缩

`ContextManager`（`agent-loop.ts` / `context-manager.ts`）与 `step-compressor.ts` 提供两档压缩策略：

- **snip（聊天 / 手动压缩默认）**：原子组截断 + LLM 摘要，失败回退规则摘要；按 token（默认 ~100K）或回合数触发，默认压缩最旧 50% 轮次
- **step（AGORA，Agent 循环默认）**：免推理步骤级压缩——整步保留 / 整步丢弃，永不拆分工具调用与其结果（详见第五章 5.4）；压缩前先做 `pruneToolResults` 大结果剪枝，再按 always-keep floor 保留最近 6 步与计划关键步骤

### 4.6 停止策略

`stopPolicyEvaluate()` 函数评估是否应停止执行：

- **质量验证（可选）**：ReviewArtifact 供模型在需要时运行验证命令
- **主要检查**：`<FINAL_ANSWER>` 标记检测（解析 LLM 输出中的结束信号）
- **max_tokens 保护**：当 API 返回 `stop_reason: 'max_tokens'` 时强制继续
- **计划完成确认**：所有计划任务 `completed` 才允许停止
- **连续纯文本检测**：连续 5 轮无工具调用强制停止
- **空响应检测**：连续 2 次空响应停止

### 4.7 上下文缓存对齐（规范快照重放）

Work/Code 统一引擎（`query-engine.ts` → `step-engine.ts`）为 DeepSeek 前缀缓存做了客户端侧对齐（详见第五章 5.9）：

- 每轮自然结束后把完整规范消息快照写入会话 chat-log（`llm_context_v1` system 事件）；下一轮优先重放快照，仅追加新记忆与新用户消息
- 快照头部校验：system prompt / 会话 preamble / work guide 必须与当前版本一致，否则回退 fresh 组装（防升级、换项目、切思考档后使用旧指令）
- 记忆作为 `memoryContext` 独立字段走 IPC，后端插入请求尾部；重放时与快照最后一条记忆做字节级去重
- 渲染层编辑 / 删除 / 重新生成 / 撤销时通过 `ai:clearQueryContext` 作废快照
- 快照读写为 best-effort：失败只告警并降级为 fresh，不中断已成功的回复

涉及文件：`electron/ipc/query-context.ts`、`electron/ipc/query-engine.ts`、`electron/ipc/ai-handlers.ts`、`electron/preload.ts`、`src/stores/useChatStore.ts`。

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

- **M1 证据地基**：`memory-evidence.ts` 把用户消息、工具观测、纠错、审批事件捕获为不可变 Evidence（sha256 内容哈希去重，SQLite / JSON 双后端）；`chat-log.ts` / `session-log.ts` 写入后实时挂接 best-effort 捕获
- **M2 信号与信念**：`signal-rules.ts` 规则化检测日期 / 实体 / URL / 版本 / 决策 / 纠错 / 批准 / 拒绝信号；`belief-validation.ts` 硬锚点验证（evidence 必须存在、关键实体与数值归一化匹配、纠错需双证据）；状态机 `draft → promoted → active → superseded / rejected / deleted`
- **M3 确定性读路径**：`memory-read.ts` 四路检索 R1 FTS5 / R2 实体时间 / R3 观测流 / R4 本地向量（`AURAXIS_MEMORY_EMBEDDINGS=1` 可选），**零 LLM、零随机**；`memory:readForQuery` 返回 context + policy + facts + diagnostics，聊天注入已替换
- **M4 审计与归因**：`memory:beliefAudit` / `readTrace` / `erase`（擦除留审计事件）；MemoryPanel 展示证据链、支持强度、修订历史与读路径诊断；五层失败归因测试（缺证据 / 抽取失真 / 状态过期 / 检索丢失 / 模型行为）

### 5.3 MAP-Graph — 多 Agent 共享记忆授权（M5）

**核心洞察**：共享记忆只有向量检索会丢失权限、来源与信任信息，可能导致「无权证据驱动高风险动作」。

- `memory-graph.ts` 类型化执行图：agents / sources / memories / claims / actions 节点 + 血缘边
- 授权过滤：按 Agent 角色（Explore / Plan / general-purpose）与动作类型决定证据可读性；硬授权与分级信任分离
- 路径信任：来源可信度 × 派生路径的乘法信任评分，重排可读记忆
- 风险门控：高危险动作（Write/Edit/Bash 等）要求更高证据标准与来源信任，接入 `permission-profile.ts` / `tool-runner.ts` 管线；运行时由 scheduler / sub-agent 自动绑定 agentName（`AURAXIS_MEMORY_RISK_GATE=1` 启用）

### 5.4 AGORA — 步骤级上下文压缩

**核心洞察**：token 级抽取式压缩会破坏 agent 的 action grammar（工具名 / 标识符 / 括号被抽掉后环境直接拒绝），压缩只能按完整步骤进行。

- `step-compressor.ts` 免推理实现：结构解析 + always-keep floor（系统 / 前导 / 最近 K=6 步 / 计划相关关键步骤）+ 确定性启发式评分，不调用 LLM
- 永不拆分工具调用与其结果；`context-manager.ts` 压缩前先 `pruneToolResults` 剪枝大结果
- Agent 循环默认 `compressMode='step'`（`agent-loop.ts` / `step-engine.ts`）；聊天与手动压缩保持 `snip` 摘要管线

### 5.5 SWE-Touch — 共享工作区漂移感知

**核心洞察**：用户或其它进程在任务执行期间修改同一工作区时，agent 必须感知「外部漂移」并重新检查被改区域。

- `workspace-drift.ts` 在 Read/Write/Edit 成功后登记基线（stat + sha256，>2MB 仅 mtime/size），不监听文件系统事件
- 每个 agent 迭代开始前 `takeDrift(projectRoot)` 检测，发现漂移即注入上下文消息（`context_injected / workspace` 事件），要求模型定向验证
- 由 agent-loop 内部消费，含 workspace-drift 单元测试与 agent-loop 联动测试

### 5.6 Oversight Has a Capacity — 审批疲劳守卫

**核心洞察**：人工审查者不是完美 oracle，过度升级反而降低系统安全（疲劳 + 「审批洪水」攻击）；是否升级人工应作为资源分配问题。

- `approval-fatigue.ts` 记录每个 scope 的审批决策（approved / rejected / auto），20 次决策滑动窗口 + 疲劳分数
- 输出建议 `escalate / auto / balanced`；`permission-handlers.ts` 自动放行计入统计（不占人工注意力）
- 守卫不自行改变权限模式，由调用方按建议执行；供权限链路内部消费

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
- **稳定块组织（Prompt Cache）**：静态 system prompt + 工具定义 + AGENTS.md + 模式提示作为稳定块，仅在内容真实变化时原位替换；`storedHeadIsCurrent` 校验 system / preamble / work guide 与应用版本一致，升级、换项目、切思考档时自动回退 fresh 组装
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
| 会话事件时间轴               | 右侧时间轴展示会话事件与工具调用，支持追溯 / 重放                                                                                   | ToolCallTimeline / session-log                      |
| 实时 diff 与变更回滚         | 右舱「变更」视图按会话查看文件变更并回滚                                                                                            | undo-manager / undo:getSessionDiffs                 |
| 测试覆盖率面板               | 设置面板实时读取 coverage-summary.json 展示行 / 分支 / 函数覆盖率                                                                   | coverage-handlers / settings                        |

---

## 六、多 Agent 调度系统

### 6.1 三层架构

```
Agent 管理 (agent-handlers.ts)
    ↓ 创建/配置
Agent 调度器 (agent-scheduler.ts) — 单例 AgentScheduler
    ↓ 调度执行
Agent 循环 (agent-loop.ts) — agentLoopRun()
    ↓ 执行中
工具执行 (tool-handlers.ts) / 子 Agent (递归)
```

### 6.2 Agent 类型

定义在 `agent-handlers.ts`（[查看文件](../electron/ipc/agent-handlers.ts)），三种内置类型：

| 类型                | 能力                                        | 禁用工具                                       |
| ------------------- | ------------------------------------------- | ---------------------------------------------- |
| **Explore**         | 只读探索：搜索文件、阅读代码、Web 获取/搜索 | Write, Edit, Agent                             |
| **Plan**            | 只读架构师：设计实现方案，输出结构化计划    | Write, Edit, Bash, Agent（工具白名单强制限制） |
| **general-purpose** | 全能力：编码、调试、重构                    | 无限制（全部 71 个工具可用）                   |

### 6.3 AgentScheduler 调度器

单例 `AgentScheduler`（`agent-scheduler.ts`）管理多 Agent 的并行执行：

- **优先级队列**：high（权重 3）> normal（2）> low（1）
- **默认最大并发数**：3（可通过 `agent:setMaxConcurrent` IPC 调节）
- **Agent 状态机**：`idle → queued → running → completed/error/stopped/paused`
- **实时通知**：每次状态变更通过 `agent:updated` 频道广播给前端
- **200 次迭代上限**：每个 Agent 最多 200 次迭代（可通过 `maxIterations` 配置，硬安全闸 200）

### 6.4 工作区隔离

工作区隔离在 `tool-handlers.ts`（`worktreeSessions`）中实现：

- **仅 Git 仓库**：`EnterWorktree` 用 `git worktree` 在 `.auraxis-sandbox/task-<id>` 创建隔离分支（非 Git 目录会直接拒绝）
- **路径重定向**：进入 worktree 后，后续文件/命令工具自动重定向到沙箱路径
- **沙箱垃圾回收**：启动时清理无主沙箱目录（crash/taskkill 跳过 `before-quit` 后的孤儿）
- **原生沙箱**：命令级隔离另由 `sandbox-runner.ts` 提供（Windows restricted token / AppContainer、Linux、macOS 四后端）

### 6.5 冲突检测

`conflict-detector.ts` 防止多 Agent 并发写入同一文件：

- 在 Write/Edit 操作前获取文件锁
- 跟踪文件修改历史（哪个 Agent、何时修改）
- 通过 `conflict:getConflicts` 暴露冲突信息给前端

---

## 七、MCP 协议支持

`mcp-handlers.ts` 实现了 MCP（Model Context Protocol）客户端：

- **通信协议**：JSON-RPC over stdio
- **安全命令验证**：连接前验证服务器命令
- **工具发现**：`mcp:listTools` 列出远程 MCP 服务器的工具
- **工具调用**：`mcp:callTool` 调用远程工具（`mcp__serverId__toolName`）
- **状态管理**：`mcp:connect` / `mcp:disconnect` / `mcp:getStatuses`
- **DeepSeek Harness 预设**：设置 → MCP 可一键添加 `deepseek-harness`，首次连接会用 `npx` 启动本地 Harness Web；Windows 下自动使用 `cross-spawn` 兼容 `npx.cmd`。

---

## 八、插件系统

### 8.1 扩展点

插件（`src/core/plugin-manager.ts`）提供以下扩展点：

| 扩展点       | 说明                                                            |
| ------------ | --------------------------------------------------------------- |
| **commands** | 斜杠命令（`/example`），可操作聊天输入                          |
| **tools**    | AI 工具（合并到工具注册表，LLM 可调用）                         |
| **hooks**    | 生命周期钩子：`onToolExecute`, `onAgentStart`, `onAgentEnd`     |
| **ui**       | UI 扩展：`settingsPanel`（设置面板）, `statusBarItem`（状态栏） |

### 8.2 安全模型

插件运行在渲染进程中，安装流程包含多层安全检查：

1. **源代码扫描**（`plugin-loader.ts`）：检测 8 种危险模式
   - `eval()`、`new Function()` — 任意代码执行
   - `require('child_process')` — 系统进程
   - `require('fs')` — 文件系统访问
   - `fetch()` 到非本地地址 — 网络请求
   - `require('net')`、`require('os')`、`require('path')`
2. **结构验证**：检查必填字段（id, name, version, description），工具 schema 验证
3. **路径白名单**：只允许从 `plugins/` 或 `userData/plugins/` 加载
4. **用户确认**：安装时展示能力清单和风险，用户确认后安装
5. **API Key 隔离**：插件无法访问 `safeStorage` 中加密的 API 密钥
6. **权限遵循**：插件工具执行与内置工具遵循相同的权限弹窗检查

### 8.3 内置示例插件

- `src/plugins/example-timestamp.ts` — `/timestamp` 命令，插入 ISO 时间戳
- `src/plugins/example-uuid.ts` — `/uuid` 命令 + `onToolExecute` 钩子

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
| useSessionStore     | `auraxis-session-storage`  | 会话列表（最多 40 个）                              |
| useProjectStore     | `auraxis-projects`         | 项目注册表、当前项目、工作区/会话排序               |
| usePluginStore      | `auraxis-plugin-storage`   | 已安装插件、启用状态                                |
| useAdvancedStore    | `auraxis-advanced-storage` | MCP 服务器、Agent 旧设置                            |
| useKeybindingsStore | `auraxis_keybindings`      | 快捷键覆盖                                          |

> **注意**：localStorage key 使用 `auraxis-` 统一前缀，`auraxis_keybindings` 例外。

### 9.2 长期记忆（Memory）

长期记忆已升级为 **证据先于信念（evidence before belief）的溯源记忆**（Eywa + MAP-Graph，完整方案见第五章 5.2/5.3）：

- **三层数据模型**：Evidence（不可变源证据，SQLite/JSON 双后端）→ Signal（规则优先的类型化信号）→ Belief（LLM 派生 + 硬锚点验证，支持 / 不支持 / 引用不存在三态）
- **实时证据钩子**：`chat-log.ts` / `session-log.ts` 写入后 best-effort 捕获用户消息与工具终态证据
- **确定性读路径**：R1 FTS5 / R2 实体时间 / R3 观测流 / R4 本地向量（可选），零 LLM；`memory:readForQuery` 返回 context + policy + facts + diagnostics，聊天注入已切换
- **审计与归因**：beliefAudit / readTrace / erase（擦除留审计事件）；MemoryPanel 展示证据链、支持强度、修订历史与读路径诊断；五层失败归因测试
- **多 Agent 授权（M5）**：`AURAXIS_MEMORY_RISK_GATE=1` 启用 memory-graph 类型化执行图，按 Agent 角色授权、路径信任、高风险动作门控
- **兼容**：旧 `memory:getByProject` / `getByType` / `search` 等通道映射到新模型；legacy 记忆标记 `legacy=1`，不静默视为已验证

### 9.3 会话管理

`useSessionStore.ts` 管理对话会话：

- **自动保存**：流式完成后通过 `saveSession()` 自动保存
- **容量限制**：最多保存 40 个会话
- **操作**：保存、加载、删除、导出、分叉（fork）

### 9.4 加密设置存储

`settings-store.ts` 使用 Electron `safeStorage` API 加密存储 API Key：

- 设置文件：用户数据目录下的 JSON 文件
- API Key：使用 `safeStorage.encryptString()` → Base64 编码
- 读取时自动解密：`safeStorage.decryptString()`
- API Key 不会在 `settings:get` 返回中暴露
- 旧版明文 Key 首次启动读取时自动迁移为加密存储（一次性、写回后删除明文）
- 加密不可用时保留原值；解密失败时丢弃该 Key 而不是暴露损坏数据

### 9.5 日志保留与缓存清理

桌面端启动时执行 best-effort 维护（`log-retention.ts` + 各 store 的 `prune()`）：

- **日志保留**：聊天/Agent JSONL 日志默认保留 180 天或 256MB，可通过 `AURAXIS_LOG_RETENTION_DAYS` / `AURAXIS_LOG_MAX_FILE_MB` 覆盖
- **投影缓存清理**：删除没有对应 JSONL 日志的 `session-cache` 孤儿行（SQLite 后端）
- **FTS 重建**：启动时全量重建索引，之后每次追加日志按会话 600ms 防抖增量刷新
- **规范上下文快照**：Work/Code 每轮以 `llm_context_v1` system 事件写入 chat-log（用于缓存对齐重放），编辑/删除/重生成/撤销时追加 `llm_context_clear` 墓碑；两者随日志保留策略一并清理

SQLite 投影缓存与 FTS 索引均带 `PRAGMA user_version = 1`，后续结构变更可走版本迁移。

### 9.6 文件撤销

`undo-manager.ts` 实现文件级撤销：

- **触发**：Write/Edit 工具执行前自动备份
- **快照存储**：`.auraxis-snapshots/` 目录
- **操作**：撤销（undo）、恢复（revert）、获取历史

---

## 十、模型配置

### 10.1 模型解析链路

`model-config.ts` 中的 `getAllModels()` 函数按以下优先顺序解析：

```
1. 内置模型 (deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash-vision-exp)
   ↓
2. AURAXIS_MODELS 环境变量（JSON 数组）
   ↓
3. 持久化自定义模型（用户通过 UI 添加的）
```

### 10.2 环境变量

参见 `.env.example`（[查看文件](../.env.example)）：

| 变量                                                     | 说明                                        | 默认值                                           |
| -------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| `DEEPSEEK_API_KEY`                                       | DeepSeek API 密钥                           | 无（必填）                                       |
| `DEEPSEEK_BASE_URL`                                      | OpenAI 格式端点                             | `https://api.deepseek.com/beta/chat/completions` |
| `DEEPSEEK_ANTHROPIC_BASE_URL`                            | Anthropic 格式端点                          | `https://api.deepseek.com/anthropic/v1/messages` |
| `ANTHROPIC_API_KEY`                                      | Anthropic API 密钥                          | 无                                               |
| `ANTHROPIC_BASE_URL`                                     | Anthropic 端点                              | `https://api.anthropic.com/v1/messages`          |
| `OPENAI_API_KEY`                                         | OpenAI API 密钥                             | 无                                               |
| `OPENAI_BASE_URL`                                        | OpenAI 端点                                 | `https://api.openai.com/v1/chat/completions`     |
| `AURAXIS_MODELS`                                         | 自定义模型（JSON 数组）                     | 无                                               |
| `AURAXIS_MEMORY_RISK_GATE`                               | 启用 MAP-Graph 记忆风险门控（M5）           | `1` 时启用，默认关闭                             |
| `AURAXIS_MEMORY_EMBEDDINGS`                              | 启用 R4 本地确定性向量路由                  | 默认关闭                                         |
| `AURAXIS_MEMORY_LLM_SIGNALS`                             | 在规则信号之外追加 LLM 信号检测             | 默认关闭                                         |
| `AURAXIS_AUTH_DISABLED`                                  | 测试/CI 环境跳过登录门（正常桌面使用勿设）  | 默认关闭                                         |
| `AURAXIS_USER_DATA_DIR`                                  | 覆盖 userData 目录（账户/设置隔离，测试用） | 默认无                                           |
| `AURAXIS_TELEMETRY_MODE`                                 | 遥测开关（opt-in）                          | 默认关闭                                         |
| `AURAXIS_LOG_RETENTION_DAYS` / `AURAXIS_LOG_MAX_FILE_MB` | 日志保留天数 / 单文件上限                   | 180 / 256                                        |

### 10.3 自定义模型格式

```json
[
  {
    "id": "my-model",
    "name": "My Custom Model",
    "apiBase": "https://my-api.example.com/v1/chat/completions",
    "apiKey": "sk-xxx"
  }
]
```

### 10.4 双 API 格式支持

模型可以指定使用 OpenAI 兼容格式或 Anthropic 格式。默认使用 OpenAI 格式（`DEEPSEEK_BASE_URL`）。当设置了 `DEEPSEEK_ANTHROPIC_BASE_URL` 时，`deepseek-v4-flash` 等模型使用 Anthropic 格式端点。每个模型可以通过 `apiBase` 字段单独覆盖。

### 10.5 DeepSeek 官方能力与接口

- **思考强度**：`low / high / max` 三档（`reasoning_effort`）；Chat 模式按 DeepSeek 风格固定 high 并由思考开关控制，Work/Code 保留滑轨选择
- **V4 Flash Vision Exp（实验版）**：内置图片理解模型（`deepseek-v4-flash-vision-exp`）；图片仅在 `user` 消息中受支持，格式为 JPEG/PNG/GIF/WebP，ReadImage 工具结果会以图片内容块交给该模型
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

---

## 十一、主窗口配置

`main.ts`（[查看文件](../electron/main.ts)）配置：

- **窗口**：1200×800，最小 600×500，无边框（`frame: false`），macOS 隐藏标题栏
- **CSP（内容安全策略）**：
  - 开发模式：允许 `unsafe-inline`（Vite HMR 需求）
  - 生产模式：严格 CSP，仅允许 `'self'`
  - `connect-src` 允许 `localhost:*`（开发）、`api.deepseek.com`、`html.duckduckgo.com`、`https://*`（MCP/自定义端点）
- **单实例锁**：`app.requestSingleInstanceLock()` 防止多开
- **全局错误处理**：`uncaughtException` 和 `unhandledRejection` 通过 `app:error` 频道发送到渲染进程
- **安全**：仅允许 `https://` / `http://` 外部链接

---

## 十二、构建与部署

### 12.1 构建流程

```
源代码
  ├── electron/ ──→ tsc (tsconfig.electron.json) ──→ dist-electron/
  └── src/ ──────→ Vite build ────────────────────→ dist/

dist-electron/ + dist/ ──→ electron-builder ──→ release/
```

### 12.2 打包配置

`electron-builder.yml` 支持三个平台：

- **Windows**：NSIS 安装程序
- **macOS**：DMG（x64 + arm64）
- **Linux**：AppImage

### 12.3 环境变量加载

应用使用 `dotenv` 从项目根目录的 `.env` 文件加载环境变量。运行 `npm run electron:dev` 前需创建 `.env` 文件（参考 `.env.example`）。

---

## 十三、开发约定与注意事项

### 13.1 代码风格

- **语言**：用户界面文本、内联注释、文档使用**中文**
- **IPC 处理程序**：全部异步，返回 `IpcResponse<T>` 格式
- **状态管理**：全局状态仅使用 Zustand Store，不使用 Redux 或 React Context
- **组件**：功能组件 + Hooks，UI 组件库统一使用 Ant Design 5

### 13.2 测试

- **测试框架**：Vitest（`describe`, `it`, `expect`, `vi` 通过 globals 注入）
- **主进程测试**：`electron/**/__tests__/`，node 环境，依赖 `electron` 的模块用 `vi.mock('electron', ...)` 隔离
- **渲染进程测试**：`src/**/__tests__/`，jsdom 环境（@testing-library/react）
- **测试总数**：245 个测试文件 / 1789 个用例通过（另有 3 例环境性跳过）
- **覆盖率口径**：门槛统计范围仅为 `electron/ipc/`、`src/stores/`、`src/core/`；UI 组件（`src/components/`）与主进程入口（`main.ts` / `preload.ts` 等）不计入该门槛，另有组件级测试与 Playwright 端到端测试（`npm run test:e2e`）覆盖
- **覆盖率阈值**：行/语句 80%，分支 70%，函数 80%（scope: `electron/ipc/`, `src/stores/`, `src/core/`；当前实际 85.18% 行/语句、78.85% 分支、87.78% 函数）
- **覆盖率报告**：`npm run test:coverage` 同时输出 `coverage/coverage-summary.json`（gitignore 的开发期产物）；设置面板「测试覆盖率」页经 `coverage:get` IPC 实时读取，纯浏览器 dev 由 Vite 中间件提供同一路径，生产构建将其拷入 `dist/coverage/`。报告缺失时面板提示运行命令，不显示伪造数字。
- **端到端测试**：16 条 Playwright UI 链路通过（真实 Electron，含本地注册 → 登录 → 记住我持久化）
- **实战验收（DeepSeek 真实 API）**：Chat 流式回答、Code 自动代批 Bash、Code「每次确认」权限卡（允许一次后写入文件）、Work 智能放行执行流、Work 计划审批面板均跑通；沙箱脚本直启 `dist-electron/main.js` 时增加 cwd 回退（`electron/sandbox-runner.ts`）。
- **压力测试（本地 mock LLM + 真实 Electron）**：200 会话冷启动约 1.4s、会话切换约 155ms、FTS 重建约 178ms；18 个 Agent（6 并发）与 30 个 Agent（8 并发）全部完成、无失败；极端负载（30 个任务 + 200 行侧栏同时渲染）下快速模式切换偶发 8–11s 卡顿并有一次超过 15s，负载结束后自动恢复；默认 3 并发下无此现象。
- **环境限制**：本机未安装真实 Python（仅 Microsoft Store 占位符），`npm run sdk:test:py` 无法执行；JS SDK 7 个用例通过。
- **运行命令**：`npm test`（全量）、`npm run test:backend`（主进程）、`npm run test:frontend`（渲染进程）、`npm run test:coverage`（覆盖率报告）

### 13.3 类型契约

跨进程共享类型只定义在 `electron/contracts/`，`electron/types.ts`、`electron/advanced-defs.ts` 与 `src/types/*` 一律 re-export，禁止在渲染层再镜像一份。

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

- **三模式**：Chat（对话）/ Work（任务执行）/ Code（代码编程）由侧边栏切换；思考、联网、会话等状态按模式保存（`modeThinkingPrefs`），切换回来时还原
- **登录与账户**：AuthGate 登录门（首启注册、可跳过）；顶部栏账户与头像显示在设置按钮左侧；设置面板 AccountPane 支持改密与头像上传
- **输入 Dock**：Chat 显示思考开关 + 联网搜索按钮（紧邻，DeepSeek 风格），无思考深度选择；Work/Code 默认思考开启并保留思考深度滑轨（low/medium/high，磁吸流式特效）；输入框圆角、无聚焦光效
- **Work 模式**：输入区居中，任务看板 + Agent 执行流程视图（回合 / 工具行 / 交付物 / 状态）；**仅文档边界**——Work 任务只能写文档/非代码文件，代码文件写入由 `electron/work-docs-policy.ts` 硬拒绝，输入区显示「仅文档」标识
- **右侧面板**：通过工作台下拉菜单打开，不覆盖主内容；缩到最小限度时无关闭按钮（仅可缩回）
- **导航历史**（back/forward）记录 tab 切换，支持浏览器式前进/返回
- **消息区满幅 + 悬浮层**：输入 Dock 与顶部头栏都是悬浮层，消息从上下穿过时经渐变淡出；列表首尾垫出与悬浮层等高的滚动空间
- **顶部分隔线**：对话执行中显示，窗口最大化时隐藏
- **Token/Model 状态**内联在输入 Dock 上方，无独立 Inspector 面板

### 13.5 已知限制

- **持久化 key 前缀**：已统一为 `auraxis-`，`auraxis_keybindings` 例外
- **硬编码限制**：
  - Agent 业务迭代上限 200 次（可配置），安全硬上限 500 次
  - 调度器最大并发数 3
  - 会话最多 40 个
  - Agent 日志最多 500 条
  - 会话消息持久化仅保留最后 40 条
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
- **字体**：系统 UI 栈（`-apple-system, Segoe UI, PingFang SC, Microsoft YaHei`）+ 等宽栈（`SF Mono, JetBrains Mono, Fira Code, Consolas`）
- **动画**：`prefers-reduced-motion` 适配；执行等待用品牌 GIF（`src/assets/executing.gif`）+ 渐变流光文字；思考深度滑轨为数据驱动磁吸动画（特效随深度递增、磁吸力递减）
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
npm run electron:compile # 仅编译主进程
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
| [electron/ipc/index.ts](../electron/ipc/index.ts)                                                   | IPC 注册总入口                                       |
| [electron/tool-defs.ts](../electron/tool-defs.ts)                                                   | 工具定义                                             |
| [electron/ipc/step-engine.ts](../electron/ipc/step-engine.ts)                                       | 统一 ReAct 步进引擎                                  |
| [electron/ipc/query-engine.ts](../electron/ipc/query-engine.ts)                                     | 聊天驱动                                             |
| [electron/ipc/query-context.ts](../electron/ipc/query-context.ts)                                   | 规范上下文快照（缓存对齐重放 / 记忆去重 / 失效墓碑） |
| [electron/ipc/agent-loop.ts](../electron/ipc/agent-loop.ts)                                         | Agent 驱动（规划/审批/偏差/停止策略）                |
| [electron/ipc/agent-scheduler.ts](../electron/ipc/agent-scheduler.ts)                               | 多 Agent 调度                                        |
| [electron/ipc/tool-handlers.ts](../electron/ipc/tool-handlers.ts)                                   | 工具执行                                             |
| [electron/ipc/permission-handlers.ts](../electron/ipc/permission-handlers.ts)                       | 权限控制                                             |
| [electron/code-mode.ts](../electron/code-mode.ts)                                                   | Code Mode（TS 工具编排）                             |
| [electron/step-compressor.ts](../electron/step-compressor.ts)                                       | AGORA 步骤级压缩                                     |
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
