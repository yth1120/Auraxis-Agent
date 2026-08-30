import type { ToolDef } from './types';

/** Code execution, workflow and skill runtime tools. */
export const CORE_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: 'RunCode',
    description:
      'Run model-written code. language=javascript/python/shell executes a snippet in an isolated temporary directory with a hard timeout and output cap. language=typescript runs a TypeScript program whose body can call every available tool as `await tools.ToolName(args)`; sub-calls re-enter the full permission/sandbox pipeline, overlap up to 8 concurrent safe calls, and only what you print or return is sent back.',
    input_schema: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['javascript', 'python', 'shell', 'typescript'],
          description: 'Runtime language. typescript = tool-orchestration program (Code Mode)',
        },
        code: {
          type: 'string',
          description:
            'Source code to execute. For typescript: the BODY of an async function; top-level await and return are allowed, `import` resolves via require, `export` is not supported.',
        },
        description: {
          type: 'string',
          description: 'For typescript: a clear 5-10 word description of what the program does, shown in the UI',
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds (default 30000; typescript default 120000)',
        },
      },
      required: ['language', 'code'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'RunWorkflow',
    description:
      'Run a scripted multi-agent workflow. Two modes: (1) pass name to run a predefined workflow from .auraxis/workflows; (2) pass script to run an inline orchestration script — plain JS with top-level await, ending with `return <json>`. The script gets ctx.projectRoot, ctx.log, ctx.sleep, and ctx.agents.run/start/list/send/interrupt to fan work out across sub-agents. Returns the script result plus a transcript.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow id or name' },
        projectRoot: { type: 'string', description: 'Optional project root override' },
        script: {
          type: 'string',
          description: 'Optional inline orchestration script body (async JS ending with return)',
        },
      },
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'ListSkills',
    description:
      'List skills available in the local skills directory. Each skill packages a repeatable workflow (instructions + resources). When a task matches a skill description, use ReadSkill to load its instructions.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'ReadSkill',
    description:
      'Read the full instructions and resources of a skill by name (from ListSkills). Follow the skill workflow exactly.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name returned by ListSkills' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'Bash',
    description:
      'Execute a shell command in the project directory. Returns stdout, stderr, and exit code. For long-running commands (npm install, cargo build), set a timeout value in milliseconds, or set run_in_background=true to get a task id immediately and read the output later with TaskOutput. When the command needs a wider sandbox than the current mode, set sandbox_permissions (read/workspace-write/full) together with a one-sentence justification.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        workdir: { type: 'string', description: 'Working directory (optional, defaults to project root)' },
        timeout: {
          type: 'number',
          description:
            'Timeout in milliseconds. Default 120000 (2 min), max 600000 (10 min). Use for long-running commands like builds or installs.',
        },
        description: {
          type: 'string',
          description: 'One-line description of what the command does (helpful for background tasks)',
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Start in the background and return a task id immediately; poll with TaskOutput and stop with TaskStop',
        },
        sandbox_permissions: {
          type: 'string',
          enum: ['read', 'workspace-write', 'full'],
          description: 'Request a wider sandbox for this call (must pair with justification)',
        },
        justification: {
          type: 'string',
          description: 'One-sentence justification — required when sandbox_permissions is set',
        },
      },
      required: ['command', 'workdir', 'timeout'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
];
