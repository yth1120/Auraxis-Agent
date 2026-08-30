// Shared tool-definition shape used by every capability module and the
// aggregator. Kept separate to avoid a circular import between index and
// category files.
import type { ToolDef as ContractToolDef } from '../contracts/tools';

export type { ToolName, BuiltInToolName, ToolStreamEvent } from '../contracts/tools';

export interface ToolDef extends ContractToolDef {
  /** When true, this tool can run concurrently with other safe tools in the same batch.
   *  Read-only / independent tools are safe; mutation / state-changing tools are not. */
  isConcurrencySafe: boolean;
}
