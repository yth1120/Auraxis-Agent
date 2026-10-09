import type { ToolDef } from './types';

/** Professional document read/write tools. */
export const DOCUMENT_TOOL_DEFINITIONS: ToolDef[] = [
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
    name: 'IngestDocument',
    description:
      'Chunk a long document (.docx/.xlsx/.pptx/.pdf) into project memory so its content becomes retrievable by later queries. Use this instead of ReadDocument when the file is long (roughly >10 pages or >50KB of text) and you need to answer questions about it: reading it whole would flood the context. Re-ingesting the same file replaces its previous chunks. Returns chunk count and file identity.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the document (.docx/.xlsx/.pptx/.pdf)' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
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
];
