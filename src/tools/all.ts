/**
 * The complete tool surface, assembled once.
 *
 * Both consumers — the MCP entry and the CLI — import from here, so a tool
 * added to one surface cannot silently miss the other.
 */
import type { TokenStore } from '../auth/token-store.js';
import type { AnyToolDefinition } from '../server/registry.js';
import { authTools } from './auth.js';
import { checkinTools } from './checkins.js';
import { geoTools } from './geo.js';
import { placeTools } from './places.js';
import { recallTools } from './recall.js';
import { searchTools } from './search.js';
import { sqlTools } from './sql.js';
import { syncTools } from './sync.js';

/** Tools that belong together in a human-facing listing. */
export interface ToolGroup {
  readonly area: string;
  readonly tools: readonly AnyToolDefinition[];
}

export function toolGroups(store: TokenStore): readonly ToolGroup[] {
  return [
    { area: 'Archive', tools: syncTools },
    { area: 'Check-ins', tools: checkinTools },
    { area: 'Search', tools: searchTools },
    { area: 'Recall', tools: recallTools },
    { area: 'Places and statistics', tools: placeTools },
    { area: 'Geography', tools: geoTools },
    { area: 'SQL', tools: sqlTools },
    { area: 'Authentication', tools: authTools(store) },
  ];
}

export function allTools(store: TokenStore): AnyToolDefinition[] {
  return toolGroups(store).flatMap((group) => [...group.tools]);
}
