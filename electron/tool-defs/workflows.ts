import type { ToolDef } from './types';

/** Plan-mode workflow, notebook edit and worktree isolation tools. */
export const WORKFLOW_TOOL_DEFINITIONS: ToolDef[] = [
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
];
