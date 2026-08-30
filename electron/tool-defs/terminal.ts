import type { ToolDef } from './types';

/** Persistent PTY / terminal tools. */
export const TERMINAL_TOOL_DEFINITIONS: ToolDef[] = [
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
];
