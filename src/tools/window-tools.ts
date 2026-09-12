import * as z from 'zod';
import type { Bot } from 'mineflayer';
import type { Window } from 'prismarine-windows';
import { type ToolDefinition, defineTool, structured } from '../rpc/tool.ts';
import { describeWindow, viewWindow } from '../minecraft/window.ts';
import type { WindowView } from '../minecraft/window.ts';

const MAX_PATTERN_LENGTH = 256;
const OPEN_TIMEOUT_MS = 10_000;

export interface AwaitedWindowView {
  titlePattern: string | null;
  timeoutMs: number;
  window: WindowView | null;
}

export function compileTitlePattern(source: string | undefined): RegExp | null {
  if (source === undefined) {
    return null;
  }

  try {
    return new RegExp(source);
  } catch (error) {
    throw new Error(`"${source}" is not a valid regular expression: ${(error as Error).message}`);
  }
}

export function titleMatches(title: string, pattern: RegExp | null): boolean {
  return pattern === null || pattern.test(title);
}

function nextMatchingWindow(bot: Bot, pattern: RegExp | null, timeoutMs: number): Promise<Window | null> {
  return new Promise((resolve) => {
    const done = (window: Window | null) => {
      clearTimeout(timer);
      bot.removeListener('windowOpen', onOpen);
      resolve(window);
    };

    const onOpen = (window: Window) => {
      if (titleMatches(viewWindow(window).title, pattern)) {
        done(window);
      }
    };

    const timer = setTimeout(() => done(null), timeoutMs);
    bot.on('windowOpen', onOpen);
  });
}

export const windowTools: ToolDefinition[] = [
  defineTool(
    'wait-for-window',
    'Wait until a GUI window opens and return its contents. Returns straight away if a matching window is already open.',
    {
      titlePattern: z.string().min(1).max(MAX_PATTERN_LENGTH).optional()
        .describe('JavaScript regular expression the window title must match (default: any window)'),
      timeoutMs: z.coerce.number().int().min(100).max(120_000).optional()
        .describe(`How long to wait (default: ${OPEN_TIMEOUT_MS})`),
    },
    async (args, ctx) => {
      const { bot } = ctx;
      const pattern = compileTitlePattern(args.titlePattern);
      const timeoutMs = args.timeoutMs ?? OPEN_TIMEOUT_MS;

      const answer = (window: WindowView | null) => structured(
        window === null ? `nothing opened within ${timeoutMs}ms` : describeWindow(window),
        { titlePattern: args.titlePattern ?? null, timeoutMs, window } satisfies AwaitedWindowView,
      );

      if (bot.currentWindow) {
        const open = viewWindow(bot.currentWindow);

        if (titleMatches(open.title, pattern)) {
          return answer(open);
        }
      }

      const window = await nextMatchingWindow(bot, pattern, timeoutMs);

      return answer(window === null ? null : viewWindow(window));
    },
  ),

  defineTool(
    'read-window',
    'Read the window that is currently open, or report that nothing is.',
    {},
    (_args, ctx) => {
      const { bot } = ctx;
      const window = bot.currentWindow;

      /*
      Nothing being open is a state, not a failure, so it travels as window: null and mcp-server
      writes the sentence. Throwing here meant each kind of bot had its own wording for the same
      state, which is what comparing the two kinds found.
      */
      if (!window) {
        return structured('no window is open', { window: null });
      }

      const view = viewWindow(window);

      return structured(describeWindow(view), { window: view });
    },
  ),

  defineTool(
    'close-window',
    'Close the GUI window the bot has open, or report that there was none.',
    {},
    async (_args, ctx) => {
      const { bot } = ctx;
      const window = bot.currentWindow;

      /* Asking to close nothing is a no-op, not a mistake, so it travels as a state. */
      if (!window) {
        return structured('no window was open', { closed: null });
      }

      const { title, titleComponent } = viewWindow(window);
      await bot.closeWindow(window);

      return structured(`closed ${title}`, { closed: title, closedComponent: titleComponent });
    },
  ),
];
