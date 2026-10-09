<img width="3078" height="1376" alt="" src="https://github.com/user-attachments/assets/cc06146b-51a2-4b2e-a6c4-41aca0a0fb5e" />

# Auraxis Architecture & Development Documentation

Related docs: [TS SDK](../packages/auraxis-sdk/README.md) · [Python SDK](../python/auraxis_sdk/README.md) · [Engineering conventions](../AGENTS.md) · [中文版](README.zh-CN.md)

## 1. Project Overview

Auraxis v3.5.0 is an Electron-based desktop agentic workbench that combines a unified ReAct step engine, multi-agent scheduling, Code Mode tool orchestration, plugin extensibility, and persistent project memory. Execution semantics follow the common convention (`end_turn` ends the turn — no scripts or forced gates), and ReviewArtifact is an optional verification tool. The backend LLM defaults to the DeepSeek API (OpenAI / Anthropic compatible formats). Web search defaults to DeepSeek's native search (falling back to DuckDuckGo, with Exa and Perplexity also supported). Official DeepSeek capabilities are integrated: reasoning effort low/high/max, strict tools (Beta), plan-generation JSON mode, conversation prefix continuation ("continue writing" from a code block), FIM completion (Beta) API, streaming usage with context-cache hit display, user_id isolation, configurable max output tokens (up to 384K), and local offline tokenizer counting.

The project follows **paper-driven development**: 7 arXiv papers' core techniques — Eywa (provenance-grounded long-term memory), MAP-Graph (multi-agent shared-memory authorization), AGORA (step-level context compression), SWE-Touch (workspace drift detection), Oversight Has a Capacity (approval fatigue guard), AutoTool (tool usage inertia), Verifier-as-Gatekeeper (skill pollution gating); plus 4 caching-oriented techniques — RadixAttention (canonical history replay / shared-prefix maximization), Prompt Cache (stable block organization), Cache-Aware Prompt Compression (dynamic content tailing), and Byte-Exact Deduplication (byte-exact dedup of memory blocks). Paper links, technical mappings, and landing modules are detailed in [Section 5](#5-research-papers--technical-implementation). Product-side additions include local account login, Chat / Work / Code modes, thinking and web-search toggles, Agent execution flow views, session event timelines, and context-cache alignment.

- **Main process**: Electron main process (`electron/`) — window management, IPC communication, tool execution, agent scheduling
- **Renderer**: React 19 + Vite 8 (`src/`) — UI rendering, state management, user interaction
- **IPC**: bidirectional communication via Electron IPC (`contextBridge` + `ipcMain/ipcRenderer`)

### 1.1 v3.5.0 Release Highlights

- **Eval regression gate**: the eval harness finally has teeth. `eval:diff`
  turns "did this change make anything worse" into an exit code (per-case,
  per-check, process thresholds, verification level, and token sums on shared
  cases), and refuses to compare — with a stated reason — when the two runs are
  not comparable (schema version, dry vs live, missing or drifted tool-schema
  fingerprint) instead of reporting a false all-clear. `evals/baseline/` is
  frozen in-repo with machine paths and trajectories projected out; CI also runs
  the key-free `agent-eval --dry` and a schema-fingerprint check.
- **Fixed a real dynamic-tool-loading regression**: `selectToolsForTask` kept
  only the learned core set plus matched groups, and `mcp__<server>__<tool>`
  names matched no group regex and landed in `misc` — a bucket that is never
  selected. Installed MCP servers were therefore invisible to the agent. Unknown
  origins are now kept by an explicit preserve-set (mutation-verified by test).
- **Agent Activity View**: consecutive completed same-kind operations aggregate
  (`Read 4 files`, `Searched 3 times · 14 hits`, `Ran 3 commands`) while running,
  failed, cancelled and diff-bearing steps keep their own row; the oldest
  segments fold only after the run ends. Streaming terminal tail (8KB / 200 lines,
  split on line boundaries, ANSI intact), a real plan card built from `TodoWrite`,
  permission approval inline in the run row, a "new activity" pill instead of
  forced scrolling, row-level copy / terminal / view-diff actions, and a dispatch
  registry that turns a missing renderer into a compile error.
- **UI quality pass, driven by evidence rather than taste**: ~178 utility classes
  that never generated any CSS were restored (so "muted" text had been rendering
  at full contrast and hairlines as solid near-black rules); success / warning /
  danger were retuned to WCAG AA; four Ant Design 6 selector overrides that had
  silently stopped matching were fixed and two that targeted classes the library
  no longer renders were removed; 40+ dead i18n keys were dropped in both
  languages; and the token documentation was aligned with what actually ships
  (`tokens.css` wins over the `@theme` block, so five values there were lies).
- **Right workbench panel redesigned**: list → detail two-state navigation with a
  per-module `+` (add an entry to _that_ module, not another pane), fullscreen and
  split controls in the detail header, Artifacts merged into Changes (same file
  set, richer diff), the duplicate fifth agent list removed, and all seven rows
  carrying a shortcut hint that is cross-guarded against the global binding table
  by a test.
- **Sign-in / sign-up rebuilt around the brand artwork**: a full-bleed dark
  backdrop (anchored left so the mark is never cropped) with a glass form card,
  a sliding sign-in / sign-up segment reusing the app's radiogroup control, and
  the registration form split into Account / Model-access sections. The layer is
  deliberately dark-only — it scopes the dark palette and swaps in antd's
  `darkTheme` locally, so a light-theme user never gets white inputs on a black
  card — and introduces no new colour values (everything is `color-mix` over
  `tokens.css`).
- **Brand execution indicator**: the raster loading GIF is gone, replaced by an
  SVG/CSS "Axis Mark" (tilted aura ring plus an orbiting comet dash, normalised
  with `pathLength=100`) that also respects `prefers-reduced-motion` — which a
  bitmap cannot do.
- **Sessions**: archive / unarchive persists through the session-meta contract and
  is mirrored in the projection cache (`PROJECTION_VERSION` 3), so re-projection at
  startup no longer un-archives a session.
- **Sandbox**: launch failures stay fail-closed — the command is refused, never
  degraded to an unsandboxed run. The AppContainer backend documents a real OS
  limitation found while verifying it: a containerized `cmd.exe` cannot spawn an
  external executable (`0xC0000142`), while direct container launches and cmd
  built-ins work.
- **Quality gates**: 325 test files / 2,739 passing cases (platform-dependent
  skips excluded), SDK build, SDK live smoke, E2E, audit, and three-platform release CI.

### Tech Stack

<img width="1198" height="776" alt="auraxis-ui" src="https://github.com/user-attachments/assets/88f118c2-fc15-4779-8be3-928cb9c04ae8" />

| Layer               | Technology                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop framework   | Electron 44 (Node 24, built-in `node:sqlite`), frameless window, `contextIsolation: true`                                                                                       |
| Frontend            | React 19 + TypeScript 6 + Vite 8                                                                                                                                                |
| UI components       | Ant Design 6 with custom dark / light themes                                                                                                                                    |
| State management    | Zustand 5; session/settings/plugin state is authoritative in the main process, localStorage is only a renderer cache                                                            |
| Storage & retrieval | Unified JSONL event logs for sessions/agents + SQLite projection cache + FTS5 full-text search + long-term memory (node:sqlite first / better-sqlite3 fallback / JSON fallback) |
| Markdown rendering  | react-markdown + remark-gfm + remark-math + rehype-katex + highlight.js + mermaid                                                                                               |
| AI API              | axios (SSE streaming), DeepSeek / OpenAI and Anthropic formats; MCP, AGENTS.md, and lifecycle hooks protocols                                                                   |
| Testing             | Vitest + @testing-library/react + jsdom (renderer), node environment (main process)                                                                                             |
| Build               | Vite + electron-builder 26 (NSIS / DMG / AppImage; `npmRebuild: false` skips native rebuilds, better-sqlite3 falls back to JSON when missing)                                   |

### Infrastructure

- **Headless CLI**: `npm run cli -- --run "<task>"` (model / project / permission / sandbox / JSON output), plus `--sdk` / `--acp` / `--plugin list|scan|enable|disable`
- **Public SDKs**: TypeScript (`packages/auraxis-sdk`, TCP JSON-RPC) and Python (`python/auraxis_sdk`)
- **Code Mode**: `RunCode` TypeScript programs orchestrate tools in a worker thread via `await tools.Name(args)`; sub-calls re-enter the full permission pipeline (8-way concurrent overlap, hard timeout)
- **Image input**: `ReadImage` + content-addressed attachment storage; multimodal results auto-convert to OpenAI `image_url` / Anthropic `image` blocks; `deepseek-v4-flash-vision-exp` receives image blocks while non-vision DeepSeek models degrade to text
- **Background tasks**: `Task*` / `Job*` unify background bash, terminal tasks, and sub-agents; `Schedule*` supports after / at / every in-session follow-ups
- **Terminal**: dockable terminal drawer + `Terminal*` six-pack model tools + persistent PTY sessions + SSH
- **Native sandbox**: Windows restricted token / AppContainer, Linux, macOS backends + worktree isolation + read-before-write observation hard gate
- **Workflow isolation**: model orchestration scripts run in a worker thread with hard kill on timeout
- **Work document collaboration**: clarify-before-start (AskUser) by default + docs-only / non-code hard boundary; layered Instructions (global → project root → nested folder AGENTS.md) editable from Settings
- **Professional document skills**: `ReadDocument` / `WriteDocument` / `IngestDocument` (chunks a long document into project memory) for Word (.docx), Excel (.xlsx), PPT (.pptx), PDF (.pdf); 5 built-in skills (Word / Excel / PPT / PDF / cloud connectors)
- **Cloud connectors**: Slack (list channels / post messages), Google Drive (search / read), Notion (search / create pages); tokens encrypted with safeStorage, configured in Settings → Connectors
- **Session titles**: LLM-generated with rule fallback; **per-message ratings**, **attachment gallery / lightbox**, **image draft bar**
- **Appearance**: theme mode (system / light / dark), Chinese & English UI, sidebar transparency (native Windows 11 Acrylic); Settings includes a live test-coverage report (`coverage/coverage-summary.json`)
- **Login & account**: local-first account (password stored only as scrypt hash), first-run registration → login gate → avatar upload; registration never auto-unlocks, and "remember me" takes effect only after a successful login; DeepSeek API key can be filled during registration or configured later in Settings
- **Research-driven modules**: AGORA step compression, SWE-Touch workspace drift, Oversight approval fatigue, AutoTool tool inertia, VaG skill gating — consumed internally by step-engine / agent-loop / tool-runner
- **Telemetry**: opt-in (`AURAXIS_TELEMETRY_MODE`), strictly whitelisted and sanitized, NDJSON reporting

---

## 2. Process Model & Directory Structure

### 2.1 Two-Process Architecture

```
┌─ Electron main process (electron/) ────────────────────────┐      ┌─ renderer process (src/) ────────────────┐
│ main.ts         window / CSP / single-instance lock      │      │ main.tsx → App.tsx                     │
│ preload*.ts     contextBridge API (split by domain)      │ ◄──► │ React 19 + Ant Design 6                │
│ ipc/index.ts    46 register* wiring points               │  IPC │ Zustand stores (18)                    │
│ ipc/            host layer: query / scheduler / tools    │      │ src/core/         plugins / skills     │
│ agent-runtime/  pure engine: loop / step-engine / LLM /  │      │ src/components/   chat·input·layout    │
│                 context-manager / tool-runner            │      │                   agent·work·preview   │
│ tool-defs/      71 built-in tool definitions             │      │ @/ alias          → src/               │
│ servers         sdk-server / acp-server / headless       │      │                                        │
└──────────────────────────────────────────────────────────┘      └────────────────────────────────────────┘
```

**Engine boundary**: `electron/agent-runtime/` is the pure engine (loop / step-engine / LLM adapters / context-manager / tool-runner / step-compressor) and **must not** take **value** dependencies on `electron/ipc/**` (`import type` is allowed). Host capabilities (windows, storage, settings, memory, permissions) are injected through the `RuntimePorts` interface in `agent-runtime/ports.ts`, wired up in `electron/ipc/runtime-ports.ts` and shared by the desktop app, the headless CLI, and tests. Guard: `npm run check:runtime-boundary` (blocks CI).

### 2.2 Directory Structure

```
Auraxis/
├── electron/                    # Main-process code (Node.js)
│   ├── main.ts                  # App entry: window, CSP, single-instance lock, startup maintenance
│   ├── preload.ts               # contextBridge bootstrap (real bridges live in the domain modules below)
│   ├── preload-{platform,core,ai,rest,shared}.ts # IPC bridges split by domain
│   ├── preload-api.ts           # IPC bridge composition
│   ├── vite.preload.config.mts  # Sandbox-safe preload bundle (repo root)
│   ├── contracts/               # Single source of truth for cross-process types
│   │   └── core / tools / advanced / session-types / auth / permission / project / update
│   ├── types.ts / advanced-defs.ts # Compatibility re-exports (real types live in contracts/)
│   ├── tool-defs.ts             # Aggregation entry for built-in tool definitions
│   ├── tool-defs/               # 71 AI tool definitions (name, description, input schema)
│   │   └── core / files / network / planning / scheduling / workflows / devtools /
│   │       documents / integrations / terminal / runtime / types
│   ├── tool-capability.ts       # Single matrix of tool side effects (dangerous/read/write/terminal/code/Work blocks)
│   ├── tool-risk.ts             # Tool risk levels
│   ├── tool-registry.ts         # Tool-source assembly and batch execution (builtin / MCP / plugin)
│   ├── tool-provider.ts         # Unified ToolProvider abstraction (neutral leaf, no electron dependency)
│   ├── permission-profile.ts    # Permission profiles (standard / readonly / sandbox / custom)
│   ├── agent-runtime/           # Pure engine: no value deps on ipc/ (host powers via ports.ts)
│   │   ├── step-engine.ts       # Unified ReAct stepping (step-engine-{contracts,context,tools,tool-results}.ts)
│   │   ├── agent-loop.ts        # Agent driver facade (-driver / -core / -planner / -context / -stop /
│   │   │                        #   -inject / -interceptors / -messages / -prepare / -planning / -utils / -types)
│   │   ├── context-manager.ts   # Context management (-compact / -snapshot / -summary / -utils / -types)
│   │   ├── llm-adapter.ts       # LLM adapters (llm-provider-{openai,anthropic,responses,format}.ts,
│   │   │                        #   llm-streams.ts, llm-types.ts)
│   │   ├── llm-adapter-ai-sdk.ts # AI SDK 6 shadow adapter (off by default, zero load at registration)
│   │   ├── tool-runner.ts       # Tool execution orchestration (+ tool-result-prune.ts)
│   │   ├── step-compressor.ts   # AGORA step-level compression
│   │   ├── text-filter.ts       # Model-output stripping (thinking tags, zero-width chars)
│   │   └── engine-events.ts / ports.ts # Event contracts and host-capability ports
│   ├── ipc/                     # Host layer: IPC handlers and orchestration
│   │   ├── index.ts             # registerIpcHandlers() entry (46 register* wiring points)
│   │   ├── ai-handlers.ts (+ -stream / -utils) # Chat stream, FIM, connection test
│   │   ├── query-engine.ts      # Work/Code query driver (loop delegated to step-engine)
│   │   ├── query-context.ts     # Canonical context snapshots (cache-aligned replay / memory dedup / tombstones)
│   │   ├── agent-handlers.ts    # Sub-agent runner + IPC registration (roles in agent-defs.ts)
│   │   ├── agent-defs.ts        # Built-in agent roles (Explore / Plan / general-purpose)
│   │   ├── agent-subagent-registry.ts # Sub-agent registry and observers
│   │   ├── agent-scheduler*.ts  # Scheduler: -class-impl / -permission / -support / -types /
│   │   │                        #   -runtime / -snapshot / -query / -queue / -lifecycle / -runner / -cleanup
│   │   ├── agent-iteration-budget.ts # Iteration budget resolution (request → settings → 200, clamped 1–500)
│   │   ├── tool-handlers.ts     # Tool execution facade (registry/pipeline live in tool-handlers/)
│   │   ├── tool-handlers/       # registry / pipeline / internal / bash / file-tools / network /
│   │   │                        #   terminal / integrations / agents / session / runtime / worktree /
│   │   │                        #   lsp / review / execution / backup / path-utils / executor-port /
│   │   │                        #   abort-registry / task-cache
│   │   ├── memory-*.ts          # Provenance memory: db / db-sqlite-* / evidence / extractor / read /
│   │   │                        #   graph / ipc / signal-rules / signal-llm / belief-validation
│   │   ├── permission-handlers.ts / path-security.ts / trust.ts # Permissions, path bounds, sender checks
│   │   ├── mcp-handlers.ts      # MCP client policy layer (official SDK transport, tool discovery, safety validation)
│   │   ├── model-config.ts      # Model resolution (built-in + env + persisted)
│   │   ├── settings-store.ts    # Encrypted settings (API keys via safeStorage)
│   │   ├── conflict-detector.ts # File locks preventing concurrent agent writes
│   │   ├── undo-manager.ts      # File-level undo (snapshots + restore + best checkpoint)
│   │   ├── plan-handlers.ts / goal-handlers.ts / cron-handlers.ts # Plan approval, goals, cron
│   │   ├── session-log-handlers.ts / chat-log-handlers.ts / title-handlers.ts # Event logs and titles
│   │   ├── terminal-handlers.ts / task-monitor.ts / shell-executor.ts / pty-tool.ts # Terminal and background jobs
│   │   ├── update-handlers.ts   # Auto-update IPC
│   │   ├── runtime-ports.ts     # RuntimePorts wiring (desktop / headless CLI / tests)
│   │   └── __tests__/           # IPC-layer tests (138 files)
│   ├── utils/                   # guards.ts / token-counter.ts
│   ├── tokenizer/               # Official offline tokenizer vocabulary (tokenizer.json)
│   ├── __tests__/               # Main-process module tests (27 files)
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
├── src/                         # Renderer code (browser environment)
│   ├── main.tsx                 # React entry
│   ├── App.tsx                  # Root component: layout, theme, permission dialogs, command palette
│   ├── components/              # UI components
│   │   ├── layout/ (36)         # Sidebar, top bar, right panel, navigation, preview browser
│   │   ├── input/ (25)          # Input dock, thinking-depth slider, mode toggler
│   │   ├── settings/ (20)       # Settings panes (incl. AccountPane)
│   │   ├── chat/ (16)           # Message list, bubbles, Markdown renderer, tool timeline
│   │   ├── inspector/ (15)      # Execution detail, context manifest, timeline
│   │   ├── common/ (16)         # Shared components and the lucide icon shim
│   │   ├── agent/ (11)          # Agent management panel + execution flow view
│   │   ├── work/ (8)            # Work-mode board + execution flow view
│   │   ├── tools/ (6) / memory/ (3) / auth/ (2) / permissions/ (2) / skills/ (1) / preview/ (1)
│   ├── stores/                  # Zustand state (18 stores + helpers in the same directory)
│   │   ├── useChatStore.ts      # Chat messages, streaming, retry, project context, memory injection
│   │   ├── useAuthStore.ts      # Login state, account info, avatar
│   │   ├── useSettingsStore.ts  # API key, default model, notifications
│   │   ├── useAppStore.ts       # Theme, sidebar, right panel, navigation history
│   │   ├── useAgentStore.ts     # Agent CRUD, priority, concurrency (subscribes to agent:event, RAF-throttled)
│   │   ├── useSessionStore.ts   # Session save/load/delete/export/fork (up to 200)
│   │   ├── useProjectStore.ts   # Project registry, current project, workspace ordering
│   │   ├── usePluginStore.ts    # Installed plugins, enabled state
│   │   ├── useMemoryStore.ts    # Active/search memories (loaded from the main process)
│   │   ├── useFileTreeStore.ts  # File tree, expanded paths
│   │   ├── useUndoStore.ts      # Undo entries
│   │   ├── useInspectorStore.ts # Plan, system messages, active tool count (data layer)
│   │   ├── useWorktreeStore.ts  # Worktree sandbox state (active / sandbox path)
│   │   ├── useAdvancedStore.ts  # MCP servers, permission rules
│   │   ├── useTerminalTasksStore.ts / useNotificationStore.ts / useMessageFeedbackStore.ts
│   │   ├── useKeybindingsStore.ts # Keybinding overrides
│   │   └── helpers: chatStoreHelpers / chatSendMessage / chatStreamRuntime / chatActions /
│   │       chatContinueCode / chatRuntime / chatSendEvents / chatStoreSideEffects /
│   │       chatPlanListener / agentStore{Helpers,Actions,Buffers,Events} /
│   │       sessionStore{Helpers,Actions,Types} / sessionModeSwitch /
│   │       settingsStore{Actions,Types} / debouncedStorage
│   ├── core/                    # Plugins / skills / tool and command registries (plugin-manager,
│   │                            #   plugin-loader, tool-registry, command-registry, skills, agent-launch)
│   ├── services/                # ai-service.ts (browser fallback), replBridge.ts
│   ├── types/                   # Renderer types (advanced/agent are pure re-exports of contracts)
│   ├── i18n/                    # zh-CN / en-US strings
│   ├── utils/                   # 17 pure helpers (unifiedDiff, paths, time, slashCommands, …)
│   ├── hooks/                   # useAppRuntimeEffects / useAppShortcuts / useModels, 6 in total
│   ├── constants/               # Keybindings, extension colors
│   ├── plugins/                 # Built-in example plugins (example-timestamp / example-uuid)
│   ├── styles/                  # tokens.css / theme.ts and related styles
│   └── test/ + __tests__/       # Test setup and renderer cross-module guard tests
│
├── packages/                    # Public TypeScript SDK (TCP JSON-RPC)
├── python/                      # Public Python SDK
├── e2e/                         # Playwright end-to-end tests (real Electron)
├── .github/workflows/           # CI: three-platform builds, unit/coverage gates, docs and format checks, E2E, sandbox job
├── scripts/                     # Dev and gate scripts (check-docs / check-cycles / check-runtime-boundary /
│                                #   check-lint-budget / check-preload-bundle / sdk-smoke /
│                                #   smoke-electron / auraxis-mcp-preload / electron-dev)
├── docs/                        # README.md (English) / README.zh-CN.md (Chinese) / THIRD_PARTY_NOTICES.md
├── package.json
├── tsconfig.json                # Shared type check for renderer + main (ESNext/bundler, @/* → src/*)
├── tsconfig.node.json           # Vite config only (composite, standalone entry)
├── tsconfig.electron.json       # Main-process TS config (CommonJS → dist-electron/, rootDir: electron/)
├── vite.config.mts              # Vite build config
├── vite.preload.config.mts      # Sandbox-safe preload bundle config
├── vitest.config.mts            # Test config (thresholds: lines/statements/branches/functions ≥80%)
├── playwright.config.ts         # E2E config
├── electron-builder.yml         # Packaging config (NSIS/DMG/AppImage)
└── .env.example                 # Environment variable template
```

### 2.3 TypeScript Configuration Notes

There are three `tsconfig` files at the root (plus the SDK's own `packages/auraxis-sdk/tsconfig.json`):

- `tsconfig.json`: shared type check for the renderer and the main process (ESNext/bundler, `@/* → src/*`, `include: ["src", "electron"]`)
- `tsconfig.electron.json`: main-process compilation (`rootDir: "electron/"`, CommonJS output to `dist-electron/`)
- `tsconfig.node.json`: Vite config only (`composite: true`, standalone entry, nothing references it today)

Because `rootDir: "electron/"` prevents the main process from importing implementations from `src/`, **cross-process types are defined exactly once in `electron/contracts/`** (`core` / `tools` / `advanced` / `session-types` / `auth` / `permission` / `project` / `update`): `electron/types.ts`, `electron/advanced-defs.ts`, and the renderer's `src/types/{advanced,agent}.ts` only re-export them (`src/types/electron-api.ts`, `chat.ts`, `tools.ts` and friends are renderer-side projections and their own types, not mirrors of `contracts/`). New shared types must go into `contracts/`; do not copy them into `src/` again.

**Capability seams**: `SessionStore`, `ShellExecutor`, and `LlmAdapter` are the replaceable interfaces — swap implementations through the seam instead of editing consumers.
---

## 3. IPC Communication

### 3.1 Flow

```
Renderer (React)                    Main Process (Electron)
─────────────────                   ─────────────────
window.electronAPI.ai.sendQuery()
  → ipcRenderer.invoke()    ──→    ipcMain.handle('ai:sendQuery', ...)
                                      ↓
                                   query-engine.ts runs the ReAct loop
                                      ↓
                                   win.webContents.send('ai:queryEvent:${id}', ...)  // win resolved from event.sender
  ← ipcRenderer.on()        ←──        ↓
  → callback.onEvent(data)           (tool executions, text chunks, errors, …)
```

### 3.2 IPC Channel Naming

**Format**: `domain:action` (colon separator). Domains are a single lowercase segment, with camelCase for compound domains (`chatLog` / `sessionLog` / `sessionTitle` / `agentShell` / `pluginState`), and actions are camelCase; main→renderer events may use kebab-case (`window:maximize-changed`), and `terminal:tasks:*` is the one three-segment exception.

### 3.3 IPC Response Contract

Business-domain handlers return a unified shape (defined in `electron/contracts/core.ts`):

```typescript
interface IpcResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
```

Exceptions: the window-control handlers return bare values or nothing (`window:isMaximized` → boolean, `window:zoom` → number, `window:minimize` / `maximize` / `close` → void), as do `ai:abortStream` / `ai:abortQuery`.

### 3.4 Streaming

Streaming requests use **dedicated event channels**:

- Chat stream: `ai:chunk:${requestId}`
- Query stream: `ai:queryEvent:${requestId}`
- Agent events: `agent:event:${agentId}`

`ai:chunk:*` / `ai:queryEvent:*` register their listener when the request is created and clean up automatically on `done` / `error` or `abort`; `agent:event:${agentId}` registers when the event subscription is created, the subscription only returns an unsubscribe function, and the renderer releases it after the agent finishes.

### 3.5 Full IPC Channel Table

The table below lists **every** registered channel by domain: renderer→main are `invoke` channels (all wrapped by `secureHandle` in `electron/ipc/trust.ts`, which calls `ipcMain.handle` after validating the sender), and main→renderer are `webContents.send` event channels; `—` means the domain has no event channel. Regenerate the channel names with `grep -rho "secureHandle('[^']*'" electron`.

| Domain           | Renderer→main (invoke)                                                                                                                                                                                                                                                                                                          | Main→renderer (events)                                                        | Description                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **window**       | `window:minimize` / `window:maximize` / `window:close` / `window:focus` / `window:isMaximized` / `window:zoom` / `window:glassState` / `window:setBackgroundMaterial` / `window:backgroundMaterialSupported`                                                                                                                    | `window:maximize-changed`                                                     | Window controls, zoom and Windows 11 Acrylic material                           |
| **shell**        | `shell:openExternal` / `shell:openPath` / `shell:openInVSCode` / `shell:openFileInVSCode` / `shell:openSkillsDirectory`                                                                                                                                                                                                         | —                                                                             | Opening external links/paths and VS Code integration                            |
| **file**         | `file:open` / `file:read` / `file:readPreview` / `file:write` / `file:search` / `file:estimateTokens` / `file:delete` / `file:rename` / `file:createFolder` / `file:createFile`                                                                                                                                                 | —                                                                             | File read/write, preview, create/rename/delete, token estimates                 |
| **project**      | `project:getTree` / `project:applyCode` / `project:previewCode` / `project:selectDirectory` / `project:loadGlobalState` / `project:saveGlobalState`                                                                                                                                                                             | —                                                                             | Project tree, code apply/preview and global project state                       |
| **context**      | `context:getProjectContext` / `context:getFileStructure` / `context:readFile` / `context:compact`                                                                                                                                                                                                                               | —                                                                             | Project context, file structure and manual compaction                           |
| **ai**           | `ai:chatStream` / `ai:sendQuery` / `ai:testConnection` / `ai:fim` / `ai:abortStream` / `ai:abortQuery` / `ai:abortTool` / `ai:retryTool` / `ai:clearQueryContext`                                                                                                                                                               | `ai:chunk:${requestId}` / `ai:queryEvent:${requestId}`                        | Chat stream, Work/Code queries, FIM, aborts and snapshot invalidation           |
| **memory**       | `memory:extract` / `memory:getByProject` / `memory:getByType` / `memory:search` / `memory:archive` / `memory:delete` / `memory:evidenceList` / `memory:evidenceDetail` / `memory:readForQuery` / `memory:readTrace` / `memory:beliefAudit` / `memory:rejections` / `memory:erase` / `memory:reindex` / `memory:graph`           | —                                                                             | Memory CRUD, evidence/belief audits, deterministic retrieval, erasure (Eywa/M5) |
| **agent**        | `agent:start` / `agent:sendMessage` / `agent:continue` / `agent:pause` / `agent:resume` / `agent:schedulerStop` / `agent:schedulerRemove` / `agent:approveDelivery` / `agent:setPriority` / `agent:setMaxConcurrent` / `agent:getQueue` / `agent:getAll` / `agent:getState` / `agent:remove` / `agent:clear` / `agent:clearAll` | `agent:updated` / `agent:event:${agentId}` / `agent:message` / `agent:report` | Scheduler lifecycle, follow-ups, queue/concurrency, sub-agent messages          |
| **agentShell**   | `agentShell:attach` / `agentShell:detach` / `agentShell:write`                                                                                                                                                                                                                                                                  | —                                                                             | Attach, write to, and detach the agent terminal shell                           |
| **mcp**          | `mcp:getServers` / `mcp:setServers` / `mcp:connect` / `mcp:disconnect` / `mcp:getStatuses` / `mcp:listTools` / `mcp:callTool`                                                                                                                                                                                                   | —                                                                             | MCP server config, connections, tool discovery and calls                        |
| **permission**   | `permission:respond` / `permission:addRule` / `permission:removeRule` / `permission:getRules` / `permission:clearRules` / `permission:listProfiles` / `permission:listProjectProfiles` / `permission:setProjectProfile` / `permission:moveProjectProfile` / `permission:saveProfiles`                                           | `permission:request`                                                          | Permission responses, rules and permission-profile management                   |
| **plan**         | `plan:approve` / `plan:reject` / `plan:list`                                                                                                                                                                                                                                                                                    | `plan:generated`                                                              | Plan approval and plan listing                                                  |
| **undo**         | `undo:getHistory` / `undo:getList` / `undo:execute` / `undo:revert` / `undo:revertLast` / `undo:getSessionDiffs` / `undo:revertSessionFile` / `undo:revertSessions` / `undo:markBest` / `undo:restoreBest` / `undo:listBest`                                                                                                    | —                                                                             | Undo/restore, best checkpoints and session-level file rollback                  |
| **conflict**     | `conflict:getConflicts` / `conflict:getFileHistory`                                                                                                                                                                                                                                                                             | —                                                                             | Concurrent-write conflicts and file modification history                        |
| **snapshot**     | `snapshot:create` / `snapshot:list` / `snapshot:restore` / `snapshot:delete`                                                                                                                                                                                                                                                    | —                                                                             | Named snapshot management                                                       |
| **system**       | `system:getStats` / `system:getGitBranches` / `system:getVersion` / `system:getAccountInfo`                                                                                                                                                                                                                                     | —                                                                             | System stats, Git branches, version, DeepSeek balance (/user/balance)           |
| **settings**     | `settings:get` / `settings:set` (incl. permissionPreset / sandboxMode persistence) / `settings:getApiKeyStatus`                                                                                                                                                                                                                 | —                                                                             | Settings read/write and API-key status                                          |
| **api**          | `api:setKey`                                                                                                                                                                                                                                                                                                                    | —                                                                             | API key writes                                                                  |
| **coverage**     | `coverage:get`                                                                                                                                                                                                                                                                                                                  | —                                                                             | Reads the test coverage report (coverage/coverage-summary.json)                 |
| **auth**         | `auth:status` / `auth:setup` / `auth:login` / `auth:logout` / `auth:changePassword` / `auth:changeName` / `auth:setAvatar` / `auth:reset`                                                                                                                                                                                       | —                                                                             | Local account signup/login/password/name/avatar/reset                           |
| **model**        | `model:getAll`                                                                                                                                                                                                                                                                                                                  | —                                                                             | List available models                                                           |
| **app**          | —                                                                                                                                                                                                                                                                                                                               | `app:error`                                                                   | Uncaught exceptions / unhandled promise rejections                              |
| **cron**         | `cron:create` / `cron:delete` / `cron:list`                                                                                                                                                                                                                                                                                     | —                                                                             | In-app scheduled task create/delete/list                                        |
| **worktree**     | `worktree:getStatus`                                                                                                                                                                                                                                                                                                            | `worktree:changed`                                                            | Agent worktree sandbox state and activation events                              |
| **update**       | `update:getState` / `update:check` / `update:download` / `update:install`                                                                                                                                                                                                                                                       | `update:state`                                                                | Auto-update state machine (electron/updater.ts)                                 |
| **pluginState**  | `pluginState:get` / `pluginState:set`                                                                                                                                                                                                                                                                                           | —                                                                             | Plugin enabled-state read/write                                                 |
| **skills**       | `skills:list` / `skills:read`                                                                                                                                                                                                                                                                                                   | —                                                                             | Local skill listing and reading                                                 |
| **stats**        | `stats:get` / `stats:reset`                                                                                                                                                                                                                                                                                                     | —                                                                             | Runtime stats                                                                   |
| **workflow**     | `workflow:list` / `workflow:get` / `workflow:run` / `workflow:runs`                                                                                                                                                                                                                                                             | —                                                                             | Workflow listing and run history                                                |
| **fts**          | `fts:search` / `fts:rebuild`                                                                                                                                                                                                                                                                                                    | —                                                                             | Full-text search and index rebuild                                              |
| **chatLog**      | `chatLog:append` / `chatLog:read` / `chatLog:list` / `chatLog:project` / `chatLog:delete` / `chatLog:fork` / `chatLog:meta`                                                                                                                                                                                                     | —                                                                             | Chat JSONL event log read/write, projection and forking                         |
| **sessionLog**   | `sessionLog:read` / `sessionLog:project`                                                                                                                                                                                                                                                                                        | —                                                                             | Agent session log reading and projection                                        |
| **sessionTitle** | `sessionTitle:generate`                                                                                                                                                                                                                                                                                                         | —                                                                             | Session title generation (LLM with rule fallback)                               |
| **goal**         | `goal:get` / `goal:create` / `goal:edit` / `goal:pause` / `goal:resume` / `goal:complete` / `goal:block` / `goal:clear` / `goal:round`                                                                                                                                                                                          | —                                                                             | Durable goal lifecycle                                                          |
| **credentials**  | `credentials:describe` / `credentials:set` / `credentials:unset`                                                                                                                                                                                                                                                                | —                                                                             | Credential describe/set/unset                                                   |
| **connector**    | `connector:status` / `connector:setToken` / `connector:getLark` / `connector:setLark` / `connector:test`                                                                                                                                                                                                                        | —                                                                             | Cloud connector (Slack / Drive / Notion / Lark) state and tokens                |
| **instructions** | `instructions:getGlobal` / `instructions:setGlobal` / `instructions:listProject` / `instructions:get` / `instructions:set`                                                                                                                                                                                                      | —                                                                             | Layered Instructions (global/project) read/write                                |
| **actions**      | `actions:list`                                                                                                                                                                                                                                                                                                                  | —                                                                             | Available actions listing                                                       |
| **ask**          | `ask:respond`                                                                                                                                                                                                                                                                                                                   | `ask:request`                                                                 | AskUser question responses and requests                                         |
| **runtime**      | `runtime:syncPlugins`                                                                                                                                                                                                                                                                                                           | —                                                                             | Runtime plugin sync                                                             |
| **tokenizer**    | `tokenizer:count`                                                                                                                                                                                                                                                                                                               | —                                                                             | Official offline tokenizer counting                                             |
| **lint**         | `lint:fix`                                                                                                                                                                                                                                                                                                                      | —                                                                             | Lint checks and fixes                                                           |
| **ssh**          | `ssh:list` / `ssh:save` / `ssh:remove` / `ssh:test` / `ssh:exec`                                                                                                                                                                                                                                                                | —                                                                             | SSH configuration and remote execution                                          |
| **rules**        | `rules:list`                                                                                                                                                                                                                                                                                                                    | —                                                                             | Project rule file reading                                                       |
| **feedback**     | `feedback:submit` / `feedback:message` / `feedback:messageList`                                                                                                                                                                                                                                                                 | —                                                                             | Per-message ratings and feedback                                                |
| **terminal**     | `terminal:create` / `terminal:input` / `terminal:resize` / `terminal:kill` / `terminal:tasks:list` / `terminal:tasks:stop` / `terminal:tasks:clear`                                                                                                                                                                             | `terminal:event:${id}` / `terminal:tasks:changed`                             | PTY terminal sessions and background task monitoring                            |

> 205 invoke channels and 15 event channels in total. `ai:chunk:*` / `ai:queryEvent:*` / `agent:event:*` / `terminal:event:*` are built dynamically per request or session; everything else uses a fixed name.

---

## 4. AI Core System

### 4.1 Three Execution Paths

Auraxis has **three drivers, one loop**: every LLM step for the query engine and sub-agents is delegated to the unified `electron/agent-runtime/step-engine.ts` (retries, tool batching, stop policy, and compaction all converge there), and Code Mode reuses the same `executeToolCall` pipeline. The three drivers keep only their orchestration responsibilities (queries execute directly; agents add planning / approval / deviance detection / pause-resume; Code Mode orchestrates tools in a worker thread).

#### Path A: Work/Code Query (query-engine.ts)

Used for full ReAct queries in the Work / Code surfaces; plain chat conversations in Chat mode go through `ai:chatStream`, and the main process explicitly rejects queries with `surface === 'chat'`. Flow:

```
User input → runQuery() → (replay via tryReplayStoredContext() on snapshot hit, otherwise assemble with prepareCacheAlignedMessages())
    ↓
ReAct loop (business cap 200 default, configurable 1–500; safety hard cap 500):
    1. LLM call (llmClientInvoke, at most 2 retries — 3 attempts total — with exponential backoff 2s/4s; the fallback model takes over once the primary is exhausted)
    2. No tool calls → treated as complete (<FINAL_ANSWER> is the secondary confirmation signal) → stop
    3. Tool calls → executeToolCall() → structured summary → append results → back to 1
    4. Context compaction (triggers when estimated tokens exceed 90% of the 100K threshold, ≈90K)
    5. Stop policy evaluation (stopPolicyEvaluate)
    6. Emit iteration summary (toolsThisIteration, llmLatencyMs)
    ↓
Return result to chat UI
```

**Features**:

- **No planning phase**: runs the ReAct loop directly
- **API retries**: 429 / 5xx / network errors retry at most 2 times (3 attempts total) with exponential backoff 2s/4s; once the primary model is exhausted, the fallback model takes over
- **Context compaction**: LLM summary (`deepseek-flash`) first, falling back to a rule-based summary; triggers at 90% of the estimated-token threshold
- **Stop signals**: a text-only reply with no tool calls ends the turn, `<FINAL_ANSWER>` is the secondary confirmation signal; the query path sets no forced quality gate (ReviewArtifact is an optional verification tool)
- **Iteration budget**: resolved as request → `agentMaxIterations` setting → default 200, clamped to 1–500 (`electron/ipc/agent-iteration-budget.ts`); safety hard cap 500. Reaching the budget pauses the run gracefully
- **Structured summaries**: 9 tool outputs carry `summary` for typed frontend cards
- **Exposed via**: `ai:sendQuery` IPC

#### Path B: Sub-Agents (agent-loop.ts → agent-handlers.ts)

Used by sidebar agents and the `Agent` tool. Flow:

```
Agent created → task description
    ↓
Planning phase (optional):
    LLM generates a JSON task plan (TaskPlan) with dependencies
    ↓
Agent driver (agentLoopRun, steps delegated to step-engine):
    1. LLM call
    2. Tool execution (executeToolCall)
    3. Deviance detection (DevianceDetector, two levels):
       - the same plan task fails twice in a row → mark it blocked and suggest changing strategy
       - the model calls the Replan tool → LLM generates a new sub-plan for the remaining work
    4. Context management (ContextManager): threshold-based compaction
    5. Stop policy evaluation
    ↓
Return result
```

**Features**:

- **Full planning**: LLM generates structured JSON task plans (dependencies + keyword matching)
- **Plan approval**: in `plan` mode, waits for user approval (5-minute timeout); only approved steps execute
- **Quality verification (per path)**: the query path sets no forced quality gate; in the agent loop under the `auto` tier (without `autoApprove`), a ReviewArtifact result of `passed:false` raises the review gate, pausing the run until a human confirms (the full-access tier is exempt)
- **Deviance detection**: two levels (a plan task failing twice in a row → blocked; Replan → a new sub-plan)
- **Context management**: LLM summaries with rule-based fallback
- **New-project detection**: detects empty dirs / missing package.json and injects initialization guidance
- **Pause / resume**: full state capture (messages / plan / iteration / toolCallCount), auto re-queue at capacity
- **Continue after the budget**: sending any message in the composer resumes the same task (same transcript, no new task); the scheduler grants a fresh budget window bounded by the 500 hard cap, so a capped run never stops again on its first step. The composer placeholder names the target task while a follow-up is possible
- **Max recursion depth**: 3 (the Agent tool can nest sub-agents, recording parent-child links)
- **Exposed via**: `agent:start` IPC (creates sidebar agents through the scheduler; the legacy `agent:create` / `stop` / `list` / `get` channels have been removed) and the `runSubAgent()` function

#### Path C: Code Mode (code-mode.ts)

When `RunCode` runs with `language=typescript`, the program body executes in a worker thread; every `await tools.Name(args)` sub-call re-enters the full `executeToolCall` permission pipeline. Concurrency-safe tools overlap up to 8 ways, mutating tools run serially, and hard timeouts / aborts can terminate the worker. Only printed/returned content is sent back to the model. Code Mode is **disabled by default (fail-closed)**: it is available only in an unpackaged build with `AURAXIS_ALLOW_UNSAFE_CODE=1` explicitly set, and `RunCode` otherwise returns a disabled notice. Forked sub-agent backends (`Agent` with `backend=fork`) live in `fork-runner.ts` (one-shot headless child process).

### 4.2 System Prompt Construction

The system prompt is the static constant `STATIC_SYSTEM_PROMPT` in `electron/agent-runtime/context-manager.ts` (a cache-friendly stable prefix, assembled by `query-engine.ts` into the system message). It is immediately followed by a session preamble user message, and together they form the per-turn context:

- **Static system prompt**: tool capability declaration, skill conventions, working style (for modification tasks, explore on demand first with Read / Grep / Glob, then modify and verify) and key rules
- **Session preamble (user message)**: platform-aware shell hints (Windows → Git Bash, macOS/Linux → standard Unix), project root, deep-thinking note (`isDeepThink`) and the work guide
- **Task completion signal**: the `<FINAL_ANSWER>` marker in model output (case-insensitive, any position; it takes effect only when that turn made no tool calls)
- **Reasoning effort**: `isDeepThink` maps to both the `thinking.type` request parameter and `reasoning_effort`; on the prompt side it only appends "you are using deep-thinking mode"

### 4.3 Tool System

Tool definitions live in `electron/tool-defs/` (11 capability-family files; [`electron/tool-defs.ts`](../electron/tool-defs.ts) is just the aggregation entry point); **71 built-in tools** in total. All three sources (built-in / MCP / plugin) are assembled through the `ToolProvider` abstraction in `electron/tool-provider.ts`: `listAllToolDefs()` returns the model-visible list in registration order (truncated past 96), `resolveToolProvider()` decides who owns a tool name, and `executeViaProviders()` dispatches — the agent never needs to know where a tool comes from. The table below lists the core 24; the remaining 47 are grouped by capability family below it.

| #   | Tool               | Category  | Description                                                                                                                                            |
| --- | ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Bash**           | dangerous | Run shell commands in the project directory. Default timeout 600s (10 min), max also 600s. Windows supports Git Bash / cmd / PowerShell                |
| 2   | **Read**           | safe      | Read file content with line offset/limit and path traversal checks. Output includes `summary` (path, lines, size)                                      |
| 3   | **Write**          | dangerous | Create / overwrite files with extension whitelist, Windows reserved-name checks, undo backup. Output includes `summary` (path, bytes)                  |
| 4   | **Edit**           | dangerous | Find-and-replace in a file; match must be unique; undo backup before writing                                                                           |
| 5   | **Delete**         | dangerous | Delete files or directories (recursive requires confirmation), path traversal checks, undo backup                                                      |
| 6   | **Grep**           | safe      | Regex search (max depth 5, up to 50 results). Output includes `summary` (match count)                                                                  |
| 7   | **Glob**           | safe      | File pattern matching (max depth 6, up to 100 files). Output includes `summary` (match count)                                                          |
| 8   | **WebFetch**       | dangerous | Fetch URL content (15s timeout), blocks local / intranet addresses                                                                                     |
| 9   | **WebSearch**      | dangerous | DeepSeek native search by default (exa / perplexity configurable), auto-degrading to DuckDuckGo HTML (no key required) on failure                      |
| 10  | **TodoWrite**      | safe      | Task list management (pending / in_progress / completed); only one in_progress at a time                                                               |
| 11  | **Agent**          | dangerous | Start a sub-agent (Explore / Plan / general-purpose), recursion depth limit 3, records parent-child links                                              |
| 12  | **Replan**         | safe      | Generate a new sub-plan (agent loop only; the query engine skips it)                                                                                   |
| 13  | **CronCreate**     | dangerous | Create recurring / one-shot scheduled jobs (5-field cron), fired while the app runs                                                                    |
| 14  | **CronDelete**     | dangerous | Cancel a scheduled job by ID (a runtime-mutation tool, so it also triggers the permission dialog)                                                      |
| 15  | **CronList**       | safe      | List all active scheduled jobs                                                                                                                         |
| 16  | **TaskOutput**     | safe      | Read accumulated output of background tasks / sub-agents (non-blocking)                                                                                |
| 17  | **TaskStop**       | dangerous | Stop a running tool / sub-agent by ID                                                                                                                  |
| 18  | **EnterPlanMode**  | safe      | Enter plan mode, generate an implementation plan for user approval                                                                                     |
| 19  | **ExitPlanMode**   | safe      | Exit plan mode after approval and start implementing                                                                                                   |
| 20  | **NotebookEdit**   | dangerous | Read / write / insert / delete Jupyter Notebook (.ipynb) cells                                                                                         |
| 21  | **EnterWorktree**  | dangerous | Create an isolated Git worktree sandbox; subsequent tool calls redirect to the sandbox path                                                            |
| 22  | **LSP**            | safe      | Code intelligence: definition / references / implementation / hover / diagnostics (prefers a real language server, falls back to regex + tsc --noEmit) |
| 23  | **ReviewArtifact** | dangerous | Optional verification tool: runs build / test / typecheck / lint                                                                                       |
| 24  | **GitCommit**      | dangerous | Stage all changes and create a Git commit, returning the commit hash                                                                                   |

> The "Category" column is an intuitive behavioral grouping; whether a tool actually triggers the permission dialog is authoritative in `electron/tool-capability.ts`'s `DANGEROUS_TOOLS` (plus `isDangerousTool()`'s verdict on every `mcp__*` name).

**The remaining 47 tools (by capability family)**:

- **Code execution / workflows**: RunCode, RunWorkflow
- **Skills**: ListSkills / ReadSkill / WriteSkill
- **File editing & image reading**: StrReplaceEditor (view/create/str_replace/insert), ReadImage
- **User interaction**: AskUser (clarify-before-work in Work mode)
- **Local shell**: Pwsh
- **Background tasks**: TaskList, JobList / JobOutput / JobKill
- **In-session scheduling**: ScheduleCreate / ScheduleDelete / ScheduleList
- **Persistent terminals**: Pty, TerminalOpen / TerminalList / TerminalRead / TerminalSend / TerminalSignal / TerminalClose
- **Goals & multi-agent collaboration**: ListAgents / SendMessage / InterruptAgent / Report, GetGoal / CreateGoal / UpdateGoal, Ralph
- **Runtime introspection / plugins**: InspectRuntime, MountPlugin / UnmountPlugin
- **Session retrieval**: SessionQuery, SessionEventSearch / SessionEventRead / SessionTrace (event-level lineage), ReadSpill
- **Professional documents**: ReadDocument (text & structured read of .docx/.xlsx/.pptx/.pdf), WriteDocument (Word/Excel/PPT/PDF generation; PDF auto-embeds CJK fonts), IngestDocument (chunk a long document into project memory; see §5.11)
- **Cloud connectors**: SlackListChannels / SlackPostMessage, DriveList / DriveRead, NotionSearch / NotionCreatePage

> Feishu / Lark is not a built-in tool: it is an official OpenAPI MCP preset, and the `mcp__lark-mcp__*` tools only appear dynamically once the server is added and connected in MCP settings.

**Tool classification** (authoritative in `electron/tool-capability.ts`):

- **Dangerous set `DANGEROUS_TOOLS` (39, plus every `mcp__*`)**: Bash, Pwsh, Pty, TerminalOpen / TerminalList / TerminalRead / TerminalSend / TerminalSignal / TerminalClose, RunCode, RunWorkflow, MountPlugin / UnmountPlugin, CronCreate, CronDelete, ScheduleCreate, ScheduleDelete, TaskStop, JobKill, EnterWorktree, WriteSkill, SendMessage, InterruptAgent, Agent, Ralph, Write, Edit, StrReplaceEditor, NotebookEdit, Delete, WriteDocument, WebFetch, WebSearch, ReviewArtifact, GitCommit, SlackPostMessage, NotionCreatePage, CreateGoal, UpdateGoal — triggers the permission dialog
- **File-mutation tools `FILE_MODIFY_TOOLS` (4)**: `['Write', 'Edit', 'NotebookEdit', 'Delete']` — trigger undo backups and conflict-detector file locks (WriteDocument is only approved as medium risk)
- **Read-only tools**: `['Read', 'Grep', 'Glob', 'ReadDocument', 'SlackListChannels', 'DriveList', 'DriveRead', 'NotionSearch']` — auto-approved in `ask` and `plan` modes

`Replan` is unavailable in the chat query path (the query engine skips it) and only usable in the agent loop.

### 4.4 Permission System

Approval policies (single source of truth `electron/contracts/core.ts` (`'ask' | 'plan' | 'auto'`), re-exported by `electron/types.ts` and `src/types/`):

| Policy                   | Behavior                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask` (default)          | Shows a permission dialog for every dangerous tool call. Read-only tools (Read/Grep/Glob) are auto-approved                                                                                                                                                                                       |
| `plan`                   | Once the plan is approved (non-empty `approvedPlanSteps`), the whole run's tools are authorized — matching is not per-tool. A rejected or timed-out plan degrades to per-call `ask`                                                                                                               |
| `auto` (fully automatic) | Runs every tool in the workspace without confirmation. Security checks still run (path checks, extension whitelist, blocked URLs); but a failed quality gate (ReviewArtifact `passed:false`) pauses for confirmation — only the "full access" tier is completely dialog-free (`autoApprove=true`) |

The Composer "runtime permission" four presets (confirm each time / auto-approve / full access / read-only) expand to an approval policy + sandbox mode (read / workspace-write / full) + autoApprove + built-in permission profile (standard / readonly); see `electron/contracts/permission.ts`. Presets never involve `plan`.

Permission rules are stored in `permission-handlers.ts` with scopes:

- `once` — removed from memory as soon as it matches once
- `session` / `always` — both persist to settings and are restored after a restart (the current implementation does not distinguish the two)

> **Approval-fatigue guard (Oversight)**: the permission chain only calls `record()` in `approval-fatigue.ts`, counting auto-approvals and manual approvals/rejections into the fatigue statistics (auto-approvals consume no human attention); the guard also exposes a `suggest()` signal (escalate / auto / balanced), but it currently has **no production caller**, so it never actually auto-approves anything — the permission tier still decides (see Section 5.6).

### 4.5 Context Compaction

`ContextManager` (`electron/agent-runtime/agent-loop-context.ts` and `electron/agent-runtime/context-manager*.ts`) and `electron/agent-runtime/step-compressor.ts` provide two compaction strategies:

- **snip (default for chat / manual compaction)**: triggers on estimated tokens (90% of the 100K query-path threshold) + whole atomic-group truncation (default retention budget 60K) + LLM summary (`deepseek-flash`), falling back to a rule-based summary; the round-count trigger hook exists but the main path does not wire it up
- **step (AGORA, default in the agent loop)**: inference-free step-level compaction — whole steps kept or dropped, never splitting a tool call from its results (see Section 5.4); `pruneToolResults` trims large results first, then an always-keep floor preserves the last 6 steps and plan-critical steps

### 4.6 Stop Policy

`stopPolicyEvaluate()` decides whether to stop execution:

- **Quality verification**: ReviewArtifact lets the model run verification commands when needed; the query path sets no quality gate, while a failure in the agent loop's `auto` tier raises the review gate and pauses for human confirmation
- **Primary check**: a text-only reply with no tool calls ends the turn; `<FINAL_ANSWER>` is the secondary confirmation signal
- **max_tokens protection**: forces continuation when the API returns `stop_reason: 'max_tokens'`
- **Plan completion check (informational only)**: unfinished plan tasks never block stopping; plan state is display and UI tracking only
- **Consecutive truncation guard**: forces an abort after 5 consecutive text-only rounds that were all truncated by max_tokens
- **Empty-response detection**: stops after 2 consecutive empty responses

### 4.7 Context-Cache Alignment (Canonical Snapshot Replay)

The unified Work/Code engine (`query-engine.ts` → `step-engine.ts`) performs client-side alignment for DeepSeek prefix caching (see Section 5.9):

- After each natural turn, the full canonical message snapshot is written to the session chat-log (`llm_context_v1` system event); the next turn replays the snapshot and only appends new memory + the new user message
- Snapshot head validation: `storedHeadIsCurrent` compares the snapshot head's system prompt / session preamble / work guide byte-for-byte against the currently assembled values, falling back to fresh assembly on any mismatch (prevents stale instructions after upgrades, project switches, or thinking-mode changes)
- Memory travels as the `memoryContext` field through IPC and is inserted at the request tail; byte-exact dedup against the snapshot's last memory on replay
- Renderer edits / deletes / regenerations / undos invalidate snapshots via `ai:clearQueryContext`
- Snapshot read/write is best-effort: failures only warn and degrade to fresh assembly without interrupting replies

Involved files: `electron/ipc/query-context.ts`, `electron/ipc/query-engine.ts`, `electron/ipc/ai-handlers.ts`, `electron/preload-ai.ts` (the `ai:clearQueryContext` bridge), `src/stores/useChatStore.ts`, `src/stores/chatActions.ts` (invalidates snapshots on edit / delete / regenerate / undo).

---

## 5. Research Papers & Technical Implementation

> All 11 papers/systems below are sources for the project's paper-driven development; implementations are original (algorithmic ideas borrowed, no paper code copied). Caching techniques are **client-side adaptations** of DeepSeek's official prefix-cache mechanism (server-side algorithms such as radix tree / KV fusion cannot be invoked directly on a managed API).

### 5.1 Paper Overview

| #   | Paper (arXiv)                                                                                                                                | arXiv ID                  | Core insight                                                                                    | Landing modules                                                                            | Status                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| 1   | [Eywa: Provenance-Grounded Long-Term Memory for AI Agents](https://arxiv.org/abs/2605.30771)                                                 | 2605.30771 (2026-05)      | Evidence before belief; zero-LLM retrieval; answer policy separated from context                | memory-evidence / signal-rules / belief-validation / memory-read / memory-db / MemoryPanel | ✅ landed v1.0                       |
| 2   | [MAP-Graph: Provenance-Aware Shared Memory for Multi-Agent Workflows](https://arxiv.org/abs/2608.10509)                                      | 2608.10509 (2026-08)      | Authorization, trust, and lineage for multi-agent shared memory                                 | memory-graph / agent-loop / tool-runner / agent-scheduler                                  | ✅ landed (M5, opt-in)               |
| 3   | [AGORA: Adapter-Grounded Observation-Action Retention for Inference-Free Prompt Compression in LLM Agents](https://arxiv.org/abs/2605.26596) | 2605.26596 (2026-05)      | Inference-free step compression that protects action grammar                                    | step-compressor / context-manager / agent-loop / step-engine                               | ✅ landed (agent-loop default)       |
| 4   | [SWE-Touch: Benchmarking Coding Agents When Users Touch the Code](https://arxiv.org/abs/2608.02499)                                          | 2608.02499 (2026-08)      | Shared-workspace drift awareness and targeted verification                                      | workspace-drift / agent-loop / tool-handlers                                               | ✅ landed                            |
| 5   | [Oversight Has a Capacity: Calibrating Agent Guards to a Subjective, Fatiguing Human](https://arxiv.org/abs/2606.08919)                      | 2606.08919 (2026-06)      | Human oversight has limited capacity; safety vs approval rate is inverted-U                     | approval-fatigue / permission-handlers                                                     | ✅ landed (advisory layer)           |
| 6   | [AutoTool: Efficient Tool Selection for Large Language Model Agents](https://arxiv.org/abs/2511.14650)                                       | 2511.14650 (AAAI 2026)    | Tool-call inertia → directed-graph prediction, saving inference cost                            | tool-inertia / tool-runner                                                                 | ✅ landed (observation + prediction) |
| 7   | [When Self-Evolution Backfires: Pre-Commit Gating against Skill Contamination in LLM Agents](https://arxiv.org/abs/2608.05810)               | 2608.05810 (2026-08)      | Skill contamination is structurally irreversible; pre-commit gating required                    | skill-gate / tool-handlers (WriteSkill)                                                    | ✅ landed                            |
| 8   | [SGLang: Efficient Execution of Structured Language Model Programs (RadixAttention)](https://arxiv.org/abs/2312.07104)                       | 2312.07104 (NeurIPS 2024) | Prefix-tree KV reuse; client side takes "longest shared prefix + canonical replay"              | query-context / query-engine / useChatStore                                                | ✅ landed (client-side adaptation)   |
| 9   | [Prompt Cache: Modular Attention Reuse for Low-Latency Inference](https://arxiv.org/abs/2311.04934)                                          | 2311.04934 (MLSys 2024)   | Reusable content as contiguous stable blocks; dynamic content never inserted into stable blocks | context-manager / query-context                                                            | ✅ landed                            |
| 10  | [Cache-Aware Prompt Compression: A Two-Tier Cost Model for LLM API Caching](https://arxiv.org/abs/2607.15516)                                | 2607.15516 (2026-07)      | Prefix/tail boundary by change frequency; dynamic content tailed                                | query-context / query-engine / useChatStore                                                | ✅ landed                            |
| 11  | [Byte-Exact Deduplication in Retrieval-Augmented Generation](https://arxiv.org/abs/2605.09611)                                               | 2605.09611 (2026-05)      | Byte-exact dedup of retrieved context to avoid bloat                                            | query-context (memory-block dedup)                                                         | ✅ landed (dedup approach)           |

### 5.2 Eywa — Provenance-Grounded Long-Term Memory (M1–M4)

**Core insight**: LLM-extracted "memories" are only revisable indexes; original session evidence must be immutable, beliefs must be traceable and auditable, and every answer can answer "which layer went wrong."

- **M1 Evidence foundation**: `memory-evidence.ts` captures user messages, tool observations, and user corrections as immutable Evidence (sha256 content-hash dedup, SQLite / JSON backends; evidence roles are limited to user / assistant / tool / system, so approval events are never written into Evidence); `chat-log.ts` / `session-log.ts` hook best-effort capture after writes
- **M2 Signals & beliefs**: `signal-rules.ts` detects eight signal kinds by rule — date / entity / URL / version / decision / correction / approval / rejection — held as a typed index over Evidence and backfilled centrally by `memory:reindex` (zero LLM by default; with `AURAXIS_MEMORY_LLM_SIGNALS=1` it switches to LLM semantic detection in `signal-llm.ts` and silently falls back to the rules); `belief-validation.ts` hard-anchor validation (evidence must exist, key entities & values normalized, corrections need dual evidence); state machine `draft → promoted → active → superseded / rejected / deleted`
- **M3 Deterministic read path**: `memory-read.ts` four routes — R1 keyword (FTS5 via `memory-fts.ts`: trigram external-content index over `beliefs`/`evidence`, triggers keep it in sync, bm25 ordering; queries shorter than 3 characters fall back to `LIKE` because trigram `MATCH` requires ≥3) / R2 entity-time / R3 observation stream / R4 local vectors (`AURAXIS_MEMORY_EMBEDDINGS=1`, optional; served through the `EmbeddingProvider` seam, cached as SQLite BLOBs and re-embedded only on identity mismatch — see §5.11) — **zero LLM, zero randomness**; `memory:readForQuery` returns context + policy + facts + diagnostics and replaces chat injection
- **M4 Audit & attribution**: `memory:beliefAudit` / `readTrace` / `erase` (erasure leaves audit events); MemoryPanel shows evidence chains, support strength, revision history, and read-path diagnostics; five-layer failure attribution tests (missing evidence / extraction distortion / stale state / retrieval loss / model behavior)

### 5.3 MAP-Graph — Multi-Agent Shared-Memory Authorization (M5)

**Core insight**: vector-only retrieval loses permission, source, and trust information, which can let "unauthorized evidence drive high-risk actions."

- `memory-graph.ts` typed execution graph: agents / sources / memories / claims / actions nodes + lineage edges
- Authorization filtering: evidence readability decided by agent role (Explore / Plan / general-purpose) and action type; hard authorization separated from graded trust
- Path trust: multiplicative trust scoring of source credibility × derivation path, used by the opt-in risk gate (`AURAXIS_MEMORY_RISK_GATE=1`) — it does **not** re-rank retrieval results
- Risk gating: high-risk actions (Write / Edit / Bash etc.) require higher evidence standards and source trust; the gate hangs off step-engine's tool-execution hook (`riskGate`) and is bound to memory-graph's trust evaluation through `electron/ipc/runtime-ports.ts`; scheduler / sub-agents auto-bind agentName at runtime (`AURAXIS_MEMORY_RISK_GATE=1`, opt-in)

### 5.4 AGORA — Step-Level Context Compression

**Core insight**: token-level extractive compression breaks an agent's action grammar (tool names / identifiers / brackets removed → environment rejects the call); compression must operate on whole steps.

- `step-compressor.ts` inference-free implementation: structural parsing + always-keep floor (system / lead / last K=6 steps / plan-critical steps) + deterministic heuristic scoring, no LLM
- Never splits a tool call from its result; `context-manager.ts` runs `pruneToolResults` before compressing large results
- Agent loop defaults to `compressMode='step'` (`agent-loop.ts` / `step-engine.ts`); chat and manual compaction keep the `snip` summary pipeline

### 5.5 SWE-Touch — Shared-Workspace Drift Detection

**Core insight**: when the user or another process modifies the same workspace during task execution, the agent must perceive "external drift" and re-check the modified areas.

- `workspace-drift.ts` records baselines after successful Read / ReadImage / Write / Edit / StrReplaceEditor (stat + sha256; >2MB uses mtime/size only), without listening to filesystem events; registration is wired in `electron/ipc/tool-handlers/path-utils.ts` + `file-tools.ts` and covers all four StrReplaceEditor commands (view / create / str_replace / insert)
- Before each agent iteration, `takeDrift(projectRoot)` detects drift and injects a context message (`context_injected / workspace` event), asking the model to verify the affected areas
- Consumed internally by agent-loop, with workspace-drift unit tests; on the agent-loop side a `takeDrift` stub verifies the drift-injection event stream (there is no dedicated agent-loop drift integration case)

### 5.6 Oversight Has a Capacity — Approval-Fatigue Guard

**Core insight**: human reviewers are not perfect oracles; over-escalation reduces overall safety (fatigue + "approval-flood" attacks). Whether to escalate to a human should be treated as a resource-allocation problem.

- `approval-fatigue.ts` records approval decisions per scope (approved / rejected / auto) with a 20-decision sliding window + fatigue score
- Exposes `record()` / `state()` / `suggest()` with suggestions `escalate / auto / balanced`; the permission chain only calls `record()` — `permission-handlers.ts` counts auto-approvals in the statistics (without consuming human attention)
- The guard never changes the permission mode itself, and `suggest()` currently has no production caller, so fatigue never actually auto-approves anything today

### 5.7 AutoTool — Tool Usage Inertia

**Core insight**: tool-call sequences have predictable low-entropy inertia; building a directed graph from historical trajectories can predict the next tool before the LLM decides, saving up to ~30% inference cost.

- `tool-inertia.ts` builds a Tool Inertia Graph (TIG): tool nodes + transition probabilities; `tool-runner.ts` registers sequences automatically after each batch (including cross-batch continuation)
- `suggestNext(scope, history, { minProbability })` returns candidate tools with confidence (high / medium / low) for an upstream bypass switch
- Consumed internally by tool-runner; parameter-level prefill is not implemented yet

### 5.8 Verifier-as-Gatekeeper — Skill-Library Gate

**Core insight**: once a skill pool exceeds a critical size, new skills pollute the downstream distillation chain, and the pollution is structurally irreversible; skill admission must be a pre-commit gate, not a post-hoc rollback.

- `skill-gate.ts` runs three heterogeneous critiques: structural validity (frontmatter / name / body length), behavioral harmlessness (dangerous command patterns), and semantic consistency (placeholder descriptions / name matching)
- Marginal-gain subset selection: dedup + diversity + freshness
- `WriteSkill` calls `validateSkill` before admission; blocking rejects, warnings surface as hints

### 5.9 Cache-Aligned Context Management (RadixAttention / Prompt Cache / Cache-Aware Prompt Compression)

**Core insight**: DeepSeek's official context cache only hits on "complete prefix units starting from token 0"; the client-side option is to keep the request head byte-stable for as long as possible and push per-round changing content to the tail.

- **Canonical history replay (client-side RadixAttention adaptation)**: `query-context.ts` writes the full message array actually sent to the LLM each round (including assistant `tool_calls`, `tool` results, `reasoning_content`) into the session chat-log as an `llm_context_v1` system event; the next `runQuery` replays the snapshot and appends new memory + new user message, keeping the prefix byte-identical and preserving tool history
- **Stable block organization (Prompt Cache)**: static system prompt + tool definitions + AGENTS.md + mode hints are stable blocks, replaced in place only when content really changes; `storedHeadIsCurrent` byte-compares the snapshot head (system prompt / session preamble / work guide) against the values assembled right now and falls back to fresh assembly on upgrades, project switches, or thinking-mode changes
- **Dynamic content tailing (Cache-Aware Prompt Compression)**: cross-session memory is no longer `unshift`ed to the head; it travels as a separate `memoryContext` field inserted before the current user message (fresh) or at the snapshot tail (replay)
- **Byte-exact dedup (Byte-Exact Deduplication)**: on replay, if the new memory block is byte-identical to the snapshot's last memory, the append is skipped, preventing the same retrieval from accumulating every round
- **Invalidation path**: renderer calls `ai:clearQueryContext` on edit / delete / regenerate / retry-last / undo-restore, writing an `llm_context_clear` tombstone; snapshot read/write failures only warn and degrade, never interrupt the conversation

Limitations: Chat mode (`ai:chatStream`) does not yet use the static prefix; the official API does not expose TTL/keepalive, so no keep-alive requests are made.

### 5.10 New Feature Checklist

| Feature                          | Description                                                                                                                                                                           | Main modules                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Local account system             | First-run registration → login gate → logout / password change; password stored only as scrypt hash; `AURAXIS_AUTH_DISABLED=1` bypasses the gate for tests only                       | auth-store / auth-handlers / AuthGate / AccountPane |
| DeepSeek API key at registration | Key can be filled and connection-tested during registration, or skipped and configured in Settings                                                                                    | AuthGate / settings / ai-handlers                   |
| Avatar & account display         | Account shown in the top bar left of Settings; avatar upload (center-cropped PNG data URL); password change in Settings                                                               | Avatar / AccountPane / auth:setAvatar               |
| Chat / Work / Code modes         | Three product forms under one ReAct engine; mode switches never pollute each other's state                                                                                            | useAppStore / useChatStore / code-mode              |
| Work agent execution flow view   | Centered input + task board + execution flow (rounds, tool rows, deliverables, status)                                                                                                | ChatArea / WorkExecutionFlow / WorkItemView         |
| Thinking toggle & depth          | Chat uses DeepSeek style: toggle only (default high, no intensity picker); Work/Code default thinking on with low/medium/high slider                                                  | ChatInput / ThinkingDepthSelector / ModeToggler     |
| Web search                       | Chat has a dedicated web-search button; Work/Code hide the toggle and let the model call WebSearch/WebFetch autonomously; defaults to DeepSeek native search with DuckDuckGo fallback | ChatInput / tool-handlers                           |
| Per-mode state snapshots         | Thinking toggle / intensity / web-search saved per mode (`modeThinkingPrefs`), restored on switch back                                                                                | useChatStore                                        |
| Provenance memory                | Evidence-before-belief, deterministic read path, evidence-chain UI, five-layer failure attribution                                                                                    | memory-* / MemoryPanel                              |
| Agent activity view              | One agent run = one header + one ordered Activity list in the chat area, derived from real engine events                                                                              | core/activity / components/activity / AgentRun      |
| Session event timeline           | Right-side timeline of session events and tool calls with trace / replay                                                                                                              | TimelineRows / session-log                          |
| Browser tools                    | Agent drives the preview panel the user already opened (open / read / screenshot); http(s) only, no silent target swap                                                                | browser-target / tool-defs/browser / PreviewBrowser |
| Live diff & rollback             | Right-panel "Changes" view lists per-session file changes and rolls back                                                                                                              | undo-manager / undo:getSessionDiffs                 |
| Test-coverage panel              | Settings reads coverage-summary.json live and shows line / branch / function coverage                                                                                                 | coverage-handlers / settings                        |

---

### 5.11 Retrieval & LLM Gateway Upgrade

**Core insight**: the pieces that decide _what the model sees_ and _what it costs_ had working but hard-coded implementations — a fixed 64-dimension hash for vectors, a value-ceiling of implicit weights for fusion, and no accounting at the one place every LLM call passes through.

- **Embedding seam** (`ipc/embedding-provider.ts`): the R4 vector route no longer hard-codes the feature-hash embedder. `EmbeddingProvider` (id / dimension / version + async `embed`) is swappable; the local hash implementation stays the default and is byte-identical to the previous algorithm. Recording _identity_ is the point: without it, swapping models re-ranks with vectors from a different space and reports nothing.
- **Persisted vectors** (`ipc/memory-vectors.ts`): belief vectors live in a SQLite BLOB column, encoded as explicit little-endian float64 — float32 round-tripping would make "cache hit" and "cache miss" rank differently, which a read path that advertises determinism cannot afford. Identity is stored **per row**, so a mismatched row is simply treated as missing and overwritten by the next write (no second piece of state to keep in sync). The read path embeds only the beliefs it lacks, in one batched call. `eraseScope` clears vectors with the rest. Backends without SQLite report "no vector store" and recompute every time — identical results, no cache.
- **Document ingestion** (`ipc/document-ingest.ts`, `IngestDocument` tool): chunk a .docx / .xlsx / .pptx / .pdf into project memory. Each chunk becomes one Evidence row — so the existing FTS5 index, cascade erase and audit trail apply with **no new code** — plus one `kind: 'reference'` belief anchored to it (Evidence alone only participates in routing; the injected `context` carries beliefs). Deterministic, zero LLM. Re-ingesting replaces the previous generation using ids derived from the content hash, so no manifest table is needed. It is deliberately _not_ in `SAFE_READONLY_TOOLS`: it only reads a file, but it persists content, so it keeps an approval prompt.
- **Semantic cache** (`ipc/semantic-cache.ts`, off by default): embedding recall plus a similarity threshold, wired to exactly one caller — session-title generation. Deliberately **not** wired to the agent loop: reusing an answer across "similar" questions would return something that contradicts the current workspace, silently. The default hash embedder makes the threshold mean "near-identical wording"; it becomes genuinely semantic only after a real embedding provider is registered.
- **LLM gateway** (`agent-runtime/llm-gateway.ts`): rate limiting (opt-in; it waits rather than fails, and its bucket has capacity 1 so `RPM=600` cannot burst), a cost ledger broken down by model × session with an exact-match price table (unlisted models are reported _unpriced_ rather than priced by guesswork), and provider health. All three hang off `invokeLlm` — the single LLM exit — so no caller can bypass them. Health is observational only: the engine already has retry plus `fallbackModel`, and a second automatic degradation path would make "why wasn't it called" unanswerable. Scheduler token usage now reaches the stats page, and the snapshot is exposed on `stats:get`.
- **Semantic eval** (`agent-eval/judge.ts`): `answer_judge` checks add LLM-as-judge scoring to the existing harness for criteria structural assertions cannot see ("explained why", "flagged the risk"). Rubric items carrying a `literal` are judged deterministically with no model call; every failure mode — no judge available, unparseable output, a "pass" with no quoted evidence — fails closed. Reasons and quotes are kept in the report for human review: the judge is a second model's opinion, not ground truth.
- **Prompt variants** (`AURAXIS_PROMPT_VARIANT_FILE`, `scripts/prompt-ab.cjs`): candidates live in `evals/prompts/*.txt`, are appended after the cache prefix (never inside `STATIC_SYSTEM_PROMPT`), log loudly when active, and are A/B'd by running the harness once per arm. Nothing is adopted automatically — a dozen cases cannot separate signal from noise.

### 5.12 Agent Activity View — one run, one ordered list of steps

**Core insight**: an assistant run used to be visually fragmented — tool activity in the bubble, but the plan / context injection / compaction / permission request each arrived as its own synthetic message, with deliverables and the rollback entry hanging outside it. The same tool events were also re-rendered in four separate places, each with its own tool-name → label table.

- **Derived-first, not a second store**: `src/core/activity/model.ts` projects an assistant message (plus its synthetic followers, attributed by `segments.ts`) into an `ActivityRun`. Activity is a **pure function of state that already exists** (`messages[].toolCalls`), so refresh needs no rebuild path — `localStorage` restores the messages and the same function re-derives the view. A second copy would have to be kept in sync at ~10 mutation entry points (send / retry / edit / delete / regenerate / switch-session / clear / fork / rollback / rehydrate), and one missed sync shows up as "the run is there but the steps are gone".
- **One presentation table**: `src/core/activity/presentation.ts` maps **every** built-in tool to a semantic `ActivityType` through a `Record<BuiltInToolName, ActivityType>` — adding a tool without classifying it is a **compile error**, not a silently degraded row. It also renders the engine's already-computed `buildToolSummary` facts (`Read: 120 lines / 8KB`, `exit 0 · out 1.2KB`), which existed but had no consumer; the UI used to re-derive weaker summaries from tool input in four places.
- **One extraction layer, one renderer**: `src/core/activity/agentCards.ts` turns a tool result into a typed card model (read / search / web / code / diff / terminal) and `src/components/agent/ToolOutputCard.tsx` renders it. The chat activity view, the agent conversation and the right-panel trajectory all call these two — the three hand-rolled copies (`readCardProps` & friends in `AgentConversationRender.tsx`, `ReadDetail`/`GrepDetail`/`WebDetail`/`RunCodeDetail` in `TimelineRows.tsx`) are gone, and `TimelineUtils.toolSummary` / `AgentConversationUtils.summarizeInput` now delegate to the same `summaryFromInput`. Lifting the extractors into `src/core/` also put them inside the coverage gate. Two honest consequences: a fetched page's **body** is now shown (WebFetch returns `{url, content_type, content}` — the content had no renderer anywhere before), and a failed command with no exit code no longer fabricates `exitCode: 1`.
- **`agent:event:*` is a discriminated union**: `electron/contracts/agent-events.ts` derives the payload type from the engine's own `AgentLoopEvent` (plus the two channel-only events `plan` and `user_message`), and preload + renderer share it. It used to be `Record<string, unknown> & { type: string }` on the renderer side and `{ type: string } & Record<string, unknown>` in preload, so a wrong field name just read `undefined` — `event.maxIterations` had been dead for exactly that reason. `src/stores/__tests__/agent-event-types.test.ts` asserts both directions at compile time, so an engine event the renderer does not know about fails `tsc6` instead of silently doing nothing. The budget is now a real field again: the engine carries `config.maxIterations` into `StepEngineConfig` and emits it on `iteration_start` (omitted when the host cannot resolve one — never a default), and the run header shows `round 3/42` while that run is the live one.
- **Resident terminals have a card too**: `Pty` / `TerminalOpen|List|Read|Send|Signal|Close` each return a different shape. `TerminalRead`'s payload is terminal text _with ANSI escapes_, which used to be `JSON.stringify`-ed into `{"output":"\u001b[32m…"}` — unreadable. `ptyCardModel` maps each action to real fields (session list, sent character count, signal name, how many sessions were cleared) and the read action renders through `TerminalBlock`.
- **Status machine**: `pending / running / completed / failed / cancelled / waiting / skipped`, each transition tied to a real engine event. This fixed two live defects: `tool_aborted` was recorded as `done` + an error string, so a step the user cancelled rendered as "completed"; and a run stopped by the user was indistinguishable from a completed one, because `stopStreaming` only clears `isStreaming` — the store now records the real terminal (`stopped` / `timeout` / `disconnected`).
- **Items are in-place**: tool events reuse one item id (`toolCallId`), so a streaming terminal refreshes the same row instead of appending rows. Live output comes straight from `ToolCall.streamOutput`.
- **Real diffs, real ±**: Write/Edit outputs already carry `oldContent`/`newContent`; `countDiffChanges` produces the `+N −M` chip. Above a size cap the counts are **omitted rather than estimated** (`lcsDiff` is O(n·m) in time and memory), and the UI says so.
- **Aggregation, two layers**: batch grouping (one LLM turn's parallel fan-out) is gone from the top level — it is an implementation detail. `core/activity/aggregate.ts` merges **consecutive same-kind completed** operations instead (`Read 4 files`, `Searched · 3 queries · 14 matches`, `Ran 3 commands`); anything running, failed, cancelled, or file-mutating (the ± chips) stays on its own row, because that is what the user is actually looking at. Expanding a merged row shows the **same `ActivityItem` objects** (asserted by reference in tests), so a drill-down always reaches the real step. Runs with more than 24 segments fold the oldest into one `19 earlier steps folded` row — only once the run has settled, never while it is still working.
- **Streaming terminals show their output**: `tool_progress` had always been collected into `ToolCall.streamOutput`, but `TerminalBlock` gated the output area on `!running` — during a long build the user saw a spinner and nothing else. Now the running card renders a **tail-only** window (`core/activity/liveOutput.ts`: 8KB / 200 lines, cut on line boundaries so an ANSI sequence never splits), follows the bottom **only when the user is already there**, and reports omitted lines honestly instead of pretending that is everything.
- **Plans are a checklist, not JSON**: `TodoWrite` used to expand into `{"todos":[…]}`. `planCardModel` maps the real `input.todos` into a compact list with truthful `2/4` progress, rendered by the shared card layer (so the agent conversation and the trajectory panel get it too).
- **Permission approvals live in the run**: the approval card renders **inside the activity row** and the decision flips that row in place (`◐ waiting` → `✓ granted`), recording into `useActivityStore.approvals`. Two guards came out of adversarial review: an undecided request is only `waiting` while **that run is live** (a reloaded session can no longer mount a card that instantly self-denies), and `resetForSession` no longer wipes `runTerminal`/`approvals` (they are the only record that a run was stopped or a request approved, keyed by globally unique ids).
- **Nesting**: a `sub_agent` item renders its child's steps from the real sub-agent event stream (`useAgentStore` log), associated via the injected `_agentId`, converted with the same type/label layer.
- **Persistence**: the durable session log now carries what the view needs — `summary`, `stepGroupId` and `durationMs` were written to disk but dropped by the projection, and the `aborted` action was unknown to it (a replayed cancelled tool stayed stuck on "running").

## 6. Multi-Agent Scheduling

### 6.1 Three-Layer Architecture

```
Agent management (ipc/agent-handlers.ts)
    ↓ create / configure
Agent scheduler (singleton implemented in ipc/agent-scheduler-class-impl.ts; ipc/agent-scheduler.ts only registers IPC)
    ↓ schedule & execute
Agent loop (agent-runtime/agent-loop-driver.ts) — agentLoopRun()
    ↓ while running
Tool execution (ipc/tool-handlers/*) / sub-agents (recursion)
```

### 6.2 Agent Types

Defined in `agent-defs.ts` ([view file](../electron/ipc/agent-defs.ts)); three built-in types:

| Type                | Capability                                                                                                                                                       | Disabled tools                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Explore**         | Read-only exploration: file search, code reading, web fetch/search, read-only Bash (ls / git status / log / diff / find / cat, constrained by the system prompt) | Write, Edit, Agent                                                                                                                                        |
| **Plan**            | Read-only architect: designs implementation plans, outputs structured plans                                                                                      | Write, Edit, Agent (Bash constrained to read-only by the system prompt)                                                                                   |
| **general-purpose** | Full capability: coding, debugging, refactoring                                                                                                                  | None (all 71 built-in tools available; up to 96 once MCP and dynamically mounted plugin tools are added — MAX_TOTAL_TOOLS in `electron/tool-registry.ts`) |

### 6.3 AgentScheduler

The singleton `AgentScheduler` (`agent-scheduler.ts`) manages parallel agent execution:

- **Priority queue**: high (weight 3) > normal (2) > low (1)
- **Default max concurrency**: 3 (adjustable via `agent:setMaxConcurrent` IPC)
- **Agent state machine**: `idle → queued → running → completed/error/stopped/paused/review` (in non-fully-automatic Work mode a finished task first enters the `review` delivery-acceptance state and only turns `completed` after `agent:approveDelivery`)
- **Live notifications**: every state change broadcasts via the `agent:updated` channel
- **Host decoupling**: status broadcasts and approval dialogs all go through the `SchedulerNotifier` port (`send` / `isAlive`); `agent-scheduler-notifier.ts` is the only scheduler-related module importing `electron`, so the scheduler core is reusable in headless / SDK / test environments
- **Iteration budget**: per run, default 200 (Settings → Agent runtime → `agentMaxIterations`, clamped to 1–500); a budget-exhausted task resumes with the next composer message and gets a fresh window, with the cumulative count bounded by the 500 hard cap

### 6.4 Workspace Isolation

Workspace isolation is implemented in `electron/ipc/tool-handlers/worktree.ts` (`worktreeSessions`):

- **Git repos only**: `EnterWorktree` uses `git worktree` to create an isolated branch `auraxis-task-<id>` under `../.auraxis-sandbox/task-<id>` — a sibling directory of the project root, not a folder inside the project (non-Git directories are rejected)
- **Path redirection**: after entering a worktree, file/command tools redirect to the sandbox path
- **Sandbox reuse**: re-entering the same task_id first runs `git worktree remove --force` and deletes the old sandbox directory; the code performs no startup scan for orphaned directories
- **Native sandbox**: command-level isolation is provided by `sandbox-runner.ts` (Windows restricted token / AppContainer, Linux, macOS backends)

### 6.5 Conflict Detection

`conflict-detector.ts` prevents multiple agents from writing the same file concurrently:

- Acquires a file lock before Write / Edit / NotebookEdit / Delete, and only when the tool runs inside an agent task context (`ctx.agentId` exists)
- Tracks file modification history (which agent, when)
- If another agent already holds the lock on the same file, this write is rejected outright with a conflict message (locks expire automatically after 5 minutes)
- Exposes conflicts to the frontend via `conflict:getConflicts`

---

## 7. MCP Protocol Support

`mcp-handlers.ts` implements the **policy layer** of the MCP (Model Context Protocol) client, with the protocol itself delegated to the official `@modelcontextprotocol/sdk`:

- **Transport**: the SDK's stdio transport (`StdioClientTransport`) and remote **Streamable HTTP** (`StreamableHTTPClientTransport`); handshake, capability negotiation, request timeouts and notifications are handled by the SDK, and the protocol version is negotiated by it (SDK 1.31.0 → `2025-11-25`; previously a hand-rolled JSON-RPC client pinned to `2024-11-05`)
- **Transport selection**: a config with `url` uses HTTP, one with `command` uses stdio; the `transport` field overrides this explicitly (otherwise it is inferred from the presence of `url`)
- **Remote endpoint policy**: https only by default (loopback `http://localhost` / `127.0.0.1` / `::1` excepted); cloud-metadata and link-local addresses are rejected outright (SSRF protection); private ranges are denied unless `AURAXIS_MCP_ALLOW_PRIVATE_HOSTS=1`; `AURAXIS_MCP_ALLOWED_HOSTS` configures an egress allowlist (`example.com` matches the host and its subdomains, `.example.com` subdomains only, IPs match exactly); credentials must not be embedded in the URL
- **Credentials & authorization**: static tokens come either from custom `headers` or from the access-token field (kept in the safeStorage-encrypted credential store — the config only keeps the serverId). When a server demands authorization, **OAuth (authorization code + PKCE + dynamic client registration)** can be enabled: connecting opens the system browser, the authorization code comes back through a `127.0.0.1` loopback callback into the SDK's `finishAuth()`, and tokens / client registration / PKCE verifier are all persisted encrypted, with `invalidateCredentials` clearing them when the server says they are stale
- **Timeouts**: 180 s for the first handshake (npx cold start), 30 s for regular `tools/list` / `tools/call`
- **Command validation**: server command and arguments are validated before connecting (command allowlist + rejection of code-execution/interactive flags)
- **Tool discovery**: `mcp:listTools` lists remote MCP server tools
- **Tool calls**: `mcp:callTool` invokes remote tools (`mcp__serverId__toolName`); calls coming from the agent tool pipeline carry the host's `ToolContext.abortSignal` into the SDK request options, so cancelling a run rejects the in-flight request immediately and the SDK emits `notifications/cancelled` (without it a long-running tool could only be interrupted by the 30 s timeout)
- **Status management**: `mcp:connect` / `mcp:disconnect` / `mcp:getStatuses`; when the child process exits or errors (`client.onclose` / `onerror`) that server's tools are dropped immediately
- **DeepSeek Harness preset**: Settings → MCP can add `deepseek-harness` in one click; the first connection starts the local Harness Web through the `deepseek-harness-mcp` bridge (that package calls `npx` internally). On Windows a `scripts/auraxis-mcp-preload.cjs` bridge is injected via `NODE_OPTIONS=--require`, forwarding nested `.cmd` / `.bat` spawns through `cmd.exe` so `npx.cmd` remains spawnable.

---

## 8. Plugin System

> The repository ships **two plugin mechanisms** with different extension points: the renderer-side `src/core/plugin-{manager,loader}.ts` (example plugins, source scanning, confirm-to-install — this is what 8.1–8.3 describe; it contributes **commands, lifecycle hooks and UI only**) and the main-process `electron/ipc/dynamic-plugin.ts` (the model mounts plugins at runtime through the `MountPlugin` / `UnmountPlugin` tools, and execution re-enters the full `executeToolCall` pipeline). **Only the main-process mechanism can contribute tools** — tools must pass the permission / sandbox / approval gates, so a renderer plugin cannot expose them; a `tools` field declared there is ignored and reported by `loadPlugin`.

### 8.1 Extension Points

Plugins (`src/core/plugin-manager.ts`) provide the following extension points:

| Extension point | Description                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **commands**    | Slash commands (`/example`) that can manipulate chat input                                                                                                                                                                                |
| **hooks**       | Lifecycle hooks: `afterAgentStart`, `beforeToolExecute`, `afterSessionEnd`, `onAppReady` (declared in `src/types/plugin.ts:22-27` and collected, but `executeHook()` has no call site in the repo yet, so event dispatch is not wired up) |
| **ui**          | UI extensions: `settingsComponent` (a React component rendered on the plugin page of the Settings panel)                                                                                                                                  |

### 8.2 Security Model

Plugins installed through this renderer-side mechanism run in the renderer process; installation includes multi-layer security checks:

1. **Source-code scan** (`plugin-loader.ts`): detects 8 dangerous patterns
   - `eval()`, `new Function()` — arbitrary code execution
   - `require('child_process')` — system processes
   - `require('fs')` — filesystem access
   - `fetch()` to non-local addresses — network requests
   - `require('net')`, `require('os')`, `require('path')`
2. **Structural validation**: required fields (id, name, version, description) and tool schema validation
3. **Path whitelist**: `loadPlugin` only accepts modules whose path contains a `plugins` directory segment (strict mode can pass `allowedRoots` to pin specific directories); the two built-in example plugins are bundled modules assembled silently via `installBuiltin` and skip this check
4. **User confirmation**: installation shows the capability list and the scanned risks and waits for confirm; the source scan is best-effort (`fetch('file://…')` sits inside a try/catch that swallows errors), so the risk list can be empty when the source cannot be read
5. **API key isolation**: plugins cannot access API keys encrypted in `safeStorage`
6. **Permission adherence**: plugin tool execution follows the same permission-dialog checks as built-in tools

### 8.3 Built-in Example Plugins

- `src/plugins/example-timestamp.ts` — `/timestamp` command, inserts ISO timestamp
- `src/plugins/example-uuid.ts` — `/uuid` command + `afterSessionEnd` hook

---

## 9. Persistence

### 9.1 Zustand Store Persistence

Uses `zustand/middleware/persist` into `localStorage`:

| Store               | localStorage key           | Persisted content                                                                 |
| ------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| useChatStore        | `auraxis-chat-storage`     | Last 40 messages                                                                  |
| useSettingsStore    | `auraxis-settings-storage` | API key, default model, project path, notification settings, sidebar transparency |
| useAppStore         | `auraxis-app-storage`      | Theme, sidebar state, panel widths, right-panel view                              |
| useAgentStore       | `auraxis-agent-storage`    | Agent list, priority, concurrency settings                                        |
| useSessionStore     | `auraxis-session-storage`  | Session list (max 200)                                                            |
| usePluginStore      | `auraxis-plugin-storage`   | Installed plugins, enabled state                                                  |
| useAdvancedStore    | `auraxis-advanced-storage` | MCP servers, permission rules (`permissionRules`)                                 |
| useKeybindingsStore | `auraxis_keybindings`      | Keybinding overrides                                                              |
| useI18nStore        | `auraxis-locale`           | UI language (zh / en)                                                             |

> **Note**: localStorage keys use the unified `auraxis-` prefix; `auraxis_keybindings` is the exception.
>
> **Persistence outside localStorage**: `useProjectStore` now persists to disk (`auraxis-global-state.json` under userData, via `project:loadGlobalState` / `project:saveGlobalState`) and merges then deletes the legacy `auraxis-projects` key at startup; the chat store writes through `debouncedStorage` with a 1s debounce, so streaming does not hit disk message-by-message; preview browser history reads/writes `auraxis-browser-history` directly (not zustand persist).

### 9.2 Long-Term Memory

Long-term memory is upgraded to **evidence-before-belief provenance memory** (Eywa + MAP-Graph; full design in Sections 5.2/5.3):

- **Three-layer data model**: Evidence (immutable source evidence, SQLite/JSON dual backend) → Signal (rule-first typed signals) → Belief (LLM-derived + hard-anchor validated; supported / unsupported / missing-reference three states)
- **Live evidence hooks**: `chat-log.ts` / `session-log.ts` best-effort capture user messages and terminal tool states after writes
- **Deterministic read path**: R1 keyword (FTS5 trigram index; `LIKE` fallback for queries <3 chars) / R2 entity-time / R3 observation stream / R4 local vectors (optional; `EmbeddingProvider` seam + persisted vectors, see §5.11), zero LLM; `memory:readForQuery` returns context + policy + facts + diagnostics; chat injection switched over
- **Audit & attribution**: beliefAudit / readTrace / erase (erasure leaves audit events); MemoryPanel shows evidence chains, support strength, revision history, and read-path diagnostics; five-layer failure attribution tests
- **Multi-agent authorization (M5)**: `AURAXIS_MEMORY_RISK_GATE=1` enables the memory-graph typed execution graph with role-based authorization, path trust, and high-risk action gating
- **Compatibility**: legacy `memory:getByProject` / `getByType` / `search` channels map to the new model; legacy memories are tagged `legacy=1` and never silently treated as verified

### 9.3 Session Management

`useSessionStore.ts` manages chat sessions:

- **Auto-save**: streaming completion triggers `saveSession()`
- **Capacity limit**: at most 200 sessions, each keeping its latest 200 messages
- **Operations**: save, load, delete, export, fork

### 9.4 Encrypted Settings Storage

`settings-store.ts` uses Electron `safeStorage` to encrypt API keys:

- Settings file: JSON file under the user-data directory
- API keys: `safeStorage.encryptString()` → Base64
- Auto-decrypt on read: `safeStorage.decryptString()`
- API keys are never exposed in `settings:get` responses
- Legacy plaintext keys auto-migrate to encrypted storage on first read (one-time; plaintext removed after write-back)
- When encryption is unavailable the key is **dropped** instead (plaintext never reaches disk; embedded `apiKey`s of custom models are handled the same way); when decryption fails the key is likewise dropped instead of exposing corrupt data (`electron/ipc/settings-store.ts:112-142`)

### 9.5 Log Retention & Cache Cleanup

Best-effort maintenance runs on the desktop GUI startup branch only (`log-retention.ts` + each store's `prune()`); SDK / ACP / `--run` headless modes return earlier and therefore skip log retention, projection-cache cleanup, and the FTS rebuild (`electron/main.ts:419-467`):

- **Log retention**: chat/agent JSONL logs kept for 180 days or 256MB by default, overridable via `AURAXIS_LOG_RETENTION_DAYS` / `AURAXIS_LOG_MAX_FILE_MB`
- **Projection-cache cleanup**: removes orphan `session-cache` rows with no matching JSONL log (SQLite backend)
- **FTS rebuild**: full rebuild at startup, then per-session 600ms debounced incremental refresh after appends
- **Canonical context snapshots**: Work/Code write an `llm_context_v1` system event to chat-log each round (cache-aligned replay); edit/delete/regenerate/undo appends an `llm_context_clear` tombstone; both follow the log retention policy

The SQLite projection cache and FTS index both carry `PRAGMA user_version = 1` for future migrations.

### 9.6 File Undo

`undo-manager.ts` implements file-level undo:

- **Trigger**: automatic backup before execution of the Write / Edit / NotebookEdit / Delete tools
- **Snapshot storage**: `.auraxis-snapshots/` directory
- **Operations**: undo, revert, get history

---

## 10. Model Configuration

### 10.1 Model Resolution Chain

`getAllModels()` in `model-config.ts` resolves models in this priority order (built-in definitions live in `BUILT_IN_MODELS` in `electron/contracts/core.ts`; `resolveModelId()` normalizes legacy names):

```
1. Built-in models (deepseek-flash = V4.1 Flash, deepseek-v4-pro; retired names are no longer listed and only resolve to V4.1 Flash through resolveModelId() as compatibility aliases)
   ↓
2. AURAXIS_MODELS environment variable (JSON array)
   ↓
3. Persisted custom models (added by the user via UI)
```

### 10.2 Environment Variables

See `.env.example` ([view file](../.env.example)):

| Variable                                                                    | Description                                                                                                                                                                                                                                                               | Default                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `DEEPSEEK_API_KEY`                                                          | DeepSeek API key                                                                                                                                                                                                                                                          | none (required)                                     |
| `DEEPSEEK_BASE_URL`                                                         | OpenAI-format endpoint                                                                                                                                                                                                                                                    | `https://api.deepseek.com/beta/chat/completions`    |
| `DEEPSEEK_ANTHROPIC_BASE_URL`                                               | Anthropic-format endpoint (**currently reserved**: no caller, does not affect endpoint selection)                                                                                                                                                                         | `https://api.deepseek.com/anthropic/v1/messages`    |
| `ANTHROPIC_API_KEY`                                                         | Placeholder; not read by the current version                                                                                                                                                                                                                              | none                                                |
| `ANTHROPIC_BASE_URL`                                                        | Placeholder; not read by the current version                                                                                                                                                                                                                              | `https://api.anthropic.com/v1/messages`             |
| `OPENAI_API_KEY`                                                            | Placeholder; not read by the current version                                                                                                                                                                                                                              | none                                                |
| `OPENAI_BASE_URL`                                                           | Placeholder; not read by the current version                                                                                                                                                                                                                              | `https://api.openai.com/v1/chat/completions`        |
| `AURAXIS_MODELS`                                                            | Custom models (JSON array)                                                                                                                                                                                                                                                | none                                                |
| `AURAXIS_ALLOW_UNSAFE_CODE`                                                 | Trusted dev environments only: let RunCode / dynamic plugins / inline workflows execute arbitrary code                                                                                                                                                                    | off                                                 |
| `AURAXIS_TRUST_PROJECT_RULES` / `AURAXIS_TRUST_PROJECT_HOOKS`               | Trust and load project `.auraxis/rules/*.rules` / `.auraxis/hooks.json`                                                                                                                                                                                                   | off                                                 |
| `AURAXIS_UNATTENDED_AUTOAPPROVE`                                            | Let cron / follow-up tasks / workflows run fully automated with full permissions                                                                                                                                                                                          | off (goes through ask)                              |
| `AURAXIS_SDK_TOKEN` / `AURAXIS_SDK_AUTOAPPROVE` / `AURAXIS_ACP_AUTOAPPROVE` | SDK / ACP server token and full-auto switches (a token is generated and reported to the client when unset)                                                                                                                                                                | random token / off                                  |
| `AURAXIS_SANDBOX_MODE` / `AURAXIS_SANDBOX_BACKEND`                          | Force sandbox mode (read / workspace-write / full) and native backend                                                                                                                                                                                                     | resolved from the permission preset                 |
| `AURAXIS_MCP_ALLOW_PRIVATE_HOSTS`                                           | Allow remote MCP endpoints on private addresses (denied by default as SSRF protection)                                                                                                                                                                                    | off by default                                      |
| `AURAXIS_MCP_ALLOWED_HOSTS`                                                 | Egress host allowlist for remote MCP, comma-separated (`example.com` includes subdomains, `.example.com` subdomains only)                                                                                                                                                 | no host restriction when unset                      |
| `AURAXIS_MEMORY_RISK_GATE`                                                  | Enable MAP-Graph memory risk gating (M5)                                                                                                                                                                                                                                  | off unless `1`                                      |
| `AURAXIS_MEMORY_EMBEDDINGS`                                                 | Enable R4 local deterministic vector route                                                                                                                                                                                                                                | off by default                                      |
| `AURAXIS_MEMORY_LLM_SIGNALS`                                                | Add LLM signal detection on top of rule signals                                                                                                                                                                                                                           | off by default                                      |
| `AURAXIS_AUTH_DISABLED`                                                     | Skip login gate for tests/CI (don't set in normal desktop use)                                                                                                                                                                                                            | off by default                                      |
| `AURAXIS_USER_DATA_DIR`                                                     | Override userData directory (account/settings isolation, tests)                                                                                                                                                                                                           | none by default                                     |
| `AURAXIS_TELEMETRY_MODE`                                                    | Telemetry switch (opt-in; `off` / `feedback-only` / `full`)                                                                                                                                                                                                               | off by default                                      |
| `AURAXIS_LLM_GATEWAY`                                                       | Force the LLM gateway. Unset = the OpenAI-compatible line (`/chat/completions`) runs through the official Vercel AI SDK, while Anthropic Messages / Responses stay on the built-in adapter; `builtin` reverts everything to the in-repo implementation (emergency switch) | `ai-sdk` for OpenAI-compatible, `builtin` otherwise |
| `AURAXIS_OTLP_ENDPOINT`                                                     | Export agent traces as OTLP/HTTP JSON spans (run / turn / tool / subagent; approvals become root-span attributes). Fires on agent termination and after headless runs. Delivery failures are logged and never affect the run                                              | off unless set                                      |
| `AURAXIS_OTLP_SERVICE_NAME` / `AURAXIS_OTLP_HEADERS`                        | `service.name` resource attribute / extra request headers (`k=v,k2=v2`)                                                                                                                                                                                                   | `auraxis` / none                                    |
| `AURAXIS_LOG_RETENTION_DAYS` / `AURAXIS_LOG_MAX_FILE_MB`                    | Log retention days / per-file cap                                                                                                                                                                                                                                         | 180 / 256                                           |

### 10.3 Custom Model Format

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

`protocol` is optional and accepts `openai-chat` (default) / `anthropic-messages` / `openai-responses`; declare it when the endpoint path is non-standard instead of relying on URL shape.

### 10.4 Dual API Format Support

Protocol resolution is centralised in `resolveModelProtocol()` in `electron/contracts/core.ts`, with this precedence: **an explicit `protocol` passed by the caller** → **a `protocol` declared on the model in settings / `AURAXIS_MODELS`** → **inference from the `apiBase` shape** (ending in `/responses` → the native **Responses API** for Codex-style clients; containing `/messages` or `/anthropic/` → Anthropic Messages; otherwise OpenAI-compatible).

The endpoint itself comes from `resolveModelApiBase()` (`AURAXIS_MODELS` → the custom model's `apiBase` from settings → otherwise `DEEPSEEK_BASE_URL`). Model capabilities (`tools` / `vision` / `reasoning`) are likewise provided by `modelCapabilities()`, so providers no longer do their own string checks; `DEEPSEEK_ANTHROPIC_BASE_URL` is currently reserved and takes no part in routing.

### 10.5 DeepSeek Official Capabilities & Interfaces

- **Reasoning effort**: `low / high / max` (`reasoning_effort`); Chat follows DeepSeek style (fixed high, controlled by the thinking toggle), Work/Code keep the slider. Because DeepSeek enables thinking by default, the agent-engine path sends an explicit `thinking: enabled|disabled` on every request (temperature is not sent while thinking), while the Chat streaming path only sends `enabled` when the thinking toggle is on
- **V4.1 Flash (deepseek-flash)**: multimodal by default — images are accepted in `user` messages (JPEG/PNG/GIF/WebP) and ReadImage results are delivered as image content. The retired legacy names (`deepseek-v4-flash-vision-exp`, `deepseek-v4-flash`) still resolve to it
- **strict tools (Beta)**: strict tool mode with automatic handling of empty schemas, avoiding "object cannot be empty" 400 errors
- **Plan-generation JSON mode**: agent planning uses JSON mode to produce TaskPlan
- **Conversation prefix continuation**: code-block "continue writing" uses the conversation prefix
- **FIM completion (Beta)**: code completion interface
- **Streaming usage & cache-hit display**: stream events carry usage / cache hits, shown inline in the UI
- **Context-cache alignment**: Work/Code persist canonical message snapshots per session and replay them each round; dynamic content (memory, new questions) is tailed; edits invalidate old snapshots (Sections 5.9 and 4.7)
- **user_id isolation**: DeepSeek user_id derived from the local account (auth-store → ai-handlers)
- **Max output tokens**: configurable, cap 384K
- **Official offline tokenizer**: local token counting, no network dependency
- **Native search**: DeepSeek official search is the default web-search provider with DuckDuckGo fallback; Exa / Perplexity also supported
- **Shadow adapter (AI SDK)**: `llm-adapter-ai-sdk.ts` plugs Vercel AI SDK 6 (`ai@^6.0.296`, using its Custom Provider extension point — no `@ai-sdk/*` package needed) in through `registerLlmAdapter('ai-sdk', …)`. It is **off by default and never on the production request path**; registration loads nothing (the SDK is imported lazily), and it exists to prove the adapter seam and scout a future migration — tests compare its output field-by-field against the built-in path for the same SSE stream

---

## 11. Main Window Configuration

`main.ts` ([view file](../electron/main.ts)) configures:

- **Window**: 1200×800, minimum 600×500, frameless (`frame: false`), macOS hides the title bar
- **CSP (Content Security Policy)**:
  - Dev mode: script-src allows `unsafe-inline` (required by Vite HMR), and `connect-src` additionally allows `http://localhost:*` and `ws://localhost:*`
  - Production: script-src is tightened to `'self'`; style-src still allows `'unsafe-inline'` and Google Fonts, img-src allows `'self' data: https: http:`, and frame-src allows `http://localhost:*` / `http://127.0.0.1:*` / `https:` (internal preview browser)
  - `connect-src` whitelists 9 explicit origins — `api.deepseek.com`, `html.duckduckgo.com`, `api.exa.ai`, `api.perplexity.ai`, `slack.com`, `www.googleapis.com`, `api.notion.com`, `fonts.googleapis.com`, `fonts.gstatic.com` (see `electron/network-policy.ts`; there is **no** `https://*` wildcard)
- **Single-instance lock**: `app.requestSingleInstanceLock()` prevents multiple instances
- **Global error handling**: `uncaughtException` and `unhandledRejection` are forwarded to the renderer via the `app:error` channel
- **Security**: only `https://` / `http://` external links are allowed

---

## 12. Build & Deployment

### 12.1 Build Flow

```
Source code
  ├── electron/ ──────────→ tsc6 (tsconfig.electron.json) ─────────→ dist-electron/
  ├── electron/preload.ts → vite build (vite.preload.config.mts) ─→ dist-electron/preload.js
  └── src/ ───────────────→ Vite build ───────────────────────────→ dist/

dist-electron/ + dist/ ──→ electron-builder ──→ release/
```

`electron/preload.ts` (together with its `preload-*.ts` domain modules) is bundled separately into `dist-electron/preload.js`: the sandboxed renderer cannot `require` local modules, so the bridge has to be inlined.

### 12.2 Packaging Configuration

`electron-builder.yml` targets three platforms:

- **Windows**: NSIS installer
- **macOS**: DMG (x64 + arm64)
- **Linux**: AppImage

### 12.3 Auto-update & Signing

- **Update channel**: packaged builds read the GitHub release metadata (`latest*.yml`) through `electron-updater`; electron-builder writes `app-update.yml` into the app resources. Settings → About offers check / download / restart-and-install, and the app also checks once 15 seconds after startup with `autoDownload = false` so it never pulls hundreds of MB in the background.
- **Signing & notarization**: CI reads `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` (Developer ID), `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` (notarization) and `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` (Windows code signing). When a secret is missing the build skips that step and still produces runnable unsigned artifacts.
- **Local verification**: `npx electron-builder --win --dir` only packs a directory (no installer, no `app-update.yml`); verify the update chain with a real target build on the matching platform.
- **Python SDK publishing**: `.github/workflows/publish-pypi.yml` builds `python/auraxis_sdk` into sdist + wheel (`python -m build`, `twine check`) and uploads to PyPI on `v*` tags. It first asserts the `pyproject.toml` version equals `package.json`'s, and when `PYPI_API_TOKEN` is absent it only builds and warns — the same skip-when-secret-missing behaviour as signing. The dev toolchain (ruff / pytest) is pinned in the `dev` extra; `npm run sdk:check:py` runs ruff + pyright + unittest locally.

### 12.4 Environment Variable Loading

The app uses a built-in `.env` parser to load environment variables from `.env` at the project root (no third-party `dotenv` dependency). Create a `.env` file (see `.env.example`) before running `npm run electron:dev`.

---

## 13. Development Conventions & Notes

### 13.1 Code Style

- **Language**: UI text and inline comments use **Chinese**; documentation is maintained in English (Chinese version: `docs/README.zh-CN.md`)
- **IPC handlers**: all async, returning `IpcResponse<T>`
- **State management**: global state only via Zustand stores; no Redux or React Context
- **Components**: function components + hooks; UI library is Ant Design 6

### 13.2 Testing

- **Framework**: Vitest (`describe`, `it`, `expect`, `vi` injected via globals)
- **Main-process tests**: `electron/**/__tests__/`, node environment; modules depending on `electron` are isolated with `vi.mock('electron', ...)`
- **Renderer tests**: `src/**/__tests__/`, jsdom environment (@testing-library/react)
- **Total**: 325 test files / 2,739 cases passing (platform-dependent skips excluded)
- **Coverage scope**: the branch gate counts `electron/**`, `src/stores/**`, `src/core/**`; UI components (`src/components/`) and main-process entry points (`main.ts` / `preload*.ts` etc.) are excluded from the gate and covered by component tests + Playwright E2E (`npm run test:e2e`)
- **Coverage thresholds**: lines/statements ≥ 80%, branches ≥ 80%, functions ≥ 80% (latest full branch gate: 89.86% statements / 92.25% lines / 81.36% branches / 89.00% functions; Electron main entry and the preload bridge are verified by E2E and SDK smoke; Linux CI runs the coverage gate by default; `check-doc-stats` tolerates ≤0.6pp platform drift)
- **Coverage report**: `npm run test:coverage` outputs `coverage/coverage-summary.json` (gitignored dev artifact); the Settings "Test coverage" page reads it live via the `coverage:get` IPC; pure browser dev is served by a Vite middleware, and production builds copy it into `dist/coverage/`. When the report is missing, the panel shows the command to run instead of fake numbers
- **E2E**: 16 Playwright UI flows passing (real Electron, including register → login → remember-me persistence)
- **Real-API acceptance (DeepSeek)**: chat streaming, Code auto-approve Bash, Code "confirm each time" permission card (write after one approval), Work smart-execution flow, and Work plan-approval panel all verified. On `deepseek-flash` (V4.1): image input (a colour swatch read back correctly), thinking on/off, multi-turn tool chains, chat/work/code surface gates (chat issues zero tool calls), and a fresh zero-dependency CommonJS + `node:test` project created and verified through `npm test` all pass; inline `RunWorkflow` remains fail-closed. A capped run (budget 3 from `agentMaxIterations`) stopped exactly at the budget with the files it wrote already on disk, and a composer follow-up resumed it. When the host cannot create the restricted token, the native Windows sandbox refuses execution instead of downgrading to an unsandboxed run (`electron/sandbox-runner.ts`)
- **Stress testing (local mock LLM + real Electron)**: 200 sessions cold start ~1.4s, session switch ~155ms, FTS rebuild ~178ms; 18 agents (6 concurrent) and 30 agents (8 concurrent) all completed without failure; under extreme load (30 tasks + 200 sidebar rows) fast mode switches occasionally stalled 8–11s with one >15s, recovering automatically after load; no issue at the default 3-concurrency setting
- **Environment**: local Python 3.10.x (3.10.9 as currently measured; the `python` on PATH is the Microsoft Store placeholder, so use `py -3`); `npm run sdk:test:py` passes 7 cases and `npm run sdk:smoke` verifies the live headless runtime
- **Commands**: `npm test` (all), `npm run test:backend` (IPC layer only — `vitest run electron/ipc`; `electron/` holds 189 test files, 147 of them under `electron/ipc/__tests__/`), `npm run test:frontend` (renderer), `npm run test:coverage` (coverage report), `npm run check:docs` (docs + version-stat checks), `node scripts/ui-preview.mjs` (one-off UI screenshot harness — runs the renderer in system Chrome against `npm run dev`, dev tool only, not in CI)

### 13.3 Type Contracts

Cross-process shared types are defined only in `electron/contracts/`; `electron/types.ts`, `electron/advanced-defs.ts`, and `src/types/*` all re-export. Never mirror a copy in the renderer.

### 13.4 Frontend Layout Architecture

The main UI is **Chat / Work / Code three modes** (switched in the sidebar; each mode keeps independent state, no split/fullscreen toggles):

```
┌─ Top Bar (title bar + window controls) ──────────────────┐
├─ Tab Bar (shown with multiple tabs) ────────────────────┤
├─────────────────────────────────────────────────────────┤
│ Sider │ Floating header (mode switch / compact / fork / log)
│ (Nav) │ ─────────────────────────────────────────────── │
│       │ Message area (fills the whole chat area, extends │
│       │  behind the floating layers)                    │
│       │                                                │
│       │ [Floating input dock: context row + input + toolbar]
└───────┴────────────────────────────────────────────────┘
```

- **Three modes**: Chat (conversation) / Work (task execution) / Code (coding) switched from the sidebar; thinking, web-search, and session state are saved per mode (`modeThinkingPrefs`) and restored on switch-back
- **Login & account**: AuthGate login gate (first-run registration, skippable); account + avatar in the top bar left of the Settings button; AccountPane supports password change and avatar upload
- **Input dock**: Chat shows a thinking toggle + web-search button (adjacent, DeepSeek style) with no thinking-depth picker; Work/Code default thinking on with a low/medium/high slider (magnetic streaming effect); input has rounded corners, no focus glow
- **Work mode**: centered input, task board + agent execution flow (rounds / tool rows / deliverables / status); **docs-only boundary** — Work tasks may only write document/non-code files, code writes are hard-rejected by `electron/work-docs-policy.ts`, and the input shows a "Docs only" badge
- **Right panel**: opened from the workbench dropdown, never covers main content; at minimum width there is no close button (only collapse); every feature (Changes / Files / Execution / Timeline / Preview) has a "New" action that opens it in a second pane, and the split is **side by side**
- **Main area is the conversation**: the top tab bar is gone — file / change / preview views live in the right panel, so the header's nav history no longer tracks tab switches
- **Full-bleed message area + floating layers**: the input dock and top header are floating; messages fade out via gradients when passing behind them; the list pads header/footer with scroll space equal to the floating layers
- **Top divider**: shown while a conversation is running, hidden when the window is maximized
- **Token/model status** is inline above the input dock; no separate inspector panel

### 13.5 Known Limitations

- **Persisted key prefix**: unified as `auraxis-`; `auraxis_keybindings` is the exception
- **Hardcoded limits**:
  - Agent business iteration cap 200 (configurable), safety hard cap 500
  - Scheduler max concurrency 3
  - Session list keeps at most 200 sessions (each session keeps up to 200 messages)
  - Agent logs capped at 500 entries
  - Only the last 40 messages persisted per session (`useChatStore`)
  - Voice input usually unavailable in Electron (`webkitSpeechRecognition` restricted)

### 13.6 Design System

Aura design system — "Black is the Axis, White is the Structure, Purple is the Aura":

- **Brand colors**: Auraxis Black `#111216` (dark base) / Ivory `#F1F1EE` (light text) + Aura purple-gray `#8C8AA8` at ~3% accent only; **no blue or large colorful gradients**
- **Six corner radii**: 5 / 6 / 8 / 12 / 14 / 9999; 3/4/7/9/10px fragments forbidden
- **Hairline borders**: `--color-border-dim` for all hairlines; no dark solid lines, no heavy shadow stacking
- **Zero-position animations**: no hover movement/scale or dialog open/close animations; only functional rotation and data-driven animations
- **Selected state**: background highlight (`bg-primary-soft`), **no left color bars**
- **Font weights**: body 400 / items & buttons 500 / titles & active 600; controls 36px high; content width 748px
- **Icons**: `lucide-react` via the `src/components/common/icons.tsx` compatibility layer; **AntD icons and @phosphor-icons/react are banned**
- **Fonts**: Latin text uses the bundled `Inter Variable`, then falls back to the CJK system stack (`Segoe UI` / `PingFang SC` / `Microsoft YaHei`); the monospace stack is `SF Mono, JetBrains Mono, Fira Code, Cascadia Code, Consolas`
- **Animation**: `prefers-reduced-motion` support; execution waiting uses the **Auraxis run mark** (vector: axis + aura + an arc travelling the orbit, `src/components/common/ExecutingIndicator.tsx`) + gradient streaming text; the thinking-depth slider is a data-driven magnetic animation (effect grows with depth, magnetism decreases)
- **Sidebar transparency**: Settings → Appearance → Sidebar transparency (0–100%); native Acrylic (`backgroundMaterial: 'acrylic'`) only on Windows 11, slider auto-disabled elsewhere; most-transparent keeps ~12% base for readability; the top bar stays opaque

### 13.7 IDE Alias

Vite and TypeScript both map `@/` to `src/`:

```typescript
// Equivalent to src/components/chat/MessageBubble.tsx
import { MessageBubble } from '@/components/chat/MessageBubble';
```

---

## Appendix: Quick Reference

### Common Commands

```bash
npm run electron:dev     # Full dev environment
npm run dev              # Frontend only (Vite HMR, no Electron)
npm run electron:compile # Compile the main process + bundle the preload bridge
npm test                 # Run all tests
npm run test:backend     # Backend tests
npm run test:frontend    # Frontend tests
npm run test:coverage    # Coverage tests
npm run build            # Production build
```

### Key File Index

| File                                                                                                        | Responsibility                                                                              |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [electron/main.ts](../electron/main.ts)                                                                     | App entry                                                                                   |
| [electron/preload.ts](../electron/preload.ts)                                                               | IPC bridge                                                                                  |
| [electron/preload-api.ts](../electron/preload-api.ts)                                                       | IPC bridge composition                                                                      |
| [vite.preload.config.mts](../vite.preload.config.mts)                                                       | Sandbox-safe preload bundling                                                               |
| [electron/ipc/index.ts](../electron/ipc/index.ts)                                                           | IPC registration entry                                                                      |
| [electron/tool-defs.ts](../electron/tool-defs.ts)                                                           | Tool definitions                                                                            |
| [electron/tool-defs/](../electron/tool-defs/)                                                               | Tool definitions (capability modules)                                                       |
| [electron/agent-runtime/step-engine.ts](../electron/agent-runtime/step-engine.ts)                           | Unified ReAct step engine                                                                   |
| [electron/ipc/query-engine.ts](../electron/ipc/query-engine.ts)                                             | Chat driver                                                                                 |
| [electron/ipc/query-context.ts](../electron/ipc/query-context.ts)                                           | Canonical context snapshots (cache-aligned replay / memory dedup / invalidation tombstones) |
| [electron/agent-runtime/agent-loop.ts](../electron/agent-runtime/agent-loop.ts)                             | Agent driver (plan/approval/deviance/stop)                                                  |
| [electron/agent-runtime/agent-loop-prepare.ts](../electron/agent-runtime/agent-loop-prepare.ts)             | Agent context/prompt preparation                                                            |
| [electron/agent-runtime/agent-loop-interceptors.ts](../electron/agent-runtime/agent-loop-interceptors.ts)   | Plan/replan synthetic tool seams                                                            |
| [electron/ipc/agent-subagent-registry.ts](../electron/ipc/agent-subagent-registry.ts)                       | Sub-agent registry and observer bridge                                                      |
| [electron/ipc/agent-scheduler.ts](../electron/ipc/agent-scheduler.ts)                                       | Multi-agent scheduling                                                                      |
| [electron/ipc/agent-scheduler-runner.ts](../electron/ipc/agent-scheduler-runner.ts)                         | Scheduler run lifecycle                                                                     |
| [electron/ipc/agent-scheduler-queue.ts](../electron/ipc/agent-scheduler-queue.ts)                           | Scheduler queue helpers                                                                     |
| [electron/ipc/tool-handlers.ts](../electron/ipc/tool-handlers.ts)                                           | Tool execution facade (registry/pipeline live in tool-handlers/)                            |
| [electron/ipc/tool-handlers/runtime.ts](../electron/ipc/tool-handlers/runtime.ts)                           | Cron / schedule / task / job tools                                                          |
| [electron/ipc/tool-handlers/lsp.ts](../electron/ipc/tool-handlers/lsp.ts)                                   | LSP code intelligence                                                                       |
| [electron/ipc/tool-handlers/review.ts](../electron/ipc/tool-handlers/review.ts)                             | ReviewArtifact quality gate                                                                 |
| [electron/ipc/tool-handlers/execution.ts](../electron/ipc/tool-handlers/execution.ts)                       | Plugin / skill / workflow / code / PowerShell tools                                         |
| [electron/ipc/tool-handlers/worktree.ts](../electron/ipc/tool-handlers/worktree.ts)                         | Git worktree sandbox session tools                                                          |
| [electron/ipc/agent-scheduler-class-impl.ts](../electron/ipc/agent-scheduler-class-impl.ts)                 | Multi-agent scheduler implementation (agent-scheduler-class.ts is a compat entry)           |
| [electron/ipc/agent-scheduler-types.ts](../electron/ipc/agent-scheduler-types.ts)                           | Scheduler contracts + plan mapping                                                          |
| [electron/ipc/permission-handlers.ts](../electron/ipc/permission-handlers.ts)                               | Permission control                                                                          |
| [electron/code-mode.ts](../electron/code-mode.ts)                                                           | Code Mode (TS tool orchestration)                                                           |
| [electron/agent-runtime/step-compressor.ts](../electron/agent-runtime/step-compressor.ts)                   | AGORA step compression                                                                      |
| [electron/agent-runtime/step-engine-tools.ts](../electron/agent-runtime/step-engine-tools.ts)               | Shared step tool batch seam                                                                 |
| [electron/agent-runtime/step-engine-tool-results.ts](../electron/agent-runtime/step-engine-tool-results.ts) | Step tool-result formatting                                                                 |
| [electron/agent-runtime/context-manager-snapshot.ts](../electron/agent-runtime/context-manager-snapshot.ts) | Atomic-group safe truncation                                                                |
| [electron/agent-runtime/context-manager-summary.ts](../electron/agent-runtime/context-manager-summary.ts)   | Context summary generation                                                                  |
| [electron/workspace-drift.ts](../electron/workspace-drift.ts)                                               | SWE-Touch workspace drift                                                                   |
| [electron/approval-fatigue.ts](../electron/approval-fatigue.ts)                                             | Oversight approval fatigue                                                                  |
| [electron/tool-inertia.ts](../electron/tool-inertia.ts)                                                     | AutoTool tool inertia                                                                       |
| [electron/skill-gate.ts](../electron/skill-gate.ts)                                                         | VaG skill gate                                                                              |
| [electron/auth-store.ts](../electron/auth-store.ts)                                                         | Local account (register/login/avatar)                                                       |
| [electron/ipc/memory-read.ts](../electron/ipc/memory-read.ts)                                               | Eywa deterministic read path                                                                |
| [electron/ipc/memory-graph.ts](../electron/ipc/memory-graph.ts)                                             | MAP-Graph authorization gating                                                              |
| [electron/contracts/](../electron/contracts/)                                                               | Cross-process type contracts                                                                |
| [electron/session-store.ts](../electron/session-store.ts)                                                   | Unified event logs                                                                          |
| [src/App.tsx](../src/App.tsx)                                                                               | React root component                                                                        |
| [src/stores/useChatStore.ts](../src/stores/useChatStore.ts)                                                 | Chat state                                                                                  |
| [src/stores/agentStoreActions.ts](../src/stores/agentStoreActions.ts)                                       | Agent store actions                                                                         |
| [src/stores/sessionStoreActions.ts](../src/stores/sessionStoreActions.ts)                                   | Session store actions                                                                       |
| [src/stores/settingsStoreActions.ts](../src/stores/settingsStoreActions.ts)                                 | Settings store mutations                                                                    |
| [src/components/auth/AuthGate.tsx](../src/components/auth/AuthGate.tsx)                                     | Login gate                                                                                  |
| [src/components/work/WorkExecutionFlow.tsx](../src/components/work/WorkExecutionFlow.tsx)                   | Work execution flow view                                                                    |
| [src/components/input/ThinkingDepthSelector.tsx](../src/components/input/ThinkingDepthSelector.tsx)         | Thinking-depth slider (magnetic streaming effect)                                           |
| [src/core/plugin-manager.ts](../src/core/plugin-manager.ts)                                                 | Plugin management                                                                           |
| [src/styles/theme.ts](../src/styles/theme.ts)                                                               | Theme configuration                                                                         |
