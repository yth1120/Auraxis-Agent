import type { ToolDef } from './types';

/** Web fetch/search tools. */
export const NETWORK_TOOL_DEFINITIONS: ToolDef[] = [
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
];
