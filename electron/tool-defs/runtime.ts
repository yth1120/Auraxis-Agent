import type { ToolDef } from './types';

/** Runtime introspection, agent/goal, plugin, shell and session trace tools. */
export const RUNTIME_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: 'InspectRuntime',
    description:
      'Inspect the live agent runtime: available tools (name + summary), installed plugins (id/name/version/enabled/capabilities), and discoverable skills. Read-only — use before deciding to extend capabilities.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'WriteSkill',
    description:
      'Create or overwrite a reusable skill: a markdown instruction file that becomes discoverable by ListSkills immediately. Use for repeatable workflows (review checklists, release steps, project conventions). The skill is user-owned and can be edited later.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name (slugified into a directory name)' },
        content: {
          type: 'string',
          description:
            'Markdown body. Optionally start with YAML frontmatter (---\nname: ...\ndescription: ...\n---). If omitted, a name/description header is added automatically.',
        },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'ListAgents',
    description:
      'List live agents and sub-agents: id, name, status, type, parent link, and any reports they sent via the Report tool. Use before SendMessage / InterruptAgent to resolve a target id.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'SendMessage',
    description:
      "Send a follow-up instruction to a running background sub-agent (from ListAgents). The instruction is queued and delivered at the agent's next turn boundary; returns immediately. Useful for steering a long-running child without waiting for it to finish.",
    input_schema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id from ListAgents' },
        message: { type: 'string', description: 'The follow-up instruction to deliver' },
      },
      required: ['agentId', 'message'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'InterruptAgent',
    description:
      'Interrupt a running agent or sub-agent by id (from ListAgents). The agent stops as soon as possible; background results can still be read with TaskOutput.',
    input_schema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id from ListAgents' },
        reason: { type: 'string', description: 'Optional reason shown in the interruption record' },
      },
      required: ['agentId'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'Report',
    description:
      'Send a progress report to the agent that started you. Call this zero or more times for findings, blockers, or partial results. Reporting does not finish your work; your direct parent reads reports via ListAgents.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Self-contained report text for your parent' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'GetGoal',
    description:
      'Read the current durable goal for this run: text, phase (active/paused/completed/blocked/cleared), revision, rounds started, and round cap. Returns null when no goal exists.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'CreateGoal',
    description:
      'Create a durable goal for this run. Only succeeds when no active/completed goal exists (a cleared/completed goal can be replaced). The goal is injected into the prompt and bounded by maxRounds of execution.',
    input_schema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'The concrete completion objective inferred from the direct human request',
        },
        maxRounds: { type: 'number', description: 'Optional positive round cap for automatic continuation' },
      },
      required: ['objective'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'UpdateGoal',
    description:
      'Update the current goal revision. Actions: edit (replace objective / maxRounds), pause, resume, complete, blocked (with reason). Requires the exact goalId and revision from GetGoal.',
    input_schema: {
      type: 'object',
      properties: {
        goalId: { type: 'string', description: 'Exact goal id returned by GetGoal' },
        revision: { type: 'number', description: 'Exact revision returned by GetGoal' },
        action: {
          type: 'string',
          enum: ['edit', 'pause', 'resume', 'complete', 'blocked'],
          description: 'Operation to perform',
        },
        objective: { type: 'string', description: 'Replacement objective; valid only with action edit' },
        maxRounds: { type: 'number', description: 'Replacement round cap; valid only with action edit' },
        reason: { type: 'string', description: 'Blocking condition; required only with action blocked' },
      },
      required: ['goalId', 'revision', 'action'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'MountPlugin',
    description:
      'Dynamically mount a plugin into the running app: register new tools the model can call in subsequent requests. Each tool needs a name, description, optional inputSchema, and a handler as a JS function body like `(input, ctx) => ({ echo: input.value })` or `async (input, ctx) => ...`. ctx exposes projectRoot, log, sleep and agents (run/start/list/send/interrupt). Handlers run in a restricted sandbox with no require/fs/process. Use UnmountPlugin to remove the plugin.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Plugin id (slug)' },
        name: { type: 'string', description: 'Human-readable plugin name' },
        version: { type: 'string', description: 'Optional version string' },
        description: { type: 'string', description: 'Optional one-line description' },
        tools: {
          type: 'array',
          description: 'Tool definitions to register',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Tool name (PascalCase)' },
              description: { type: 'string', description: 'Tool description shown to the model' },
              inputSchema: { type: 'object', description: 'JSON Schema for the tool input (optional)' },
              handler: { type: 'string', description: 'JS function body: (input, ctx) => result' },
            },
            required: ['name', 'description', 'handler'],
            additionalProperties: false,
          },
        },
      },
      required: ['id', 'name', 'tools'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'UnmountPlugin',
    description:
      'Remove a dynamically mounted plugin (id from MountPlugin or InspectRuntime) and unregister all of its tools.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Plugin id returned by MountPlugin' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'Ralph',
    description:
      'Iterate toward an objective with a fresh sub-agent each round. Every round starts a brand-new agent with no conversation seed; the shared project directory is the durable memory, and each round reports progress, completion, or a blocker. Use ONLY when the user explicitly asks for a Ralph loop / fresh-agent iterative execution. For ordinary long tasks prefer goals; for bounded delegation prefer Agent or RunWorkflow.',
    input_schema: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'Immutable completion objective for every round' },
        maxRounds: { type: 'number', description: 'Round cap (default 8, max 30)' },
      },
      required: ['objective'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'Pwsh',
    description:
      'Execute a PowerShell command (powershell.exe on Windows, pwsh when available elsewhere). Returns stdout, stderr, and exit code. Use for PowerShell-specific work: modules, registry, pipelines, .ps1 scripts.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The PowerShell command to execute' },
        workdir: { type: 'string', description: 'Working directory (optional, defaults to project root)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'SessionEventSearch',
    description:
      'Search the raw event stream of one session (agent run or chat) for matching text, tool names, inputs, outputs, errors, and system events. Returns matching events with sequence numbers for use with SessionEventRead.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword or phrase to search (Chinese and English both work)' },
        sessionId: {
          type: 'string',
          description: 'Session/agent id to search (optional — searches recent sessions when omitted)',
        },
        limit: { type: 'number', description: 'Max results (1-50, default 10)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'SessionEventRead',
    description:
      'Read one full raw event from a session event stream by its sequence number, with optional neighboring events before/after. Use seq values from SessionEventSearch or SessionTrace.',
    input_schema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session/agent id' },
        seq: { type: 'number', description: 'Event sequence number' },
        before: { type: 'number', description: 'How many preceding events to include (0-20, default 2)' },
        after: { type: 'number', description: 'How many following events to include (0-20, default 2)' },
      },
      required: ['sessionId', 'seq'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'SessionTrace',
    description:
      "Read a session's lineage: its parent (branchedFrom), its children (forks), event count, and a condensed event summary. Use to understand how sessions relate before digging into events.",
    input_schema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session/agent id to trace' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'TaskList',
    description:
      'List background shell tasks (run_in_background Bash) and running agents/sub-agents with ids, status, commands, and timestamps. Use TaskOutput to read a task result and TaskStop to stop one. JobList/JobOutput/JobKill are equivalent 同一运行时的兼容命名.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'JobList',
    description:
      'List every background job the runtime knows about: background bash commands, terminal tasks, and running sub-agents. Same source as TaskList.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'JobOutput',
    description:
      'Read the accumulated output of a background job (bash task, terminal task, or sub-agent) by its id without blocking the turn.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id returned by JobList or by a run_in_background call' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'JobKill',
    description: 'Stop a running background job (bash task, terminal task, or sub-agent) by its id.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id to stop' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
];
