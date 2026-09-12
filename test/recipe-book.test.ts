import assert from 'node:assert/strict';
import test from 'node:test';
import { RecipeBook } from '../src/minecraft/recipe-book.ts';
import type { RecipeBookClient } from '../src/minecraft/recipe-book.ts';

const STICK = 947;
const BARREL = 1059;
const OAK_BUTTON = 752;

function fakeClient(): {
  client: RecipeBookClient;
  add: (packet: unknown) => void;
  remove: (packet: unknown) => void;
} {
  const listeners = new Map<string, (packet: never) => void>();

  const client: RecipeBookClient = {
    on: (event, listener) => {
      listeners.set(event, listener);
      return client;
    },
  };

  const fire = (event: string) => (packet: unknown) => {
    const listener = listeners.get(event);
    assert.ok(listener, `no ${event} listener was registered`);
    listener(packet as never);
  };

  return { client, add: fire('recipe_book_add'), remove: fire('recipe_book_remove') };
}

function shaped(displayId: number, itemId: number, count: number, width: number, height: number) {
  return {
    recipe: {
      displayId,
      display: {
        type: 'crafting_shaped',
        data: {
          width,
          height,
          ingredients: Array.from({ length: width * height }, () => ({ type: 'tag', data: '#minecraft:planks' })),
          result: { type: 'item_stack', data: { itemId, itemCount: count } },
        },
      },
    },
  };
}

function shapeless(displayId: number, itemId: number, count: number, ingredients: number) {
  return {
    recipe: {
      displayId,
      display: {
        type: 'crafting_shapeless',
        data: {
          ingredients: Array.from({ length: ingredients }, () => ({ type: 'item', data: 36 })),
          result: { type: 'item_stack', data: { itemId, itemCount: count } },
        },
      },
    },
  };
}

test('a recipe is indexed by the item it produces, with the yield of one craft', () => {
  const { client, add } = fakeClient();
  const book = new RecipeBook();

  book.attach(client);
  add({ entries: [shaped(1211, STICK, 4, 1, 2)], replace: true });

  assert.deepEqual(book.forItem(STICK), [
    { displayId: 1211, itemId: STICK, count: 4, needsTable: false },
  ]);
});

test('a grid wider or taller than two needs a table, and the two-by-two does not', () => {
  const { client, add } = fakeClient();
  const book = new RecipeBook();

  const TABLE = 333;
  const DOOR = 500;

  book.attach(client);
  add({
    entries: [shaped(48, BARREL, 1, 3, 3), shaped(293, TABLE, 1, 2, 2), shaped(865, DOOR, 3, 2, 3)],
    replace: true,
  });

  assert.equal(book.forItem(BARREL)[0]?.needsTable, true);
  assert.equal(book.forItem(TABLE)[0]?.needsTable, false);
  assert.equal(book.forItem(DOOR)[0]?.needsTable, true);
});

test('a shapeless recipe needs a table only once it wants a fifth ingredient', () => {
  const { client, add } = fakeClient();
  const book = new RecipeBook();

  book.attach(client);
  add({ entries: [shapeless(863, OAK_BUTTON, 1, 1), shapeless(900, 1, 1, 5)], replace: true });

  assert.equal(book.forItem(OAK_BUTTON)[0]?.needsTable, false);
  assert.equal(book.forItem(1)[0]?.needsTable, true);
});

test('the grid a player carries is preferred over the one that needs walking to', () => {
  const { client, add } = fakeClient();
  const book = new RecipeBook();

  book.attach(client);
  add({ entries: [shaped(1, STICK, 4, 3, 3), shaped(2, STICK, 4, 1, 2)], replace: true });

  assert.deepEqual(book.forItem(STICK).map((entry) => entry.displayId), [2, 1]);
});

/*
A recipe whose result is a family of items is a thing to look at in a recipe book, not a thing to
ask the server to place, and reading its result as an item id would name whatever item happened to
share that number.
*/
test('a result that is not one item is left out of the index', () => {
  const { client, add } = fakeClient();
  const book = new RecipeBook();

  book.attach(client);
  add({
    entries: [{
      recipe: {
        displayId: 77,
        display: {
          type: 'crafting_shapeless',
          data: { ingredients: [], result: { type: 'tag', data: 'minecraft:planks' } },
        },
      },
    }],
    replace: true,
  });

  assert.equal(book.size, 0);
});

test('a smelting display is not a crafting recipe and is not indexed', () => {
  const { client, add } = fakeClient();
  const book = new RecipeBook();

  book.attach(client);
  add({
    entries: [{
      recipe: {
        displayId: 5,
        display: {
          type: 'furnace',
          data: { result: { type: 'item_stack', data: { itemId: STICK, itemCount: 1 } } },
        },
      },
    }],
    replace: true,
  });

  assert.equal(book.size, 0);
});

test('a recipe the server takes away stops being craftable', () => {
  const { client, add, remove } = fakeClient();
  const book = new RecipeBook();

  book.attach(client);
  add({ entries: [shaped(1211, STICK, 4, 1, 2)], replace: true });
  remove({ recipeIds: [1211] });

  assert.deepEqual(book.forItem(STICK), []);
});

/*
The book the server sends on login replaces the one from the connection before it. Keeping both
would leave display ids from the old session in the index, and the server answers a request for one
of those with nothing at all.
*/
test('a book sent with replace set drops everything held before it', () => {
  const { client, add } = fakeClient();
  const book = new RecipeBook();

  book.attach(client);
  add({ entries: [shaped(1211, STICK, 4, 1, 2)], replace: true });
  add({ entries: [shaped(48, BARREL, 1, 3, 3)], replace: true });

  assert.deepEqual(book.forItem(STICK), []);
  assert.equal(book.forItem(BARREL).length, 1);
});

test('a book sent without replace adds to what is already known', () => {
  const { client, add } = fakeClient();
  const book = new RecipeBook();

  book.attach(client);
  add({ entries: [shaped(1211, STICK, 4, 1, 2)], replace: true });
  add({ entries: [shaped(48, BARREL, 1, 3, 3)] });

  assert.equal(book.size, 2);
});
