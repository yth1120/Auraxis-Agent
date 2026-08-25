// Tool definitions shared between main and renderer processes
// Tool identity + base shape live in contracts/tools.ts (single source).
import type { ToolDef as ContractToolDef, ToolName, BuiltInToolName } from './contracts/tools';

export type { ToolName, BuiltInToolName };
export type { ToolStreamEvent } from './contracts/tools';

export interface ToolDef extends ContractToolDef {
  /** When true, this tool can run concurrently with other safe tools in the same batch.
   *  Read-only / independent tools are safe; mutation / state-changing tools are not. */
  isConcurrencySafe: boolean;
}

export const TOOL_DEFINITIONS: ToolDef[] = [
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
  {
    name: 'Read',
    description:
      'Read the contents of a file. Supports text files. The result includes a "version" (content hash) — pass it back to Write/Edit to avoid overwriting concurrent changes.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file' },
        offset: { type: 'number', description: 'Line offset to start from (optional)' },
        limit: { type: 'number', description: 'Max lines to read (optional)' },
      },
      required: ['file_path', 'offset', 'limit'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'ReadImage',
    description:
      'Read an image file (png/jpg/jpeg/gif/webp/bmp/svg) and make it visible to the model. Returns the image content plus a durable attachment id; the bytes are also stored content-addressed so repeated reads are cheap. Use this to inspect screenshots, diagrams, or UI mockups.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the image file' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'Write',
    description:
      'Create or overwrite a file. If you read the file first, pass its "version" back to avoid clobbering concurrent edits; pass version="new" to refuse overwriting an existing file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Full file content' },
        version: {
          type: 'string',
          description: 'Optional version from Read; the write fails if the file changed since',
        },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'Edit',
    description:
      'Replace old_string with new_string in a file. Must match exactly once. Pass the "version" from your last Read to reject stale edits.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        version: {
          type: 'string',
          description: 'Optional version from Read; the edit fails if the file changed since',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'StrReplaceEditor',
    description:
      'Single-purpose text editor with unified editor semantics. Commands: view (read a file), create (write a new file, fails if it exists), str_replace (replace old_str with new_str, must match exactly once), insert (append new_str after insert_line). Use this instead of mixing Read/Write/Edit when the task is a localized file change.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'], description: 'Editor command' },
        path: { type: 'string', description: 'File path' },
        file_text: { type: 'string', description: 'Full content (create only)' },
        old_str: { type: 'string', description: 'Exact text to replace (str_replace only)' },
        new_str: { type: 'string', description: 'Replacement / insertion text' },
        insert_line: { type: 'number', description: '1-based line to insert after (insert only)' },
        view_range: { type: 'array', items: { type: 'number' }, description: 'Optional [startLine, endLine] for view' },
      },
      required: ['command', 'path'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'Grep',
    description: 'Search for a regex pattern in project files.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        path: { type: 'string', description: 'Directory or file to search (optional)' },
        include: { type: 'string', description: 'File glob filter e.g. "*.ts" (optional)' },
      },
      required: ['pattern', 'path', 'include'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern e.g. "src/**/*.ts"' },
        path: { type: 'string', description: 'Directory to search (optional)' },
      },
      required: ['pattern', 'path'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'WebFetch',
    description: 'Fetch content from a URL and extract text.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        prompt: { type: 'string', description: 'What to extract (optional)' },
      },
      required: ['url', 'prompt'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'WebSearch',
    description: 'Search the web using DuckDuckGo.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'TodoWrite',
    description:
      'Create and manage a structured task list for tracking progress. Use this to plan complex multi-step tasks, track what is in progress, and mark items as completed. Always update the list as you make progress — mark items complete IMMEDIATELY after finishing.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description:
            'The complete todo list. Each item must have: content (what to do), status (pending/in_progress/completed), activeForm (present continuous form shown during execution, e.g. "Adding login"). Exactly ONE item in_progress at a time.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'What needs to be done' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current status' },
              activeForm: { type: 'string', description: 'Present continuous form, e.g. "Fixing auth bug"' },
            },
            required: ['content', 'status', 'activeForm'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'Agent',
    description:
      'Launch a sub-agent to handle complex, multi-step tasks autonomously. Use for research (Explore), planning (Plan), or general coding tasks (general-purpose). The sub-agent runs independently and returns a single result message. Default backend "internal" runs the built-in sub-agent; "fork" spawns a one-shot child-process fork with its own session.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short (3-5 word) description of the task' },
        prompt: {
          type: 'string',
          description:
            'Complete task description for the sub-agent. Include context, what to do, what tools to use, and expected output format.',
        },
        subagent_type: {
          type: 'string',
          enum: ['Explore', 'Plan', 'general-purpose'],
          description:
            'Agent type: Explore (search/read code), Plan (design implementation), general-purpose (full tools)',
        },
        backend: {
          type: 'string',
          enum: ['internal', 'fork'],
          description: 'Sub-agent backend: internal (built-in, default), fork (one-shot headless fork)',
        },
        background: {
          type: 'boolean',
          description:
            'Start in the background and return immediately with an agentId. Use ListAgents to track it, SendMessage to steer it, and TaskOutput to read the final result.',
        },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'Replan',
    description:
      'When the current execution plan cannot proceed (tasks are blocked or the original approach is invalid), call this tool to generate a new sub-plan for the remaining work. Provide the status of completed and blocked tasks so the planner understands the current situation.',
    input_schema: {
      type: 'object',
      properties: {
        currentPlanStatus: {
          type: 'string',
          description: 'Summary of the current plan status — which tasks are completed, blocked, and still pending.',
        },
        blockedTasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of blocked task IDs that need a new approach',
        },
        reason: { type: 'string', description: 'Why the original plan cannot continue and what needs to change' },
      },
      required: ['currentPlanStatus', 'blockedTasks', 'reason'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },

  // ── Cron / Scheduling ──────────────────────────────────
  {
    name: 'CronCreate',
    description:
      'Schedule a recurring or one-shot task. Uses cron syntax with minute/hour/day-of-month/month/day-of-week. Tasks fire when the app is running. Use for periodic checks, reminders, or automation triggers.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for this cron job' },
        prompt: { type: 'string', description: 'The prompt to execute when the cron fires' },
        cron: {
          type: 'string',
          description:
            'Standard 5-field cron expression e.g. "0 9 * * *" for daily at 9am, "*/5 * * * *" for every 5 minutes',
        },
        recurring: { type: 'boolean', description: 'true = fire on every match, false = fire once then delete' },
      },
      required: ['name', 'prompt', 'cron', 'recurring'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'CronDelete',
    description: 'Cancel a scheduled cron job by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job ID returned by CronCreate' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'CronList',
    description: 'List all active cron jobs (both recurring and one-shot).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'ScheduleCreate',
    description:
      'Create a session-local scheduled follow-up: run a prompt after a delay (after_seconds), at an absolute time (at, epoch ms), or on a fixed interval (every_seconds, bounded repeats). Delivery is session-local and only fires while the app is running; entries do not survive a restart.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to run when the follow-up fires' },
        after_seconds: { type: 'number', description: 'Delay in seconds (1 to 30 days)' },
        at: { type: 'number', description: 'Absolute epoch-ms timestamp (future, within 30 days)' },
        every_seconds: { type: 'number', description: 'Fixed interval in seconds (1 to 30 days, bounded repeats)' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'ScheduleDelete',
    description: 'Cancel a scheduled follow-up by id.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Schedule id from ScheduleCreate' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'ScheduleList',
    description: 'List scheduled follow-ups (kind, prompt, next fire time, repeat budget).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },

  // ── Task management ────────────────────────────────────
  {
    name: 'TaskOutput',
    description:
      'Read accumulated output from a running background task or sub-agent. Use to check progress without blocking.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The toolCallId or agent ID to read output from' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'TaskStop',
    description: 'Stop a running tool or sub-agent by its ID. Use to cancel long-running operations.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The toolCallId or agent ID to stop' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },

  // ── Plan mode gating ───────────────────────────────────
  {
    name: 'EnterPlanMode',
    description:
      'Enter planning mode — before making changes, design an implementation plan and present it for user approval. Use for non-trivial multi-file changes. The plan will be shown to the user, who can approve or reject it.',
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What you want to accomplish — used to generate the plan' },
        context: { type: 'string', description: 'Additional context about the codebase or constraints (optional)' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'ExitPlanMode',
    description: 'Exit planning mode after the user has approved the plan. Signals that implementation can begin.',
    input_schema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'The plan ID to approve (optional — approves current plan if omitted)' },
      },
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },

  // ── Notebook ───────────────────────────────────────────
  {
    name: 'NotebookEdit',
    description:
      'Read or modify cells in a Jupyter notebook (.ipynb) file. Supports read, write, insert, and delete operations on individual cells. Pass the "version" from your last Read to reject stale edits.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the .ipynb file' },
        cell_index: {
          type: 'number',
          description: '0-based cell index to target (optional for insert — appends at end)',
        },
        action: {
          type: 'string',
          enum: ['read', 'write', 'insert', 'delete'],
          description: 'Operation: read a cell, write/replace a cell, insert a new cell, or delete a cell',
        },
        source: {
          type: 'string',
          description: "Cell source content (required for write, insert). Use '\\n' for line breaks.",
        },
        cell_type: {
          type: 'string',
          enum: ['code', 'markdown'],
          description: 'Cell type (for insert). Defaults to code.',
        },
        version: {
          type: 'string',
          description: 'Optional version from Read; the edit fails if the file changed since',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },

  // ── Git Worktree Isolation ─────────────────────────────
  {
    name: 'EnterWorktree',
    description:
      'Create an isolated Git worktree sandbox. ALL subsequent tool calls (Read, Write, Edit, Bash) will be automatically redirected to the sandbox path. This prevents the agent from modifying the main branch directly. Useful in auto mode to isolate changes.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Unique task identifier (e.g. "fix-login-bug"). Used for sandbox directory and branch naming.',
        },
        projectRoot: {
          type: 'string',
          description: 'Project root directory (optional — defaults to current project root)',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },

  // ── LSP Code Intelligence ──────────────────────────────
  {
    name: 'LSP',
    description:
      'Code intelligence tool. Actions: definition (find where a symbol is declared), references (find all usages), implementation (find implementors of an interface/class), hover (get type/signature info at a position), diagnostics (run TypeScript type checking). Prefers a real language server when available (AURAXIS_LSP_SERVER), otherwise falls back to regex + tsc. Provide file_path with line/column for position-aware actions.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['definition', 'references', 'implementation', 'hover', 'diagnostics'],
          description: 'Which LSP operation to perform',
        },
        symbol: { type: 'string', description: 'Symbol name to search for (required for definition and references)' },
        file_path: { type: 'string', description: 'Optional file path to scope the search or diagnostics to' },
        line: {
          type: 'number',
          description: '1-based line number (required for hover/implementation with a real server)',
        },
        column: {
          type: 'number',
          description: '1-based column number (required for hover/implementation with a real server)',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },

  // ── Review Artifact Quality Gate ───────────────────────
  {
    name: 'ReviewArtifact',
    description:
      'Run build, test, typecheck, or lint verification on the current project (or active worktree sandbox). Returns the command output, error output, and exit status so you can decide how to respond.',
    input_schema: {
      type: 'object',
      properties: {
        check_type: {
          type: 'string',
          enum: ['build', 'test', 'typecheck', 'lint'],
          description: 'Type of verification to run',
        },
        projectRoot: {
          type: 'string',
          description: 'Project root (optional — defaults to current project root or active worktree sandbox)',
        },
        file_path: { type: 'string', description: 'Optional specific file to check (for typecheck)' },
      },
      required: ['check_type'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },

  // ── File Deletion ────────────────────────────────────
  {
    name: 'Delete',
    description:
      'Delete a file or directory within the project. For directories, must set recursive=true. The file is backed up to the undo system before deletion so it can be restored.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file or directory to delete' },
        recursive: {
          type: 'boolean',
          description: 'Set to true to delete directories recursively. Ignored for files.',
          default: false,
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },

  // ── Git Commit ──────────────────────────────────────
  {
    name: 'GitCommit',
    description:
      'Stage all changes and create a git commit with the given message. Returns the commit hash. Only works within a project directory that has a git repository.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message describing the changes made' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },

  // ── Session Memory Query ────────────────────────────
  {
    name: 'SessionQuery',
    description:
      'Search past chat and agent session transcripts for a keyword or phrase. Returns matching sessions with title, timestamp, snippet, and relevance score. Use this to recall prior decisions, previously discussed code locations, or what was already tried — before re-reading files or asking the user to repeat context.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword or phrase to search for (Chinese and English both work)' },
        limit: { type: 'number', description: 'Max results to return (1-20, default 8)', default: 8 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },

  {
    name: 'ReadSpill',
    description:
      'Read the full content of an oversized tool output that was spilled to disk (a tool result may contain "spill_path" when output is too large). Pass the exact spill_path value. Returns the complete original payload.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'spill_path returned in a previous tool result' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },

  // ── Ask the user a question ─────────────────────────
  {
    name: 'AskUser',
    description:
      "Ask the human a clarifying question and wait for their answer. Use this when the task is genuinely ambiguous — a required choice, missing preference, or a decision the user should make — instead of guessing. Provide concise options when the choice is bounded; otherwise the user can type a free-form answer. The tool result contains the user's reply.",
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask, in Chinese, concise and unambiguous' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional answer choices (2-5). If omitted, the user answers freely.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },

  // ── Professional document skills (Office / PDF) ──────
  {
    name: 'ReadDocument',
    description:
      'Read a professional document file (.docx/.xlsx/.pptx/.pdf) and return its text content as plain text (xlsx also returns structured sheets). Use this instead of Read for binary document formats.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the document (.docx/.xlsx/.pptx/.pdf)' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'WriteDocument',
    description:
      'Create or overwrite a professional document (.docx/.xlsx/.pptx/.pdf) from a structured spec. For docx/pdf: { title?, blocks: [{type:"paragraph|heading|bullet|numbered|table|pageBreak", text?, level?, rows?}] }. For xlsx: { sheets: [{ name, rows: string[][] }] }. For pptx: { slides: [{ title?, subtitle?, bullets?, notes? }] }. Returns the written path and byte size.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute output path ending in .docx/.xlsx/.pptx/.pdf' },
        spec: {
          type: 'object',
          description:
            'Structured document content (title/blocks for Word & PDF, sheets for Excel, slides for PowerPoint)',
        },
      },
      required: ['file_path', 'spec'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },

  // ── Cloud connectors (Slack / Drive / Notion) ────────
  {
    name: 'SlackListChannels',
    description:
      'List Slack channels (public + private) the configured bot/user can access. Tokens come from Settings → 连接器; do not ask the user for a token.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max channels to return (1-200, default 100)', default: 100 },
      },
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'SlackPostMessage',
    description:
      'Post a message to a Slack channel by id (from SlackListChannels). External side effect — confirm intent before use.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Slack channel id (C…)' },
        text: { type: 'string', description: 'Message body' },
      },
      required: ['channel', 'text'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'DriveList',
    description:
      'List Google Drive files/folders the configured token can access. Optional query follows the Drive API `q` syntax (e.g. "name contains \'Report\'").',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional Drive API query (q)' },
        page_size: { type: 'number', description: 'Max results (1-100, default 50)', default: 50 },
      },
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'DriveRead',
    description:
      'Read a Google Drive file by id (from DriveList). Text files return text; other files return base64 content.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Drive file id' },
      },
      required: ['file_id'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'NotionSearch',
    description: 'Search Notion pages/databases the integration token can access. Returns page id, title and url.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional search text' },
        page_size: { type: 'number', description: 'Max results (1-50, default 10)', default: 10 },
      },
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'NotionCreatePage',
    description:
      'Create a Notion page under a parent page (from NotionSearch). Markdown (headings/bullets/numbered/code/paragraphs) becomes Notion blocks. External side effect — confirm intent before use.',
    input_schema: {
      type: 'object',
      properties: {
        parent_page_id: { type: 'string', description: 'Parent page id' },
        title: { type: 'string', description: 'New page title' },
        markdown: { type: 'string', description: 'Optional Markdown content converted to page blocks' },
      },
      required: ['parent_page_id', 'title'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },

  // ── Persistent PTY terminal ─────────────────────────
  {
    name: 'Pty',
    description:
      'Manage persistent interactive terminal (PTY) sessions that keep state across tool calls. Use for interactive programs (REPLs, dev servers, prompts) where a one-shot Bash call would lose context. Actions: create (start a session), write (send input; set enter=true to press Enter), read (return output since the last read; timeout_ms up to 30000), close (end a session), list (active sessions of this task), clear (close all sessions of this task). Sessions are scoped to the current task and are NOT visible to other tasks.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'write', 'read', 'close', 'list', 'clear'],
          description: 'Which PTY operation to perform',
        },
        session_id: { type: 'string', description: 'Session id returned by create (required for write/read/close)' },
        command: { type: 'string', description: 'Program to start for create (defaults to the system shell)' },
        cwd: { type: 'string', description: 'Working directory for create (defaults to the project root)' },
        data: { type: 'string', description: 'Input to write to the session' },
        enter: { type: 'boolean', description: 'Append an Enter (\\r) after data for write', default: false },
        timeout_ms: {
          type: 'number',
          description: 'How long read waits for new output (default 2000, max 30000)',
          default: 2000,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'TerminalOpen',
    description:
      'Open a persistent terminal session for the current task. Returns a session_id to use with the other Terminal* tools. The shell is default-shell + cwd=project root unless overridden.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Program to start (defaults to the system shell)' },
        cwd: { type: 'string', description: 'Working directory (defaults to the project root)' },
        session_id: {
          type: 'string',
          description: 'Optional stable session id; reuses the existing session when present',
        },
      },
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'TerminalList',
    description: "List the current task's open terminal sessions with their ids.",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'TerminalRead',
    description: 'Read new output from a terminal session since the last read (waits up to timeout_ms).',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id from TerminalOpen' },
        timeout_ms: { type: 'number', description: 'Wait for new output (default 2000, max 30000)' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
  },
  {
    name: 'TerminalSend',
    description: 'Send input to a terminal session. Set enter=true to submit the line.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id from TerminalOpen' },
        data: { type: 'string', description: 'Text to send' },
        enter: { type: 'boolean', description: 'Append Enter after data', default: false },
      },
      required: ['session_id', 'data'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'TerminalSignal',
    description:
      'Send a control signal to a terminal session. SIGINT/SIGTSTP/SIGQUIT are written as control characters; SIGTERM/SIGKILL close the session.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id from TerminalOpen' },
        signal: {
          type: 'string',
          enum: ['SIGINT', 'SIGTSTP', 'SIGQUIT', 'SIGTERM', 'SIGKILL'],
          description: 'Signal name',
        },
      },
      required: ['session_id', 'signal'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },
  {
    name: 'TerminalClose',
    description: 'Close a terminal session and release its shell process.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id from TerminalOpen' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
  },

  // ── Bounded self-modification ───────────────────────
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

  // ── Sub-agent orchestration （子代理控制） ─────
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

  // ── Goal management （目标管理） ────────────
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

  // ── Runtime plugin mounting （运行时插件） ────────
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

  // ── Fresh-agent iterative loop （迭代循环） ────
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

  // ── Native PowerShell （PowerShell 执行） ─────────
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

  // ── Session event tracing （会话事件检索） ─
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

  // ── Background task listing （后台任务） ──
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
