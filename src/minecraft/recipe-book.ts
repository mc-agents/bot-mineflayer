/*
A client cannot craft out of the game's recipe list. The server lays the grid out, and it finds the
recipe by the display id it handed this player in the recipe book, so the book is the whole of what
this bot can craft and there is no way to ask for a recipe that is not in it.

Tracking it is also what stops the bot laying the grid out itself. That is what mineflayer does, and
on 26.1 it puts the ingredients in the wrong cells: a request for two lots of sticks came back with
four sticks and an oak_button, five planks gone. The server never makes that mistake about its own
recipes.

mineflayer does not know these two packets exist, so the book is kept here the same way the
scoreboard is.
*/

/** A player carries a two-by-two; anything larger is a crafting table. */
const OWN_GRID_SIDE = 2;

export interface BookEntry {
  displayId: number;
  itemId: number;
  /** How many one craft yields. */
  count: number;
  needsTable: boolean;
}

interface WireStack {
  itemId?: number;
  itemCount?: number;
}

interface WireSlotDisplay {
  type?: string;
  data?: WireStack | number;
}

interface WireRecipe {
  displayId?: number;
  display?: {
    type?: string;
    data?: {
      width?: number;
      height?: number;
      ingredients?: unknown[];
      result?: WireSlotDisplay;
    };
  };
}

interface AddPacket {
  entries?: { recipe?: WireRecipe }[];
  /** The book the server sends at login replaces whatever was there. */
  replace?: boolean;
}

interface RemovePacket {
  recipeIds?: number[];
}

export interface RecipeBookClient {
  on: (
    event: 'recipe_book_add' | 'recipe_book_remove',
    listener: (packet: never) => void,
  ) => unknown;
}

/** What the result of one craft is, for the two shapes a single-item result arrives in. */
function resultStack(result: WireSlotDisplay | undefined): WireStack | null {
  if (result === undefined) {
    return null;
  }
  if (result.type === 'item' && typeof result.data === 'number') {
    return { itemId: result.data, itemCount: 1 };
  }
  if (result.type === 'item_stack' && typeof result.data === 'object' && result.data !== null) {
    return result.data;
  }
  /* A tag or a composite is a family of results, and nothing in a family is a thing to craft. */
  return null;
}

function readEntry(recipe: WireRecipe | undefined): BookEntry | null {
  const display = recipe?.display;
  const shaped = display?.type === 'crafting_shaped';

  if (recipe?.displayId === undefined || (!shaped && display?.type !== 'crafting_shapeless')) {
    return null;
  }

  const stack = resultStack(display?.data?.result);

  if (stack?.itemId === undefined || stack.itemCount === undefined) {
    return null;
  }

  const needsTable = shaped
    ? (display?.data?.width ?? 0) > OWN_GRID_SIDE || (display?.data?.height ?? 0) > OWN_GRID_SIDE
    : (display?.data?.ingredients?.length ?? 0) > OWN_GRID_SIDE * OWN_GRID_SIDE;

  return { displayId: recipe.displayId, itemId: stack.itemId, count: stack.itemCount, needsTable };
}

export class RecipeBook {
  private readonly entries = new Map<number, BookEntry>();

  attach(client: RecipeBookClient): void {
    /* A new connection is a new book: display ids from the last one mean nothing to this server. */
    this.entries.clear();

    client.on('recipe_book_add', ((packet: AddPacket) => this.add(packet)) as never);
    client.on('recipe_book_remove', ((packet: RemovePacket) => {
      for (const id of packet.recipeIds ?? []) {
        this.entries.delete(id);
      }
    }) as never);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Every unlocked way to make this item, the ones needing no table first and the biggest yield
   * within that. A craft in the player's own grid needs nothing walked to, so it is worth
   * preferring even when a table happens to be in reach.
   */
  forItem(itemId: number): BookEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.itemId === itemId)
      .sort((a, b) => Number(a.needsTable) - Number(b.needsTable) || b.count - a.count);
  }

  private add(packet: AddPacket): void {
    if (packet.replace === true) {
      this.entries.clear();
    }

    for (const { recipe } of packet.entries ?? []) {
      const entry = readEntry(recipe);

      if (entry !== null) {
        this.entries.set(entry.displayId, entry);
      }
    }
  }
}
