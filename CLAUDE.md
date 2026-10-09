# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **强制工程与 UI 规范见 [AGENTS.md](AGENTS.md)**（Claude Code 会自动加载，改代码前必读；冲突时以它为准）。
> 本文件只补充 AGENTS.md 没有的内容：命令速查、架构大图、跨文件才能拼出的链路与约定、守卫脚本与坑点。
> 详细的模块目录、IPC 全通道表见 [docs/README.md](docs/README.md)（§2.2 目录结构、§3 IPC、§4 AI 核心、附录 Key File Index），中文镜像 [docs/README.zh-CN.md](docs/README.zh-CN.md)。

Electron + React 19 + TypeScript + Zustand 桌面端 Agent 工作台。主进程 `electron/`，渲染层 `src/`，三种模式 Chat / Work / Code，另有 Python 与 TypeScript 两套 SDK。

## 常用命令

```sh
npm run electron:dev      # 编译主进程 + Vite + Electron；主进程改动必须重启，渲染层走 HMR
npm run electron:compile  # 仅编译 electron/ → dist-electron/（同时产出 preload bundle）
npm run dev               # 只起渲染层（纯浏览器，window.electronAPI 为空，走 ai-service.ts 回退）
npm run build             # 全量构建 + electron-builder 打包

npm test                  # vitest 全量
npm run test:watch        # watch 模式
npm run test:coverage     # 全量 + coverage/coverage-summary.json（设置面板「测试覆盖率」页读同一份文件）
npm run test:backend      # = vitest run electron/ipc
npm run test:frontend     # = vitest run src

npx vitest run electron/ipc/__tests__/agent-handlers.test.ts   # 单文件
npx vitest run src/stores/__tests__/useChatStore-flow.test.ts -t "用例名"  # 单个用例
npx vitest run electron/ipc                                    # 单目录

npm run test:smoke        # 真实 Electron 跑 dist/ 生产渲染层，验 electronAPI 与 6 条 IPC 通道
npm run test:e2e          # Playwright 驱动真实 Electron（含注册/登录/重启链路）
npm run sdk:build && npm run sdk:test && npm run sdk:test:py && npm run sdk:smoke
npm run eval:agent:dry    # 只验数据集与 grader（无需 key）；去掉 :dry 跑真实模型，需 DEEPSEEK_API_KEY
npm run eval:prompt-ab    # 提示词变体 A/B：evals/prompts/*.txt 各跑一遍评测 + 基线臂对比

npm run check             # 本地全量门禁，9 步：
                          # lint → lint:budget → check:cycles → check:runtime-boundary
                          # → electron:compile → check:preload-bundle → tsc6 --noEmit -p tsconfig.json
                          # → test → check:docs
```

**工具链坑**：`typescript` 被 alias 成 `npm:@typescript/typescript6@6.0.2`，bin 名是 **`tsc6`**。一律用 `npx tsc6`，**不要**用全局 `tsc`，也不要把类型检查换成 `tsc -p`。

## 架构大图：一轮对话的完整链路

```
src 输入框 → useChatStore.sendMessage（src/stores/chatSendMessage.ts）
   ├ Chat 模式      → ai.chatStream  → electron/ipc/ai-handlers.ts（无工具，纯对话）
   └ Work / Code    → ai.sendQuery   → electron/ipc/ai-handlers.ts
                                        ├ 查询路径 → electron/ipc/query-engine.ts
                                        └ Agent / SDK / ACP → electron/ipc/agent-handlers.ts:runSubAgent
                                        └ 多 Agent 队列 → electron/ipc/agent-scheduler-*.ts
     → agent-runtime/agent-loop-driver.ts:agentLoopRun   （外层循环：迭代预算 / 停止策略 / 质量门 / Replan 拦截）
         → agent-runtime/step-engine.ts:runStep          （一次 ReAct 迭代）
             nudge 注入 → 上下文装配 + UserPromptSubmit hook
             → invokeLlmWithRetry（429/5xx/ECONNRESET 退避重试，随后一次 fallbackModel）
             → runToolBatch：agent-runtime/tool-runner.ts
             → 无工具调用则交由 agent-runtime/agent-loop-stop.ts:stopPolicyEvaluate 判停
             → maybeCompact（agent-runtime/context-manager-compact.ts，超阈值触发压缩）
     ← 事件回传 → src/stores/chatSendEvents.ts（RAF + 节流缓冲）写入 store → 选择器驱动重渲染
```

- 引擎文件全在 `electron/agent-runtime/`：`agent-loop-driver.ts`（外层循环）、`step-engine.ts`（单步）、`context-manager*.ts`（上下文装配/压缩）、`llm-adapter.ts` + `llm-provider-{format,anthropic,openai,responses}.ts`（协议适配与工具 schema 规范化）、`tool-runner.ts`（工具批）。
- **系统提示词与工具 schema 必须字节稳定**（缓存前缀），`context-manager.ts:STATIC_SYSTEM_PROMPT` 里禁止出现 `Date.now` / 随机数 / 环境变量；动态内容一律放前缀之后。
- 停止策略、压缩、重试、质量门都是 step-engine 的**策略钩子**，不允许在别处再写一套循环。

## 引擎边界（最容易踩的架构红线）

- `electron/agent-runtime/**` 是纯引擎：**禁止**对 `electron/ipc/**` 有**值**依赖（`import type` 可以）。守卫 `npm run check:runtime-boundary`（CI 阻塞）。
- 新增宿主能力的正确顺序：在 `electron/agent-runtime/ports.ts` 的 `RuntimePorts` 里声明 → 在 `electron/ipc/runtime-ports.ts` 装配实现。桌面、无头 CLI、SDK 与测试共用同一份装配。
- 三个宿主入口的分工不要混：`ipc/query-engine.ts`（Chat 外的查询路径）、`ipc/agent-handlers.ts`（Agent 工具 / SDK / ACP 的子 Agent）、`ipc/agent-scheduler-*.ts`（队列、并发、暂停续跑、快照持久化）。
- `surface: 'chat'` 在上游就被拒（`ipc/ai-handlers.ts`、`ipc/agent-scheduler.ts`），Chat 没有工具面。
- 迭代预算只能经 `electron/ipc/agent-iteration-budget.ts:resolveIterationBudget()` 解析，渲染层禁止自带默认值。

## 工具执行管线：顺序即安全模型

`electron/tool-runner.ts` 只是门面，真实的门禁顺序在 `electron/ipc/tool-handlers/pipeline.ts:executeToolCall`，**不可绕过、不可调序**：

```
Work 文档门（electron/work-docs-policy.ts）
→ 路径卫生（electron/ipc/path-security.ts：敏感路径拒绝 + 物理路径边界）
→ 权限 profile（electron/permission-profile.ts）
→ 沙箱门（electron/sandbox-policy.ts，拒绝模型自行提权）
→ 项目规则（electron/rules.ts，默认不授权）
→ 审批（electron/ipc/permission-handlers.ts）
→ worktree 重定向 → 备份 / 冲突锁 → PreToolUse hook → 执行器
→ 结果缓存 + PostToolUse hook
```

- 能力集合（读/写/Shell/终端/危险/Work 禁用/受限不支持）的**单一事实源**是 `electron/tool-capability.ts`，禁止在别处重复维护同名字符串集合。
- 子进程环境一律走 `electron/safe-env.ts` 白名单；`RunCode` 里的 `await tools.Name(...)` 子调用也必须回穿同一条管线。
- 沙箱 **fail-closed**：原生沙箱启动失败必须拒绝执行，绝不退化成无沙箱。
- 新增工具必须**同时**改 `electron/tool-defs/`、`electron/ipc/tool-handlers.ts` 的 registry、必要的门禁（详见 AGENTS.md）；漏一处会出现「模型看得到工具但调用失败」。

## 会话与记忆

- 会话是 **append-only 事件流**：唯一词表 `electron/contracts/session-types.ts`，存储实现 `electron/session-store.ts`（JSONL + 投影缓存），聊天与 Agent 共用。**禁止再开私有持久化格式。**
- 跨进程类型放 `electron/contracts/`，`electron/types.ts` 与 `src/types/*` 一律 re-export，禁止三处各写一份。
- 记忆：`electron/ipc/memory-db.ts` 单例，SQLite（`auraxis-memory.db`）为主、JSON 回退，存证据 / 信号 / 信念 / 审计。

## 无头模式 / SDK / ACP

- 入口 `electron/main.ts` 在 `app.whenReady()` 后解析 CLI（`electron/cli-args.ts`）并分流：桌面窗口 / `--run` / `--sdk` / `--acp` / 插件 CLI。无头分支跳过单实例锁并使用独立 Chromium profile。
- `electron/headless-run.ts:runHeadlessTask` 复用 `agentLoopRun`；默认只放行只读工具，除非 `--auto-approve`。
- SDK 与 ACP 复用子 Agent 链路：`electron/sdk-server.ts`（回环 TCP，端口与 token 打到 stdout —— 因为 Windows 无法给 Electron 主进程定向 stdin）、`electron/acp-server.ts`（stdio JSON-RPC）。自动批准分别受 `AURAXIS_SDK_AUTOAPPROVE` / `AURAXIS_ACP_AUTOAPPROVE` 约束。

## 渲染层

- **没有路由器**。导航即状态：`useAppStore` 的 tab 列表 + `tabHistory`、`sidebarMode`、`activeToolView`、`rightPanelView`。新增界面多半是加一个 view key / tab type（`src/types/chat.ts`）并在 `src/components/layout/WorkbenchContent.tsx` 注册，而不是加路由。右面板能力注册表在 `src/workbench/workbench-panels.tsx`（每项声明 `availability(ctx)`，能力不足时渲染带原因的锁定态，不要放假面板）。
- **Store 约定是「工厂注入」，不是 slice**：`useChatStore.ts` 等只持有 state + persist 配置，动作 / 缓冲 / 副作用拆在同目录的 `createXxx(deps)` 工厂模块里，用 `set`/`get` 注入后 spread 进 initializer（目的是断循环依赖 + 可单测）。chat 的运行时状态（`abortController`、IPC 订阅、看门狗超时）刻意放在 `src/stores/chatStreamRuntime.ts` 的**模块级单例**，不进 React state。
- **IPC 边界**：契约唯一来源 `src/types/electron-api.ts`，文件末尾有与 preload 的类型漂移守卫。`window.electronAPI` 是**可选**的（纯浏览器回退），调用点一律 `?.`；没有统一 wrapper 层，组件直接调（例外：`src/services/ai-service.ts`、`agentStoreHelpers.agentIpc()`）。
- **流式回传**：没有全局 token 通道。每次请求注册回调并返回订阅，事件经 `chatSendEvents.ts` 节流后写 store。
- **样式三处同源（真实维护陷阱）**：`src/styles/tokens.css`、`src/styles/app.css` 的 `@theme` 块、`src/styles/theme.ts`（antd `ThemeConfig`）各自硬编码同一套调色板。改色必须三处同改，否则 utility class 与组件库会打架。
- **图标**：只从 `src/components/common/icons.tsx` 导入（lucide 兼容层，沿用 Phosphor 命名），禁止直接 `import 'lucide-react'`；`IconContext` 的 `size: '1em'` 是硬要求。
- **持久化**：各 store 的 `partialize` 才是真正的持久化契约；版本号 bump 必须配 `migrate`（bump 不得让 hydration 变砖）；与主进程对账（权限预设、玻璃能力、API key 状态）放 `onRehydrateStorage`。

## 模式边界（Chat / Work / Code）

- `sidebarMode` 存于 `useAppStore`；跨能力边界切模式会跳到该模式最近的会话（`src/stores/sessionModeSwitch.ts`）。
- 三处隔离同时生效：会话按模式打标、`chatStoreSideEffects.ts` 按模式快照 thinking / plan 偏好、`useAgentStore` 按 surface 记 `lastAgentIdBySurface`。
- 主进程侧硬边界：Work 由 `electron/work-docs-policy.ts` 拒绝一切代码文件的写/改/删；Chat 无工具、无右面板、无终端。

## 测试约定

- 全局 `environment: 'node'`（`vitest.config.mts`）。React / 组件用例在**文件首行**用 `// @vitest-environment jsdom` 逐文件 opt-in。
- `src/test/setup.ts` 提供 `ResizeObserver` / `matchMedia` polyfill，并在 `afterEach` 清理 antd 静态 portal —— `message` / `Modal.confirm` 在 `act` 外的延迟任务是 jsdom teardown 噪声的主因。
- 依赖 `electron` 的模块用 `vi.mock('electron', ...)`；需要跨用例 `mockClear()` 时用 `vi.hoisted()` 先建 mock 对象。纯逻辑优先抽成可测函数，而不是去 mock Electron。
- 新用例放模块旁的 `__tests__/`，命名 `<module>.test.ts` 或 `<topic>-<aspect>.test.ts`。
- 覆盖率只统计 `electron/**`、`src/stores/**`、`src/core/**`；`electron/main.ts` 与 `electron/preload*.ts` 明确排除（由 E2E / smoke / headless CLI 覆盖）。四项阈值均 80。**文档里的覆盖率与用例数字以 `coverage/coverage-summary.json` 与 `check-doc-stats` 为准，不要凭记忆写。**

## 守卫脚本与 CI 门禁

改完代码前先跑 `npm run check`。以下守卫各自拦一类事故，**不要把它们的失败当成误报**：

| 守卫                             | 拦什么                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check:cycles`           | `electron/` 与 `src/` 的静态 import 环。预算全 0：值环、运行时环、含 `import type` 的环都不允许（`--list` 打印断边）                                |
| `npm run check:runtime-boundary` | 引擎对 `electron/ipc/**` 的值依赖（见「引擎边界」）                                                                                                 |
| `npm run check:preload-bundle`   | `dist-electron/preload.js` 缺失、不含 `contextBridge`、或 require 了拆分模块。历史事故：tsc 静默失败 → `window.electronAPI` 为 undefined → 无法登录 |
| `npm run lint:budget`            | ESLint warning 预算为 0。复杂度 30 / 嵌套 5 / 函数 220 行 / 文件 800 行是 warning 级但计入预算，新代码不得新增该面                                  |
| `npm run check:docs`             | `check-doc-parity`（docs 中英 1–3 级标题数必须一致）+ `check-doc-stats`（版本号 / 测试数 / 覆盖率声明互查）                                         |

- **改任何文档数字前先跑 `npm run check:docs`**：`check-doc-stats.cjs` 会校验测试文件数、用例数、`v3.5.0` 版本串（含 SDK 与 pyproject 版本一致）、以及形如 `NN.NN% lines` 的覆盖率声明与实测相差不超过 0.6pp，并禁止旧数字残留。
- CI（`.github/workflows/build.yml`）三平台均为阻断项；Linux 额外跑覆盖率门禁、xvfb 下的 SDK smoke 与 E2E。`.github/workflows/sandbox.yml` 为手动触发（Windows 原生沙箱用例默认 skip）。
- `npm run test:coverage` 写入的 `coverage/coverage-summary.json` 是设置面板「测试覆盖率」页的数据源，不是给人看的临时文件。

## 生成物：不要手改，也不要把它们当源码

`dist/`、`dist-electron/`、`release/`、`packages/auraxis-sdk/dist/`、`coverage/`、`evals/reports/`、`evals/candidates/`、`test-results/`、`playwright-report/`、`spill/` 全部可再生，直接删掉重建。

`dist-electron/preload.js` 卡住时：先删掉 `dist-electron/` 再 `npm run electron:compile`。

## 与 AGENTS.md 的分工

本文件**不重复** AGENTS.md 的「改动联动检查」清单、「UI 视觉规范」（色板 / 圆角六档 / 单层容器 / 零位移动画 / 字号字重 / 图标档位）、「安全与验证」清单与「模型工具开发约定」。改任何功能前，请按 AGENTS.md 的联动面清单逐项排查（状态入口、请求链路、展示链路、模式联动、持久化迁移、测试）。
