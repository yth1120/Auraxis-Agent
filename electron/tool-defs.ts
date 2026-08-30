// Public entry point for built-in AI tool definitions.
// The definitions live under electron/tool-defs/ so each capability family can
// be maintained and reviewed without touching a 1k+ line monolith.
export { TOOL_DEFINITIONS } from './tool-defs/index';
export type { ToolDef, ToolName, BuiltInToolName, ToolStreamEvent } from './tool-defs/index';
