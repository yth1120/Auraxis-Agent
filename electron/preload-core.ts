/** preload-core.ts — memory/settings/context/agent/permission/plan renderer bridge. */
import type { AgentInfo, PermissionRequest } from './contracts/advanced';
import { invoke, subscribe } from './preload-shared';

type AgentEventPayload = { type: string } & Record<string, unknown>;

export function createCoreApi() {
  return {
    memory: {
      extract: (ctx: unknown) => invoke('memory:extract', ctx),
      getByProject: (projectPath: string) => invoke('memory:getByProject', projectPath),
      getByType: (projectPath: string, type: string) => invoke('memory:getByType', projectPath, type),
      search: (projectPath: string, query: string) => invoke('memory:search', projectPath, query),
      archive: (id: string) => invoke('memory:archive', id),
      delete: (id: string) => invoke('memory:delete', id),
      evidenceList: (projectPath: string) => invoke('memory:evidenceList', projectPath),
      evidenceDetail: (id: string) => invoke('memory:evidenceDetail', id),
      readForQuery: (projectPath: string, query: string, opts?: unknown) =>
        invoke('memory:readForQuery', projectPath, query, opts),
      beliefAudit: (id: string) => invoke('memory:beliefAudit', id),
      readTrace: (runId: string) => invoke('memory:readTrace', runId),
      erase: (scope: string) => invoke('memory:erase', scope),
      reindex: (projectPath: string) => invoke('memory:reindex', projectPath),
      graph: (projectPath: string, role?: string, agent?: { id?: string; name?: string }) =>
        invoke('memory:graph', projectPath, role, agent),
      rejections: (projectPath: string) => invoke('memory:rejections', projectPath),
    },

    settings: {
      get: (key?: string) => invoke('settings:get', key),
      set: (key: string, value: unknown) => invoke('settings:set', key, value),
      getApiKeyStatus: (provider: string) => invoke('settings:getApiKeyStatus', provider),
      setApiKey: (provider: string, key: string) => invoke('api:setKey', provider, key),
    },

    context: {
      getProjectContext: (projectRoot: string) => invoke('context:getProjectContext', projectRoot),
      getFileStructure: (projectRoot: string) => invoke('context:getFileStructure', projectRoot),
      readFile: (filePath: string, projectRoot?: string) => invoke('context:readFile', filePath, projectRoot),
      compact: (projectRoot: string, messages: { role: string; content: string }[]) =>
        invoke('context:compact', { projectRoot, messages }),
    },

    instructions: {
      getGlobal: () => invoke('instructions:getGlobal'),
      setGlobal: (content: string) => invoke('instructions:setGlobal', content),
      listProject: (projectRoot: string) => invoke('instructions:listProject', projectRoot),
      get: (projectRoot: string, relPath?: string) => invoke('instructions:get', projectRoot, relPath),
      set: (projectRoot: string, relPath: string | undefined, content: string) =>
        invoke('instructions:set', projectRoot, relPath, content),
    },

    connectors: {
      status: () => invoke('connector:status'),
      setToken: (kind: 'slack' | 'drive' | 'notion', token: string) => invoke('connector:setToken', kind, token),
      getLark: () => invoke('connector:getLark'),
      setLark: (input: { appId: string; appSecret: string; domain?: string; tools?: string }) =>
        invoke('connector:setLark', input),
      test: (kind: 'slack' | 'drive' | 'notion' | 'lark') => invoke('connector:test', kind),
    },

    permission: {
      respond: (requestId: string, allowed: boolean) => invoke('permission:respond', requestId, allowed),
      addRule: (rule: unknown, requestId: string) => invoke('permission:addRule', rule, requestId),
      getRules: () => invoke('permission:getRules'),
      removeRule: (ruleId: string) => invoke('permission:removeRule', ruleId),
      clearRules: () => invoke('permission:clearRules'),
      onRequest: (callback: (request: PermissionRequest) => void) =>
        subscribe('permission:request', (request) => callback(request as PermissionRequest)),
    },

    permissionProfile: {
      list: () => invoke('permission:listProfiles'),
      save: (custom: unknown[], activeId: string) => invoke('permission:saveProfiles', { custom, activeId }),
      listProjectProfiles: () => invoke('permission:listProjectProfiles'),
      setProjectProfile: (path: string, profileId: string | null) =>
        invoke('permission:setProjectProfile', { path, profileId }),
      moveProjectProfile: (from: string, to: string) => invoke('permission:moveProjectProfile', { from, to }),
    },

    ask: {
      respond: (askId: string, answer: string) => invoke('ask:respond', askId, answer),
      onRequest: (callback: (request: { askId: string; question: string; options: string[] }) => void) =>
        subscribe('ask:request', (request) =>
          callback(request as { askId: string; question: string; options: string[] }),
        ),
    },

    runtime: {
      syncPlugins: (plugins: unknown[]) => invoke('runtime:syncPlugins', plugins),
    },

    mcp: {
      getServers: () => invoke('mcp:getServers'),
      setServers: (servers: unknown[]) => invoke('mcp:setServers', servers),
      connect: (serverId: string) => invoke('mcp:connect', serverId),
      disconnect: (serverId: string) => invoke('mcp:disconnect', serverId),
      getStatuses: () => invoke('mcp:getStatuses'),
      listTools: (serverId: string) => invoke('mcp:listTools', serverId),
      callTool: (serverId: string, toolName: string, args: unknown) => invoke('mcp:callTool', serverId, toolName, args),
    },

    agent: {
      start: (config: unknown, projectPath: string) => invoke('agent:start', { config, projectPath }),
      schedulerStop: (agentId: string) => invoke('agent:schedulerStop', agentId),
      pause: (agentId: string) => invoke('agent:pause', agentId),
      resume: (agentId: string) => invoke('agent:resume', agentId),
      continue: (agentId: string, instruction: string, displayInstruction?: string) =>
        invoke('agent:continue', agentId, instruction, displayInstruction),
      approveDelivery: (agentId: string) => invoke('agent:approveDelivery', agentId),
      setPriority: (agentId: string, priority: string) => invoke('agent:setPriority', agentId, priority),
      getQueue: () => invoke('agent:getQueue'),
      setMaxConcurrent: (n: number) => invoke('agent:setMaxConcurrent', n),
      getAll: () => invoke('agent:getAll'),
      getState: (agentId: string) => invoke('agent:getState', agentId),
      remove: (agentId: string) => invoke('agent:remove', agentId),
      schedulerRemove: (agentId: string) => invoke('agent:schedulerRemove', agentId),
      clear: () => invoke('agent:clear'),
      clearAll: () => invoke('agent:clearAll'),
      onUpdated: (callback: (agent: AgentInfo) => void) =>
        subscribe('agent:updated', (agent) => callback(agent as AgentInfo)),
      onEvent: (agentId: string, callback: (event: AgentEventPayload) => void) =>
        subscribe(`agent:event:${agentId}`, (event) => callback(event as AgentEventPayload)),
    },

    app: {
      onError: (callback: (err: { message: string; stack?: string }) => void) =>
        subscribe('app:error', (err) => callback(err as { message: string; stack?: string })),
    },

    model: {
      getAll: () => invoke('model:getAll'),
    },

    worktree: {
      getStatus: (sessionKey: string) => invoke('worktree:getStatus', sessionKey),
      onChanged: (callback: (data: { active: boolean; sandboxPath?: string; taskId?: string }) => void) =>
        subscribe('worktree:changed', (data) =>
          callback(data as { active: boolean; sandboxPath?: string; taskId?: string }),
        ),
    },

    conflict: {
      getConflicts: () => invoke('conflict:getConflicts'),
      getFileHistory: (filePath: string) => invoke('conflict:getFileHistory', filePath),
    },

    plan: {
      approve: (planId: string, approvedStepIds: string[]) => invoke('plan:approve', { planId, approvedStepIds }),
      reject: (planId: string) => invoke('plan:reject', { planId }),
      list: (projectRoot?: string) => invoke('plan:list', { projectRoot }),
      onGenerated: (
        callback: (data: {
          planId: string;
          steps: { id: string; toolName: string; description: string; parameters: Record<string, unknown> }[];
          filePath?: string;
          agentId?: string;
        }) => void,
      ) =>
        subscribe('plan:generated', (data) =>
          callback(
            data as {
              planId: string;
              steps: { id: string; toolName: string; description: string; parameters: Record<string, unknown> }[];
              filePath?: string;
              agentId?: string;
            },
          ),
        ),
    },
  };
}
