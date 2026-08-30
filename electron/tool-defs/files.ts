import type { ToolDef } from './types';

/** File read/write/search tools. */
export const FILE_TOOL_DEFINITIONS: ToolDef[] = [
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
];
