import { blockTools } from '../tools/block-tools.ts';
import { chatTools } from '../tools/chat-tools.ts';
import { craftingTools } from '../tools/crafting-tools.ts';
import { displayTools, entityTools } from '../tools/entity-tools.ts';
import { furnaceTools } from '../tools/furnace-tools.ts';
import { hudTools } from '../tools/hud-tools.ts';
import { interactTools } from '../tools/interact-tools.ts';
import { inventoryTools } from '../tools/inventory-tools.ts';
import { movementTools } from '../tools/movement-tools.ts';
import { serverTools } from '../tools/server-tools.ts';
import { slotTools } from '../tools/slot-tools.ts';
import { windowTools } from '../tools/window-tools.ts';
import { CATALOG_VERSION, WIRE_SCHEMA_HASHES } from './catalog-hashes.ts';
import type { Capability } from './protocol.ts';
import type { ToolDefinition } from './tool.ts';

export { CATALOG_VERSION };

/*
A tool the catalogue does not know is not reported: the server would ignore it anyway, and
reporting one would only make a bot built against a newer catalogue look broken against an older
server. A tool the catalogue knows and this bot does not implement is simply absent, which is how
one bot can ship a tool before the other does.
*/
const IMPLEMENTED: readonly ToolDefinition[] = [
  ...blockTools,
  ...chatTools,
  ...craftingTools,
  ...entityTools,
  ...displayTools,
  ...furnaceTools,
  ...hudTools,
  ...interactTools,
  ...inventoryTools,
  ...movementTools,
  ...serverTools,
  ...slotTools,
  ...windowTools,
];

function index(tools: readonly ToolDefinition[]): Map<string, ToolDefinition> {
  const byName = new Map<string, ToolDefinition>();

  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`two tools are called "${tool.name}"`);
    }
    byName.set(tool.name, tool);
  }

  return byName;
}

export const TOOLS: ReadonlyMap<string, ToolDefinition> = index(IMPLEMENTED);

export const TOOL_NAMES: readonly string[] = [...TOOLS.keys()].sort();

/*
The whole point of sending a hash is that it comes from the catalogue rather than from the bot's
own opinion of the schema. A tool with no entry has nothing to agree with, so it is not offered.
*/
export function capabilities(): Capability[] {
  return TOOL_NAMES
    .filter((tool) => WIRE_SCHEMA_HASHES[tool] !== undefined)
    .map((tool) => ({ tool, argsHash: WIRE_SCHEMA_HASHES[tool]! }));
}

export function unhashedTools(): string[] {
  return TOOL_NAMES.filter((tool) => WIRE_SCHEMA_HASHES[tool] === undefined);
}

export function unimplementedTools(): string[] {
  return Object.keys(WIRE_SCHEMA_HASHES).filter((tool) => !TOOLS.has(tool)).sort();
}
