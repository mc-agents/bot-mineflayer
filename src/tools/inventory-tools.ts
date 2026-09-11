import * as z from 'zod';
import type { EquipmentDestination } from 'mineflayer';
import loadItem from 'prismarine-item';
import type { Item } from 'prismarine-item';
import type { IndexedData } from 'minecraft-data';
import { type ToolDefinition, defineTool, structured } from '../rpc/tool.ts';

export interface StackView {
  name: string;
  count: number;
  slot: number;
}

export interface InventoryView {
  items: StackView[];
}

export interface FoundItemView {
  query: string;
  item: StackView | null;
}

function viewStack(item: Item): StackView {
  return { name: item.name, count: item.count, slot: item.slot };
}

/*
prismarine-item ships an ESM declaration over a CommonJS module: the runtime export is the loader
itself, while the types read as a namespace. The cast states what the module actually is.
*/
type ItemLoader = (registry: IndexedData) => new (type: number, count: number) => Item;

const loadItemForVersion = loadItem as unknown as ItemLoader;

const EQUIPMENT_DESTINATIONS = ['hand', 'head', 'torso', 'legs', 'feet', 'off-hand'] as const;

function findItem(items: Item[], query: string): Item | undefined {
  const needle = query.trim().toLowerCase();
  return items.find((item) => item.name === needle)
    ?? items.find((item) => item.name.includes(needle));
}

export const inventoryTools: ToolDefinition[] = [
  defineTool(
    'list-inventory',
    "List every item in the bot's inventory with slot numbers.",
    {},
    (_args, ctx) => {
      const { bot } = ctx;
      const items = bot.inventory.items();

      return structured(`${items.length} stacks`, { items: items.map(viewStack) } satisfies InventoryView);
    },
  ),

  defineTool(
    'find-item',
    "Look for an item in the bot's inventory by exact or partial name.",
    {
      nameOrType: z.string().min(1).describe('Item name or a fragment of it'),
    },
    (args, ctx) => {
      const { bot } = ctx;
      const item = findItem(bot.inventory.items(), args.nameOrType);

      return structured(item ? `found ${item.name}` : 'no match', {
        query: args.nameOrType,
        item: item ? viewStack(item) : null,
      } satisfies FoundItemView);
    },
  ),

  defineTool(
    'equip-item',
    'Equip an item from the inventory.',
    {
      itemName: z.string().min(1).describe('Item name or a fragment of it'),
      destination: z.enum(EQUIPMENT_DESTINATIONS).optional()
        .describe("Where to equip it (default: 'hand')"),
    },
    async (args, ctx) => {
      const { bot } = ctx;
      const item = findItem(bot.inventory.items(), args.itemName);

      if (!item) {
        throw new Error(`No inventory item matches "${args.itemName}"`);
      }

      const destination = (args.destination ?? 'hand') as EquipmentDestination;
      await bot.equip(item, destination);
      return `Equipped ${item.name} to ${destination}.`;
    },
  ),

  defineTool(
    'give-item',
    'Put an item straight into the inventory. Creative mode only, which is what makes it useful: ' +
    'a test can start from the state it needs instead of gathering its way there.',
    {
      itemName: z.string().min(1).describe('Exact item name, for example diamond_pickaxe'),
      count: z.coerce.number().int().min(1).max(64).optional().describe('How many (default: 1)'),
      slot: z.coerce.number().int().min(0).max(44).optional()
        .describe('Inventory slot to fill (default: the first empty one)'),
    },
    async (args, ctx) => {
      const { bot } = ctx;

      if (bot.game.gameMode !== 'creative') {
        throw new Error(`The bot is in ${bot.game.gameMode} mode; give-item needs creative.`);
      }

      const kind = bot.registry.itemsByName[args.itemName];

      if (!kind) {
        throw new Error(`"${args.itemName}" is not an item in this version.`);
      }

      const slot = args.slot ?? bot.inventory.firstEmptyInventorySlot();

      if (slot === null || slot === undefined) {
        throw new Error('The inventory is full and no slot was given.');
      }

      const count = args.count ?? 1;
      const ItemForVersion = loadItemForVersion(bot.registry);
      await bot.creative.setInventorySlot(slot, new ItemForVersion(kind.id, count));

      return `Put ${count} ${args.itemName} in slot ${slot}.`;
    },
  ),
];
