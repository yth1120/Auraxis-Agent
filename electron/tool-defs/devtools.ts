import type { ToolDef } from './types';

/** LSP, review, session memory and user interaction tools. */
export const DEVTOOLS_TOOL_DEFINITIONS: ToolDef[] = [
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
];
