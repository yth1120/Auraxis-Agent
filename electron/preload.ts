import { contextBridge, ipcRenderer } from 'electron';
import type { ToolStreamEvent } from './tool-defs';
import type { AgentInfo, PermissionRequest } from './contracts/advanced';
import type { TerminalTask } from './ipc/task-monitor';
import type { ApplyCodePayload, ApiMessage } from './contracts/core';

interface UsageEvent {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

type QueryEvent = ToolStreamEvent;
type AgentEventPayload = { type: string } & Record<string, unknown>;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Track active subscriptions so abort can clean up listeners
const queryCleanups = new Map<string, () => void>();
const streamCleanups = new Map<string, () => void>();

const electronAPI = {
  // --- Platform ---
  platform: process.platform,
  // User home directory — terminal prompts collapse it to `~`.
  homePath: process.env.USERPROFILE || process.env.HOME || '',

  // --- Window controls ---
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  focusWindow: () => ipcRenderer.invoke('window:focus'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  // UI zoom: delta in zoom-level steps (+0.5 / -0.5), null resets to 100%.
  zoom: (delta: number | null) => ipcRenderer.invoke('window:zoom', delta),
  // Native frosted-glass window material (Windows 11 Acrylic) for the sidebar.
  setBackgroundMaterial: (enabled: boolean) => ipcRenderer.invoke('window:setBackgroundMaterial', enabled),
  backgroundMaterialSupported: () => ipcRenderer.invoke('window:backgroundMaterialSupported'),
  getGlassState: () => ipcRenderer.invoke('window:glassState'),
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isMaximized: boolean) => callback(isMaximized);
    ipcRenderer.on('window:maximize-changed', handler);
    return () => {
      ipcRenderer.removeListener('window:maximize-changed', handler);
    };
  },

  // --- Local account / login ---
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    setup: (params: { name: string; email: string; password: string; rememberMe: boolean }) =>
      ipcRenderer.invoke('auth:setup', params),
    login: (params: { email: string; password: string; rememberMe: boolean }) =>
      ipcRenderer.invoke('auth:login', params),
    logout: () => ipcRenderer.invoke('auth:logout'),
    changePassword: (params: { currentPassword: string; newPassword: string }) =>
      ipcRenderer.invoke('auth:changePassword', params),
    setAvatar: (avatar: string) => ipcRenderer.invoke('auth:setAvatar', avatar),
    changeName: (name: string) => ipcRenderer.invoke('auth:changeName', { name }),
  },

  // --- File operations ---
  file: {
    open: (projectRoot?: string) => ipcRenderer.invoke('file:open', projectRoot),
    read: (filePath: string, projectRoot?: string) => ipcRenderer.invoke('file:read', filePath, projectRoot),
    estimateTokens: (files: string[], projectRoot?: string) =>
      ipcRenderer.invoke('file:estimateTokens', files, projectRoot),
    readPreview: (filePath: string, projectRoot?: string) =>
      ipcRenderer.invoke('file:readPreview', filePath, projectRoot),
    write: (filePath: string, content: string) => ipcRenderer.invoke('file:write', filePath, content),
    search: (keyword: string, projectRoot: string) => ipcRenderer.invoke('file:search', keyword, projectRoot),
    delete: (filePath: string, projectRoot?: string) => ipcRenderer.invoke('file:delete', filePath, projectRoot),
    rename: (oldPath: string, newPath: string, projectRoot?: string) =>
      ipcRenderer.invoke('file:rename', oldPath, newPath, projectRoot),
    createFolder: (dirPath: string, projectRoot?: string) =>
      ipcRenderer.invoke('file:createFolder', dirPath, projectRoot),
    createFile: (filePath: string, projectRoot?: string) =>
      ipcRenderer.invoke('file:createFile', filePath, projectRoot),
  },

  // --- Project operations ---
  project: {
    getTree: (projectRoot: string) => ipcRenderer.invoke('project:getTree', projectRoot),
    applyCode: (payload: ApplyCodePayload) => ipcRenderer.invoke('project:applyCode', payload),
    previewCode: (payload: ApplyCodePayload) => ipcRenderer.invoke('project:previewCode', payload),
    selectDirectory: () => ipcRenderer.invoke('project:selectDirectory'),
    loadGlobalState: () => ipcRenderer.invoke('project:loadGlobalState'),
    saveGlobalState: (state: unknown) => ipcRenderer.invoke('project:saveGlobalState', state),
  },

  // --- AI operations ---
  ai: {
    chatStream: (
      request: {
        model: string;
        messages: ApiMessage[];
        isDeepThink: boolean;
        reasoningEffort?: 'low' | 'high' | 'max';
        isWebSearch: boolean;
        apiKey?: string;
        surface?: 'chat' | 'work' | 'code';
        prefix?: { content: string; stop?: string[] };
      },
      callbacks: {
        onChunk: (text: string) => void;
        onThinking?: (text: string) => void;
        onUsage?: (usage: {
          inputTokens: number;
          outputTokens: number;
          reasoningTokens?: number;
          cacheHitTokens?: number;
          cacheMissTokens?: number;
        }) => void;
        onDone: () => void;
        onError: (error: string) => void;
      },
    ) => {
      const requestId = generateId();

      const chunkHandler = (
        _event: Electron.IpcRendererEvent,
        data: { requestId: string; type: string; text?: string; usage?: UsageEvent; error?: string },
      ) => {
        if (data.requestId !== requestId) return;
        try {
          switch (data.type) {
            case 'chunk':
              callbacks.onChunk(data.text || '');
              break;
            case 'thinking':
              callbacks.onThinking?.(data.text || '');
              break;
            case 'usage':
              if (data.usage) callbacks.onUsage?.(data.usage);
              break;
            case 'done':
              cleanup();
              callbacks.onDone();
              break;
            case 'error':
              cleanup();
              callbacks.onError(data.error || '未知错误');
              break;
          }
        } catch (err) {
          cleanup();
          callbacks.onError(String(err));
        }
      };

      const cleanup = () => {
        streamCleanups.delete(requestId);
        ipcRenderer.removeListener(`ai:chunk:${requestId}`, chunkHandler);
      };

      streamCleanups.set(requestId, cleanup);
      ipcRenderer.on(`ai:chunk:${requestId}`, chunkHandler);

      ipcRenderer.invoke('ai:chatStream', { ...request, requestId });

      return {
        requestId,
        unsubscribe: cleanup,
      };
    },

    abortStream: (requestId: string) => {
      const cleanup = streamCleanups.get(requestId);
      if (cleanup) cleanup();
      return ipcRenderer.invoke('ai:abortStream', requestId);
    },
    // FIM 补全（Beta）：中间填充，供编辑器/行内补全使用。
    fim: (params: { model: string; apiKey?: string; prompt: string; suffix?: string; maxTokens?: number }) =>
      ipcRenderer.invoke('ai:fim', params),

    sendQuery: (
      request: {
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
      },
      callbacks: { onEvent: (event: QueryEvent) => void; onDone: () => void; onError: (error: string) => void },
    ) => {
      const requestId = generateId();

      const eventHandler = (_event: Electron.IpcRendererEvent, raw: QueryEvent) => {
        const data = raw as ToolStreamEvent;
        if (data.requestId !== requestId) return;
        if (data.type === 'done') {
          callbacks.onEvent(data);
          cleanup();
          callbacks.onDone();
        } else if (data.type === 'error') {
          callbacks.onEvent(data);
          cleanup();
          callbacks.onError(data.error || '未知错误');
        } else {
          callbacks.onEvent(data);
        }
      };

      const cleanup = () => {
        queryCleanups.delete(requestId);
        ipcRenderer.removeListener(`ai:queryEvent:${requestId}`, eventHandler);
      };

      queryCleanups.set(requestId, cleanup);
      ipcRenderer.on(`ai:queryEvent:${requestId}`, eventHandler);

      ipcRenderer.invoke('ai:sendQuery', { ...request, requestId });

      return {
        requestId,
        unsubscribe: cleanup,
      };
    },

    abortQuery: (requestId: string) => {
      const cleanup = queryCleanups.get(requestId);
      if (cleanup) cleanup();
      return ipcRenderer.invoke('ai:abortQuery', requestId);
    },

    clearQueryContext: (sessionId: string) => ipcRenderer.invoke('ai:clearQueryContext', sessionId),

    abortTool: (requestId: string, toolCallId: string) => ipcRenderer.invoke('ai:abortTool', requestId, toolCallId),

    retryTool: (requestId: string, toolName: string) => ipcRenderer.invoke('ai:retryTool', requestId, toolName),

    setApiKey: (apiKey: string) => ipcRenderer.invoke('api:setKey', 'deepseek', apiKey),

    testConnection: (apiKey: string) => ipcRenderer.invoke('ai:testConnection', { apiKey }),
  },

  // --- 官方离线 tokenizer ---
  tokenizer: {
    count: (text: string) => ipcRenderer.invoke('tokenizer:count', text),
  },

  // --- Memory ---
  memory: {
    extract: (ctx: unknown) => ipcRenderer.invoke('memory:extract', ctx),
    getByProject: (projectPath: string) => ipcRenderer.invoke('memory:getByProject', projectPath),
    getByType: (projectPath: string, type: string) => ipcRenderer.invoke('memory:getByType', projectPath, type),
    search: (projectPath: string, query: string) => ipcRenderer.invoke('memory:search', projectPath, query),
    archive: (id: string) => ipcRenderer.invoke('memory:archive', id),
    delete: (id: string) => ipcRenderer.invoke('memory:delete', id),
    evidenceList: (projectPath: string) => ipcRenderer.invoke('memory:evidenceList', projectPath),
    evidenceDetail: (id: string) => ipcRenderer.invoke('memory:evidenceDetail', id),
    readForQuery: (projectPath: string, query: string, opts?: unknown) =>
      ipcRenderer.invoke('memory:readForQuery', projectPath, query, opts),
    beliefAudit: (id: string) => ipcRenderer.invoke('memory:beliefAudit', id),
    readTrace: (runId: string) => ipcRenderer.invoke('memory:readTrace', runId),
    erase: (scope: string) => ipcRenderer.invoke('memory:erase', scope),
    reindex: (projectPath: string) => ipcRenderer.invoke('memory:reindex', projectPath),
    graph: (projectPath: string, role?: string, agent?: { id?: string; name?: string }) =>
      ipcRenderer.invoke('memory:graph', projectPath, role, agent),
    rejections: (projectPath: string) => ipcRenderer.invoke('memory:rejections', projectPath),
  },

  // --- Settings ---
  settings: {
    get: (key?: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    getApiKeyStatus: (provider: string) => ipcRenderer.invoke('settings:getApiKeyStatus', provider),
    setApiKey: (provider: string, key: string) => ipcRenderer.invoke('api:setKey', provider, key),
  },

  // --- Context ---
  context: {
    getProjectContext: (projectRoot: string) => ipcRenderer.invoke('context:getProjectContext', projectRoot),
    getFileStructure: (projectRoot: string) => ipcRenderer.invoke('context:getFileStructure', projectRoot),
    readFile: (filePath: string, projectRoot?: string) => ipcRenderer.invoke('context:readFile', filePath, projectRoot),
    compact: (projectRoot: string, messages: { role: string; content: string }[]) =>
      ipcRenderer.invoke('context:compact', { projectRoot, messages }),
  },

  // --- Instructions (global / folder-level AGENTS.md) ---
  instructions: {
    getGlobal: () => ipcRenderer.invoke('instructions:getGlobal'),
    setGlobal: (content: string) => ipcRenderer.invoke('instructions:setGlobal', content),
    listProject: (projectRoot: string) => ipcRenderer.invoke('instructions:listProject', projectRoot),
    get: (projectRoot: string, relPath?: string) => ipcRenderer.invoke('instructions:get', projectRoot, relPath),
    set: (projectRoot: string, relPath: string | undefined, content: string) =>
      ipcRenderer.invoke('instructions:set', projectRoot, relPath, content),
  },

  // --- Cloud connectors (Slack / Drive / Notion / Feishu-Lark) ---
  connectors: {
    status: () => ipcRenderer.invoke('connector:status'),
    setToken: (kind: 'slack' | 'drive' | 'notion', token: string) =>
      ipcRenderer.invoke('connector:setToken', kind, token),
    getLark: () => ipcRenderer.invoke('connector:getLark'),
    setLark: (input: { appId: string; appSecret: string; domain?: string; tools?: string }) =>
      ipcRenderer.invoke('connector:setLark', input),
    test: (kind: 'slack' | 'drive' | 'notion' | 'lark') => ipcRenderer.invoke('connector:test', kind),
  },

  // --- Permission ---
  permission: {
    respond: (requestId: string, allowed: boolean) => ipcRenderer.invoke('permission:respond', requestId, allowed),
    addRule: (rule: unknown, requestId: string) => ipcRenderer.invoke('permission:addRule', rule, requestId),
    getRules: () => ipcRenderer.invoke('permission:getRules'),
    removeRule: (ruleId: string) => ipcRenderer.invoke('permission:removeRule', ruleId),
    clearRules: () => ipcRenderer.invoke('permission:clearRules'),
    onRequest: (callback: (request: PermissionRequest) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, request: PermissionRequest) => callback(request);
      ipcRenderer.on('permission:request', handler);
      return () => {
        ipcRenderer.removeListener('permission:request', handler);
      };
    },
  },

  // --- Permission profiles ---
  permissionProfile: {
    list: () => ipcRenderer.invoke('permission:listProfiles'),
    save: (custom: unknown[], activeId: string) => ipcRenderer.invoke('permission:saveProfiles', { custom, activeId }),
    listProjectProfiles: () => ipcRenderer.invoke('permission:listProjectProfiles'),
    setProjectProfile: (path: string, profileId: string | null) =>
      ipcRenderer.invoke('permission:setProjectProfile', { path, profileId }),
    moveProjectProfile: (from: string, to: string) => ipcRenderer.invoke('permission:moveProjectProfile', { from, to }),
  },

  // --- AskUser (model → human question) ---
  ask: {
    respond: (askId: string, answer: string) => ipcRenderer.invoke('ask:respond', askId, answer),
    onRequest: (callback: (request: { askId: string; question: string; options: string[] }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, request: unknown) =>
        callback(request as { askId: string; question: string; options: string[] });
      ipcRenderer.on('ask:request', handler);
      return () => {
        ipcRenderer.removeListener('ask:request', handler);
      };
    },
  },

  // --- Runtime inspect (bounded self-modification) ---
  runtime: {
    syncPlugins: (plugins: unknown[]) => ipcRenderer.invoke('runtime:syncPlugins', plugins),
  },

  // --- MCP ---
  mcp: {
    getServers: () => ipcRenderer.invoke('mcp:getServers'),
    setServers: (servers: unknown[]) => ipcRenderer.invoke('mcp:setServers', servers),
    connect: (serverId: string) => ipcRenderer.invoke('mcp:connect', serverId),
    disconnect: (serverId: string) => ipcRenderer.invoke('mcp:disconnect', serverId),
    getStatuses: () => ipcRenderer.invoke('mcp:getStatuses'),
    listTools: (serverId: string) => ipcRenderer.invoke('mcp:listTools', serverId),
    callTool: (serverId: string, toolName: string, args: unknown) =>
      ipcRenderer.invoke('mcp:callTool', serverId, toolName, args),
  },

  // --- Agent ---
  agent: {
    start: (config: unknown, projectPath: string) => ipcRenderer.invoke('agent:start', { config, projectPath }),
    schedulerStop: (agentId: string) => ipcRenderer.invoke('agent:schedulerStop', agentId),
    pause: (agentId: string) => ipcRenderer.invoke('agent:pause', agentId),
    resume: (agentId: string) => ipcRenderer.invoke('agent:resume', agentId),
    continue: (agentId: string, instruction: string, displayInstruction?: string) =>
      ipcRenderer.invoke('agent:continue', agentId, instruction, displayInstruction),
    approveDelivery: (agentId: string) => ipcRenderer.invoke('agent:approveDelivery', agentId),
    setPriority: (agentId: string, priority: string) => ipcRenderer.invoke('agent:setPriority', agentId, priority),
    getQueue: () => ipcRenderer.invoke('agent:getQueue'),
    setMaxConcurrent: (n: number) => ipcRenderer.invoke('agent:setMaxConcurrent', n),
    getAll: () => ipcRenderer.invoke('agent:getAll'),
    getState: (agentId: string) => ipcRenderer.invoke('agent:getState', agentId),
    // Two delete paths run from useAgentStore.removeAgent:
    //   remove           → cleans the agent-handlers Map (sub-agents spawned via the Agent tool)
    //   schedulerRemove  → cleans scheduler.instances (sidebar-created agents)
    // Calling both is intentional — an agentId may live in either Map.
    remove: (agentId: string) => ipcRenderer.invoke('agent:remove', agentId),
    schedulerRemove: (agentId: string) => ipcRenderer.invoke('agent:schedulerRemove', agentId),
    clear: () => ipcRenderer.invoke('agent:clear'),
    clearAll: () => ipcRenderer.invoke('agent:clearAll'),
    onUpdated: (callback: (agent: AgentInfo) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, agent: AgentInfo) => callback(agent);
      ipcRenderer.on('agent:updated', handler);
      return () => {
        ipcRenderer.removeListener('agent:updated', handler);
      };
    },
    onEvent: (agentId: string, callback: (event: AgentEventPayload) => void) => {
      const channel = `agent:event:${agentId}`;
      const handler = (_event: Electron.IpcRendererEvent, data: AgentEventPayload) => callback(data);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
  },

  // --- App-level errors ---
  // Surfaces uncaughtException / unhandledRejection raised in the main process.
  // App.tsx mounts a single listener and toasts the message so users see
  // failures instead of them disappearing into stderr.
  app: {
    onError: (callback: (err: { message: string; stack?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, err: unknown) =>
        callback(err as { message: string; stack?: string });
      ipcRenderer.on('app:error', handler);
      return () => {
        ipcRenderer.removeListener('app:error', handler);
      };
    },
  },

  // --- Model ---
  model: {
    getAll: () => ipcRenderer.invoke('model:getAll'),
  },

  // --- Worktree sandbox ---
  worktree: {
    getStatus: (sessionKey: string) => ipcRenderer.invoke('worktree:getStatus', sessionKey),
    onChanged: (callback: (data: { active: boolean; sandboxPath?: string; taskId?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as { active: boolean; sandboxPath?: string; taskId?: string });
      ipcRenderer.on('worktree:changed', handler);
      return () => {
        ipcRenderer.removeListener('worktree:changed', handler);
      };
    },
  },

  // --- Conflict detection ---
  conflict: {
    getConflicts: () => ipcRenderer.invoke('conflict:getConflicts'),
    getFileHistory: (filePath: string) => ipcRenderer.invoke('conflict:getFileHistory', filePath),
  },

  // --- Plan approval ---
  plan: {
    approve: (planId: string, approvedStepIds: string[]) =>
      ipcRenderer.invoke('plan:approve', { planId, approvedStepIds }),
    reject: (planId: string) => ipcRenderer.invoke('plan:reject', { planId }),
    list: (projectRoot?: string) => ipcRenderer.invoke('plan:list', { projectRoot }),
    onGenerated: (
      callback: (data: {
        planId: string;
        steps: { id: string; toolName: string; description: string; parameters: Record<string, unknown> }[];
        filePath?: string;
        agentId?: string;
      }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
        callback(
          data as {
            planId: string;
            steps: { id: string; toolName: string; description: string; parameters: Record<string, unknown> }[];
            filePath?: string;
            agentId?: string;
          },
        );
      ipcRenderer.on('plan:generated', handler);
      return () => {
        ipcRenderer.removeListener('plan:generated', handler);
      };
    },
  },

  // --- Undo ---
  undo: {
    getHistory: (sessionId?: string) => ipcRenderer.invoke('undo:getHistory', sessionId),
    getList: () => ipcRenderer.invoke('undo:getList'),
    getSessionDiffs: (sessionId: string, projectRoot: string) =>
      ipcRenderer.invoke('undo:getSessionDiffs', sessionId, projectRoot),
    revertSessionFile: (sessionId: string, relPath: string, projectRoot: string) =>
      ipcRenderer.invoke('undo:revertSessionFile', { sessionId, relPath, projectRoot }),
    execute: (fileId: string, projectRoot: string) => ipcRenderer.invoke('undo:execute', fileId, projectRoot),
    revert: (fileId: string, projectRoot: string) => ipcRenderer.invoke('undo:revert', fileId, projectRoot),
    revertLast: (projectRoot: string) => ipcRenderer.invoke('undo:revertLast', projectRoot),
    revertSessions: (sessionIds: string[], projectRoot: string) =>
      ipcRenderer.invoke('undo:revertSessions', { sessionIds, projectRoot }),
  },

  // --- Named snapshots ---
  snapshot: {
    create: (projectRoot: string, name: string) => ipcRenderer.invoke('snapshot:create', projectRoot, name),
    list: (projectRoot: string) => ipcRenderer.invoke('snapshot:list', projectRoot),
    restore: (id: string, projectRoot: string) => ipcRenderer.invoke('snapshot:restore', id, projectRoot),
    delete: (id: string, projectRoot: string) => ipcRenderer.invoke('snapshot:delete', id, projectRoot),
  },

  // --- Lint auto-fix ---
  lint: {
    fix: (projectRoot: string, files?: string[]) => ipcRenderer.invoke('lint:fix', { projectRoot, files }),
  },

  // --- Shell operations ---
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
    openInVSCode: (projectPath: string) => ipcRenderer.invoke('shell:openInVSCode', projectPath),
    openFileInVSCode: (filePath: string) => ipcRenderer.invoke('shell:openFileInVSCode', filePath),
    openSkillsDirectory: () => ipcRenderer.invoke('shell:openSkillsDirectory'),
  },

  // --- Skills ---
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    read: (name: string) => ipcRenderer.invoke('skills:read', name),
  },

  // --- Goals ---
  goal: {
    get: (sessionId: string) => ipcRenderer.invoke('goal:get', sessionId),
    create: (sessionId: string, text: string, maxRounds?: number) =>
      ipcRenderer.invoke('goal:create', sessionId, text, maxRounds),
    edit: (sessionId: string, text: string) => ipcRenderer.invoke('goal:edit', sessionId, text),
    pause: (sessionId: string) => ipcRenderer.invoke('goal:pause', sessionId),
    resume: (sessionId: string) => ipcRenderer.invoke('goal:resume', sessionId),
    complete: (sessionId: string) => ipcRenderer.invoke('goal:complete', sessionId),
    block: (sessionId: string, reason: string) => ipcRenderer.invoke('goal:block', sessionId, reason),
    clear: (sessionId: string) => ipcRenderer.invoke('goal:clear', sessionId),
    round: (sessionId: string) => ipcRenderer.invoke('goal:round', sessionId),
  },

  // --- Credentials ---
  credentials: {
    describe: (name: string, projectRoot?: string) => ipcRenderer.invoke('credentials:describe', name, projectRoot),
    set: (name: string, value: string) => ipcRenderer.invoke('credentials:set', name, value),
    unset: (name: string) => ipcRenderer.invoke('credentials:unset', name),
  },

  // --- Actions ---
  actions: {
    list: (projectRoot: string) => ipcRenderer.invoke('actions:list', projectRoot),
  },

  // --- Terminal ---
  terminal: {
    create: (payload: { id: string; cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('terminal:create', payload),
    input: (id: string, data: string) => ipcRenderer.invoke('terminal:input', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
    listTasks: () => ipcRenderer.invoke('terminal:tasks:list'),
    stopTask: (id: string) => ipcRenderer.invoke('terminal:tasks:stop', id),
    clearTasks: () => ipcRenderer.invoke('terminal:tasks:clear'),
    onData: (id: string, cb: (data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { type: string; data?: string }) => {
        if (payload?.type === 'data' && typeof payload.data === 'string') cb(payload.data);
      };
      ipcRenderer.on(`terminal:event:${id}`, listener);
      return () => ipcRenderer.removeListener(`terminal:event:${id}`, listener);
    },
    onTasksChanged: (cb: (tasks: TerminalTask[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tasks: TerminalTask[]) => cb(tasks || []);
      ipcRenderer.on('terminal:tasks:changed', listener);
      return () => ipcRenderer.removeListener('terminal:tasks:changed', listener);
    },
    onExit: (id: string, cb: (info: { exitCode: number; error?: string }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { type: string; data?: { exitCode: number; error?: string } },
      ) => {
        if (payload?.type === 'exit' && payload.data) cb(payload.data);
      };
      ipcRenderer.on(`terminal:event:${id}`, listener);
      return () => ipcRenderer.removeListener(`terminal:event:${id}`, listener);
    },
  },

  // Read-only mirror of an agent's persistent shell （终端会话）.
  agentShell: {
    attach: (agentId: string) => ipcRenderer.invoke('agentShell:attach', agentId),
    detach: (agentId: string) => ipcRenderer.invoke('agentShell:detach', agentId),
    write: (agentId: string, data: string) => ipcRenderer.invoke('agentShell:write', agentId, data),
    onData: (agentId: string, cb: (data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: string) => cb(data);
      ipcRenderer.on(`agentShell:data:${agentId}`, handler);
      return () => ipcRenderer.removeListener(`agentShell:data:${agentId}`, handler);
    },
    onExit: (agentId: string, cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on(`agentShell:exit:${agentId}`, handler);
      return () => ipcRenderer.removeListener(`agentShell:exit:${agentId}`, handler);
    },
  },

  // --- SSH ---
  ssh: {
    list: () => ipcRenderer.invoke('ssh:list'),
    save: (conn: unknown) => ipcRenderer.invoke('ssh:save', conn),
    remove: (id: string) => ipcRenderer.invoke('ssh:remove', id),
    test: (conn: unknown) => ipcRenderer.invoke('ssh:test', conn),
    exec: (conn: unknown, command: string) => ipcRenderer.invoke('ssh:exec', conn, command),
  },

  // --- Rules ---
  rules: {
    list: (projectRoot?: string) => ipcRenderer.invoke('rules:list', projectRoot),
  },

  // --- Import ---

  // --- Session logs ---
  sessionLog: {
    read: (agentId: string) => ipcRenderer.invoke('sessionLog:read', agentId),
    project: (agentId: string) => ipcRenderer.invoke('sessionLog:project', agentId),
  },

  // --- Chat logs (authoritative session store) ---
  chatLog: {
    append: (sessionId: string, events: unknown[], projectRoot?: string) =>
      ipcRenderer.invoke('chatLog:append', sessionId, events, projectRoot),
    read: (sessionId: string) => ipcRenderer.invoke('chatLog:read', sessionId),
    list: () => ipcRenderer.invoke('chatLog:list'),
    project: (sessionId: string) => ipcRenderer.invoke('chatLog:project', sessionId),
    delete: (sessionId: string) => ipcRenderer.invoke('chatLog:delete', sessionId),
    fork: (sessionId: string, uptoMessageId?: string) => ipcRenderer.invoke('chatLog:fork', sessionId, uptoMessageId),
    meta: (sessionId: string, meta: unknown) => ipcRenderer.invoke('chatLog:meta', sessionId, meta),
  },

  // --- Workflows ---
  workflow: {
    list: (projectRoot?: string) => ipcRenderer.invoke('workflow:list', projectRoot),
    run: (payload: { workflowId: string; projectRoot: string }) => ipcRenderer.invoke('workflow:run', payload),
    get: (runId: string) => ipcRenderer.invoke('workflow:get', runId),
    runs: (workflowId?: string) => ipcRenderer.invoke('workflow:runs', workflowId),
  },

  // --- Full-text search ---
  fts: {
    search: (query: string, limit?: number) => ipcRenderer.invoke('fts:search', query, limit),
    rebuild: () => ipcRenderer.invoke('fts:rebuild'),
  },

  // --- Feedback ---
  feedback: {
    submit: (text: string) => ipcRenderer.invoke('feedback:submit', text),
    message: (record: { messageId: string; sessionId: string; rating: 'up' | 'down' | null; note?: string }) =>
      ipcRenderer.invoke('feedback:message', record),
    messageList: (sessionId: string) => ipcRenderer.invoke('feedback:messageList', sessionId),
  },

  // --- LLM session titles ---
  sessionTitle: {
    generate: (messages: { content: string }[]) => ipcRenderer.invoke('sessionTitle:generate', { messages }),
  },

  // --- Shared plugin enabled/disabled state (CLI + UI) ---
  pluginState: {
    get: () => ipcRenderer.invoke('pluginState:get'),
    set: (id: string, enabled: boolean) => ipcRenderer.invoke('pluginState:set', id, enabled),
  },

  // --- Cron ---
  cron: {
    create: (params: { name: string; prompt: string; cron: string; recurring: boolean }) =>
      ipcRenderer.invoke('cron:create', params),
    delete: (jobId: string) => ipcRenderer.invoke('cron:delete', jobId),
    list: () => ipcRenderer.invoke('cron:list'),
  },

  // --- System ---
  system: {
    getStats: () => ipcRenderer.invoke('system:getStats'),
    getGitBranches: (projectRoot: string) => ipcRenderer.invoke('system:getGitBranches', projectRoot),
    getVersion: () => ipcRenderer.invoke('system:getVersion'),
    getAccountInfo: (apiKey: string) => ipcRenderer.invoke('system:getAccountInfo', apiKey),
  },

  // --- Test coverage (dev-time report generated by npm run test:coverage) ---
  coverage: {
    get: () => ipcRenderer.invoke('coverage:get'),
  },

  // --- Stats ---
  stats: {
    get: () => ipcRenderer.invoke('stats:get'),
    reset: () => ipcRenderer.invoke('stats:reset'),
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export { electronAPI };
