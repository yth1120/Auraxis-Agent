// Built-in AI tool definitions, split by capability family.
// Tool identity + base shape live in contracts/tools.ts (single source).
import type { ToolDef } from './types';
import { CORE_TOOL_DEFINITIONS } from './core';
import { FILE_TOOL_DEFINITIONS } from './files';
import { NETWORK_TOOL_DEFINITIONS } from './network';
import { PLANNING_TOOL_DEFINITIONS } from './planning';
import { SCHEDULING_TOOL_DEFINITIONS } from './scheduling';
import { WORKFLOW_TOOL_DEFINITIONS } from './workflows';
import { DEVTOOLS_TOOL_DEFINITIONS } from './devtools';
import { DOCUMENT_TOOL_DEFINITIONS } from './documents';
import { INTEGRATION_TOOL_DEFINITIONS } from './integrations';
import { TERMINAL_TOOL_DEFINITIONS } from './terminal';
import { RUNTIME_TOOL_DEFINITIONS } from './runtime';

export type { ToolDef, ToolName, BuiltInToolName, ToolStreamEvent } from './types';

export const TOOL_DEFINITIONS: ToolDef[] = [
  ...CORE_TOOL_DEFINITIONS,
  ...FILE_TOOL_DEFINITIONS,
  ...NETWORK_TOOL_DEFINITIONS,
  ...PLANNING_TOOL_DEFINITIONS,
  ...SCHEDULING_TOOL_DEFINITIONS,
  ...WORKFLOW_TOOL_DEFINITIONS,
  ...DEVTOOLS_TOOL_DEFINITIONS,
  ...DOCUMENT_TOOL_DEFINITIONS,
  ...INTEGRATION_TOOL_DEFINITIONS,
  ...TERMINAL_TOOL_DEFINITIONS,
  ...RUNTIME_TOOL_DEFINITIONS,
];
