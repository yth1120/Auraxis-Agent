/** preload-rest.ts — terminal/session/workflow/system renderer bridge. */
import type { TerminalTask } from './ipc/task-monitor';
import { invoke, subscribe } from './preload-shared';

export function createRestApi() {
  return {
    undo: {
      getHistory: (sessionId?: string) => invoke('undo:getHistory', sessionId),
      getList: () => invoke('undo:getList'),
      getSessionDiffs: (sessionId: string, projectRoot: string) =>
        invoke('undo:getSessionDiffs', sessionId, projectRoot),
      revertSessionFile: (sessionId: string, relPath: string, projectRoot: string) =>
        invoke('undo:revertSessionFile', { sessionId, relPath, projectRoot }),
      execute: (fileId: string, projectRoot: string) => invoke('undo:execute', fileId, projectRoot),
      revert: (fileId: string, projectRoot: string) => invoke('undo:revert', fileId, projectRoot),
      revertLast: (projectRoot: string) => invoke('undo:revertLast', projectRoot),
      revertSessions: (sessionIds: string[], projectRoot: string) =>
        invoke('undo:revertSessions', { sessionIds, projectRoot }),
    },

    snapshot: {
      create: (projectRoot: string, name: string) => invoke('snapshot:create', projectRoot, name),
      list: (projectRoot: string) => invoke('snapshot:list', projectRoot),
      restore: (id: string, projectRoot: string) => invoke('snapshot:restore', id, projectRoot),
      delete: (id: string, projectRoot: string) => invoke('snapshot:delete', id, projectRoot),
    },

    lint: {
      fix: (projectRoot: string, files?: string[]) => invoke('lint:fix', { projectRoot, files }),
    },

    shell: {
      openExternal: (url: string) => invoke('shell:openExternal', url),
      openPath: (filePath: string) => invoke('shell:openPath', filePath),
      openInVSCode: (projectPath: string) => invoke('shell:openInVSCode', projectPath),
      openFileInVSCode: (filePath: string) => invoke('shell:openFileInVSCode', filePath),
      openSkillsDirectory: () => invoke('shell:openSkillsDirectory'),
    },

    skills: {
      list: () => invoke('skills:list'),
      read: (name: string) => invoke('skills:read', name),
    },

    goal: {
      get: (sessionId: string) => invoke('goal:get', sessionId),
      create: (sessionId: string, text: string, maxRounds?: number) =>
        invoke('goal:create', sessionId, text, maxRounds),
      edit: (sessionId: string, text: string) => invoke('goal:edit', sessionId, text),
      pause: (sessionId: string) => invoke('goal:pause', sessionId),
      resume: (sessionId: string) => invoke('goal:resume', sessionId),
      complete: (sessionId: string) => invoke('goal:complete', sessionId),
      block: (sessionId: string, reason: string) => invoke('goal:block', sessionId, reason),
      clear: (sessionId: string) => invoke('goal:clear', sessionId),
      round: (sessionId: string) => invoke('goal:round', sessionId),
    },

    credentials: {
      describe: (name: string, projectRoot?: string) => invoke('credentials:describe', name, projectRoot),
      set: (name: string, value: string) => invoke('credentials:set', name, value),
      unset: (name: string) => invoke('credentials:unset', name),
    },

    actions: {
      list: (projectRoot: string) => invoke('actions:list', projectRoot),
    },

    terminal: {
      create: (payload: { id: string; cwd?: string; cols?: number; rows?: number }) =>
        invoke('terminal:create', payload),
      input: (id: string, data: string) => invoke('terminal:input', id, data),
      resize: (id: string, cols: number, rows: number) => invoke('terminal:resize', id, cols, rows),
      kill: (id: string) => invoke('terminal:kill', id),
      listTasks: () => invoke('terminal:tasks:list'),
      stopTask: (id: string) => invoke('terminal:tasks:stop', id),
      clearTasks: () => invoke('terminal:tasks:clear'),
      onData: (id: string, cb: (data: string) => void) =>
        subscribe(`terminal:event:${id}`, (payload) => {
          const p = payload as { type: string; data?: string };
          if (p?.type === 'data' && typeof p.data === 'string') cb(p.data);
        }),
      onTasksChanged: (cb: (tasks: TerminalTask[]) => void) =>
        subscribe('terminal:tasks:changed', (tasks) => cb((tasks || []) as TerminalTask[])),
      onExit: (id: string, cb: (info: { exitCode: number; error?: string }) => void) =>
        subscribe(`terminal:event:${id}`, (payload) => {
          const p = payload as { type: string; data?: { exitCode: number; error?: string } };
          if (p?.type === 'exit' && p.data) cb(p.data);
        }),
    },

    agentShell: {
      attach: (agentId: string) => invoke('agentShell:attach', agentId),
      detach: (agentId: string) => invoke('agentShell:detach', agentId),
      write: (agentId: string, data: string) => invoke('agentShell:write', agentId, data),
      onData: (agentId: string, cb: (data: string) => void) =>
        subscribe(`agentShell:data:${agentId}`, (data) => cb(String(data))),
      onExit: (agentId: string, cb: () => void) => subscribe(`agentShell:exit:${agentId}`, () => cb()),
    },

    ssh: {
      list: () => invoke('ssh:list'),
      save: (conn: unknown) => invoke('ssh:save', conn),
      remove: (id: string) => invoke('ssh:remove', id),
      test: (conn: unknown) => invoke('ssh:test', conn),
      exec: (conn: unknown, command: string) => invoke('ssh:exec', conn, command),
    },

    rules: {
      list: (projectRoot?: string) => invoke('rules:list', projectRoot),
    },

    sessionLog: {
      read: (agentId: string) => invoke('sessionLog:read', agentId),
      project: (agentId: string) => invoke('sessionLog:project', agentId),
    },

    chatLog: {
      append: (sessionId: string, events: unknown[], projectRoot?: string) =>
        invoke('chatLog:append', sessionId, events, projectRoot),
      read: (sessionId: string) => invoke('chatLog:read', sessionId),
      list: () => invoke('chatLog:list'),
      project: (sessionId: string) => invoke('chatLog:project', sessionId),
      delete: (sessionId: string) => invoke('chatLog:delete', sessionId),
      fork: (sessionId: string, uptoMessageId?: string) => invoke('chatLog:fork', sessionId, uptoMessageId),
      meta: (sessionId: string, meta: unknown) => invoke('chatLog:meta', sessionId, meta),
    },

    workflow: {
      list: (projectRoot?: string) => invoke('workflow:list', projectRoot),
      run: (payload: { workflowId: string; projectRoot: string }) => invoke('workflow:run', payload),
      get: (runId: string) => invoke('workflow:get', runId),
      runs: (workflowId?: string) => invoke('workflow:runs', workflowId),
    },

    fts: {
      search: (query: string, limit?: number) => invoke('fts:search', query, limit),
      rebuild: () => invoke('fts:rebuild'),
    },

    feedback: {
      submit: (text: string) => invoke('feedback:submit', text),
      message: (record: { messageId: string; sessionId: string; rating: 'up' | 'down' | null; note?: string }) =>
        invoke('feedback:message', record),
      messageList: (sessionId: string) => invoke('feedback:messageList', sessionId),
    },

    sessionTitle: {
      generate: (messages: { content: string }[]) => invoke('sessionTitle:generate', { messages }),
    },

    pluginState: {
      get: () => invoke('pluginState:get'),
      set: (id: string, enabled: boolean) => invoke('pluginState:set', id, enabled),
    },

    cron: {
      create: (params: { name: string; prompt: string; cron: string; recurring: boolean }) =>
        invoke('cron:create', params),
      delete: (jobId: string) => invoke('cron:delete', jobId),
      list: () => invoke('cron:list'),
    },

    system: {
      getStats: () => invoke('system:getStats'),
      getGitBranches: (projectRoot: string) => invoke('system:getGitBranches', projectRoot),
      getVersion: () => invoke('system:getVersion'),
      getAccountInfo: (apiKey: string) => invoke('system:getAccountInfo', apiKey),
    },

    coverage: {
      get: () => invoke('coverage:get'),
    },

    stats: {
      get: () => invoke('stats:get'),
      reset: () => invoke('stats:reset'),
    },
  };
}
