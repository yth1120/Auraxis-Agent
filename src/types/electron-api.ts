import type {
  ApiMessage,
  ApplyCodePayload,
  ApplyCodeResult,
  FileSearchResult,
  FileResult,
  DirectoryEntry,
  ModelDefinition,
  WorkspaceFileDiff,
} from '../../electron/types';
import type {
  ChatLogEvent,
  ChatSessionMeta,
  ChatSessionSummary,
  ProjectedChatSession,
} from '../../electron/chat-log-types';
import type {
  BeliefRecord,
  BeliefRejection,
  EvidenceRecord,
  ReadResultRecord,
  SignalRecord,
} from '../../electron/ipc/memory-db';
import type { MemoryReadResult, ReadTrace } from '../../electron/ipc/memory-read';
import type { AuthChangePasswordParams, AuthLoginParams, AuthPhase, AuthSetupParams, AuthStatus } from '../../electron/contracts/auth';
import type { ProjectGlobalState } from '../../electron/contracts/project';

// Re-export for convenience
export type { ApiMessage, ApplyCodePayload, ApplyCodeResult, FileSearchResult, FileResult, DirectoryEntry, ModelDefinition, WorkspaceFileDiff };
export type { AuthPhase, AuthStatus, AuthSetupParams, AuthLoginParams, AuthChangePasswordParams };

export interface AIStreamCallbacks {
  onChunk: (text: string) => void;
  /** DeepSeek thinking mode 的 reasoning_content 流（仅 Chat 路径）。 */
  onThinking?: (text: string) => void;
  /** 流式末尾 usage（含推理 tokens 与上下文缓存命中）。 */
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
  }) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

export interface AIStreamSubscription {
  requestId: string;
  unsubscribe: () => void;
}

export interface TerminalTask {
  id: string;
  source: 'agent';
  command: string;
  cwd?: string;
  toolCallId?: string;
  requestId?: string;
  agentId?: string;
  status: 'running' | 'success' | 'failed' | 'stopped' | 'timeout';
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  durationMs?: number;
  error?: string;
}

export interface NamedSnapshot {
  id: string;
  name: string;
  createdAt: number;
  files: { path: string; bytes: number }[];
}

export interface PermissionProfile {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  toolPolicy: 'ask' | 'plan' | 'auto';
  fileScopes: { pattern: string; access: 'read' | 'write' | 'deny' }[];
  networkScopes: { pattern: string; access: 'allow' | 'deny' }[];
}

export interface AskRequest {
  askId: string;
  question: string;
  options: string[];
}

export interface RuntimePluginInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  capabilities?: string[];
}

export interface ElectronAPI {
  platform: string;
  homePath: string;
  auth: {
    status: () => Promise<{ ok: boolean; data?: AuthStatus; error?: string }>;
    setup: (params: AuthSetupParams) => Promise<{ ok: boolean; error?: string }>;
    login: (params: AuthLoginParams) => Promise<{ ok: boolean; error?: string }>;
    logout: () => Promise<{ ok: boolean; error?: string }>;
    changePassword: (params: AuthChangePasswordParams) => Promise<{ ok: boolean; error?: string }>;
    setAvatar: (avatar: string) => Promise<{ ok: boolean; error?: string }>;
    changeName: (name: string) => Promise<{ ok: boolean; error?: string }>;
  };
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  focusWindow: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
  zoom: (delta: number | null) => Promise<number>;
  setBackgroundMaterial: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  backgroundMaterialSupported: () => Promise<{ ok: boolean; data?: boolean; error?: string }>;
  getGlassState: () => Promise<{ ok: boolean; data?: { supported: boolean; ready: boolean }; error?: string }>;

  file: {
    open: (projectRoot?: string) => Promise<{ ok: boolean; data?: FileResult[]; error?: string }>;
    read: (filePath: string, projectRoot?: string) => Promise<{ ok: boolean; data?: string; error?: string }>;
    estimateTokens: (files: string[], projectRoot?: string) => Promise<{
      ok: boolean;
      data?: { path: string; bytes: number; tokens: number | null; skipped?: 'binary' | 'too-large' }[];
      error?: string;
    }>;
    readPreview: (filePath: string, projectRoot?: string) => Promise<{
      ok: boolean;
      data?: { path: string; mime: string; base64: string; size: number };
      error?: string;
    }>;
    write: (filePath: string, content: string) => Promise<{ ok: boolean; error?: string }>;
    search: (keyword: string, projectRoot: string) => Promise<{ ok: boolean; data?: FileSearchResult[]; error?: string }>;
    delete: (filePath: string, projectRoot?: string) => Promise<{ ok: boolean; error?: string }>;
    rename: (oldPath: string, newPath: string, projectRoot?: string) => Promise<{ ok: boolean; error?: string }>;
    createFolder: (dirPath: string, projectRoot?: string) => Promise<{ ok: boolean; error?: string }>;
    createFile: (filePath: string, projectRoot?: string) => Promise<{ ok: boolean; error?: string }>;
  };

  project: {
    getTree: (projectRoot: string) => Promise<{ ok: boolean; data?: DirectoryEntry | null; error?: string }>;
    applyCode: (payload: ApplyCodePayload) => Promise<ApplyCodeResult>;
    previewCode: (payload: ApplyCodePayload) => Promise<{ ok: boolean; url?: string; filePath?: string; error?: string }>;
    selectDirectory: () => Promise<{ ok: boolean; data?: string | null; error?: string }>;
    loadGlobalState: () => Promise<{ ok: boolean; data?: ProjectGlobalState; error?: string }>;
    saveGlobalState: (state: ProjectGlobalState) => Promise<{ ok: boolean; error?: string }>;
  };

  ai: {
    chatStream: (request: {
      model: string;
      messages: ApiMessage[];
      isDeepThink: boolean;
      reasoningEffort?: 'low' | 'high' | 'max';
      isWebSearch: boolean;
      apiKey?: string;
      surface?: 'chat' | 'work' | 'code';
      /** 对话前缀续写（Beta）：强制模型从给定 assistant 前缀继续输出。 */
      prefix?: { content: string; stop?: string[] };
    }, callbacks: AIStreamCallbacks) => AIStreamSubscription;
    abortStream: (requestId: string) => Promise<void>;
    /** FIM 补全（Beta）：中间填充，供编辑器/行内补全使用。 */
    fim: (params: {
      model: string;
      apiKey?: string;
      prompt: string;
      suffix?: string;
      maxTokens?: number;
    }) => Promise<{ ok: boolean; data?: { text: string }; error?: string }>;
    sendQuery: (request: {
      sessionId?: string;
      model: string;
      messages: ApiMessage[];
      memoryContext?: string;
      isDeepThink: boolean;
      reasoningEffort?: 'low' | 'high' | 'max';
      projectRoot: string;
      autoApprove?: boolean;
      mode?: 'ask' | 'plan' | 'auto';
      apiKey?: string;
      maxIterations?: number;
      approvedPlanSteps?: string[];
      surface?: 'chat' | 'work' | 'code';
    }, callbacks: {
      onEvent: (event: import('./tools').ToolStreamEvent) => void;
      onDone: () => void;
      onError: (error: string) => void;
    }) => AIStreamSubscription;
    abortQuery: (requestId: string) => Promise<void>;
    clearQueryContext: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
    abortTool: (requestId: string, toolCallId: string) => Promise<{ ok: boolean }>;
    retryTool: (requestId: string, toolName: string) => Promise<{ ok: boolean; error?: string }>;
    setApiKey: (apiKey: string) => Promise<void>;
    testConnection: (apiKey: string) => Promise<{ ok: boolean; data?: { message: string; models?: string[] }; error?: string }>;
  };

  context: {
    getProjectContext: (projectRoot: string) => Promise<{ ok: boolean; data?: { instructionsMd: string; fileTree: string; packageJson: string }; error?: string }>;
    getFileStructure: (projectRoot: string) => Promise<{ ok: boolean; data?: string; error?: string }>;
    readFile: (filePath: string, projectRoot?: string) => Promise<{ ok: boolean; data?: string; error?: string }>;
    compact: (projectRoot: string, messages: { role: string; content: string }[]) => Promise<{
      ok: boolean;
      data?: {
        messages: { role: string; content: string }[];
        messagesRemoved?: number;
        tokensSaved?: number;
        tokensBefore: number;
        tokensAfter: number;
      };
      error?: string;
    }>;
  };

  instructions: {
    getGlobal: () => Promise<{ ok: boolean; data?: { path: string; content: string }; error?: string }>;
    setGlobal: (content: string) => Promise<{ ok: boolean; error?: string }>;
    listProject: (projectRoot: string) => Promise<{
      ok: boolean;
      data?: { relPath: string; hasOverride: boolean; hasAgents: boolean }[];
      error?: string;
    }>;
    get: (projectRoot: string, relPath?: string) => Promise<{
      ok: boolean;
      data?: { path: string; content: string; relPath: string };
      error?: string;
    }>;
    set: (projectRoot: string, relPath: string | undefined, content: string) =>
      Promise<{ ok: boolean; error?: string }>;
  };

  connectors: {
    status: () => Promise<{
      ok: boolean;
      data?: { kind: 'slack' | 'drive' | 'notion'; configured: boolean; tokenHint?: string }[];
      error?: string;
    }>;
    setToken: (kind: 'slack' | 'drive' | 'notion', token: string) =>
      Promise<{ ok: boolean; error?: string }>;
    test: (kind: 'slack' | 'drive' | 'notion') =>
      Promise<{ ok: boolean; data?: { ok: boolean; message: string }; error?: string }>;
  };

  permission: {
    respond: (requestId: string, allowed: boolean) => Promise<{ ok: boolean }>;
    addRule: (rule: import('./advanced').PermissionRule, requestId: string) => Promise<{ ok: boolean }>;
    getRules: () => Promise<{ ok: boolean; data?: import('./advanced').PermissionRule[] }>;
    removeRule: (ruleId: string) => Promise<{ ok: boolean; data?: import('./advanced').PermissionRule[]; error?: string }>;
    clearRules: () => Promise<{ ok: boolean }>;
    onRequest: (callback: (request: import('./advanced').PermissionRequest) => void) => () => void;
  };

  permissionProfile: {
    list: () => Promise<{ ok: boolean; data?: { profiles: PermissionProfile[]; activeId: string }; error?: string }>;
    save: (custom: PermissionProfile[], activeId: string) => Promise<{ ok: boolean; error?: string }>;
    listProjectProfiles: () => Promise<{
      ok: boolean;
      data?: { profiles: PermissionProfile[]; activeId: string; overrides: Record<string, string> };
      error?: string;
    }>;
    setProjectProfile: (path: string, profileId: string | null) => Promise<{ ok: boolean; error?: string }>;
    moveProjectProfile: (from: string, to: string) => Promise<{ ok: boolean; error?: string }>;
  };

  ask: {
    respond: (askId: string, answer: string) => Promise<{ ok: boolean; error?: string }>;
    onRequest: (callback: (request: AskRequest) => void) => () => void;
  };

  runtime: {
    syncPlugins: (plugins: RuntimePluginInfo[]) => Promise<{ ok: boolean }>;
  };

  mcp: {
    getServers: () => Promise<{ ok: boolean; data?: import('./advanced').MCPServerConfig[] }>;
    setServers: (servers: import('./advanced').MCPServerConfig[]) => Promise<{ ok: boolean }>;
    connect: (serverId: string) => Promise<{ ok: boolean; data?: import('./advanced').MCPStatus; error?: string }>;
    disconnect: (serverId: string) => Promise<{ ok: boolean; data?: import('./advanced').MCPStatus }>;
    getStatuses: () => Promise<{ ok: boolean; data?: import('./advanced').MCPStatus[] }>;
    listTools: (serverId: string) => Promise<{ ok: boolean; data?: import('./advanced').MCPToolDef[]; error?: string }>;
    callTool: (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  };

  agent: {
    create: (request: import('./advanced').AgentCreateRequest) => Promise<{ ok: boolean; data?: import('./advanced').AgentInfo }>;
    start: (config: any, projectPath: string) => Promise<{ ok: boolean; data?: { agentId: string } }>;
    stop: (agentId: string) => Promise<{ ok: boolean }>;
    schedulerStop: (agentId: string) => Promise<{ ok: boolean }>;
    pause: (agentId: string) => Promise<{ ok: boolean; data?: { paused: boolean } }>;
    resume: (agentId: string) => Promise<{ ok: boolean; data?: { resumed: boolean } }>;
    continue: (agentId: string, instruction: string, displayInstruction?: string) => Promise<{ ok: boolean; data?: { continued: boolean }; error?: string }>;
    approveDelivery: (agentId: string) => Promise<{ ok: boolean; data?: { approved: boolean }; error?: string }>;
    setPriority: (agentId: string, priority: string) => Promise<{ ok: boolean }>;
    getQueue: () => Promise<{ ok: boolean; data?: { running: any[]; queued: any[] } }>;
    setMaxConcurrent: (n: number) => Promise<{ ok: boolean }>;
    getAll: () => Promise<{ ok: boolean; data?: any[] }>;
    getState: (agentId: string) => Promise<{ ok: boolean; data?: any }>;
    list: () => Promise<{ ok: boolean; data?: import('./advanced').AgentInfo[] }>;
    get: (agentId: string) => Promise<{ ok: boolean; data?: import('./advanced').AgentInfo; error?: string }>;
    remove: (agentId: string) => Promise<{ ok: boolean }>;
    clear: () => Promise<{ ok: boolean }>;
    clearAll: () => Promise<{ ok: boolean; data?: { cleared: number }; error?: string }>;
    onUpdated: (callback: (agent: import('./advanced').AgentInfo) => void) => () => void;
    onEvent: (agentId: string, callback: (event: import('./tools').ToolStreamEvent) => void) => () => void;
  };

  worktree: {
    getStatus: (sessionKey: string) => Promise<{ ok: boolean; data?: { active: boolean; sandboxPath: string | null; sessionKey: string }; error?: string }>;
    onChanged: (callback: (data: { active: boolean; sandboxPath?: string; taskId?: string }) => void) => () => void;
  };

  stats?: {
    get: () => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  };

  tokenizer?: {
    count: (text: string) => Promise<{ ok: boolean; data?: number; error?: string }>;
  };

  memory: {
    extract: (sessionContext: any) => Promise<{ ok: boolean; data?: any[]; error?: string }>;
    getByProject: (projectPath: string) => Promise<{ ok: boolean; data?: any[]; error?: string }>;
    getByType: (projectPath: string, type: string) => Promise<{ ok: boolean; data?: any[]; error?: string }>;
    search: (projectPath: string, query: string) => Promise<{ ok: boolean; data?: any[]; error?: string }>;
    archive: (id: string) => Promise<{ ok: boolean; error?: string }>;
    delete: (id: string) => Promise<{ ok: boolean; error?: string }>;
    evidenceList: (projectPath: string) => Promise<{ ok: boolean; data?: EvidenceRecord[]; error?: string }>;
    evidenceDetail: (id: string) => Promise<{
      ok: boolean;
      data?: { evidence: EvidenceRecord; signals: SignalRecord[] } | null;
      error?: string;
    }>;
    readForQuery: (projectPath: string, query: string, opts?: unknown) =>
      Promise<{ ok: boolean; data?: MemoryReadResult; error?: string }>;
    beliefAudit: (id: string) => Promise<{
      ok: boolean;
      data?: {
        belief: BeliefRecord;
        evidence: {
          evidence: EvidenceRecord;
          support_strength: number;
          signals: SignalRecord[];
        }[];
        revisions: { id: string; belief_id: string; prev_status: string | null; next_status: string; reason: string | null; actor: string; ts: number }[];
      } | null;
      error?: string;
    }>;
    readTrace: (runId: string) => Promise<{ ok: boolean; data?: ReadTrace | null; error?: string }>;
    erase: (scope: string) => Promise<{ ok: boolean; data?: { erased: number }; error?: string }>;
    reindex: (projectPath: string) => Promise<{
      ok: boolean;
      data?: { signals: number; beliefsChecked: number; rejected: number };
      error?: string;
    }>;
    graph: (projectPath: string, role?: string, agent?: { id?: string; name?: string }) =>
      Promise<{ ok: boolean; data?: any; error?: string }>;
    rejections: (projectPath: string) => Promise<{ ok: boolean; data?: BeliefRejection[]; error?: string }>;
  };

  conflict: {
    getConflicts: () => Promise<{ ok: boolean; data?: any[]; error?: string }>;
    getFileHistory: (filePath: string) => Promise<{ ok: boolean; data?: any[]; error?: string }>;
  };

  plan: {
    approve: (planId: string, approvedStepIds: string[]) => Promise<{ ok: boolean; error?: string }>;
    reject: (planId: string) => Promise<{ ok: boolean; error?: string }>;
    list: (projectRoot?: string) => Promise<{ ok: boolean; data?: { path: string; name: string; relative?: string; createdAt: number }[]; error?: string }>;
    onGenerated: (callback: (data: { planId: string; steps: { id: string; toolName: string; description: string; parameters: Record<string, unknown> }[]; filePath?: string; agentId?: string }) => void) => () => void;
  };

  undo: {
    getHistory: (sessionId?: string) => Promise<{ ok: boolean; data?: any[]; error?: string }>;
    getList: () => Promise<{ ok: boolean; data?: any[]; error?: string }>;
    getSessionDiffs: (sessionId: string, projectRoot: string) => Promise<{ ok: boolean; data?: WorkspaceFileDiff[]; error?: string }>;
    revertSessionFile: (sessionId: string, relPath: string, projectRoot: string) => Promise<{ ok: boolean; data?: { reverted: number }; error?: string }>;
    execute: (fileId: string, projectRoot: string) => Promise<{ ok: boolean; error?: string }>;
    revert: (fileId: string, projectRoot: string) => Promise<{ ok: boolean; error?: string }>;
    revertLast: (projectRoot: string) => Promise<{ ok: boolean; error?: string }>;
    revertSessions: (sessionIds: string[], projectRoot: string) => Promise<{ ok: boolean; data?: { reverted: number }; error?: string }>;
  };

  snapshot: {
    create: (projectRoot: string, name: string) => Promise<{ ok: boolean; data?: NamedSnapshot; error?: string }>;
    list: (projectRoot: string) => Promise<{ ok: boolean; data?: NamedSnapshot[]; error?: string }>;
    restore: (id: string, projectRoot: string) => Promise<{ ok: boolean; data?: { restored: number; skipped: number }; error?: string }>;
    delete: (id: string, projectRoot: string) => Promise<{ ok: boolean; error?: string }>;
  };

  lint: {
    fix: (projectRoot: string, files?: string[]) => Promise<{ ok: boolean; data?: { exitCode: number | null; output: string }; error?: string }>;
  };

  settings: {
    get: (key?: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
    set: (key: string, value: unknown) => Promise<{ ok: boolean; error?: string }>;
    getApiKey: (provider: string) => Promise<{ ok: boolean; data?: string; error?: string }>;
    setApiKey: (provider: string, key: string) => Promise<{ ok: boolean; error?: string }>;
  };

  model: {
    getAll: () => Promise<{ ok: boolean; data?: ModelDefinition[]; error?: string }>;
  };

  shell: {
    openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
    openPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
    openInVSCode: (projectPath: string) => Promise<{ ok: boolean; error?: string }>;
    openFileInVSCode: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
    openSkillsDirectory: () => Promise<{ ok: boolean; data?: string; error?: string }>;
  };
  skills: {
    list: () => Promise<{
      ok: boolean;
      data?: {
        skills: { name: string; description: string; whenToUse?: string; path: string; updatedAt: number }[];
        complete: boolean;
      };
      error?: string;
    }>;
    read: (name: string) => Promise<{
      ok: boolean;
      data?: { name: string; description: string; whenToUse?: string; path: string; updatedAt: number; body: string };
      error?: string;
    }>;
  };
  goal: {
    get: (sessionId: string) => Promise<{ ok: boolean; data?: import('./agent').AgentGoalState | null; error?: string }>;
    create: (sessionId: string, text: string, maxRounds?: number) => Promise<{ ok: boolean; data?: import('./agent').AgentGoalState | null; error?: string }>;
    edit: (sessionId: string, text: string) => Promise<{ ok: boolean; data?: import('./agent').AgentGoalState | null; error?: string }>;
    pause: (sessionId: string) => Promise<{ ok: boolean; data?: import('./agent').AgentGoalState | null; error?: string }>;
    resume: (sessionId: string) => Promise<{ ok: boolean; data?: import('./agent').AgentGoalState | null; error?: string }>;
    complete: (sessionId: string) => Promise<{ ok: boolean; data?: import('./agent').AgentGoalState | null; error?: string }>;
    block: (sessionId: string, reason: string) => Promise<{ ok: boolean; data?: import('./agent').AgentGoalState | null; error?: string }>;
    clear: (sessionId: string) => Promise<{ ok: boolean; data?: import('./agent').AgentGoalState | null; error?: string }>;
    round: (sessionId: string) => Promise<{ ok: boolean; data?: import('./agent').AgentGoalState | null; error?: string }>;
  };
  cron: {
    create: (params: { name: string; prompt: string; cron: string; recurring: boolean }) => Promise<{ ok: boolean; data?: { jobId: string; nextFireAt: number }; error?: string }>;
    delete: (jobId: string) => Promise<{ ok: boolean; error?: string }>;
    list: () => Promise<{ ok: boolean; data?: { id: string; name: string; cron: string; recurring: boolean; nextFireAt: number; firedCount: number; createdAt: number; lastRun?: { at: number; status: string; result?: string; error?: string } }[]; error?: string }>;
  };
  credentials: {
    describe: (name: string, projectRoot?: string) => Promise<{ ok: boolean; data?: { configured: boolean; source?: 'env' | 'user-env' | 'project-env'; writable: boolean }; error?: string }>;
    set: (name: string, value: string) => Promise<{ ok: boolean; error?: string }>;
    unset: (name: string) => Promise<{ ok: boolean; error?: string }>;
  };
  actions: {
    list: (projectRoot: string) => Promise<{ ok: boolean; data?: { name: string; command: string; platform?: string }[]; error?: string }>;
  };
  terminal: {
    create: (payload: { id: string; cwd?: string; cols?: number; rows?: number }) => Promise<{ ok: boolean; error?: string }>;
    input: (id: string, data: string) => Promise<{ ok: boolean }>;
    resize: (id: string, cols: number, rows: number) => Promise<{ ok: boolean }>;
    kill: (id: string) => Promise<{ ok: boolean }>;
    listTasks: () => Promise<{ ok: boolean; data?: TerminalTask[]; error?: string }>;
    stopTask: (id: string) => Promise<{ ok: boolean; error?: string }>;
    clearTasks: () => Promise<{ ok: boolean; error?: string }>;
    onData: (id: string, cb: (data: string) => void) => () => void;
    onExit: (id: string, cb: (info: { exitCode: number; error?: string }) => void) => () => void;
    onTasksChanged: (cb: (tasks: TerminalTask[]) => void) => () => void;
  };
  agentShell: {
    attach: (agentId: string) => Promise<{ ok: boolean; buffer?: string; exited?: boolean; error?: string }>;
    detach: (agentId: string) => Promise<{ ok: boolean }>;
    write: (agentId: string, data: string) => Promise<{ ok: boolean; error?: string }>;
    onData: (agentId: string, cb: (data: string) => void) => () => void;
    onExit: (agentId: string, cb: () => void) => () => void;
  };
  ssh: {
    list: () => Promise<{ ok: boolean; data?: { id: string; name: string; host: string; port: number; username: string; keyPath?: string; useAgent?: boolean; createdAt: number }[]; error?: string }>;
    save: (conn: { id?: string; name?: string; host: string; port?: number; username?: string; keyPath?: string; useAgent?: boolean }) => Promise<{ ok: boolean; data?: { id: string; name: string; host: string; port: number; username: string; keyPath?: string; useAgent?: boolean; createdAt: number }[]; error?: string }>;
    remove: (id: string) => Promise<{ ok: boolean; data?: { id: string; name: string; host: string; port: number; username: string; keyPath?: string; useAgent?: boolean; createdAt: number }[]; error?: string }>;
    test: (conn: { id?: string; name?: string; host: string; port?: number; username?: string; keyPath?: string; useAgent?: boolean }) => Promise<{ ok: boolean; data?: { output: string }; error?: string }>;
    exec: (conn: { id?: string; name?: string; host: string; port?: number; username?: string; keyPath?: string; useAgent?: boolean }, command: string) => Promise<{ ok: boolean; data?: { output: string }; error?: string }>;
  };
  rules: {
    list: (projectRoot?: string) => Promise<{ ok: boolean; data?: { pattern: string[]; decision: 'allow' | 'deny' | 'prompt'; justification?: string; source: string }[]; error?: string }>;
  };
  sessionLog: {
    read: (agentId: string) => Promise<{ ok: boolean; data?: Record<string, unknown>[]; error?: string }>;
    project: (agentId: string) => Promise<{ ok: boolean; data?: ProjectedChatSession | null; error?: string }>;
  };
  chatLog: {
    append: (sessionId: string, events: Array<Omit<ChatLogEvent, 'seq'>>, projectRoot?: string) =>
      Promise<{ ok: boolean; error?: string }>;
    read: (sessionId: string) => Promise<{ ok: boolean; data?: ChatLogEvent[]; error?: string }>;
    list: () => Promise<{ ok: boolean; data?: ChatSessionSummary[]; error?: string }>;
    project: (sessionId: string) => Promise<{ ok: boolean; data?: ProjectedChatSession | null; error?: string }>;
    delete: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
    fork: (sessionId: string, uptoMessageId?: string) => Promise<{ ok: boolean; data?: string | null; error?: string }>;
    meta: (sessionId: string, meta: ChatSessionMeta) => Promise<{ ok: boolean; error?: string }>;
  };
  workflow: {
    list: (projectRoot?: string) => Promise<{ ok: boolean; data?: { id: string; name: string; description?: string; steps: { id: string; name: string; agentType?: string; prompt: string; dependsOn?: string[] }[] }[]; error?: string }>;
    run: (payload: { workflowId: string; projectRoot: string }) => Promise<{ ok: boolean; data?: { runId: string }; error?: string }>;
    get: (runId: string) => Promise<{ ok: boolean; data?: { runId: string; workflowId: string; workflowName: string; status: string; startedAt: number; endedAt?: number; steps: Record<string, { status: string; result?: string; error?: string; agentId?: string }> }; error?: string }>;
    runs: (workflowId?: string) => Promise<{ ok: boolean; data?: { runId: string; workflowId: string; workflowName: string; status: string; startedAt: number; endedAt?: number; steps: Record<string, { status: string; result?: string; error?: string; agentId?: string }> }[]; error?: string }>;
  };
  fts: {
    search: (query: string, limit?: number) => Promise<{ ok: boolean; data?: { type: 'chat' | 'agent'; id: string; title: string; snippet: string; ts: number; score: number }[]; error?: string }>;
    rebuild: () => Promise<{ ok: boolean; data?: { indexed: number }; error?: string }>;
  };
  feedback: {
    submit: (text: string) => Promise<{ ok: boolean; error?: string }>;
    message: (record: { messageId: string; sessionId: string; rating: 'up' | 'down' | null; note?: string; projectPath?: string }) =>
      Promise<{ ok: boolean; error?: string }>;
    messageList: (sessionId: string) => Promise<{
      ok: boolean;
      data?: { messageId: string; sessionId: string; rating: 'up' | 'down' | null; note?: string; ts: number }[];
      error?: string;
    }>;
  };
  sessionTitle: {
    generate: (messages: { content: string }[]) => Promise<{ ok: boolean; data?: { title: string }; error?: string }>;
  };
  pluginState: {
    get: () => Promise<{ ok: boolean; data?: { enabledIds: string[] }; error?: string }>;
    set: (id: string, enabled: boolean) => Promise<{ ok: boolean; data?: { enabledIds: string[] }; error?: string }>;
  };

  system: {
    getStats: () => Promise<{ ok: boolean; data?: SystemStats; error?: string }>;
    getGitBranches: (projectRoot: string) => Promise<{ ok: boolean; data?: { current: string; branches: string[] }; error?: string }>;
    getVersion: () => Promise<{ ok: boolean; data?: string; error?: string }>;
    getAccountInfo: (apiKey: string) => Promise<{
      ok: boolean;
      data?: { balance: string; toppedUp: string; currency: string };
      error?: string;
    }>;
  };

  coverage: {
    get: () => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  };

  browser?: {
    onRefresh?: (callback: (data: any) => void) => () => void;
  };

  app?: {
    onError?: (callback: (err: { message?: string; stack?: string }) => void) => () => void;
  };
}

export interface SystemStats {
  cpu: number;
  mem: { usedGB: string; totalGB: string; percent: number };
  hostname: string;
  platform: string;
  arch: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    __auraxis_project_path?: string;
  }
}
