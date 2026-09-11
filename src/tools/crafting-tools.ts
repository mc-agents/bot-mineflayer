import * as z from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Recipe } from 'prismarine-recipe';
import minecraftData from 'minecraft-data';
import type { IndexedData } from 'minecraft-data';
import { type ToolDefinition, defineTool, structured } from '../rpc/tool.ts';
import { walkTo } from '../minecraft/navigate.ts';
import { plainName } from '../minecraft/names.ts';

const TABLE_SEARCH_RADIUS = 16;
const TABLE_REACH = 3;
const MAX_LISTED_RECIPES = 100;

export interface Ingredient {
  name: string;
  count: number;
}

export interface RecipeView {
  result: Ingredient;
  ingredients: Ingredient[];
  missing: Ingredient[];
  requiresTable: boolean;
}

/*
`item` set means the caller asked about one item; unset means the scan of everything craftable,
which is the only mode that can run out of room and the only one that cares about the table.
*/
export interface RecipeListView {
  item: string | null;
  tableInReach: boolean;
  stoppedAt: number | null;
  recipes: RecipeView[];
}

export interface CanCraftView {
  item: string;
  craftable: boolean;
  hasRecipe: boolean;
  missing: Ingredient[];
  needsTable: boolean;
}

function itemName(mcData: IndexedData, id: number): string {
  return mcData.items[id]?.name ?? `item#${id}`;
}

function resolveItem(mcData: IndexedData, query: string): { id: number; name: string } {
  const needle = plainName(query);
  const exact = mcData.itemsByName[needle];

  if (exact) {
    return { id: exact.id, name: exact.name };
  }

  const partial = Object.values(mcData.itemsByName).find((item) => item.name.includes(needle));

  if (!partial) {
    throw new Error(`No item name matches "${query}"`);
  }

  return { id: partial.id, name: partial.name };
}

function ingredientsOf(mcData: IndexedData, recipe: Recipe): Ingredient[] {
  const counts = new Map<number, number>();

  for (const entry of recipe.delta) {
    if (entry.count >= 0) {
      continue;
    }
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + Math.abs(entry.count));
  }

  return [...counts].map(([id, count]) => ({ name: itemName(mcData, id), count }));
}

function missingFor(bot: Bot, mcData: IndexedData, recipe: Recipe): Ingredient[] {
  const held = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    held.set(item.name, (held.get(item.name) ?? 0) + item.count);
  }

  return ingredientsOf(mcData, recipe)
    .map(({ name, count }) => ({ name, count: count - (held.get(name) ?? 0) }))
    .filter(({ count }) => count > 0);
}

function viewRecipe(mcData: IndexedData, recipe: Recipe, missing: Ingredient[]): RecipeView {
  return {
    result: { name: itemName(mcData, recipe.result.id), count: recipe.result.count },
    ingredients: ingredientsOf(mcData, recipe),
    missing,
    requiresTable: recipe.requiresTable,
  };
}

async function reachableCraftingTable(bot: Bot, mcData: IndexedData): Promise<Block | null> {
  const tableId = mcData.blocksByName.crafting_table?.id;

  if (tableId === undefined) {
    return null;
  }

  const table = bot.findBlock({ matching: tableId, maxDistance: TABLE_SEARCH_RADIUS });

  if (!table) {
    return null;
  }

  if (bot.entity.position.distanceTo(table.position) > TABLE_REACH) {
    await walkTo(bot, table.position, 2);
  }

  return table;
}

export const craftingTools: ToolDefinition[] = [
  defineTool(
    'list-recipes',
    'List recipes the bot can craft right now with what it carries. ' +
    'Pass outputItem to inspect one item instead of scanning everything.',
    {
      outputItem: z.string().min(1).optional().describe('Restrict the list to this item'),
    },
    async (args, ctx) => {
      const { bot } = ctx;
      const mcData = minecraftData(bot.version);
      const table = await reachableCraftingTable(bot, mcData);

      if (args.outputItem !== undefined) {
        const item = resolveItem(mcData, args.outputItem);
        const recipes = bot.recipesAll(item.id, null, table);

        return structured(`${recipes.length} recipes for ${item.name}`, {
          item: item.name,
          tableInReach: table !== null,
          stoppedAt: null,
          recipes: recipes.map((recipe) => viewRecipe(mcData, recipe, missingFor(bot, mcData, recipe))),
        } satisfies RecipeListView);
      }

      const craftable: RecipeView[] = [];

      for (const item of mcData.itemsArray) {
        if (craftable.length >= MAX_LISTED_RECIPES) {
          break;
        }
        const recipes = bot.recipesFor(item.id, null, 1, table);
        if (recipes.length > 0 && recipes[0]) {
          craftable.push(viewRecipe(mcData, recipes[0], []));
        }
      }

      return structured(`${craftable.length} craftable`, {
        item: null,
        tableInReach: table !== null,
        stoppedAt: craftable.length >= MAX_LISTED_RECIPES ? MAX_LISTED_RECIPES : null,
        recipes: craftable,
      } satisfies RecipeListView);
    },
  ),

  defineTool(
    'get-recipe',
    'Show every recipe for an item together with what the bot still needs.',
    {
      itemName: z.string().min(1).describe('Item to look up'),
    },
    async (args, ctx) => {
      const { bot } = ctx;
      const mcData = minecraftData(bot.version);
      const item = resolveItem(mcData, args.itemName);
      const table = await reachableCraftingTable(bot, mcData);
      const recipes = bot.recipesAll(item.id, null, table)
        .map((recipe) => ({ recipe, missing: missingFor(bot, mcData, recipe) }))
        .sort((a, b) => a.missing.length - b.missing.length)
        .map(({ recipe, missing }) => viewRecipe(mcData, recipe, missing));

      return structured(`${recipes.length} recipes for ${item.name}`, {
        item: item.name,
        tableInReach: table !== null,
        stoppedAt: null,
        recipes,
      } satisfies RecipeListView);
    },
  ),

  defineTool(
    'can-craft',
    'Check whether the bot can craft an item right now.',
    {
      itemName: z.string().min(1).describe('Item to check'),
    },
    async (args, ctx) => {
      const { bot } = ctx;
      const mcData = minecraftData(bot.version);
      const item = resolveItem(mcData, args.itemName);
      const table = await reachableCraftingTable(bot, mcData);

      if (bot.recipesFor(item.id, null, 1, table).length > 0) {
        return structured(`${item.name}: yes`, {
          item: item.name,
          craftable: true,
          hasRecipe: true,
          missing: [],
          needsTable: false,
        } satisfies CanCraftView);
      }

      const closest = bot.recipesAll(item.id, null, table)
        .map((recipe) => ({ recipe, missing: missingFor(bot, mcData, recipe) }))
        .sort((a, b) => a.missing.length - b.missing.length)[0];

      return structured(`${item.name}: no`, {
        item: item.name,
        craftable: false,
        hasRecipe: closest !== undefined,
        missing: closest?.missing ?? [],
        needsTable: closest !== undefined && closest.recipe.requiresTable && table === null,
      } satisfies CanCraftView);
    },
  ),

  defineTool(
    'craft-item',
    'Craft an item, walking to a nearby crafting table when the recipe needs one.',
    {
      outputItem: z.string().min(1).describe('Item to craft'),
      amount: z.coerce.number().int().min(1).max(64).optional().describe('How many times to craft (default: 1)'),
    },
    async (args, ctx) => {
      const { bot } = ctx;
      const mcData = minecraftData(bot.version);
      const item = resolveItem(mcData, args.outputItem);
      const amount = args.amount ?? 1;
      const table = await reachableCraftingTable(bot, mcData);
      const recipe = bot.recipesFor(item.id, null, amount, table)[0]
        ?? bot.recipesFor(item.id, null, 1, table)[0];

      if (!recipe) {
        const known = bot.recipesAll(item.id, null, table);

        if (known.length === 0) {
          throw new Error(`No recipe produces ${item.name}`);
        }

        const closest = known
          .map((candidate) => ({ candidate, missing: missingFor(bot, mcData, candidate) }))
          .sort((a, b) => a.missing.length - b.missing.length)[0];

        const missing = closest?.missing.map(({ name, count }) => `${name} x${count}`).join(', ');
        throw new Error(
          `Cannot craft ${item.name}. Missing ${missing ?? 'ingredients'}` +
          `${closest?.candidate.requiresTable && !table ? ' and a crafting table in reach' : ''}`,
        );
      }

      await bot.craft(recipe, amount, table ?? undefined);
      return `Crafted ${item.name} x${recipe.result.count * amount}.`;
    },
  ),
];
