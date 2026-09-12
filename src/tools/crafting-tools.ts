import * as z from 'zod';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Recipe } from 'prismarine-recipe';
import type { Window } from 'prismarine-windows';
import minecraftData from 'minecraft-data';
import type { IndexedData } from 'minecraft-data';
import { type ToolDefinition, defineTool, structured } from '../rpc/tool.ts';
import { walkTo } from '../minecraft/navigate.ts';
import { plainName } from '../minecraft/names.ts';
import { toPlainText } from '../minecraft/text.ts';
import type { BookEntry } from '../minecraft/recipe-book.ts';

const TABLE_SEARCH_RADIUS = 16;
const TABLE_REACH = 3;
const MAX_LISTED_RECIPES = 100;

/** The player's own inventory, which is the window a two-by-two craft happens in. */
const OWN_WINDOW = 0;

/** First in a crafting window, whichever kind it is. */
const RESULT_SLOT = 0;

/** prismarine-windows for the block; the player's own grid has no window type of its own. */
const CRAFTING_WINDOW = 'minecraft:crafting';

/** Shift-click, which takes the whole result rather than picking it up. */
const QUICK_MOVE = 1;

/** How long to give the server to fill the grid. Two seconds is a great deal longer than it needs. */
const PLACE_PATIENCE_TICKS = 40;

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
  onlyWhatTheBotKnows: boolean;
}

export interface CanCraftView {
  item: string;
  craftable: boolean;
  hasRecipe: boolean;
  missing: Ingredient[];
  needsTable: boolean;
  onlyWhatTheBotKnows: boolean;
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

function held(bot: Bot, itemId: number): number {
  return bot.inventory.items()
    .filter((stack) => stack.type === itemId)
    .reduce((total, stack) => total + stack.count, 0);
}

/*
The server lays the grid out and the bot takes the result. mineflayer's own craft does the laying
out, and on 26.1 it puts the ingredients in cells the recipe does not use: two lots of sticks came
back as four sticks and an oak_button. Which recipe to place is the only thing the server needs
told, and it cannot be wrong about a recipe of its own.
*/
async function placeAndTake(bot: Bot, entry: BookEntry, windowId: number): Promise<boolean> {
  bot._client.write('craft_recipe_request', {
    windowId,
    recipeId: entry.displayId,
    makeAll: false,
  });

  for (let tick = 0; tick < PLACE_PATIENCE_TICKS; tick++) {
    const result = (bot.currentWindow ?? bot.inventory).slots[RESULT_SLOT];

    if (result?.type === entry.itemId) {
      await bot.clickWindow(RESULT_SLOT, 0, QUICK_MOVE);
      return true;
    }

    await bot.waitForTicks(1);
  }

  return false;
}

/*
Whatever is left in the grid belongs in the inventory: a craft that stopped half way must not
strand its ingredients somewhere the next tool cannot see them. Closing is what hands them back,
and the player's own grid is closed the same way a client closes it -- by saying so for window
zero, which has no window object to close.
*/
async function returnGrid(bot: Bot, window: Window | null): Promise<void> {
  if (window === null) {
    bot._client.write('close_window', { windowId: OWN_WINDOW });
  } else {
    bot.closeWindow(window);
  }

  await bot.waitForTicks(2);
}

/**
 * Why nothing came out, in the words of the static recipe table. The server says nothing at all
 * when it will not place a recipe, and missing ingredients is far and away the usual reason.
 */
function explainEmptyGrid(bot: Bot, mcData: IndexedData, item: { id: number; name: string }, table: Block | null): string {
  const closest = bot.recipesAll(item.id, null, table)
    .map((recipe) => ({ recipe, missing: missingFor(bot, mcData, recipe) }))
    .sort((a, b) => a.missing.length - b.missing.length)[0];

  if (closest === undefined || closest.missing.length === 0) {
    return `The server placed no recipe for ${item.name} and gave no reason. `
      + 'get-recipe shows what it takes and list-inventory what the bot is carrying.';
  }

  const missing = closest.missing.map(({ name, count }) => `${name} x${count}`).join(', ');

  return `Cannot craft ${item.name}. Missing ${missing}`;
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
          onlyWhatTheBotKnows: false,
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
        onlyWhatTheBotKnows: false,
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
        onlyWhatTheBotKnows: false,
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
          onlyWhatTheBotKnows: false,
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
        onlyWhatTheBotKnows: false,
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
      const entry = ctx.recipes.forItem(item.id)[0];

      if (entry === undefined) {
        /* The same sentence the other kind of bot refuses with: the two share the constraint. */
        throw new Error(
          `No recipe produces ${item.name}, or the server has not unlocked one for this bot. ` +
          'A client is only told the recipes its book holds.',
        );
      }

      const open = bot.currentWindow;

      if (open !== null && open.type !== CRAFTING_WINDOW) {
        throw new Error(
          `Crafting needs the player's own grid or a crafting table, and "${toPlainText(open.title)}" ` +
          'is open in front of both. Close it first.',
        );
      }

      /* A crafting window the caller left open is a table, and using it beats walking to another. */
      const table = entry.needsTable && open === null
        ? await reachableCraftingTable(bot, mcData)
        : null;

      if (entry.needsTable && open === null && table === null) {
        throw new Error(
          `Crafting ${item.name} needs a grid bigger than the two-by-two a player carries, and ` +
          `no crafting table is within ${TABLE_SEARCH_RADIUS} blocks.`,
        );
      }

      /*
      Counted rather than predicted, which is what caught the grid being laid out wrongly in the
      first place: a run that asked for two lots of sticks reported eight and had actually made
      four and an oak_button. A sentence about what the inventory gained cannot say that.
      */
      const before = held(bot, item.id);
      const opened = table === null ? null : await bot.openBlock(table);
      const windowId = opened?.id ?? open?.id ?? OWN_WINDOW;
      let placed = 0;

      try {
        while (placed < amount && await placeAndTake(bot, entry, windowId)) {
          placed++;
        }
      } finally {
        /* Only what this tool opened is closed; a window the caller was using stays up. */
        if (open === null) {
          await returnGrid(bot, opened);
        }
      }

      const gained = held(bot, item.id) - before;

      if (gained <= 0) {
        throw new Error(explainEmptyGrid(bot, mcData, item, table));
      }

      return `Crafted ${item.name} x${gained}.`;
    },
  ),
];
