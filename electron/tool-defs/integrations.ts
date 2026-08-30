import type { ToolDef } from './types';

/** Slack / Drive / Notion connector tools. */
export const INTEGRATION_TOOL_DEFINITIONS: ToolDef[] = [
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
];
