import assert from 'node:assert/strict';
import test from 'node:test';
import type { Window } from 'prismarine-windows';
import { viewWindow } from '../src/minecraft/window.ts';
import { compileTitlePattern, titleMatches } from '../src/tools/window-tools.ts';

test('an omitted title pattern compiles to no pattern at all', () => {
  assert.equal(compileTitlePattern(undefined), null);
});

test('a broken regular expression is rejected with the source quoted back', () => {
  assert.throws(
    () => compileTitlePattern('Shop ('),
    (error: Error) => error.message.startsWith('"Shop (" is not a valid regular expression:'),
  );
});

test('a window matches when no pattern narrows the wait', () => {
  assert.equal(titleMatches('Auction House', null), true);
  assert.equal(titleMatches('', null), true);
});

test('a pattern matches a substring of the title but not an unrelated one', () => {
  const pattern = compileTitlePattern('Shop');

  assert.equal(titleMatches('Village Shop - Page 1', pattern), true);
  assert.equal(titleMatches('Crafting Table', pattern), false);
});

test('an anchored pattern only matches the whole title', () => {
  const pattern = compileTitlePattern('^Chest$');

  assert.equal(titleMatches('Chest', pattern), true);
  assert.equal(titleMatches('Large Chest', pattern), false);
});

/*
The catalogue says the two ranges are first and last, and prismarine's inventoryEnd is one past the
last. A 63-slot chest reported as running to 63 is a range whose top slot the server would refuse a
click on, and the other kind of bot -- reading the menu's own slot list -- said 62.
*/
test('the slot ranges name the first and last slot, not one past the end', () => {
  const view = viewWindow({
    title: 'Chest',
    type: 'minecraft:generic_9x3',
    slots: new Array(63).fill(null),
    inventoryStart: 27,
    inventoryEnd: 63,
  } as unknown as Window);

  assert.deepEqual(view.containerSlots, [0, 26]);
  assert.deepEqual(view.inventorySlots, [27, 62]);
  assert.equal(view.slotCount, 63);
});
