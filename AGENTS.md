# AGENTS.md — Auraxis 工程与 UI 规范

桌面端 AI 智能体工作台（Electron + React 19 + TypeScript + Zustand）。本项目是**普通桌面客户端**：功能与工具面覆盖业界主流 Agent 能力，架构与开发细节见 `docs/README.md`。

## 常用命令

```sh
npm run electron:dev     # 编译主进程 + Vite + Electron（开发）
npm run electron:compile # 仅编译 electron/ → dist-electron/
npm run build            # 全量构建 + electron-builder
npm run test             # vitest 全量
npm run test:coverage    # 全量 + 覆盖率报告（生成 coverage/coverage-summary.json）
npm run sdk:build        # packages/auraxis-sdk 编译
npm run sdk:test         # SDK 测试
npm run lint             # ESLint（含 React Hooks 规则，阻断规则错误）
npm run format:check     # Prettier 格式校验
npm run check            # lint + 主进程编译 + 渲染层类型检查 + 全量测试
```

- 主进程改动必须重启 Electron 才生效；渲染层改动走 Vite HMR。
- `dist/`、`dist-electron/`、`release/`、`packages/auraxis-sdk/dist/` 都是可再生构建产物，禁止手改、禁止当作源码；清理时直接删除即可重建。

## 改动联动检查（每次改动必做）

改任何功能时，不能只改用户点名的那一处，必须排查该功能的**上下游联动面**，至少覆盖：

- **状态/入口**：同一状态是否还有别处渲染或修改（开关、按钮、面板、斜杠命令、快捷键），入口必须一致。
- **请求链路**：渲染层 → preload → 主进程 → 模型适配/工具管线，参数是否全程一致；关闭态必须真正不触发（防“关了还有”）。
- **展示链路**：流式、历史、重试、回放时，开关关闭后相关 UI（思考块、工具卡片、搜索注入、执行状态）是否彻底隐藏。
- **模式联动**：Chat / Work / Code 之间状态是否互相污染（per-mode 快照、默认值、plan 模式、surface 隔离、权限预设）。
- **持久化/迁移**：localStorage 存档版本、旧数据迁移、重启后状态还原是否正确。
- **测试**：新增/改动必须同步补联动回归用例，禁止只测单点。

## 架构约定

- **进程边界**：Node 能力只允许在主进程（`electron/`）执行；渲染层（`src/`）经 `preload.ts` 的 `window.electronAPI` 走 IPC，禁止在渲染层 require Node 模块。
- **类型单一事实源**：跨进程类型放 `electron/contracts/`（core/tools/advanced/session-types），`electron/types.ts`、`src/types/*` 一律 re-export，禁止三处各写一份。
- **统一循环**：LLM 步进只允许走 `step-engine.ts`（聊天与 Agent 共用），停止策略/压缩/重试/质量门做成策略钩子，禁止在 query-engine / agent-loop 里另写一套循环。
- **工具执行管线**：所有工具经 `tool-runner.ts` → `executeToolCall`，权限 profile → 沙箱门 → 审批 → 执行顺序不可绕过；新增后端或子调用必须回穿这条管线。
- **会话事实源**：聊天与 Agent 共用 append-only 事件流（词表 `electron/contracts/session-types.ts`，存储 `electron/session-store.ts` / chat-log / session-log），禁止再开私有持久化格式。
- **能力 seam**：已有 `SessionStore`、`ShellExecutor`、`LlmAdapter` 三个可替换接口；换实现走 seam，不直接改消费方。
- **Work 模式边界**：Work 模式只允许创建/修改/删除文档与非代码文件（门禁见 `electron/work-docs-policy.ts`），任何对代码文件的 Write/Edit/NotebookEdit/StrReplaceEditor/Delete 都会被硬拒绝；Code 模式不受影响。

## 模型工具开发约定

- 新增工具必须**同时**改三处：`electron/tool-defs.ts` 的 `TOOL_DEFINITIONS`（schema + `isConcurrencySafe`）、`electron/ipc/tool-handlers.ts` 的 `toolRegistry`（处理器）、必要时 `electron/permission-profile.ts` 的门禁。漏注册会出现「模型看得到工具但调用失败」。
- `Replan` 是**例外**：不进 registry，由 loop 驱动的 `interceptTool` 合成缝处理（`agent-loop.ts` 的 `tc.name !== 'Replan'` 分支）。
- **read-before-write**：存在文件的 Write/Edit 必须先 Read（或携带其 `version`）；Read/Write/Edit 成功都会登记会话级观测。`autoApprove` 无头流程按惯例豁免。
- Code Mode（`RunCode` 的 `language=typescript`）：程序体在 worker 线程执行，`await tools.Name(args)` 子调用必须回穿 `executeToolCall` 全管线，并发安全工具最多 8 路重叠、变异工具串行；实现见 `electron/code-mode.ts`。
- 文件类工具必须过 `resolveToolPath` / `isPathInside` 的路径边界与 `isSafeExtension` 检查，除非 `autoApprove`。

## UI 视觉规范（严格遵守）

- 主色：品牌黑 `#111216`（深底）/ 象牙白 `#F1F1EE`（浅底文字）+ Aura 紫灰 `#8C8AA8` 仅作约 3% 强调（焦点/选中/状态点）；**禁止蓝色、大面积紫色与渐变作为主色**。
- 圆角六档：5 / 6（rounded-md）/ 8（rounded-lg）/ 12（rounded-xl）/ 14（rounded-2xl）/ 9999（rounded-full）。禁止 3px、4px、7px、9px、10px 等碎角。
- 边框统一 hairline（`--color-border-dim`）；结构分隔线保留但必须最浅；不新增深色实线。
- 任何按钮/选中项**禁止左侧色条**；选中态一律用背景高亮（`bg-primary-soft` / `bg-border-dim`）。
- 零位移动画：按钮禁 hover/active 位移与缩放、弹窗禁开合动画；只允许功能性旋转（spinner）与数据驱动动画（模式滑块、工作流边）。
- 字重：正文 400、条目/按钮 500、标题/激活 600。字号档位：`text-4xs`(9) / `3xs`(10) / `2xs`(11) / `xs`(12) / `sm`(13) / `base`(14) / `md`(15) / `lg`(16)。
- 控件高度统一 36px（antd `controlHeight: 36`，见 `src/styles/theme.ts`）。
- 内容宽度：消息流/输入框 `--content-max-width: 748px`（`src/styles/tokens.css`）；首页快捷卡片可单独 1080px。
- 侧边栏透明度：设置 → 外观 → 侧边栏透明度（0–100%）；仅 Windows 11 启用原生 Acrylic（`backgroundMaterial: 'acrylic'`），非 Win11 自动禁用滑杆；最透明保留约 12% 底色保证文字可读，顶部栏保持不透明。

## 聊天区布局约定

- 消息区占满整个主聊天区；**输入 Dock（含上下文行）与顶部头栏都是悬浮层**，消息从上下两端穿过后自然淡出（上/下各一条渐变遮罩）。
- 消息列表必须用 Virtuoso `Header`/`Footer` 垫出与悬浮层等高的滚动空间，保证首尾消息能完整滚出遮挡区。
- `Header`/`Footer` 组件身份必须稳定：高度经 ResizeObserver 测好后存 **ref**，禁止把测量值放进 `useCallback` 依赖（否则 Virtuoso 每次重挂列表）。
- 顶部分隔线只在「对话执行中」显示，且窗口最大化时隐藏（还原后恢复）。

## 图标规范

- 全部按钮图标使用 `lucide-react`（经 `src/components/common/icons.tsx` 兼容层导出，统一 `weight→strokeWidth` 语义）；**禁用 AntD 图标**；不再使用 `@phosphor-icons/react`。
- 权重→描边：`regular`=1.5、`bold`=1.75、`fill`=2（细描边风格）。
- 尺寸档位：micro 12 / small 14 / medium 16 / card 20；禁止 11/13/15/17/18/22 等中间值。
- 着色：默认 `text-muted`，hover/激活 `text-primary`；成功/失败/警告色仅用于语义状态。
- 唯一允许保留的 SVG：消息上下文仪表进度环、VS Code 品牌标。

## 安全与验证

- 模型编写的任意代码执行（`RunCode`、动态插件 handler、内联工作流）**默认禁用**；只有显式设置 `AURAXIS_ALLOW_UNSAFE_CODE=1` 的受信开发环境才允许，且仍不视为 OS 沙箱。
- 原生沙箱启动失败必须拒绝执行（fail-closed）；终端、Lint、LSP、Code Runtime 等子进程只继承 `safeProcessEnv()` 白名单环境。
- 所有主进程 IPC 注册必须经 `secureHandle` 或 `assertTrustedIpcSender` 校验来源；文件/项目/上下文写入路径必须经 `resolveTrustedProjectRoot` 校验。

## 测试与验证

- 新增/改动必须过：`npx tsc --noEmit`（渲染层）、`npm run electron:compile`（主进程）、`npx vitest run`（全量）、`npx vite build`（构建）。
- 测试覆盖门槛：lines/statements ≥ 80%、branches ≥ 70%、functions ≥ 80%（`vitest.config.ts`）；最近一次全量报告为 77.58% statements / 79.94% lines / 67.01% branches / 73.85% functions，当前低于门槛，需要补测试后再将门槛视为可守住水平。
- CI 当前把全量单元测试作为阻断项；覆盖率门槛未达时仍生成报告并在设置页展示，但不再阻断平台 Release（见 `.github/workflows/build.yml`）。
- 覆盖率报告：`npm run test:coverage` 同时输出 `coverage/coverage-summary.json`（gitignore，开发期产物），设置面板「测试覆盖率」页经 `coverage:get` IPC 实时读取该文件；README / AGENTS / docs 中的用例数与覆盖率数字以最近一次全量覆盖率为准，更新后必须同步。
- 覆盖率统计范围：`electron/ipc/`、`src/stores/`、`src/core/`（不含 `src/components/` 与主进程入口）；UI 由组件级测试覆盖，桌面端到端链路由 `npm run test:smoke` 覆盖。
- 端到端：`npm run test:e2e`（Playwright 启动真实 Electron，覆盖启动/模式切换/发消息/快捷卡片/设置主题/本地注册登录等 16 条链路）；改动渲染层或主进程启动链路后必须重跑。
- 主进程模块依赖 `electron` 的测试需 `vi.mock('electron', ...)`；纯逻辑优先抽成可测函数。
