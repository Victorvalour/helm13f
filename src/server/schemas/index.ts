// Single source of truth for the 6 Query + 5 Execute tool definitions.
// Phase 3 will import ALL_TOOLS into the MCP server registration code.

import { Q1, Q2, Q3, Q4, Q5, Q6, QUERY_TOOLS } from './query.js';
import { E1, E2, E3, E4, E5, EXECUTE_TOOLS } from './execute.js';

export { Q1, Q2, Q3, Q4, Q5, Q6, E1, E2, E3, E4, E5 };
export { QUERY_TOOLS, EXECUTE_TOOLS };

export const ALL_TOOLS = [...QUERY_TOOLS, ...EXECUTE_TOOLS] as const;

export type ToolDef = (typeof ALL_TOOLS)[number];
