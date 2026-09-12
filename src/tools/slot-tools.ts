import * as z from 'zod';
import { Vec3 } from 'vec3';
import { type ToolDefinition, coordinateArgs, defineTool, floorCoordinates, structured } from '../rpc/tool.ts';
import { walkTo } from '../minecraft/navigate.ts';
import { type HeldView, describeWindow, requireWindow, viewHeld, viewWindow } from '../minecraft/window.ts';

const CLICK_BUTTONS = ['left', 'right'] as const;

const CONTAINER_BLOCKS = new Set([
  'chest',
  'trapped_chest',
  'ender_chest',
  'barrel',
  'hopper',
  'dispenser',
  'dropper',
  'shulker_box',
]);

const CONTAINER_REACH = 3;
const CURSOR_SLOT = -999;

export type ClickButton = (typeof CLICK_BUTTONS)[number];

export interface ClickedSlotView {
  slot: number;
  button: ClickButton;
  shift: boolean;
  before: HeldView | null;
  after: HeldView | null;
  cursor: HeldView | null;
}

export interface DroppedItemView {
  slot: number | null;
  dropped: HeldView | null;
}

export interface ClickPlan {
  mouseButton: number;
  mode: number;
}

export function planClick(button: ClickButton, shift: boolean): ClickPlan {
  return { mouseButton: button === 'right' ? 1 : 0, mode: shift ? 1 : 0 };
}

export function assertSlotInWindow(slot: number, slotCount: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= slotCount) {
    throw new Error(`Slot ${slot} is outside the window, whose slots run 0-${slotCount - 1}`);
  }
}

export function isContainerBlock(name: string): boolean {
  return CONTAINER_BLOCKS.has(name) || name.endsWith('_shulker_box');
}

export const slotTools: ToolDefinition[] = [
  defineTool(
    'click-slot',
    'Click one slot of the window that is currently open.',
    {
      slot: z.coerce.number().int().describe('Slot number as listed by the window contents'),
      button: z.enum(CLICK_BUTTONS).optional().describe("Which mouse button to press (default: 'left')"),
      shift: z.boolean().optional()
        .describe('Shift-click, which moves the whole stack across the window (default: false)'),
    },
    async (args, ctx) => {
      const { bot } = ctx;
      const window = requireWindow(bot);

      assertSlotInWindow(args.slot, window.slots.length);

      const button = args.button ?? 'left';
      const shift = args.shift ?? false;
      const before = viewHeld(window.slots[args.slot]);
      const { mouseButton, mode } = planClick(button, shift);

      await bot.clickWindow(args.slot, mouseButton, mode);

      /*
      The slot after the click and the cursor go back as well, because a plugin that cancels the
      click leaves both untouched and a sentence naming only the slot cannot tell that from a
      click that worked. The caller used to have to follow every click with read-window.
      */
      return structured('clicked slot ' + args.slot, {
        slot: args.slot,
        button,
        shift,
        before,
        after: viewHeld(window.slots[args.slot]),
        cursor: viewHeld(window.selectedItem),
      } satisfies ClickedSlotView);
    },
  ),

  defineTool(
    'open-container',
    'Open the chest-like block at a position, walking to it first when out of reach, and list what it holds.',
    coordinateArgs,
    async (args, ctx) => {
      const { bot } = ctx;
      const target = floorCoordinates(args.x, args.y, args.z);
      const position = new Vec3(target.x, target.y, target.z);
      const block = bot.blockAt(position);

      if (!block || !isContainerBlock(block.name)) {
        throw new Error(
          `(${target.x}, ${target.y}, ${target.z}) holds ${block?.name ?? 'nothing loaded'}, not a container`,
        );
      }

      if (bot.entity.position.distanceTo(position) > CONTAINER_REACH) {
        await walkTo(bot, target, 2);
      }

      await bot.openContainer(block);

      const view = viewWindow(requireWindow(bot));

      return structured(describeWindow(view), view);
    },
  ),

  defineTool(
    'drop-held-item',
    'Drop whatever the cursor is holding, or the stack in a given slot. The window stays open.',
    {
      slot: z.coerce.number().int().optional()
        .describe('Slot to empty onto the ground. Omit it to drop what the cursor holds.'),
    },
    async (args, ctx) => {
      const { bot } = ctx;
      const window = bot.currentWindow ?? bot.inventory;

      /* Nothing to drop is a state, so it travels as dropped: null and mcp-server says so. */
      const answer = (slot: number | null, dropped: HeldView | null) => structured(
        dropped === null ? 'nothing to drop' : 'dropped ' + dropped.name,
        { slot, dropped } satisfies DroppedItemView,
      );

      if (args.slot === undefined) {
        const cursor = viewHeld(window.selectedItem);

        if (cursor !== null) {
          await bot.clickWindow(CURSOR_SLOT, 0, 0);
        }

        return answer(null, cursor);
      }

      assertSlotInWindow(args.slot, window.slots.length);

      const item = viewHeld(window.slots[args.slot]);

      if (item !== null) {
        await bot.clickWindow(args.slot, 0, 0);
        await bot.clickWindow(CURSOR_SLOT, 0, 0);
      }

      return answer(args.slot, item);
    },
  ),
];
