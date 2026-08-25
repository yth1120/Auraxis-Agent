<img width="3078" height="1376" alt="" src="https://github.com/user-attachments/assets/cc06146b-51a2-4b2e-a6c4-41aca0a0fb5e" />

# Auraxis Architecture & Development Documentation

Related docs: [TS SDK](../packages/auraxis-sdk/README.md) · [Python SDK](../python/auraxis_sdk/README.md) · [Engineering conventions](../AGENTS.md) · [中文版](README.zh-CN.md)

## 1. Project Overview

Auraxis v3.2.0 is an Electron-based desktop agentic workbench that combines a unified ReAct step engine, multi-agent scheduling, Code Mode tool orchestration, plugin extensibility, and persistent project memory. Execution semantics follow the common convention (`end_turn` ends the turn — no scripts or forced gates), and ReviewArtifact is an optional verification tool. The backend LLM defaults to the DeepSeek API (OpenAI / Anthropic compatible formats). Web search defaults to DeepSeek's native search (falling back to DuckDuckGo, with Exa and Perplexity also supported). Official DeepSeek capabilities are integrated: reasoning effort low/high/max, strict tools (Beta), plan-generation JSON mode, conversation prefix continuation ("continue writing" from a code block), FIM completion (Beta) API, streaming usage with context-cache hit display, user_id isolation, configurable max output tokens (up to 384K), and local offline tokenizer counting.

The project follows **paper-driven development**: 7 arXiv papers' core techniques — Eywa (provenance-grounded long-term memory), MAP-Graph (multi-agent shared-memory authorization), AGORA (step-level context compression), SWE-Touch (workspace drift detection), Oversight Has a Capacity (approval fatigue guard), AutoTool (tool usage inertia), Verifier-as-Gatekeeper (skill pollution gating); plus 4 caching-oriented techniques — RadixAttention (canonical history replay / shared-prefix maximization), Prompt Cache (stable block organization), Cache-Aware Prompt Compression (dynamic content tailing), and Byte-Exact Deduplication (byte-exact dedup of memory blocks). Paper links, technical mappings, and landing modules are detailed in [Section 5](#5-research-papers--technical-implementation). Product-side additions include local account login, Chat / Work / Code modes, thinking and web-search toggles, Agent execution flow views, session event timelines, and context-cache alignment.

- **Main process**: Electron main process (`electron/`) — window management, IPC communication, tool execution, agent scheduling
- **Renderer**: React 19 + Vite 8 (`src/`) — UI rendering, state management, user interaction
- **IPC**: bidirectional communication via Electron IPC (`contextBridge` + `ipcMain/ipcRenderer`)

### Tech Stack

<img width="1198" height="776" alt="auraxis-ui" src="https://github.com/user-attachments/assets/88f118c2-fc15-4779-8be3-928cb9c04ae8" />

| Layer               | Technology                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop framework   | Electron 44 (Node 24, built-in `node:sqlite`), frameless window, `contextIsolation: true`                                                             |
| Frontend            | React 19 + TypeScript 6 + Vite 8                                                                                                                      |
| UI components       | Ant Design 6 with custom dark / light themes                                                                                                          |
| State management    | Zustand 5; session/settings/plugin state is authoritative in the main process, localStorage is only a renderer cache                                  |
| Storage & retrieval | Unified JSONL event logs for sessions/agents + SQLite projection cache + FTS5 full-text search + long-term memory (better-sqlite3 with JSON fallback) |
| Markdown rendering  | react-markdown + remark-gfm + rehype-highlight + rehype-katex + mermaid                                                                               |
| AI API              | axios (SSE streaming), DeepSeek / OpenAI and Anthropic formats; MCP, AGENTS.md, and lifecycle hooks protocols                                         |
| Testing             | Vitest + @testing-library/react + jsdom (renderer), node environment (main process)                                                                   |
| Build               | Vite + electron-builder 26 (NSIS / DMG / AppImage; native deps require Python/VS toolchain for rebuild)                                               |

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
- **Professional document skills**: `ReadDocument` / `WriteDocument` for Word (.docx), Excel (.xlsx), PPT (.pptx), PDF (.pdf); 5 built-in skills (Word / Excel / PPT / PDF / cloud connectors)
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
Electron Main Process (electron/)            Renderer Process (src/)
┌──────────────────────────────────┐    ┌──────────────────────────────┐
│ main.ts — window, CSP, lock      │    │ main.tsx → App.tsx            │
│ preload.ts — contextBridge API   │◄──►│ React 19 + Ant Design 6       │
│                                  │    │                              │
│ ipc/index.ts — 30+ modules       │IPC │ Zustand Stores (18)           │
│ ipc/step-engine.ts — ReAct step  │    │                              │
│ ipc/query-engine.ts — chat drive │    │ src/core/ — plugin manager    │
│ ipc/agent-loop.ts — agent drive  │    │   tool/command registry       │
│ ipc/agent-scheduler.ts — sched.  │    │                              │
│ ipc/agent-handlers.ts — CRUD     │    │                              │
│ ipc/tool-handlers.ts — 71 tools  │    │ src/components/ — UI         │
│ tool-defs.ts — 71 tool defs      │    │  chat/, input/, layout/,      │
│ ipc/permission-*.ts — perms      │    │  settings/, agent/,           │
│ ipc/mcp-handlers.ts — MCP        │    │  permissions/, preview/       │
│ ipc/memory-*.ts — memory         │    │                              │
│ ipc/model-config.ts — models     │    │ @/ alias → src/               │
│ ipc/settings-store.ts — storage  │    │                              │
│ ipc/conflict-detector.ts — locks │    │                              │
│ ipc/undo-manager.ts — undo       │    │                              │
│ ipc/plan-handlers.ts — plan      │    │                              │
│ code-mode.ts — Code Mode         │    │                              │
│ step-compressor.ts — AGORA       │    │                              │
│ workspace-drift.ts — SWE-Touch   │    │                              │
│ approval-fatigue.ts — Oversight  │    │                              │
│ tool-inertia.ts — AutoTool       │    │                              │
│ skill-gate.ts — VaG gate         │    │                              │
│ attachments.ts — attachments     │    │                              │
│ session-store.ts — event logs    │    │                              │
│ sandbox-runner.ts — sandbox      │    │                              │
│ sdk-server / acp-server / headless│   │                              │
└──────────────────────────────────┘    └──────────────────────────────┘
```

### 2.2 Directory Structure

```
Auraxis/
├── electron/                    # Main process code (Node.js)
│   ├── main.ts                  # App entry: window, CSP, single-instance lock
│   ├── preload.ts               # contextBridge API for the renderer
│   ├── types.ts                 # Shared types (ApprovalPolicy, IpcResponse, ModelDefinition…)
│   ├── tool-defs.ts             # 71 AI tool definitions (name, description, input schema)
│   ├── contracts/               # Single source of truth for cross-process types
│   ├── advanced-defs.ts         # MCP / Agent / Permission advanced types
│   └── ipc/                     # IPC handler modules
│       ├── index.ts             # registerIpcHandlers() entry
│       ├── ai-handlers.ts       # Chat stream, query engine, interrupt, connection test
│       ├── query-engine.ts      # Chat-mode ReAct loop (3 API retries)
│       ├── step-engine.ts       # Unified ReAct stepping (shared by chat & agents)
│       ├── agent-loop.ts        # Agent driver (planning / deviance / compaction / stop)
│       ├── agent-handlers.ts    # Agent CRUD + 3 built-in agent types + parent-child links
│       ├── agent-scheduler.ts   # Multi-agent concurrent scheduler (queue, limits, pause/resume)
│       ├── tool-handlers.ts     # 71 tool executors + permission guards + structured summaries
│       ├── permission-handlers.ts # Permission checks, rules, dialog requests
│       ├── mcp-handlers.ts      # MCP protocol client (JSON-RPC, discovery, security)
│       ├── model-config.ts      # Model resolution (built-in + env + persisted)
│       ├── memory-db.ts         # Provenance memory store (Evidence/Signal/Belief, SQLite + JSON)
│       ├── memory-extractor.ts  # LLM-driven belief extraction (hard anchor validation)
│       ├── memory-ipc.ts        # Memory CRUD IPC bridge
│       ├── memory-evidence.ts   # Eywa M1: immutable evidence capture
│       ├── memory-read.ts       # Eywa M3: deterministic multi-route retrieval (zero LLM)
│       ├── memory-graph.ts      # MAP-Graph M5: role authorization / path trust / risk gate
│       ├── belief-validation.ts # Eywa M2: belief hard-anchor validation
│       ├── signal-rules.ts      # Eywa M2: rule-based signal detection
│       ├── context-handlers.ts  # Project context (instruction files, file tree, package.json)
│       ├── file-handlers.ts     # File operations (open/read/write/search)
│       ├── project-handlers.ts  # Project ops (file tree, directory picker, apply/preview)
│       ├── system-handlers.ts   # System info (stats, git branches, version)
│       ├── settings-store.ts    # Encrypted persisted settings (API keys via safeStorage)
│       ├── coverage-handlers.ts # Test coverage report reader (coverage/coverage-summary.json)
│       ├── conflict-detector.ts # Multi-agent file locks against concurrent writes
│       ├── undo-manager.ts      # File-level undo (snapshots + restore)
│       ├── plan-handlers.ts     # Plan approval flow (send → frontend → wait → timeout)
│       ├── shared.ts            # Path validation, safe extensions, excluded dirs
│       ├── text-filter.ts       # Strips model artifacts (thinking tags, zero-width chars…)
│       ├── code-mode.ts         # Code Mode: TS program + tool bindings + concurrent calls (worker)
│       ├── step-compressor.ts   # AGORA step compression (inference-free, keep/drop whole steps)
│       ├── workspace-drift.ts   # SWE-Touch shared-workspace drift detection
│       ├── approval-fatigue.ts  # Oversight approval fatigue guard (inverted-U supervision)
│       ├── tool-inertia.ts      # AutoTool tool inertia graph (TIG)
│       ├── skill-gate.ts        # VaG skill pre-commit gate
│       ├── auth-store.ts        # Local account (register/login/avatar, scrypt)
│       ├── attachments.ts       # Content-addressed attachment storage (ReadImage backend)
│       ├── fork-runner.ts       # One-shot forked sub-agents (headless child process)
│       ├── schedule-store.ts    # In-session follow-up tasks (after/at/every)
│       ├── session-store.ts     # Unified JSONL event logs (chat & agent)
│       ├── sandbox-runner.ts    # Native sandbox dispatch (restricted/AppContainer/linux/macos)
│       ├── acp-server.ts / sdk-server.ts / headless-run.ts  # ACP / JSON-RPC SDK / headless
│       └── __tests__/           # Main-process tests (245 files / 1789 cases repo-wide)
│
├── src/                         # Renderer code (browser environment)
│   ├── main.tsx                 # React entry
│   ├── App.tsx                  # Root component: layout, theme, permission dialogs, command palette
│   ├── components/              # UI components
│   │   ├── chat/                # Chat (message list, bubbles, Markdown, input)
│   │   ├── layout/              # Layout (sidebar, top bar, right panel, nav)
│   │   ├── settings/            # Settings panels
│   │   ├── permissions/         # Permission dialogs
│   │   ├── agent/               # Agent panel + execution flow + graph workflow
│   │   ├── memory/              # Memory panel
│   │   ├── auth/                # Auth gate (AuthGate), Avatar
│   │   ├── work/                # Work mode board + agent execution flow
│   │   ├── input/               # Input dock, thinking-depth slider, mode switcher
│   │   ├── skills/              # Skills UI
│   │   ├── tools/               # Tools UI
│   │   ├── inspector/           # Plan / inspector panels
│   │   ├── preview/             # File tree panel, preview browser
│   │   └── common/              # Shared components
│   ├── stores/                  # Zustand stores (18)
│   │   ├── useChatStore.ts      # Chat messages, stream, retry, project context, memory injection
│   │   ├── useAuthStore.ts      # Login state, account info, avatar
│   │   ├── useSettingsStore.ts  # API key, default model, notifications
│   │   ├── useAppStore.ts       # Theme, sidebar, right panel, nav history
│   │   ├── useAgentStore.ts     # Agent CRUD, priority, concurrency (persisted, RAF-throttled)
│   │   ├── useSessionStore.ts   # Session save/load/delete/export/fork (max 40)
│   │   ├── useProjectStore.ts   # Project registry, current project, workspace order
│   │   ├── usePluginStore.ts    # Installed plugins, enable/disable
│   │   ├── useMemoryStore.ts    # Active/search memory (loaded from main)
│   │   ├── useFileTreeStore.ts  # File tree, expanded paths
│   │   ├── useUndoStore.ts      # Undo entries
│   │   ├── useInspectorStore.ts # Plan, system messages, active tool count (data only)
│   │   ├── useWorktreeStore.ts  # Worktree sandbox state (active/sandbox path)
│   │   ├── useAdvancedStore.ts  # MCP servers, legacy agent settings
│   │   ├── useTerminalTasksStore.ts # Terminal task list (background bash state)
│   │   ├── useNotificationStore.ts  # Notifications / unread counts
│   │   ├── useMessageFeedbackStore.ts # Per-message ratings persistence
│   │   └── useKeybindingsStore.ts # Keybinding overrides
│   ├── core/                    # Core logic
│   │   ├── plugin-manager.ts    # Plugin install/uninstall/enable/disable
│   │   ├── plugin-loader.ts     # Dynamic loading + security scan
│   │   ├── tool-registry.ts     # Plugin tool registry
│   │   ├── command-registry.ts  # Plugin command registry
│   │   └── __tests__/           # Core logic tests
│   ├── services/                # AI services (browser fallback)
│   ├── types/                   # Renderer types (re-export electron/contracts)
│   ├── plugins/                 # Built-in example plugins
│   ├── styles/                  # Theme config (dark/light)
│   ├── hooks/                   # Custom React hooks
│   └── constants/               # Keybindings, extension colors
│
├── scripts/                     # Dev scripts
│   └── electron-dev.js          # Launch Electron after clearing ELECTRON_RUN_AS_NODE
├── docs/                        # Docs
│   └── README.md                # Architecture & development docs
├── package.json
├── tsconfig.json                # Renderer TS config (ESNext/bundler, @/* → src/*)
├── tsconfig.node.json           # Vite config (composite project reference)
├── tsconfig.electron.json       # Main process TS config (CommonJS → dist-electron/, rootDir: electron/)
├── vite.config.mts              # Vite build config
├── vitest.config.ts             # Test config (coverage thresholds: 80% lines / 70% branches / 80% functions)
├── electron-builder.yml         # Packaging config (NSIS/DMG/AppImage)
└── .env.example                 # Environment variable template
```

### 2.3 TypeScript Configuration Notes

The project has three `tsconfig` files. `tsconfig.electron.json` sets `rootDir: "electron/"`, which means the main process **cannot import types from `src/`**. Shared cross-process types are therefore defined in one place:

- **Cross-process contract single source of truth**: `electron/contracts/` (`core.ts` / `tools.ts` / `advanced.ts` / `session-types.ts`) is the only place they are defined; `electron/types.ts`, `electron/advanced-defs.ts`, and `src/types/*` all re-export from it — no more mirrored maintenance in two places.

`tsconfig.electron.json` keeps `rootDir: "electron/"` (CommonJS output to `dist-electron/`). New shared types must go into `contracts/` and be re-exported on both ends; do not copy types into `src/`.

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
                                   mainWindow.webContents.send('ai:queryEvent:${id}', ...)
  ← ipcRenderer.on()        ←──        ↓
  → callback.onEvent(data)           (tool executions, text chunks, errors, …)
```

### 3.2 IPC Channel Naming

**Format**: `domain:action` (kebab-case namespace + colon separator)

### 3.3 IPC Response Contract

All handlers return a unified shape:

```typescript
interface IpcResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
```

### 3.4 Streaming

Streaming requests use **dedicated event channels**:

- Chat stream: `ai:chunk:${requestId}`
- Query stream: `ai:queryEvent:${requestId}`
- Agent events: `agent:event:${agentId}`

Each channel registers its listener when the request is created and cleans up automatically on `done` / `error` or `abort`.

### 3.5 Full IPC Channel Table

| Domain         | Channel                                                                   | Direction     | Description                                                                            |
| -------------- | ------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| **window**     | `window:minimize`                                                         | renderer→main | Minimize window                                                                        |
|                | `window:maximize`                                                         | renderer→main | Maximize / restore window                                                              |
|                | `window:close`                                                            | renderer→main | Close window                                                                           |
|                | `window:focus`                                                            | renderer→main | Focus window (notification click)                                                      |
|                | `window:isMaximized`                                                      | renderer→main | Query maximized state                                                                  |
|                | `window:maximize-changed`                                                 | main→renderer | Maximize state change event                                                            |
|                | `window:setBackgroundMaterial` / `window:backgroundMaterialSupported`     | renderer→main | Sidebar Acrylic material toggle & support check (Windows 11)                           |
| **shell**      | `shell:openExternal`                                                      | renderer→main | Open URL in default browser (http/https only)                                          |
|                | `shell:openInVSCode`                                                      | renderer→main | Open project in VS Code                                                                |
| **file**       | `file:open`                                                               | renderer→main | Open file dialog                                                                       |
|                | `file:read`                                                               | renderer→main | Read file content                                                                      |
|                | `file:write`                                                              | renderer→main | Write file                                                                             |
|                | `file:search`                                                             | renderer→main | Search files by keyword                                                                |
| **project**    | `project:getTree`                                                         | renderer→main | Get project file tree                                                                  |
|                | `project:applyCode`                                                       | renderer→main | Apply code to files                                                                    |
|                | `project:previewCode`                                                     | renderer→main | Preview code (HTML/images…)                                                            |
|                | `project:selectDirectory`                                                 | renderer→main | Pick project directory                                                                 |
| **context**    | `context:getProjectContext`                                               | renderer→main | Project context (instruction files, file tree, package.json)                           |
|                | `context:getFileStructure`                                                | renderer→main | File structure overview                                                                |
|                | `context:readFile`                                                        | renderer→main | Read file (for context)                                                                |
| **ai**         | `ai:chatStream`                                                           | renderer→main | Start chat stream (pure conversation, no tools)                                        |
|                | `ai:sendQuery`                                                            | renderer→main | Start query (full ReAct loop)                                                          |
|                | `ai:testConnection`                                                       | renderer→main | Test API connection                                                                    |
|                | `ai:abortStream` / `ai:abortQuery`                                        | renderer→main | Abort stream / query                                                                   |
|                | `ai:abortTool`                                                            | renderer→main | Abort a single tool execution                                                          |
|                | `ai:retryTool`                                                            | renderer→main | Retry a tool execution                                                                 |
|                | `ai:chunk:${requestId}`                                                   | main→renderer | Chat stream text chunks                                                                |
|                | `ai:queryEvent:${requestId}`                                              | main→renderer | All query-stream events (tool start/end, text…)                                        |
| **memory**     | `memory:extract`                                                          | renderer→main | Extract memory from conversation                                                       |
|                | `memory:getByProject`                                                     | renderer→main | Get memory by project                                                                  |
|                | `memory:getByType`                                                        | renderer→main | Get memory by type                                                                     |
|                | `memory:search`                                                           | renderer→main | Search memory                                                                          |
|                | `memory:archive` / `memory:delete`                                        | renderer→main | Archive / delete memory                                                                |
|                | `memory:evidenceList` / `memory:evidenceDetail`                           | renderer→main | List / view immutable evidence (Eywa M1)                                               |
|                | `memory:readForQuery`                                                     | renderer→main | Deterministic multi-route retrieval → context + policy + facts + diagnostics (Eywa M3) |
|                | `memory:beliefAudit`                                                      | renderer→main | Belief evidence chain, signals, revision history (Eywa M4)                             |
|                | `memory:readTrace`                                                        | renderer→main | Per-route retrieval result by read_run                                                 |
|                | `memory:erase`                                                            | renderer→main | Cascade-erase evidence/beliefs/read traces by scope, leaving audit events              |
|                | `memory:reindex`                                                          | renderer→main | Rebuild signals/beliefs from existing evidence                                         |
|                | `memory:graph`                                                            | renderer→main | MAP-Graph typed execution graph (role authorization / lineage)                         |
| **agent**      | `agent:create` / `agent:start`                                            | renderer→main | Create / start agent                                                                   |
|                | `agent:stop` / `agent:schedulerStop`                                      | renderer→main | Stop agent                                                                             |
|                | `agent:pause` / `agent:resume`                                            | renderer→main | Pause / resume agent                                                                   |
|                | `agent:setPriority`                                                       | renderer→main | Set priority                                                                           |
|                | `agent:getQueue`                                                          | renderer→main | Get pending queue                                                                      |
|                | `agent:setMaxConcurrent`                                                  | renderer→main | Set max concurrency                                                                    |
|                | `agent:getAll` / `agent:list` / `agent:get`                               | renderer→main | Query agent list / detail                                                              |
|                | `agent:remove` / `agent:clear`                                            | renderer→main | Remove / clear agents                                                                  |
|                | `agent:updated`                                                           | main→renderer | Agent state update event                                                               |
|                | `agent:event:${agentId}`                                                  | main→renderer | Agent execution events (tool calls…)                                                   |
| **mcp**        | `mcp:getServers` / `mcp:setServers`                                       | renderer→main | MCP server config                                                                      |
|                | `mcp:connect` / `mcp:disconnect`                                          | renderer→main | Connect / disconnect MCP server                                                        |
|                | `mcp:getStatuses`                                                         | renderer→main | All server statuses                                                                    |
|                | `mcp:listTools` / `mcp:callTool`                                          | renderer→main | List / call MCP tools                                                                  |
| **permission** | `permission:respond`                                                      | renderer→main | User reply to a permission request                                                     |
|                | `permission:addRule`                                                      | renderer→main | Add permission rule                                                                    |
|                | `permission:getRules`                                                     | renderer→main | Get all rules                                                                          |
|                | `permission:request`                                                      | main→renderer | Permission request event                                                               |
| **plan**       | `plan:approve` / `plan:reject`                                            | renderer→main | Approve / reject plan                                                                  |
|                | `plan:generated`                                                          | main→renderer | Plan generated event                                                                   |
| **undo**       | `undo:getHistory` / `undo:getList`                                        | renderer→main | Get undo history                                                                       |
|                | `undo:execute` / `undo:revert` / `undo:revertLast`                        | renderer→main | Execute undo / restore                                                                 |
|                | `undo:getSessionDiffs` / `undo:revertSessionFile` / `undo:revertSessions` | renderer→main | Per-session diff view / rollback (right panel "Changes")                               |
| **conflict**   | `conflict:getConflicts`                                                   | renderer→main | Get conflict list                                                                      |
|                | `conflict:getFileHistory`                                                 | renderer→main | Get file modification history                                                          |
| **snapshot**   | `snapshot:create` / `list` / `restore` / `delete`                         | renderer→main | Named snapshot management                                                              |
| **system**     | `system:getStats`                                                         | renderer→main | System stats                                                                           |
|                | `system:getGitBranches`                                                   | renderer→main | Git branches                                                                           |
|                | `system:getVersion`                                                       | renderer→main | App version                                                                            |
|                | `system:getAccountInfo`                                                   | renderer→main | DeepSeek account balance (/user/balance)                                               |
| **settings**   | `settings:get` / `settings:set`                                           | renderer→main | Read / write settings                                                                  |
|                | `settings:getApiKey` / `api:setKey`                                       | renderer→main | API key management                                                                     |
|                | `settings:set` (permissionPreset / sandboxMode)                           | renderer→main | Unified runtime-permission persistence                                                 |
| **coverage**   | `coverage:get`                                                            | renderer→main | Read coverage report (coverage/coverage-summary.json)                                  |
| **auth**       | `auth:status` / `auth:setup`                                              | renderer→main | Query login phase / first-run registration                                             |
|                | `auth:login` / `auth:logout`                                              | renderer→main | Login / logout                                                                         |
|                | `auth:changePassword`                                                     | renderer→main | Change account password                                                                |
|                | `auth:setAvatar`                                                          | renderer→main | Set avatar (PNG data URL)                                                              |
| **model**      | `model:getAll`                                                            | renderer→main | All available models                                                                   |
| **app**        | `app:error`                                                               | main→renderer | Uncaught exceptions / unhandled rejections                                             |
| **cron**       | `cron:create` / `cron:delete` / `cron:list`                               | renderer→main | Scheduled jobs CRUD                                                                    |
| **worktree**   | `worktree:getStatus`                                                      | renderer→main | Agent worktree sandbox status                                                          |
|                | `worktree:changed`                                                        | main→renderer | Worktree activate/deactivate event                                                     |

---

## 4. AI Core System

### 4.1 Two Execution Paths

Auraxis has **two drivers, one loop**: every LLM step for chat and agents is delegated to the unified `step-engine.ts` (retries, tool batching, stop policy, and compaction all converge there). The two drivers keep only their orchestration responsibilities (chat executes directly; agents add planning / approval / deviance detection / pause-resume).

#### Path A: Chat Query (query-engine.ts)

Used by the main chat UI. Flow:

```
User input → buildSystemPrompt() → prepareMessages()
    ↓
ReAct loop (max 500 iterations; business cap 200 + safety hard cap 500):
    1. LLM call (llmClientInvoke, 3 retries, exponential backoff 2s/4s/8s/16s max)
    2. No tool calls → check <FINAL_ANSWER> → stop
    3. Tool calls → executeToolCall() → structured summary → append results → back to 1
    4. Context compaction (triggers above ~100K tokens)
    5. Stop policy evaluation (stopPolicyEvaluate)
    6. Emit iteration summary (toolsThisIteration, llmLatencyMs)
    ↓
Return result to chat UI
```

**Features**:

- **No planning phase**: runs the ReAct loop directly
- **API retries**: 429 / 5xx / network errors auto-retry 3 times with exponential backoff
- **Context compaction**: rule-based, token threshold ~100K
- **Stop signals**: `<FINAL_ANSWER>` + `stop_reason` checks; ReviewArtifact is optional (no forced quality gate)
- **Business iteration cap**: 200 (configurable), safety hard cap 500
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
    3. Deviance detection (DevianceDetector):
       - L1: tool failure → mark blocked
       - L2: consecutive stalls → suggest replanning
       - L3: Replan tool triggered → LLM generates a new sub-plan
    4. Context management (ContextManager): round/token-based compaction
    5. Stop policy evaluation
    ↓
Return result
```

**Features**:

- **Full planning**: LLM generates structured JSON task plans (dependencies + keyword matching)
- **Plan approval**: in `plan` mode, waits for user approval (5-minute timeout); only approved steps execute
- **Quality verification (optional)**: ReviewArtifact can run build / test / typecheck / lint on demand
- **Deviance detection**: three levels (tool failure L1, stall L2, replan L3)
- **Context management**: LLM summaries with rule-based fallback
- **New-project detection**: detects empty dirs / missing package.json and injects initialization guidance
- **Pause / resume**: full state capture (messages / plan / iteration / toolCallCount), auto re-queue at capacity
- **Max recursion depth**: 3 (the Agent tool can nest sub-agents, recording parent-child links)
- **Exposed via**: `agent:create` IPC and the `runSubAgent()` function

#### Path C: Code Mode (code-mode.ts)

When `RunCode` runs with `language=typescript`, the program body executes in a worker thread; every `await tools.Name(args)` sub-call re-enters the full `executeToolCall` permission pipeline. Concurrency-safe tools overlap up to 8 ways, mutating tools run serially, and hard timeouts / aborts can terminate the worker. Only printed/returned content is sent back to the model. Forked sub-agent backends (`Agent` with `backend=fork`) live in `fork-runner.ts` (one-shot headless child process).

### 4.2 System Prompt Construction

`buildSystemPrompt()` in `query-engine.ts` builds the Chinese system prompt, which includes:

- Tool capability declaration
- **Task completion signal**: `<FINAL_ANSWER>` marker (uppercase, must be on the final line)
- **Two-phase workflow**: phase 1 exploration (Glob/Grep/Read) → phase 2 execution (Write/Edit/Bash)
- Platform-aware shell hints (Windows → Git Bash, macOS/Linux → standard Unix)
- Deep-thinking instructions appended when `isDeepThink` is enabled

### 4.3 Tool System

Tool definitions live in `electron/tool-defs.ts` ([view file](../electron/tool-defs.ts)); **71 built-in tools** in total. The table below lists the core 24; the rest are grouped by capability family.

| #   | Tool               | Category  | Description                                                                                                                           |
| --- | ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Bash**           | dangerous | Run shell commands in the project directory. Default timeout 120s, max 600s. Windows supports Git Bash / cmd / PowerShell             |
| 2   | **Read**           | safe      | Read file content with line offset/limit and path traversal checks. Output includes `summary` (path, lines, size)                     |
| 3   | **Write**          | dangerous | Create / overwrite files with extension whitelist, Windows reserved-name checks, undo backup. Output includes `summary` (path, bytes) |
| 4   | **Edit**           | dangerous | Find-and-replace in a file; match must be unique; undo backup before writing                                                          |
| 5   | **Delete**         | dangerous | Delete files or directories (recursive requires confirmation), path traversal checks, undo backup                                     |
| 6   | **Grep**           | safe      | Regex search (max depth 5, up to 50 results). Output includes `summary` (match count)                                                 |
| 7   | **Glob**           | safe      | File pattern matching (max depth 6, up to 100 files). Output includes `summary` (match count)                                         |
| 8   | **WebFetch**       | dangerous | Fetch URL content (15s timeout), blocks local / intranet addresses                                                                    |
| 9   | **WebSearch**      | dangerous | DuckDuckGo HTML search (no API key required)                                                                                          |
| 10  | **TodoWrite**      | safe      | Task list management (pending / in_progress / completed); only one in_progress at a time                                              |
| 11  | **Agent**          | dangerous | Start a sub-agent (Explore / Plan / general-purpose), recursion depth limit 3, records parent-child links                             |
| 12  | **Replan**         | safe      | Generate a new sub-plan (agent loop only; the query engine skips it)                                                                  |
| 13  | **CronCreate**     | dangerous | Create recurring / one-shot scheduled jobs (5-field cron), fired while the app runs                                                   |
| 14  | **CronDelete**     | safe      | Cancel a scheduled job by ID                                                                                                          |
| 15  | **CronList**       | safe      | List all active scheduled jobs                                                                                                        |
| 16  | **TaskOutput**     | safe      | Read accumulated output of background tasks / sub-agents (non-blocking)                                                               |
| 17  | **TaskStop**       | dangerous | Stop a running tool / sub-agent by ID                                                                                                 |
| 18  | **EnterPlanMode**  | safe      | Enter plan mode, generate an implementation plan for user approval                                                                    |
| 19  | **ExitPlanMode**   | safe      | Exit plan mode after approval and start implementing                                                                                  |
| 20  | **NotebookEdit**   | dangerous | Read / write / insert / delete Jupyter Notebook (.ipynb) cells                                                                        |
| 21  | **EnterWorktree**  | dangerous | Create an isolated Git worktree sandbox; subsequent tool calls redirect to the sandbox path                                           |
| 22  | **LSP**            | safe      | Code intelligence: definition / references / diagnostics (tsc --noEmit)                                                               |
| 23  | **ReviewArtifact** | dangerous | Optional verification tool: runs build / test / typecheck / lint                                                                      |
| 24  | **GitCommit**      | dangerous | Stage all changes and create a Git commit, returning the commit hash                                                                  |

> The "Category" column is an intuitive behavioral grouping; whether a tool actually triggers the permission dialog follows the dangerous-tool set in `tool-handlers.ts`.

**The remaining 47 tools (by capability family)**:

- **Orchestration / introspection**: RunWorkflow, Ralph, ListAgents / SendMessage / InterruptAgent / Report, GetGoal / CreateGoal / UpdateGoal, InspectRuntime, MountPlugin / UnmountPlugin
- **Files**: StrReplaceEditor (view/create/str_replace/insert), ReadImage, NotebookEdit-related
- **Terminal**: TerminalOpen / TerminalList / TerminalRead / TerminalSend / TerminalSignal / TerminalClose, Pty, Pwsh
- **Background / scheduling**: JobList / JobOutput / JobKill, ScheduleCreate / ScheduleDelete / ScheduleList
- **Session retrieval**: SessionQuery, SessionEventSearch / SessionEventRead / SessionTrace (event-level lineage), ReadSpill
- **Capability loading**: ListSkills / ReadSkill / WriteSkill, LSP, ReviewArtifact, GitCommit, EnterWorktree
- **Professional documents**: ReadDocument (text & structured read of .docx/.xlsx/.pptx/.pdf), WriteDocument (Word/Excel/PPT/PDF generation; PDF auto-embeds CJK fonts)
- **Cloud connectors**: SlackListChannels / SlackPostMessage, DriveList / DriveRead, NotionSearch / NotionCreatePage
- **Feishu / Lark**: official OpenAPI MCP (`mcp__lark-mcp__*`) covering messages, groups, docs, spreadsheets, calendars and more

**Tool classification**:

- **Dangerous set**: `['Bash', 'Write', 'Edit', 'Delete', 'WebFetch', 'WebSearch', 'CronCreate', 'TaskStop', 'EnterWorktree', 'ReviewArtifact', 'GitCommit', 'WriteDocument', 'SlackPostMessage', 'NotionCreatePage']` — triggers the permission dialog
- **File-mutation tools**: `['Write', 'Edit', 'NotebookEdit', 'Delete', 'WriteDocument']` — trigger undo backups and conflict-detector file locks
- **Read-only tools**: `['Read', 'Grep', 'Glob', 'ReadDocument', 'SlackListChannels', 'DriveList', 'DriveRead', 'NotionSearch']` — auto-approved in `ask` and `plan` modes

`Replan` is unavailable in the chat query path (the query engine skips it) and only usable in the agent loop.

### 4.4 Permission System

Approval policies (`electron/types.ts` → `src/types/`):

| Policy                   | Behavior                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ask` (default)          | Shows a permission dialog for every dangerous tool call. Read-only tools (Read/Grep/Glob) are auto-approved                               |
| `plan`                   | Tools explicitly approved in the plan-approval step run automatically. Tools outside the plan follow `ask` mode                           |
| `auto` (fully automatic) | Approves all tools without confirmation. Security checks still run (path checks, extension whitelist, blocked URLs) but no dialogs appear |

The Composer "runtime permission" four presets (confirm each time / auto-approve / full access / read-only) map to the above policy + sandbox mode + autoApprove; see `electron/contracts/permission.ts`.

Permission rules are stored in `permission-handlers.ts` with scopes:

- `once` — valid for this call only
- `session` — valid for the current session
- `always` — permanent

> **Approval-fatigue guard (Oversight)**: the permission chain plugs into the `approval-fatigue.ts` policy layer; auto-approvals count toward fatigue statistics (without consuming human attention). Under high load + low recent rejection rate, low/medium-risk operations are suggested for auto-approval to avoid "approval floods" overwhelming human review (see Section 5.6).

### 4.5 Context Compaction

`ContextManager` (`agent-loop.ts` / `context-manager.ts`) and `step-compressor.ts` provide two compaction strategies:

- **snip (default for chat / manual compaction)**: atomic-group truncation + LLM summary, falling back to rule-based summaries; triggers on tokens (default ~100K) or rounds; compacts the oldest ~50% by default
- **step (AGORA, default in the agent loop)**: inference-free step-level compaction — whole steps kept or dropped, never splitting a tool call from its results (see Section 5.4); `pruneToolResults` trims large results first, then an always-keep floor preserves the last 6 steps and plan-critical steps

### 4.6 Stop Policy

`stopPolicyEvaluate()` decides whether to stop execution:

- **Quality verification (optional)**: ReviewArtifact lets the model run verification commands when needed
- **Primary check**: `<FINAL_ANSWER>` marker detection (parses the end signal from LLM output)
- **max_tokens protection**: forces continuation when the API returns `stop_reason: 'max_tokens'`
- **Plan completion check**: only stops when all plan tasks are `completed`
- **Consecutive text detection**: stops after 5 consecutive rounds with no tool calls
- **Empty-response detection**: stops after 2 consecutive empty responses

### 4.7 Context-Cache Alignment (Canonical Snapshot Replay)

The unified Work/Code engine (`query-engine.ts` → `step-engine.ts`) performs client-side alignment for DeepSeek prefix caching (see Section 5.9):

- After each natural turn, the full canonical message snapshot is written to the session chat-log (`llm_context_v1` system event); the next turn replays the snapshot and only appends new memory + the new user message
- Snapshot head validation: system prompt / session preamble / work guide must match the current version, otherwise fall back to fresh assembly (prevents stale instructions after upgrades, project switches, or thinking-mode changes)
- Memory travels as the `memoryContext` field through IPC and is inserted at the request tail; byte-exact dedup against the snapshot's last memory on replay
- Renderer edits / deletes / regenerations / undos invalidate snapshots via `ai:clearQueryContext`
- Snapshot read/write is best-effort: failures only warn and degrade to fresh assembly without interrupting replies

Involved files: `electron/ipc/query-context.ts`, `electron/ipc/query-engine.ts`, `electron/ipc/ai-handlers.ts`, `electron/preload.ts`, `src/stores/useChatStore.ts`.

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

- **M1 Evidence foundation**: `memory-evidence.ts` captures user messages, tool observations, corrections, and approval events as immutable Evidence (sha256 content-hash dedup, SQLite / JSON backends); `chat-log.ts` / `session-log.ts` hook best-effort capture after writes
- **M2 Signals & beliefs**: `signal-rules.ts` rule-based detection of date / entity / URL / version / decision / correction / approval / rejection signals; `belief-validation.ts` hard-anchor validation (evidence must exist, key entities & values normalized, corrections need dual evidence); state machine `draft → promoted → active → superseded / rejected / deleted`
- **M3 Deterministic read path**: `memory-read.ts` four routes — R1 FTS5 / R2 entity-time / R3 observation stream / R4 local vectors (`AURAXIS_MEMORY_EMBEDDINGS=1`, optional) — **zero LLM, zero randomness**; `memory:readForQuery` returns context + policy + facts + diagnostics and replaces chat injection
- **M4 Audit & attribution**: `memory:beliefAudit` / `readTrace` / `erase` (erasure leaves audit events); MemoryPanel shows evidence chains, support strength, revision history, and read-path diagnostics; five-layer failure attribution tests (missing evidence / extraction distortion / stale state / retrieval loss / model behavior)

### 5.3 MAP-Graph — Multi-Agent Shared-Memory Authorization (M5)

**Core insight**: vector-only retrieval loses permission, source, and trust information, which can let "unauthorized evidence drive high-risk actions."

- `memory-graph.ts` typed execution graph: agents / sources / memories / claims / actions nodes + lineage edges
- Authorization filtering: evidence readability decided by agent role (Explore / Plan / general-purpose) and action type; hard authorization separated from graded trust
- Path trust: multiplicative trust scoring of source credibility × derivation path, re-ranking readable memories
- Risk gating: high-risk actions (Write / Edit / Bash etc.) require higher evidence standards and source trust, wired into `permission-profile.ts` / `tool-runner.ts`; scheduler / sub-agents auto-bind agentName at runtime (`AURAXIS_MEMORY_RISK_GATE=1`)

### 5.4 AGORA — Step-Level Context Compression

**Core insight**: token-level extractive compression breaks an agent's action grammar (tool names / identifiers / brackets removed → environment rejects the call); compression must operate on whole steps.

- `step-compressor.ts` inference-free implementation: structural parsing + always-keep floor (system / lead / last K=6 steps / plan-critical steps) + deterministic heuristic scoring, no LLM
- Never splits a tool call from its result; `context-manager.ts` runs `pruneToolResults` before compressing large results
- Agent loop defaults to `compressMode='step'` (`agent-loop.ts` / `step-engine.ts`); chat and manual compaction keep the `snip` summary pipeline

### 5.5 SWE-Touch — Shared-Workspace Drift Detection

**Core insight**: when the user or another process modifies the same workspace during task execution, the agent must perceive "external drift" and re-check the modified areas.

- `workspace-drift.ts` records baselines after successful Read / Write / Edit (stat + sha256; >2MB uses mtime/size only), without listening to filesystem events
- Before each agent iteration, `takeDrift(projectRoot)` detects drift and injects a context message (`context_injected / workspace` event), asking the model to verify the affected areas
- Consumed internally by agent-loop, with workspace-drift unit tests and agent-loop integration tests

### 5.6 Oversight Has a Capacity — Approval-Fatigue Guard

**Core insight**: human reviewers are not perfect oracles; over-escalation reduces overall safety (fatigue + "approval-flood" attacks). Whether to escalate to a human should be treated as a resource-allocation problem.

- `approval-fatigue.ts` records approval decisions per scope (approved / rejected / auto) with a 20-decision sliding window + fatigue score
- Outputs a suggestion `escalate / auto / balanced`; `permission-handlers.ts` counts auto-approvals in the statistics (without consuming human attention)
- The guard never changes the permission mode itself; callers act on the suggestion; consumed internally by the permission chain

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
- **Stable block organization (Prompt Cache)**: static system prompt + tool definitions + AGENTS.md + mode hints are stable blocks, replaced in place only when content really changes; `storedHeadIsCurrent` validates system / preamble / work guide against the app version and falls back to fresh assembly on upgrades, project switches, or thinking-mode changes
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
| Session event timeline           | Right-side timeline of session events and tool calls with trace / replay                                                                                                              | ToolCallTimeline / session-log                      |
| Live diff & rollback             | Right-panel "Changes" view lists per-session file changes and rolls back                                                                                                              | undo-manager / undo:getSessionDiffs                 |
| Test-coverage panel              | Settings reads coverage-summary.json live and shows line / branch / function coverage                                                                                                 | coverage-handlers / settings                        |

---

## 6. Multi-Agent Scheduling

### 6.1 Three-Layer Architecture

```
Agent management (agent-handlers.ts)
    ↓ create / configure
Agent scheduler (agent-scheduler.ts) — singleton AgentScheduler
    ↓ schedule & execute
Agent loop (agent-loop.ts) — agentLoopRun()
    ↓ while running
Tool execution (tool-handlers.ts) / sub-agents (recursion)
```

### 6.2 Agent Types

Defined in `agent-handlers.ts` ([view file](../electron/ipc/agent-handlers.ts)); three built-in types:

| Type                | Capability                                                                  | Disabled tools                                |
| ------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| **Explore**         | Read-only exploration: file search, code reading, web fetch/search          | Write, Edit, Agent                            |
| **Plan**            | Read-only architect: designs implementation plans, outputs structured plans | Write, Edit, Bash, Agent (whitelist enforced) |
| **general-purpose** | Full capability: coding, debugging, refactoring                             | None (all 71 tools available)                 |

### 6.3 AgentScheduler

The singleton `AgentScheduler` (`agent-scheduler.ts`) manages parallel agent execution:

- **Priority queue**: high (weight 3) > normal (2) > low (1)
- **Default max concurrency**: 3 (adjustable via `agent:setMaxConcurrent` IPC)
- **Agent state machine**: `idle → queued → running → completed/error/stopped/paused`
- **Live notifications**: every state change broadcasts via the `agent:updated` channel
- **200-iteration cap**: each agent runs at most 200 iterations (configurable via `maxIterations`; hard safety gate 200)

### 6.4 Workspace Isolation

Workspace isolation is implemented in `tool-handlers.ts` (`worktreeSessions`):

- **Git repos only**: `EnterWorktree` uses `git worktree` to create an isolated branch under `.auraxis-sandbox/task-<id>` (non-Git directories are rejected)
- **Path redirection**: after entering a worktree, file/command tools redirect to the sandbox path
- **Sandbox GC**: orphan sandbox directories are cleaned at startup (crashes / taskkill that skipped `before-quit` leave orphans)
- **Native sandbox**: command-level isolation is provided by `sandbox-runner.ts` (Windows restricted token / AppContainer, Linux, macOS backends)

### 6.5 Conflict Detection

`conflict-detector.ts` prevents multiple agents from writing the same file concurrently:

- Acquires a file lock before Write / Edit operations
- Tracks file modification history (which agent, when)
- Exposes conflicts to the frontend via `conflict:getConflicts`

---

## 7. MCP Protocol Support

`mcp-handlers.ts` implements the MCP (Model Context Protocol) client:

- **Transport**: JSON-RPC over stdio
- **Command validation**: server commands are validated before connecting
- **Tool discovery**: `mcp:listTools` lists remote MCP server tools
- **Tool calls**: `mcp:callTool` invokes remote tools (`mcp__serverId__toolName`)
- **Status management**: `mcp:connect` / `mcp:disconnect` / `mcp:getStatuses`
- **DeepSeek Harness preset**: Settings → MCP can add `deepseek-harness` in one click; the first connection launches the local Harness Web UI through `npx`, with automatic `cross-spawn` compatibility for `npx.cmd` on Windows.

---

## 8. Plugin System

### 8.1 Extension Points

Plugins (`src/core/plugin-manager.ts`) provide the following extension points:

| Extension point | Description                                                    |
| --------------- | -------------------------------------------------------------- |
| **commands**    | Slash commands (`/example`) that can manipulate chat input     |
| **tools**       | AI tools (merged into the tool registry, callable by the LLM)  |
| **hooks**       | Lifecycle hooks: `onToolExecute`, `onAgentStart`, `onAgentEnd` |
| **ui**          | UI extensions: `settingsPanel`, `statusBarItem`                |

### 8.2 Security Model

Plugins run in the renderer; installation includes multi-layer security checks:

1. **Source-code scan** (`plugin-loader.ts`): detects 8 dangerous patterns
   - `eval()`, `new Function()` — arbitrary code execution
   - `require('child_process')` — system processes
   - `require('fs')` — filesystem access
   - `fetch()` to non-local addresses — network requests
   - `require('net')`, `require('os')`, `require('path')`
2. **Structural validation**: required fields (id, name, version, description) and tool schema validation
3. **Path whitelist**: only load from `plugins/` or `userData/plugins/`
4. **User confirmation**: installation shows capability list and risks; user confirms before install
5. **API key isolation**: plugins cannot access API keys encrypted in `safeStorage`
6. **Permission adherence**: plugin tool execution follows the same permission-dialog checks as built-in tools

### 8.3 Built-in Example Plugins

- `src/plugins/example-timestamp.ts` — `/timestamp` command, inserts ISO timestamp
- `src/plugins/example-uuid.ts` — `/uuid` command + `onToolExecute` hook

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
| useSessionStore     | `auraxis-session-storage`  | Session list (max 40)                                                             |
| useProjectStore     | `auraxis-projects`         | Project registry, current project, workspace/session ordering                     |
| usePluginStore      | `auraxis-plugin-storage`   | Installed plugins, enabled state                                                  |
| useAdvancedStore    | `auraxis-advanced-storage` | MCP servers, legacy agent settings                                                |
| useKeybindingsStore | `auraxis_keybindings`      | Keybinding overrides                                                              |

> **Note**: localStorage keys use the unified `auraxis-` prefix; `auraxis_keybindings` is the exception.

### 9.2 Long-Term Memory

Long-term memory is upgraded to **evidence-before-belief provenance memory** (Eywa + MAP-Graph; full design in Sections 5.2/5.3):

- **Three-layer data model**: Evidence (immutable source evidence, SQLite/JSON dual backend) → Signal (rule-first typed signals) → Belief (LLM-derived + hard-anchor validated; supported / unsupported / missing-reference three states)
- **Live evidence hooks**: `chat-log.ts` / `session-log.ts` best-effort capture user messages and terminal tool states after writes
- **Deterministic read path**: R1 FTS5 / R2 entity-time / R3 observation stream / R4 local vectors (optional), zero LLM; `memory:readForQuery` returns context + policy + facts + diagnostics; chat injection switched over
- **Audit & attribution**: beliefAudit / readTrace / erase (erasure leaves audit events); MemoryPanel shows evidence chains, support strength, revision history, and read-path diagnostics; five-layer failure attribution tests
- **Multi-agent authorization (M5)**: `AURAXIS_MEMORY_RISK_GATE=1` enables the memory-graph typed execution graph with role-based authorization, path trust, and high-risk action gating
- **Compatibility**: legacy `memory:getByProject` / `getByType` / `search` channels map to the new model; legacy memories are tagged `legacy=1` and never silently treated as verified

### 9.3 Session Management

`useSessionStore.ts` manages chat sessions:

- **Auto-save**: streaming completion triggers `saveSession()`
- **Capacity limit**: at most 40 sessions
- **Operations**: save, load, delete, export, fork

### 9.4 Encrypted Settings Storage

`settings-store.ts` uses Electron `safeStorage` to encrypt API keys:

- Settings file: JSON file under the user-data directory
- API keys: `safeStorage.encryptString()` → Base64
- Auto-decrypt on read: `safeStorage.decryptString()`
- API keys are never exposed in `settings:get` responses
- Legacy plaintext keys auto-migrate to encrypted storage on first read (one-time; plaintext removed after write-back)
- When encryption is unavailable the original value is kept; when decryption fails the key is dropped instead of exposing corrupt data

### 9.5 Log Retention & Cache Cleanup

Best-effort maintenance runs at desktop startup (`log-retention.ts` + each store's `prune()`):

- **Log retention**: chat/agent JSONL logs kept for 180 days or 256MB by default, overridable via `AURAXIS_LOG_RETENTION_DAYS` / `AURAXIS_LOG_MAX_FILE_MB`
- **Projection-cache cleanup**: removes orphan `session-cache` rows with no matching JSONL log (SQLite backend)
- **FTS rebuild**: full rebuild at startup, then per-session 600ms debounced incremental refresh after appends
- **Canonical context snapshots**: Work/Code write an `llm_context_v1` system event to chat-log each round (cache-aligned replay); edit/delete/regenerate/undo appends an `llm_context_clear` tombstone; both follow the log retention policy

The SQLite projection cache and FTS index both carry `PRAGMA user_version = 1` for future migrations.

### 9.6 File Undo

`undo-manager.ts` implements file-level undo:

- **Trigger**: automatic backup before Write/Edit tool execution
- **Snapshot storage**: `.auraxis-snapshots/` directory
- **Operations**: undo, revert, get history

---

## 10. Model Configuration

### 10.1 Model Resolution Chain

`getAllModels()` in `model-config.ts` resolves models in this priority order:

```
1. Built-in models (deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash-vision-exp)
   ↓
2. AURAXIS_MODELS environment variable (JSON array)
   ↓
3. Persisted custom models (added by the user via UI)
```

### 10.2 Environment Variables

See `.env.example` ([view file](../.env.example)):

| Variable                                                 | Description                                                      | Default                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| `DEEPSEEK_API_KEY`                                       | DeepSeek API key                                                 | none (required)                                  |
| `DEEPSEEK_BASE_URL`                                      | OpenAI-format endpoint                                           | `https://api.deepseek.com/beta/chat/completions` |
| `DEEPSEEK_ANTHROPIC_BASE_URL`                            | Anthropic-format endpoint                                        | `https://api.deepseek.com/anthropic/v1/messages` |
| `ANTHROPIC_API_KEY`                                      | Anthropic API key                                                | none                                             |
| `ANTHROPIC_BASE_URL`                                     | Anthropic endpoint                                               | `https://api.anthropic.com/v1/messages`          |
| `OPENAI_API_KEY`                                         | OpenAI API key                                                   | none                                             |
| `OPENAI_BASE_URL`                                        | OpenAI endpoint                                                  | `https://api.openai.com/v1/chat/completions`     |
| `AURAXIS_MODELS`                                         | Custom models (JSON array)                                       | none                                             |
| `AURAXIS_ALLOW_UNSAFE_CODE`                              | Enable model-written arbitrary code execution (trusted dev only) | off                                              |
| `AURAXIS_MEMORY_RISK_GATE`                               | Enable MAP-Graph memory risk gating (M5)                         | off unless `1`                                   |
| `AURAXIS_MEMORY_EMBEDDINGS`                              | Enable R4 local deterministic vector route                       | off by default                                   |
| `AURAXIS_MEMORY_LLM_SIGNALS`                             | Add LLM signal detection on top of rule signals                  | off by default                                   |
| `AURAXIS_AUTH_DISABLED`                                  | Skip login gate for tests/CI (don't set in normal desktop use)   | off by default                                   |
| `AURAXIS_USER_DATA_DIR`                                  | Override userData directory (account/settings isolation, tests)  | none by default                                  |
| `AURAXIS_TELEMETRY_MODE`                                 | Telemetry switch (opt-in)                                        | off by default                                   |
| `AURAXIS_LOG_RETENTION_DAYS` / `AURAXIS_LOG_MAX_FILE_MB` | Log retention days / per-file cap                                | 180 / 256                                        |

### 10.3 Custom Model Format

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

### 10.4 Dual API Format Support

Models can use either OpenAI-compatible or Anthropic format. OpenAI format is the default (`DEEPSEEK_BASE_URL`). When `DEEPSEEK_ANTHROPIC_BASE_URL` is set, models such as `deepseek-v4-flash` use the Anthropic-format endpoint. Each model can override via its `apiBase` field.

### 10.5 DeepSeek Official Capabilities & Interfaces

- **Reasoning effort**: `low / high / max` (`reasoning_effort`); Chat follows DeepSeek style (fixed high, controlled by the thinking toggle), Work/Code keep the slider
- **V4 Flash Vision Exp (experimental)**: built-in image-understanding model (`deepseek-v4-flash-vision-exp`); images are accepted only in `user` messages, supported formats are JPEG/PNG/GIF/WebP, and ReadImage tool results are delivered as image content for this model
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

---

## 11. Main Window Configuration

`main.ts` ([view file](../electron/main.ts)) configures:

- **Window**: 1200×800, minimum 600×500, frameless (`frame: false`), macOS hides the title bar
- **CSP (Content Security Policy)**:
  - Dev mode: allows `unsafe-inline` (required by Vite HMR)
  - Production: strict CSP, only `'self'`
  - `connect-src` allows `localhost:*` (dev), `api.deepseek.com`, `html.duckduckgo.com`, `https://*` (MCP / custom endpoints)
- **Single-instance lock**: `app.requestSingleInstanceLock()` prevents multiple instances
- **Global error handling**: `uncaughtException` and `unhandledRejection` are forwarded to the renderer via the `app:error` channel
- **Security**: only `https://` / `http://` external links are allowed

---

## 12. Build & Deployment

### 12.1 Build Flow

```
Source code
  ├── electron/ ──→ tsc (tsconfig.electron.json) ──→ dist-electron/
  └── src/ ──────→ Vite build ────────────────────→ dist/

dist-electron/ + dist/ ──→ electron-builder ──→ release/
```

### 12.2 Packaging Configuration

`electron-builder.yml` targets three platforms:

- **Windows**: NSIS installer
- **macOS**: DMG (x64 + arm64)
- **Linux**: AppImage

### 12.3 Environment Variable Loading

The app uses `dotenv` to load environment variables from `.env` at the project root. Create a `.env` file (see `.env.example`) before running `npm run electron:dev`.

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
- **Total**: 245 test files / 1,789 cases passing (+3 environment-skips)
- **Coverage scope**: the gate only counts `electron/ipc/`, `src/stores/`, `src/core/`; UI components (`src/components/`) and main-process entry points (`main.ts` / `preload.ts` etc.) are excluded from the gate and covered by component tests + Playwright E2E (`npm run test:e2e`)
- **Coverage thresholds**: lines/statements 80%, branches 70%, functions 80% (latest full report: 77.55% statements / 79.90% lines / 66.99% branches / 73.84% functions; currently below thresholds)
- **Coverage report**: `npm run test:coverage` outputs `coverage/coverage-summary.json` (gitignored dev artifact); the Settings "Test coverage" page reads it live via the `coverage:get` IPC; pure browser dev is served by a Vite middleware, and production builds copy it into `dist/coverage/`. When the report is missing, the panel shows the command to run instead of fake numbers
- **E2E**: 16 Playwright UI flows passing (real Electron, including register → login → remember-me persistence)
- **Real-API acceptance (DeepSeek)**: chat streaming, Code auto-approve Bash, Code "confirm each time" permission card (write after one approval), Work smart-execution flow, and Work plan-approval panel all verified; sandbox scripts add cwd fallback when launching `dist-electron/main.js` directly (`electron/sandbox-runner.ts`)
- **Stress testing (local mock LLM + real Electron)**: 200 sessions cold start ~1.4s, session switch ~155ms, FTS rebuild ~178ms; 18 agents (6 concurrent) and 30 agents (8 concurrent) all completed without failure; under extreme load (30 tasks + 200 sidebar rows) fast mode switches occasionally stalled 8–11s with one >15s, recovering automatically after load; no issue at the default 3-concurrency setting
- **Environment limits**: no real Python on this machine (only Microsoft Store placeholder), so `npm run sdk:test:py` cannot run; JS SDK 7 cases pass
- **Commands**: `npm test` (all), `npm run test:backend` (main process), `npm run test:frontend` (renderer), `npm run test:coverage` (coverage report)

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
- **Right panel**: opened from the workbench dropdown, never covers main content; at minimum width there is no close button (only collapse)
- **Nav history** (back/forward) records tab switches with browser-style navigation
- **Full-bleed message area + floating layers**: the input dock and top header are floating; messages fade out via gradients when passing behind them; the list pads header/footer with scroll space equal to the floating layers
- **Top divider**: shown while a conversation is running, hidden when the window is maximized
- **Token/model status** is inline above the input dock; no separate inspector panel

### 13.5 Known Limitations

- **Persisted key prefix**: unified as `auraxis-`; `auraxis_keybindings` is the exception
- **Hardcoded limits**:
  - Agent business iteration cap 200 (configurable), safety hard cap 500
  - Scheduler max concurrency 3
  - Max 40 sessions
  - Agent logs capped at 500 entries
  - Only the last 40 messages persisted per session
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
- **Fonts**: system UI stack (`-apple-system, Segoe UI, PingFang SC, Microsoft YaHei`) + monospace stack (`SF Mono, JetBrains Mono, Fira Code, Consolas`)
- **Animation**: `prefers-reduced-motion` support; execution waiting uses a brand GIF (`src/assets/executing.gif`) + gradient streaming text; the thinking-depth slider is a data-driven magnetic animation (effect grows with depth, magnetism decreases)
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
npm run electron:compile # Compile main process only
npm test                 # Run all tests
npm run test:backend     # Backend tests
npm run test:frontend    # Frontend tests
npm run test:coverage    # Coverage tests
npm run build            # Production build
```

### Key File Index

| File                                                                                                | Responsibility                                                                              |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [electron/main.ts](../electron/main.ts)                                                             | App entry                                                                                   |
| [electron/preload.ts](../electron/preload.ts)                                                       | IPC bridge                                                                                  |
| [electron/ipc/index.ts](../electron/ipc/index.ts)                                                   | IPC registration entry                                                                      |
| [electron/tool-defs.ts](../electron/tool-defs.ts)                                                   | Tool definitions                                                                            |
| [electron/ipc/step-engine.ts](../electron/ipc/step-engine.ts)                                       | Unified ReAct step engine                                                                   |
| [electron/ipc/query-engine.ts](../electron/ipc/query-engine.ts)                                     | Chat driver                                                                                 |
| [electron/ipc/query-context.ts](../electron/ipc/query-context.ts)                                   | Canonical context snapshots (cache-aligned replay / memory dedup / invalidation tombstones) |
| [electron/ipc/agent-loop.ts](../electron/ipc/agent-loop.ts)                                         | Agent driver (plan/approval/deviance/stop)                                                  |
| [electron/ipc/agent-scheduler.ts](../electron/ipc/agent-scheduler.ts)                               | Multi-agent scheduling                                                                      |
| [electron/ipc/tool-handlers.ts](../electron/ipc/tool-handlers.ts)                                   | Tool execution                                                                              |
| [electron/ipc/permission-handlers.ts](../electron/ipc/permission-handlers.ts)                       | Permission control                                                                          |
| [electron/code-mode.ts](../electron/code-mode.ts)                                                   | Code Mode (TS tool orchestration)                                                           |
| [electron/step-compressor.ts](../electron/step-compressor.ts)                                       | AGORA step compression                                                                      |
| [electron/workspace-drift.ts](../electron/workspace-drift.ts)                                       | SWE-Touch workspace drift                                                                   |
| [electron/approval-fatigue.ts](../electron/approval-fatigue.ts)                                     | Oversight approval fatigue                                                                  |
| [electron/tool-inertia.ts](../electron/tool-inertia.ts)                                             | AutoTool tool inertia                                                                       |
| [electron/skill-gate.ts](../electron/skill-gate.ts)                                                 | VaG skill gate                                                                              |
| [electron/auth-store.ts](../electron/auth-store.ts)                                                 | Local account (register/login/avatar)                                                       |
| [electron/ipc/memory-read.ts](../electron/ipc/memory-read.ts)                                       | Eywa deterministic read path                                                                |
| [electron/ipc/memory-graph.ts](../electron/ipc/memory-graph.ts)                                     | MAP-Graph authorization gating                                                              |
| [electron/contracts/](../electron/contracts/)                                                       | Cross-process type contracts                                                                |
| [electron/session-store.ts](../electron/session-store.ts)                                           | Unified event logs                                                                          |
| [src/App.tsx](../src/App.tsx)                                                                       | React root component                                                                        |
| [src/stores/useChatStore.ts](../src/stores/useChatStore.ts)                                         | Chat state                                                                                  |
| [src/components/auth/AuthGate.tsx](../src/components/auth/AuthGate.tsx)                             | Login gate                                                                                  |
| [src/components/work/WorkExecutionFlow.tsx](../src/components/work/WorkExecutionFlow.tsx)           | Work execution flow view                                                                    |
| [src/components/input/ThinkingDepthSelector.tsx](../src/components/input/ThinkingDepthSelector.tsx) | Thinking-depth slider (magnetic streaming effect)                                           |
| [src/core/plugin-manager.ts](../src/core/plugin-manager.ts)                                         | Plugin management                                                                           |
| [src/styles/theme.ts](../src/styles/theme.ts)                                                       | Theme configuration                                                                         |
