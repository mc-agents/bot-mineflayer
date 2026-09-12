import type { Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import type { Window } from 'prismarine-windows';
import { rawComponentOf, toPlainText } from './text.ts';

export interface SlotView {
  slot: number;
  name: string;
  count: number;
  label: string | null;
  lore: string[];
  labelComponent: unknown;
  loreComponents: unknown[];
}

/** A stack that is not in a numbered slot: under the cursor, or on its way to the ground. */
export interface HeldView {
  name: string;
  count: number;
  label: string | null;
  lore: string[];
  labelComponent: unknown;
  loreComponents: unknown[];
}

export interface WindowView {
  title: string;
  type: number | string;
  slotCount: number;
  containerSlots: [number, number];
  inventorySlots: [number, number];
  filled: SlotView[];
}

export function readLabel(item: Item): string | null {
  const text = toPlainText(item.customName);
  return text === '' ? null : text;
}

/*
Blank lines kept. A blank lore line is where a menu puts its spacing, and the line below it sits
where the server put it -- the same reason a blank sign line is reported as one. Dropping them also
broke the pairing with the components below, which is by position.
*/
export function readLore(item: Item): string[] {
  return loreLines(item).map((line) => toPlainText(line));
}

/** The components those lines were written as, for mcp-server to flatten itself. */
export function loreComponents(item: Item): unknown[] {
  return loreLines(item).map(rawComponentOf);
}

function loreLines(item: Item): unknown[] {
  const raw = item.customLore;

  if (raw === null || raw === undefined) {
    return [];
  }

  return Array.isArray(raw) ? raw : [raw];
}

export function viewSlot(item: Item): SlotView {
  return {
    slot: item.slot,
    name: item.name,
    count: item.count,
    label: readLabel(item),
    lore: readLore(item),
    labelComponent: rawComponentOf(item.customName),
    loreComponents: loreComponents(item),
  };
}

/* Empty is a state, and it travels as no stack at all rather than as a count of zero. */
export function viewHeld(item: Item | null | undefined): HeldView | null {
  if (item === null || item === undefined) {
    return null;
  }

  return {
    name: item.name,
    count: item.count,
    label: readLabel(item),
    lore: readLore(item),
    labelComponent: rawComponentOf(item.customName),
    loreComponents: loreComponents(item),
  };
}

export function viewWindow(window: Window): WindowView {
  const filled = (window.slots as (Item | null)[])
    .filter((item): item is Item => item !== null && item !== undefined)
    .map(viewSlot);

  return {
    title: toPlainText(window.title),
    type: window.type,
    slotCount: window.slots.length,
    containerSlots: [0, Math.max(window.inventoryStart - 1, 0)],
    /*
    The catalogue says first and last, and inventoryEnd is one past the last: a 63-slot chest was
    reported as running to slot 63, which does not exist. A caller that clamped a click to the range
    it was given would have been refused by the server.
    */
    inventorySlots: [window.inventoryStart, Math.max(window.inventoryEnd - 1, window.inventoryStart)],
    filled,
  };
}

export function requireWindow(bot: Bot): Window {
  const window = bot.currentWindow;

  if (!window) {
    throw new Error(
      'No window is open. Run the command that opens the menu first, ' +
      'then use wait-for-window before reading or clicking it.',
    );
  }

  return window;
}

export function describeWindow(view: WindowView): string {
  return `window "${view.title}", ${view.filled.length} filled slots`;
}
