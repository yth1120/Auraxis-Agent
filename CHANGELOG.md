# Auraxis Changelog

## v3.5.0 (2026-10-10)

> Feature release：评测回归门禁与动态工具装载的真回归修复、聊天区 Agent Activity View，
> 以及一轮以实测为依据的前端 UI 打磨与仓库清减。

### Agent Engineering 闭环：接入既有能力

> 一次"能力缺口"核查发现：eval 框架、动态工具装载、难度路由**都已存在但没接上线**。
> 这一段先把两件最要紧的做掉 —— 修一个真回归，立一道真门禁。

#### Fixes

- **修复动态装载把 MCP / 插件工具静默丢弃**（真回归）：`selectToolsForTask` 只保留
  "学习核心集 ∪ 命中分组"，而 `mcp__<server>__<tool>` 这类名字落不进任何分组正则、被判为
  `misc`，而 `misc` 永不被选中 —— 装了 MCP，agent 却看不见自己的工具。预选之前这些路径拿的是
  全量工具表，所以是动态装载引入的回归。现在加了**保留集**：来路不明的名字（`mcp__` 前缀或
  未归类）一律保留，`ToolSearch` 的组名白名单照旧拦"多给"。测试用变异验证过（去掉保留集必红）。

#### Toolchain

- **评测回归门禁**：`eval:diff` 把"这次有没有变差"变成退出码。此前报告一直在写、
  `baseline.json` 也一直在，但**没有任何代码读它**，回归可以无声发生。判定在
  `electron/agent-eval/regression.ts`（纯函数、21 个用例）：逐用例/逐检查/过程门槛/验证等级/
  共同用例上的 token 和，四种"不可比"的情形（schema 版本、dry vs live、工具 schema 指纹缺失或
  不一致）**拒绝比较并说明原因**，而不是给一个"没有回归"的假安全感。
- **冻结基线**：`evals/baseline/{coding.json,tool-schema.hash}` 入库（`evals/reports` 与
  `evals/candidates` 仍是生成物、继续忽略）。基线只保留门禁读得懂的字段 —— 轨迹、stderr 与
  临时目录绝对路径在冻结时被投影掉（86KB → 29KB，零机器路径），否则等于把某台机器的目录结构
  提交进仓库。`node scripts/eval-diff.cjs --freeze --from=…` 是唯一的重跑入口，基线永远人工提交。
- **CI 增加了无 Key 的评测检查**：`agent-eval --dry`（数据集可加载 + 判分器有判别力）与
  `eval-diff --check-meta`（工具 schema 指纹没漂）。真实评测需要 `DEEPSEEK_API_KEY`，不在 CI 跑。
- 无头 CLI 现在打印 `[工具集] n= hash=` 与 `[用量] … cacheHit= cacheMiss=`：token 收益与
  "前缀有没有被击穿"从此有观测点，而不是靠推断。

### Agent Activity View（聊天区执行流程）

> 把聊天区的执行视图做到成熟 Agent Coding 产品的交互质量：聚合、流式、可下钻、
> 长任务不失控、权限就地审批。架构不动（Activity 仍是 `messages[].toolCalls` 的纯投影），
> 不碰 Runtime 与 IPC。

#### Features

- **聚合**：顶层不再按"批次"分组，改为合并连续同类**已完成**操作
  （`读取 4 个文件` / `检索 3 次 · 命中 14 处` / `运行命令 3 条`）。正在跑、失败、被取消、
  以及带 ± 的改动一律留在自己那一行。展开聚合行看到的是同一批真实条目，可继续下钻到详情；
  段数超过 24 的长任务把最早的折成一行「已折叠较早的 N 项」，且只在 Run 结束后折。
- **流式终端可见**：运行中渲染尾部窗口的实时输出（8KB / 200 行，按行边界切，不切断 ANSI），
  只在用户贴着底时跟随滚动，并如实标注省略了多少行。
- **计划卡**：`TodoWrite` 从原始 JSON 变成紧凑清单 + 真实进度（`2/4 已完成`），
  走共享卡片层，Agent 会话与轨迹面板同时受益。
- **权限就地审批**：审批卡片渲染在执行流程的那一行内，决策让该行原地翻转
  （`◐ 等待确认` → `✓ 已授权`）；修掉"权限消息被执行视图吸收后按钮不可达"的回归。
- **新活动提示**：用户上滚阅读历史时不再被强制拉回底部，改为出现「有新活动」，
  到底才消失；指纹按消息/工具/正文分桶取粗粒度，不会每帧闪。
- **行级动作**：复制（与详情同一份文本）、打开终端、「查看 Diff」现在真的把 diff 面板带到
  那个文件（此前会被文件树联动覆盖）；Chat 模式不画面板类动作（画了就是死点）。
- **视觉层级**：壳层（Run 头 / 聚合头）从 primary+semibold 降为 secondary+muted，
  最终回答保持 16px 成为唯一焦点；新增每个 id 只播一次的 160ms 入场动画，并删掉 5 个零引用动画。
- **分派注册表**：卡片渲染改为映射类型注册表、详情类型改为 `Record<ActivityType, …>` ——
  新增一种类型却漏接会**编译失败**，而不是静默渲染 undefined。

#### Toolchain

- 新增一次性开发工具 `scripts/ui-preview.mjs`：用已有 playwright + 系统 Chrome 起 Vite 渲染层
  并注入覆盖各 Activity 形态的会话数据，截图观察真实界面（本机 Electron GUI 起不来；
  该脚本不进 CI、不新增依赖）。

### 前端 UI 打磨与仓库清减

> 判据是"**写了但产物里没有**"这类静默失效，不是审美偏好。取证方式：生产 CSS 产物
> （`dist/assets/*.css`）+ 真实浏览器的计算样式 + 截图，先拍"改前"基线再动代码。

#### Fixes

- **恢复 178 处从未生成 CSS 的 utility 类**（29 个文件）：`text-muted` / `text-faint` /
  `text-secondary` / `border-dim` / `bg-secondary` / `bg-tertiary` / `bg-elevated` /
  `bg-inset` / `text-on-accent` / `duration-fast` / `duration-normal` 这套写法少了
  命名空间前缀，产物里根本没有规则 —— 于是"次要文字"渲染成满对比度正文色、
  hairline 渲染成实心深色线、崩溃页在黑底上渲染黑字（对比度 1.00）。
  按命名规则补前缀后恢复设计原意；`duration-*` 改用数字档（Tailwind v4 没有
  `--duration-*` 命名空间，`@theme` 里的同名令牌是惰性的）。
- **状态色到达 WCAG AA**：success `#497260` / danger `#9a575b` / warning `#8d612f`
  （深色 danger `#bf8c90`），并补齐唯一真正未定义的令牌 `--color-success-border` ——
  此前它未定义，`border-color` 落到初始值 `currentColor`，芯片边框渲染成 100% 不透明。
  三处同源（`tokens.css` / `app.css` 的 `@theme` / `theme.ts`）一起改，
  顺带把 `@theme` 里 5 个**从未生效**的漂移值对齐真相（`tokens.css` 优先级更高）。
- **Ant Design 6 失效覆盖**：`-content` → `-container`（modal）、`-message-notice-content` →
  `-notice`、select / cascader 两处按真实 DOM 改名；同时**删掉**指向
  `.ant-popover-inner` / `.ant-tooltip-inner` 的规则 —— 逐条查过 antd 6.6.1 源码，
  这两个元素已不再渲染，留着只会与根节点的 `filter: drop-shadow` 叠成双层阴影。
- **删除文件时确认气泡提前消失**：行内操作按钮平时 `hoveredPath === entryPath` 才渲染，
  而 `Popconfirm` 的气泡是挂 body 的 portal、位置在行**外面** —— 鼠标从行走向气泡必然
  先离开行 → 触发按钮被**卸载** → 气泡跟着关。改为"气泡打开期间钉住该行"，
  并用变异测试证明这条用例确实抓得住回归（去掉钉住必红）。同时给四个纯图标按钮补上
  `aria-label`（此前无可访问名）。
- **清死代码**：文件树的 `fileStatus` 徽标链路（字段自创建起**没有任何写入方**，
  分支永不渲染）、`collectDeliverables` / `DeliverablesCard` / `AgentSummaryCard`
  （零调用点）、重复的第 5 处 Agent 列表（右栏 `AgentTasksCard`，左栏已完整承担）、
  恒为 0 的「目标任务」统计（改数真实在跑的条数）。
- **两处"假信息"**：`ContextManifest` 标题写「**本轮**上下文」，而 Code/Work 模式的数据源
  是**整条 agent 日志**（chat 模式才是最后一轮）—— 标题改为不声明口径的「上下文清单」；
  执行详情里读 `agent.goal` 的徽标渲染层从不赋值（数字恒 0），删除。
- **删重复展示**：概览面板里的 token 行与暂停/停止按钮（与「执行详情」头栏同一根侧栏的
  两个页签重复，且是全部 9 处停止能力里**唯一绕过 store 直连 IPC** 的实现）；
  计划面板里再抄一遍的 goal 文本（GoalBar 已有且可操作）；产物面板并入变更面板
  （列的是同一批改动文件，而变更面板有 diff、有 revert）。
- **死 i18n 键**：中英各清掉 40+ 条（含 22 条从未被引用的键），并修一处真 bug ——
  `keybindings` 的 `description` 漏进显示侧映射表会 fallback 成"打开命令面板"。

#### Features

- **右侧工作台面板重做**：清单 → 详情两态导航。清单**一次性全部列出**、自上而下一行一个
  （不折叠 —— 让清单短的正确做法是删掉重复功能，而不是把它们藏起来）；`+` 的含义是
  "给**这个模块**新增一个条目"（只给真有该能力的模块画，且它与头部的「分栏」是两件事）；
  未接线的能力（PR / Computer Use）不占位。七行全部带快捷键提示，
  并补齐此前**真没有绑定**的 Ctrl+Shift+5/6/7（概览 / 计划 / 文件）——
  新增绑定追加在数组末尾，避免按数组下标持久化的用户换绑整体错位；
  再用一条用例把"提示"钉在全局绑定表上（提示写着却按不动、换绑后提示说谎，两种事故都拦）。
- **品牌执行标记**：位图 GIF 换成 SVG/CSS 的 Axis Mark（倾斜光环 + 沿轨道巡行的 comet dash，
  `pathLength=100` 归一化保证循环无跳帧），并遵循 `prefers-reduced-motion`。
- **注册 / 登录页重做**：整屏改用品牌底图 + 玻璃表单卡。底图**靠左对齐**（居中裁切会把
  品牌标记切掉一半）；登录 / 注册改成卡片顶部的滑块分段控件（复用应用既有的
  radiogroup + 滑块实现 —— 全局规则会给 `[aria-selected]` 按钮强加底色，只有
  radiogroup 有豁免），注册页字段按「账户 / 模型接入」分段，不再是十个输入框平铺。
  这一层**固定深色**并就地切 antd `darkTheme`：底图是暗的，浅色主题下不该出现
  浅色输入框落在暗底上。**不新增任何色值**，颜色全部由 `tokens.css` 用
  `color-mix` 派生；底图右侧压满不透明，压掉图里拖到画面最右的字标透出玻璃卡的鬼影。
- **会话归档**：`archived` 贯通会话 meta 契约、存储与投影缓存（`PROJECTION_VERSION` 3）——
  此前归档只活在渲染层，启动时的重投影会让已归档会话自己回到列表里。

#### Toolchain

- **`scripts/ui-preview.mjs` 扩成取证工具**：支持明暗主题、逐屏导航、
  死类探针（统计"写了但产物里没有"的类命中数）、几何溢出探针、
  计算样式探针与换行探针。用它证明了"发送按钮被挤出可视区"「执行详情是
  计划 + 产物 + 概览的并集」等结论，而不是靠读代码推断。
- **`PREVIEW_AUTH=setup|locked`**：认证相位可注入，注册页 / 登录页从此也能截图验证
  （闸门后面没有输入框，原先的等待条件必然超时）。
- **`check-doc-stats` 档位推进**：测试文件数 / 用例数 / 覆盖率声明全部更新到本轮实测
  （325 文件 / 2,739 用例 / 89.86% statements / 92.25% lines / 81.36% branches /
  89.00% functions），旧档位进禁留名单。`inspector/` 这类目录计数改为与磁盘一致
  （该块此前整体漂了 1–3）。

## v3.4.0 (2026-09-18)

> Feature release: DeepSeek V4.1 Flash as the current multimodal default, the
> Responses API adapter, capability-gated Chat/Work/Code surfaces, a corrected
> iteration budget with resumable runs, plus desktop auto-update and release
> engineering.

### Features

- Desktop auto-update: `electron-updater` reads the GitHub release metadata, the main
  process owns the update state machine (`electron/updater.ts` + `update:*` IPC), and
  Settings → About exposes check / download / restart-and-install. Startup runs one check
  15 seconds after launch with `autoDownload = false`, so a slow network never triggers a
  background download of hundreds of MB.
- Release engineering: explicit GitHub `publish` config (so `app-update.yml` and
  `latest*.yml` are produced for all three platforms), macOS hardened runtime with
  entitlements, and CI wiring for Apple notarization plus macOS/Windows code-signing
  secrets. Every credential is optional — builds without them stay runnable and unsigned.

### Toolchain

- Windows native sandbox coverage is no longer silently skipped: `.github/workflows/sandbox.yml`
  runs the restricted-token suite on demand (11 assertions pass on hosted runners; the
  integrity-level check steps aside when the host cannot enumerate groups in a service
  session, and command timeouts scale for cold hosted runners).
- Upgraded to Vitest 5 / `@vitest/coverage-v8` 5 and mermaid 12. Vitest 5 no longer
  keeps mock calls between test cases by default and runs heavier process tests closer
  together, which surfaced two latent test issues (a cross-case mock assertion and a
  starved sandbox timeout) and one real defect: `cron-store.json` writes were neither
  serialized nor atomic, so concurrent saves could corrupt the file and lose every
  scheduled job on restart.
- mermaid 12 pulls `chevrotain` → `lodash-es`, so an npm override pins `lodash-es` to
  `^4.18.1` and keeps `npm audit --audit-level=high` at zero findings.
- Added guard-branch tests for `file-tools` (read/write/edit/str_replace/delete/grep/glob
  permission, abort, oversized, sensitive-path and failure paths): the file went from
  87.5% to 95.9% statements and 81.1% to 90.9% branches.

### Maintainability

- Consolidated nine copies of the `basename` helper into `src/utils/paths.ts`.
- Removed unused dependencies (`@xyflow/react`, `dagre`, `@types/dagre`,
  `electron-builder-squirrel-windows`) together with the stale `vendor-flow`
  chunk rule and third-party notice row.
- Declared `use-sync-external-store` explicitly: three components import
  `zustand/traditional`, and the shim used to arrive only as a hoisted
  transitive package, so a clean install could resolve zustand's optional peer
  to nothing.
- Consolidated the `isRecord` type guard that was pasted into 20 modules into
  `electron/utils/guards.ts`.
- Replaced the silent `catch {}` probes in the Bash shell resolver and the
  agent-loop context scan with `devLog` traces so fallbacks are diagnosable.
- Removed fixed-duration sleeps from `workflow-run` and `RollbackToMessage`
  tests (polling / shared teardown instead) to cut flake surface.
- Coverage after that cleanup pass: 89.68% statements / 92.05% lines / 80.94%
  branches / 88.27% functions (the suite has kept growing since; current numbers
  live in the README).

### Fixed

- Agent iteration budgets now follow the configured value. The renderer used to send a
  hard-coded `maxIterations: 200` with every task, silently overriding the
  `agentMaxIterations` set in Settings → Agent runtime; the resolution now lives in
  `electron/ipc/agent-iteration-budget.ts` (request → settings → default, clamped to
  1–500) and covers the scheduler, sub-agent, unified-query and headless-CLI paths.
- Continuing a task that hit its iteration budget no longer stops immediately. The
  composer follow-up path already resumes the most recent task (including ones
  that ended with `error`), but the replayed `resumeFrom.iteration` tripped the
  same cap on the first step — typing "继续" appeared to do nothing. The scheduler
  now grants a fresh window on continuation, bounded by the 500 hard cap, so the
  existing follow-up flow works without a dedicated UI affordance.
- The composer now tells you who a message continues: `composer.placeholder.followup`
  ("在「任务名」基础上继续…" / "Continue on …") was defined in the i18n tables but never
  wired up, so the input looked identical whether you were starting a task or
  replying to one. The placeholder now resolves the same follow-up target the send
  path uses.
- `backupBeforeModify` required a non-existent module (`require('./undo-manager')`
  from the `tool-handlers/` directory), and the swallowed exception turned every
  pre-modification backup into a silent no-op — undo/rollback never recorded
  Write/Edit/Delete snapshots even though the file reported 100% coverage. It now
  uses a static import, and a regression test fails against the old code.
- Removed dead code found by a knip pass: unused `src/styles/reset.css` plus the
  `@electron/notarize` and `@types/adm-zip` devDependencies (electron-builder ships
  its own notarize implementation and adm-zip ships its own types).

### Code hygiene

- Removed the eslint "baseline exceptions for inherited code" block: `no-empty`,
  `prefer-const`, `no-useless-escape`, `no-misleading-character-class` and
  `preserve-caught-error` are enforced again, and the nine violations they exposed
  are fixed.

### Docs

- Synced every maintained document with the current code: 278 test files /
  2,144 passing cases and 89.39% statements / 91.83% lines / 80.52% branches /
  88.47% functions (README, AGENTS.md, both architecture guides, the vitest
  comment, and the doc-parity guard itself, which also now rejects the previous
  generation of numbers).
- Documented the iteration budget as it actually behaves: resolution order
  (request → Settings → 200, clamped to 1–500), the 500 hard cap, resuming a
  budget-exhausted task from the composer, the follow-up placeholder, and the
  fail-closed native-sandbox behaviour.
- Refreshed the release highlights: V4.1 Flash as the current multimodal default
  with legacy-name routing and explicit thinking flags, the Responses API route,
  and the latest real-API acceptance evidence.
- Added complexity / max-depth / max-lines budgets as warnings plus
  `npm run lint:budget` (wired into CI and `npm run check`), so code-health debt can
  only shrink; the ceiling is now 103 warnings and must be lowered after each cleanup.
- Split the complexity-62 functions in `agent-loop-context.ts` (`buildSummary`,
  `compressHistory`) into pure helpers for summary accumulation/parsing/rendering and
  compression-zone analysis.
- Split the two remaining LLM god-functions: `invokeDeepSeekOpenAI` (232 lines,
  complexity 71, nesting 8) and `invokeDeepSeekAnthropic` (complexity 62) now only
  assemble the request body, while both SSE state machines live in
  `electron/ipc/llm-streams.ts` and share the `<FINAL_ANSWER>` finalisation. Fourteen
  focused stream tests cover text/tool interleaving, thinking blocks, usage metadata
  and stop-reason mapping.

### Build & CI

- Packaging no longer ships `dist-electron/**/*.map`, keeping source maps for
  local debugging only.
- CI: least-privilege `permissions`, per-ref `concurrency` (tag releases are
  never cancelled), job `timeout-minutes`, and actions pinned to commit SHAs.
- Added `.github/dependabot.yml` (weekly npm + monthly Actions updates, major
  bumps of Electron/Mermaid/React/Vitest coverage excluded from auto PRs).

### Release Artifacts

- Windows: [Auraxis.Setup.3.4.0.exe](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.4.0/Auraxis.Setup.3.4.0.exe)
- Windows blockmap: [Auraxis.Setup.3.4.0.exe.blockmap](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.4.0/Auraxis.Setup.3.4.0.exe.blockmap)
- Windows update metadata: [latest.yml](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.4.0/latest.yml)
- macOS (Apple Silicon): [Auraxis-3.4.0-arm64.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.4.0/Auraxis-3.4.0-arm64.dmg)
- macOS (Intel): [Auraxis-3.4.0.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.4.0/Auraxis-3.4.0.dmg)
- macOS update metadata: [latest-mac.yml](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.4.0/latest-mac.yml)
- Linux: [Auraxis-3.4.0.AppImage](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.4.0/Auraxis-3.4.0.AppImage)
- Linux update metadata: [latest-linux.yml](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.4.0/latest-linux.yml)

## v3.3.0 (2026-09-14)

> Maintenance release: deep module decomposition, sandbox-safe preload bundling,
> documentation parity checks, and real-API acceptance hardening.

### Refactor & Maintainability

- Split the LLM adapter from protocol providers and added a pure `llm-types` layer.
- Split scheduler state, queue, queries, snapshots, lifecycle, cleanup and runner concerns.
- Split SQLite memory into schema, row mapping and memory/evidence/belief/audit domains.
- Split agent loop preparation/injection/interceptors and moved sub-agent registry/observer out of handlers.
- Split context truncation/summary and step-engine context/tool-result/tool-batch modules.
- Split renderer Agent/Session/Settings stores into helpers and action factories.
- Split preload IPC into domain modules and bundled them into one sandbox-safe `preload.js`.
- Added `vite.preload.config.mts`, preserved public compatibility exports, and updated structural tests.

### Fixes

- Synced `package-lock.json` with the vendored `image-size` stub (2.1.0) so a clean `npm ci`
  no longer resolves the vulnerable upstream version; `npm ls image-size` is clean.
- Refreshed security floors: `adm-zip` 0.6.1 (symlink extraction advisory) and transitive
  `js-yaml` 4.3.2 (merge-key CPU advisory); `npm audit --audit-level=high` reports 0 vulnerabilities.
- Extended the unit coverage gate to treat the split `preload*.ts` bridge modules like the
  previous monolithic `preload.ts` (verified by E2E / SDK smoke), and added branch tests for
  tool risk tiers, follow-up scheduling and the lint runner.
- `check-doc-stats` now tolerates ≤0.6pp platform coverage drift instead of failing on
  Windows-vs-Linux v8 differences, while still rejecting genuinely stale numbers.

### Validation

- 268 test files / 2,077 passing cases (platform-dependent skips excluded).
- Coverage: 89.44% statements / 91.85% lines / 80.87% branches / 88.09% functions.
- E2E 16/16, Electron smoke, TS SDK (7/7), Python SDK (7/7), live SDK smoke and dependency audit pass.
- DeepSeek V4 Flash live combo acceptance exercised file/search/web/session/skill/goal/task flows and verified a generated zero-dependency ESM + `node:test` project (13/13 tests); inline workflows stayed fail-closed by default.

### Release Artifacts

- Windows: [Auraxis.Setup.3.3.0.exe](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.3.0/Auraxis.Setup.3.3.0.exe)
- Windows blockmap: [Auraxis.Setup.3.3.0.exe.blockmap](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.3.0/Auraxis.Setup.3.3.0.exe.blockmap)
- Windows update metadata: [latest.yml](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.3.0/latest.yml)
- macOS (Apple Silicon): [Auraxis-3.3.0-arm64.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.3.0/Auraxis-3.3.0-arm64.dmg)
- macOS (Intel): [Auraxis-3.3.0.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.3.0/Auraxis-3.3.0.dmg)
- macOS update metadata: [latest-mac.yml](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.3.0/latest-mac.yml)
- Linux: [Auraxis-3.3.0.AppImage](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.3.0/Auraxis-3.3.0.AppImage)
- Linux update metadata: [latest-linux.yml](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.3.0/latest-linux.yml)

## v3.2.0 (2026-08-25)

> Feature release: official Feishu/Lark OpenAPI MCP, DeepSeek Harness MCP
> preset, MCP routing hardening, Windows shim reliability, and release
> engineering.

### Models

- Added `DeepSeek V4 Flash Vision Exp` (`deepseek-v4-flash-vision-exp`) as a
  first-class built-in experimental model with image understanding.
- Vision model accepts JPEG / PNG / GIF / WebP in `user` messages and routes
  `ReadImage` results through OpenAI-compatible image content blocks; non-vision
  DeepSeek models automatically degrade those attachments to text.
- Retained per-model context-window / max-output metadata and unified model
  resolution across Settings, IPC, and the model layer.

### MCP & Connectors

- Added official Feishu/Lark OpenAPI MCP preset (`@larksuiteoapi/lark-mcp`):
  one-click stdio setup, Feishu/Lark domain selection, lightweight / IM / full
  tool presets, and encrypted App ID / App Secret storage.
- Added Feishu/Lark credential configuration in Settings → Connectors,
  including a live `tenant_access_token` connectivity test.
- Added one-click DeepSeek Harness MCP preset with local Harness Web session
  support and automatic Auraxis DeepSeek key injection.
- Fixed MCP tool discovery/routing so tools are namespaced by server ID
  (`mcp__<serverId>__<toolName>`) instead of matching only by raw tool name.
- Added a self-contained Windows command-shim bridge so packaged MCP servers
  can launch `npx.cmd` reliably; the MCP initialize timeout is now 180s for
  first-run package downloads.

### Dependency, Refactor & CI

- Upgraded the major stack and fixed compatibility: React 18 → 19,
  Ant Design 5 → 6, Zustand 4 → 5, Electron 43 → 44, Vite 7 → 8,
  TypeScript 5 → 6, Vitest 3 → 4,
  Node target 20 → 22, KaTeX, PDFKit, jsdom, testing-library, and related
  typings.
- Migrated deprecated Ant Design props and Zustand shallow selectors; split
  large components into focused hooks / subcomponents; extracted agent log,
  scheduler, memory, workbench, composer, sidebar, inspector, settings, and
  timeline modules; removed remaining production `any` and hardened
  IPC / agent / store typings.
- Expanded the maintainability pass: split the LLM adapter/provider protocol
  layers, scheduler runtime/query/queue/lifecycle/cleanup, SQLite memory
  domains, context truncation/summary, step-engine tool context, sub-agent
  registry, renderer agent/session/settings stores, and preload IPC domains;
  preload sources stay modular while `vite.preload.config.mts` bundles them
  into one sandbox-safe `preload.js`.
- Fixed the SDK TypeScript module-resolution build, guarded real sandbox /
  AppContainer integration tests on GitHub runners, stabilized Ant Design
  portal teardown, updated E2E selectors for Ant Design 6, made the release
  matrix fail-fast off, and pinned the local safe `image-size` package so
  Windows / Linux packaging resolves it in clean CI installs.
- Recovered the login setup flow, locked account mutations, restored standard
  Windows `userData` (with legacy-cache migration), and accepted the Vite dev
  origin with a trailing slash so IPC trust validation no longer rejects local
  development.

### Quality

- Full check passes: 268 test files / 2,053 passing cases (+3 environment skips).
- Production smoke, SDK live runtime smoke, Electron IPC, skill seeding, and MCP handshake tests pass.
- DeepSeek V4 Flash live combo acceptance: headless agent exercised file/search/web/session/skill/goal/task flows and verified a generated zero-dependency ESM + `node:test` project (13/13 tests); inline workflows stayed fail-closed by default.
- Latest full branch coverage gate: 90.03% lines, 87.76% statements, 80.22% branches,
  82.20% functions; the gate covers all unit-testable Electron + stores/core code,
  while Electron main entry remains verified by real E2E and SDK smoke.
- Docs and changelog updated for the 3.2.0 release.

### Release Artifacts

- Windows: [Auraxis.Setup.3.2.0.exe](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.2.0/Auraxis.Setup.3.2.0.exe)
- Windows blockmap: [Auraxis.Setup.3.2.0.exe.blockmap](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.2.0/Auraxis.Setup.3.2.0.exe.blockmap)
- macOS Intel: [Auraxis-3.2.0.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.2.0/Auraxis-3.2.0.dmg)
- macOS Apple Silicon: [Auraxis-3.2.0-arm64.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.2.0/Auraxis-3.2.0-arm64.dmg)
- Linux: [Auraxis-3.2.0.AppImage](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.2.0/Auraxis-3.2.0.AppImage)

## v3.1.0 (2026-08-25)

> Engineering release: dependency supply-chain hardening, stricter runtime
> policy, unified DeepSeek endpoint configuration, and tooling/quality gates.

### Security & Reliability

- Replaced the vulnerable `image-size` transitive dependency with a local
  type-compatible safe stub (`vendor/image-size-safe`); `npm audit` reports 0
  vulnerabilities.
- Centralized CSP/network origins in `electron/network-policy.ts` and removed
  the production `connect-src https://*` wildcard.
- Centralized DeepSeek chat, Anthropic, models, balance, and search endpoints
  in `electron/api-config.ts`; all consumers now share one configuration path.
- MCP tool calls are now scoped to the requested server ID instead of matching
  a tool by name across every connected server.
- Tighter Electron build with Windows, macOS, and Linux E2E gates in CI.

### Quality & Maintainability

- Added ESLint 10, TypeScript ESLint, Prettier, and React Hooks linting;
  CI now runs `lint`, SDK build/tests, audit, and E2E.
- Enabled `noUnusedLocals` / `noUnusedParameters` across renderer, Electron,
  and TypeScript SDK projects; removed 130+ dead imports, variables, and
  duplicated compatibility shims.
- Made the IPC `secureHandle` wrapper strongly typed, removed duplicate local
  wrappers, and fixed React hook ordering/dependency warnings.
- Restored the missing code-block Apply/Preview actions and added the
  corresponding i18n labels.
- Fixed local auth: "remember me" is no longer persisted during account
  creation, so the first unlock always requires password verification; added
  a real-Electron register → login → restart persistence E2E.
- Fixed dev-mode IPC trust validation: Vite's `http://localhost:5173/`
  (with trailing slash) is now accepted, preventing all IPC calls from being
  rejected as "Untrusted IPC sender".
- Fixed Windows userData corruption caused by relocating Chromium cache before
  Electron had resolved `userData`; the app now keeps account/settings in the
  standard Roaming profile and migrates legacy account files from Local cache.
- E2E suite expanded to 16/16 real-Electron flows (register/login is now part
  of the gate instead of relying only on store unit tests).
- Added API endpoint and network-policy regression tests, plus MCP server-ID
  scoping coverage.
- Quality gate: 244 test files / 1,784 passing cases (+3 environment skips);
  coverage 85.18% lines/statements, 78.85% branches, 87.78% functions.

## v3.0.1 (2026-08-20)

> Patch release: Aqua glass theme, wallpaper support, preset panel redesign, and sidebar fixes.

### Aqua Glass Theme

- **Aqua 玻璃模式**（设置 → 外观）：顶栏与左右侧栏悬浮为圆角玻璃卡片，中间主区域透明融入背景；模糊/磨砂强度随滑块实时联动；Windows 11 优先透出桌面 Acrylic，其余环境使用内置氛围底色
- **壁纸设置**：从本地选择图片作为玻璃背景，自动压缩为 1920px JPEG 持久化；设置页带缩略图预览与一键移除
- **输入框**：微透玻璃底色 + 专属环绕阴影，深浅色模式自适应
- **侧边栏打磨**：收起时滑出 + 淡出、完全归零（无外边距/阴影/模糊残留）；移除悬浮卡片多余边框与接触阴影细线
- **工具入口调整**：移除「工具」折叠按钮，技能 / 插件中心 / 定时任务直接常驻显示

### UI / Settings

- **执行档位与运行权限弹窗重设计**：260px 极简单行卡片，图标 + 标题 + 选中对勾，详细说明移入悬停提示
- **侧边栏透明化修复**：恢复透明类优先级，侧栏玻璃模式下主区与右侧面板保持实色
- 修复壁纸图片在 Electron CSP 下因 `blob:` 被拦截导致的「图片读取失败」（改用 `data:` URL 加载）

### Quality

- TypeScript 检查通过；前端测试 101 文件 / 485 用例全部通过

## v3.0.0 (2026-08-18)

> Major release since v2.0.0: Work-mode document collaboration, professional document skills, cloud connectors, provenance memory, research-driven modules, cache alignment, UI/visual-system overhaul, and large infrastructure upgrades.

### Product & Modes

- **Chat / Work / Code three modes**: three product forms under one unified ReAct engine; DeepSeek-style mode switcher; modes never pollute each other's state; each mode keeps its own thinking / web-search / autonomy-tier preference snapshot
- **Work-mode document collaboration**:
  - Clarify before starting by default: when a task is ambiguous, AskUser asks first (toggleable in Settings → Agent runtime)
  - Docs-only / non-code hard boundary: Write / Edit / Bash / PowerShell rewrites of code files are rejected; code is read-only
  - Execution autonomy tiers (plan / smart / full) + delivery approval flow
  - Project directory & local workspace integration, task board, execution flow view, Work sidebar
- **Code mode**: RunCode TypeScript programs orchestrate tools in a worker thread (8-way concurrent overlap, hard timeout, sub-calls re-enter the full permission pipeline); home quick cards rearranged into a 4-column grid; right workbench, inspector, snapshot, and diff views
- **Chat mode**: session event timeline, per-message ratings, attachment gallery / lightbox, image draft bar, conversation prefix continuation ("continue writing"), FIM completion, LLM-generated titles

### Documents & Cloud Connectors

- **ReadDocument / WriteDocument**: read and generate Word (.docx), Excel (.xlsx), PowerPoint (.pptx), PDF (.pdf)
  - Word read via mammoth / write via docx; Excel via SheetJS; PPT via PptxGenJS + XML text read; PDF read via pdf-parse, write via PDFKit with automatic CJK font embedding
- **5 built-in skills**: Word documents / Excel workbooks / PPT decks / PDF documents / cloud connectors
- **Cloud connectors**: Slack (SlackListChannels / SlackPostMessage), Google Drive (DriveList / DriveRead), Notion (NotionSearch / NotionCreatePage); tokens configured in Settings → Connectors and encrypted with safeStorage
- **Layered Instructions panel**: global / project-root / nested-folder AGENTS.md editing with the same precedence as the loader

### Memory & Research-Driven Modules

- **Eywa provenance memory (M1–M4)**: evidence before belief, immutable evidence, rule-based signals, hard-anchor validation, deterministic zero-LLM read path, belief audit / erasure with audit trails
- **MAP-Graph (M5)**: multi-agent shared-memory authorization, source trust, and risk gating
- **AGORA step-level compression**: inference-free whole-step keep/drop, never splits tool calls from results
- **SWE-Touch workspace drift detection**: targeted verification after users touch code
- **Oversight approval-fatigue guard**: inverted-U supervision; auto-approvals counted in fatigue statistics
- **AutoTool tool-inertia graph**: observation + prediction layer to reduce inference cost
- **Verifier-as-Gatekeeper skill gate**: pre-commit validation for skill admission
- **Cache alignment suite**: canonical history replay (RadixAttention client-side adaptation), stable block organization (Prompt Cache), dynamic content tailing (Cache-Aware Prompt Compression), byte-exact memory-block dedup

### Engine, Tools & Permissions

- **Unified step-engine**: chat and agents share one ReAct stepping loop with strategy hooks; stop policy, compaction, retry, and quality gates converge
- **Tools 63 → 71**: added ReadDocument / WriteDocument / SlackListChannels / SlackPostMessage / DriveList / DriveRead / NotionSearch / NotionCreatePage; fixed the tool-registry total cap
- **Permissions**: four runtime presets (confirm each time / auto-approve / full access / read-only), named permission profiles (file & network scopes), native sandbox gates (Windows restricted token / AppContainer, Linux, macOS), read-before-write observation gate, file-level undo
- **Multi-agent scheduling**: priority queue, concurrency control, pause/resume, sub-agents (3-level recursion), plan approval, goal mode, background and scheduled tasks (Cron / Schedule)
- **Terminal**: dockable terminal drawer, Terminal\* six-pack, persistent PTY sessions, SSH (key auth), background command tasks
- **MCP client, plugin system (install/enable/uninstall), TS & Python SDKs, ACP service, headless CLI**
- **Session system**: unified JSONL event stream + SQLite projection cache + FTS5 search + session fork/export/delete
- **DeepSeek official capabilities**: reasoning effort low/high/max, strict tools, plan-generation JSON mode, streaming usage & cache-hit display, user_id isolation, max output tokens up to 384K, official offline tokenizer

### Account, Settings & UI

- **Local account system**: first-run registration → login gate → logout / password change; password stored only as scrypt hash; avatar upload; DeepSeek API key can be filled during registration
- **Settings rebuild**: account, custom models, connectors, layered instructions, MCP, plugins, permission profiles, rule files, Actions, Workflows, statistics, and live test-coverage report
- **UI/visual-system overhaul**: six corner radii, icon size & stroke specs, transparent button/icon backgrounds, sidebar transparency (Windows 11 Acrylic), redesigned search / permission / workbench panels, top mode-switch rail, sidebar collapse animations, floating chat header & input dock

### Quality & Release

- Unit tests: 237 test files / 1,740 cases passing (+3 environment-skips)
- Coverage: 85.42% lines / 79.08% branches / 86.63% functions
- E2E (real Electron via Playwright): 15/15 passing
- Stress: 200-session cold start ~1.4s; 18/30 agents all completed; no stalls at the default 3-concurrency setting
- Artifacts: Windows NSIS installer (x64) + blockmap + latest.yml, tag v3.0.0

## v2.0.0 (2026-08-15)

> First official major release: the full baseline of the desktop agentic workbench.

### Core Engine

- **Unified ReAct step engine**: `query-engine` + `step-engine` drive both chat and agents with streaming, retries, stop policy, and context compaction
- **Multi-agent scheduling**: AgentScheduler priority queue, concurrency control, pause/resume; Explore / Plan / general-purpose agent types; sub-agents (3-level recursion); plan generation & approval
- **Code Mode**: `RunCode` TypeScript programs orchestrate tools in a worker thread with sub-calls through the full permission pipeline (8-way concurrent overlap, hard timeout)
- **Tool system (63)**: Bash / Read / Write / Edit / Delete / Grep / Glob / WebSearch / WebFetch, Terminal\* six-pack, persistent PTY, LSP, NotebookEdit, Cron / Schedule, GitCommit, RunWorkflow, SessionQuery, ReadImage, EnterWorktree, ReviewArtifact, and more

### Capabilities & Infrastructure

- **Permissions**: ask / plan / auto policies, rules (once/session/always), native sandbox (Windows restricted token / AppContainer, Linux, macOS), read-before-write gate, file-level undo
- **MCP protocol client**: server config, connection status, tool discovery & invocation
- **Plugin system**: install / enable / disable with built-in example plugins (timestamp / uuid)
- **Public SDKs**: TypeScript SDK (TCP JSON-RPC) and Python SDK
- **Headless CLI & ACP**: `--run` headless tasks, `--plugin` management, ACP stdio service
- **Persistence**: unified JSONL event logs, SQLite projection cache, FTS5 full-text search, long-term memory (better-sqlite3 with JSON fallback)
- **Terminal & remote**: dockable terminal drawer, persistent PTY, SSH (key auth), background / scheduled tasks
- **Image input**: ReadImage + content-addressed attachments, OpenAI / Anthropic multimodal blocks, text fallback for non-vision models
- **Web search providers**: DuckDuckGo / Exa / Perplexity / DeepSeek native search

### Desktop Experience

- **Appearance**: dark / light / system themes, Chinese & English UI, Windows 11 Acrylic sidebar transparency, live test-coverage report in Settings
- **Sessions**: LLM titles, per-message ratings, attachment gallery / lightbox, image draft bar
- **Statistics**: ECharts activity heatmap (brand palette / theme-aware / activity summary)
- **Stability**: hidden action icons while streaming, unified bubble timestamps, queued continuation sends; terminal tests inject a controllable PTY, sandbox OS cases cross-platform, three-platform CI stabilized

### Quality

- Unit tests + Playwright E2E covering startup, mode switching, messaging, quick cards, and theme settings
- Artifacts: Windows NSIS / macOS DMG (x64 + arm64) / Linux AppImage

## v1.3.0 (DeepFlow Predecessor)

DeepFlow v1.3.0 is the predecessor of Auraxis: Electron 33 + React 18 + TypeScript 5.5 + Vite 5, with a ReAct agent loop, multi-agent scheduling, plugin extensibility, persistent project memory, React Flow graph workflow visualization, structured tool output cards, and the ReviewArtifact quality gate.

### Release Artifacts

- Windows: [DeepFlow.Setup.1.3.0.exe](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.3.0/DeepFlow.Setup.1.3.0.exe)
- macOS (Intel): [DeepFlow-1.3.0.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.3.0/DeepFlow-1.3.0.dmg)
- macOS (Apple Silicon): [DeepFlow-1.3.0-arm64.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.3.0/DeepFlow-1.3.0-arm64.dmg)
- Linux: [DeepFlow-1.3.0.AppImage](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.3.0/DeepFlow-1.3.0.AppImage)

## v1.2.0 (DeepFlow Predecessor)

DeepFlow v1.2.0 is a historical version of DeepFlow, the predecessor of Auraxis (2026-06-12).

### Release Artifacts

- Windows: [DeepFlow.Setup.1.2.0.exe](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.2.0/DeepFlow.Setup.1.2.0.exe)
- macOS (Intel): [DeepFlow-1.2.0.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.2.0/DeepFlow-1.2.0.dmg)
- macOS (Apple Silicon): [DeepFlow-1.2.0-arm64.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.2.0/DeepFlow-1.2.0-arm64.dmg)
- Linux: [DeepFlow-1.2.0.AppImage](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.2.0/DeepFlow-1.2.0.AppImage)

## v1.1.1 (DeepFlow Predecessor)

DeepFlow v1.1.1 is a historical version of DeepFlow, the predecessor of Auraxis (2026-06-11).

### Release Artifacts

- Windows: [DeepFlow.Setup.1.1.1.exe](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.1.1/DeepFlow.Setup.1.1.1.exe)
- macOS (Intel): [DeepFlow-1.1.1.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.1.1/DeepFlow-1.1.1.dmg)
- macOS (Apple Silicon): [DeepFlow-1.1.1-arm64.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.1.1/DeepFlow-1.1.1-arm64.dmg)
- Linux: [DeepFlow-1.1.1.AppImage](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.1.1/DeepFlow-1.1.1.AppImage)

## v1.1.0 (DeepFlow Predecessor)

DeepFlow v1.1.0 is a historical version of DeepFlow, the predecessor of Auraxis (2026-06-10).

### Release Artifacts

- Windows: [DeepFlow.Setup.1.1.0.exe](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.1.0/DeepFlow.Setup.1.1.0.exe)
- macOS (Intel): [DeepFlow-1.1.0.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.1.0/DeepFlow-1.1.0.dmg)
- macOS (Apple Silicon): [DeepFlow-1.1.0-arm64.dmg](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.1.0/DeepFlow-1.1.0-arm64.dmg)
- Linux: [DeepFlow-1.1.0.AppImage](https://github.com/yth1120/Auraxis-Agent/releases/download/deepflow-1.1.0/DeepFlow-1.1.0.AppImage)
