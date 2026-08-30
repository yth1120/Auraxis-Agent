# Auraxis Changelog

## v3.3.0 (2026-08-30)

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

### Validation

- 268 test files / 2,053 passing cases (+3 environment skips).
- Coverage: 87.73% statements / 90.00% lines / 80.13% branches / 82.20% functions.
- E2E 16/16, Electron smoke, TS SDK (7/7), Python SDK (7/7), live SDK smoke and dependency audit pass.
- DeepSeek V4 Flash live combo acceptance exercised file/search/web/session/skill/goal/task flows and verified a generated zero-dependency ESM + `node:test` project (13/13 tests); inline workflows stayed fail-closed by default.

### Release Artifacts

- Windows: [Auraxis.Setup.3.3.0.exe](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.3.0/Auraxis.Setup.3.3.0.exe)
- Windows blockmap: [Auraxis.Setup.3.3.0.exe.blockmap](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.3.0/Auraxis.Setup.3.3.0.exe.blockmap)
- Windows update metadata: [latest.yml](https://github.com/yth1120/Auraxis-Agent/releases/download/v3.3.0/latest.yml)

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
