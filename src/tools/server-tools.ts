import * as z from 'zod';
import { type ToolDefinition, defineTool, structured } from '../rpc/tool.ts';
import { toPlainText } from '../minecraft/text.ts';

export interface CompletionView {
  name: string;
  tooltip: string | null;
}

export interface CompletionsView {
  text: string;
  total: number;
  completions: CompletionView[];
}

export interface WorldStateView {
  timeOfDay: number;
  day: number;
  moonPhase: number;
  isDay: boolean;
  weather: string;
  doDaylightCycle: boolean;
}

export const serverTools: ToolDefinition[] = [
  defineTool(
    'wait-ticks',
    'Wait a number of server ticks so the server has time to apply a change.',
    {
      ticks: z.coerce.number().int().min(1).max(400).describe('How many ticks to wait (20 ticks is one second)'),
    },
    async (args, ctx) => {
      const { bot } = ctx;
      await bot.waitForTicks(args.ticks);
      return `Waited ${args.ticks} tick(s).`;
    },
  ),

  defineTool(
    'complete-command',
    'Ask the server what completes a partial command, which is how to find out what a plugin ' +
    'offers without being told. "/" lists every command the bot may run.',
    {
      text: z.string().min(1).max(256).describe('The partial command, for example "/is "'),
      timeoutMs: z.coerce.number().int().min(100).max(30_000).optional()
        .describe('How long to wait for the answer (default: 5000)'),
      limit: z.coerce.number().int().min(1).max(500).optional()
        .describe('How many completions to show (default: 60)'),
    },
    async (args, ctx) => {
      const { bot } = ctx;
      const limit = args.limit ?? 60;
      const matches = await bot.tabComplete(args.text, true, false, args.timeoutMs ?? 5_000);

      /*
      The packet carries {match, tooltip}, not the plain strings the mineflayer types promise,
      and a server with many plugins answers "/" with a thousand of them.
      */
      const completions = matches.slice(0, limit).map((entry) => {
        const completion = entry as unknown as { match?: string; tooltip?: unknown };
        const tooltip = toPlainText(completion.tooltip);

        return { name: completion.match ?? String(entry), tooltip: tooltip === '' ? null : tooltip };
      });

      return structured(`${matches.length} completions`, {
        text: args.text,
        total: matches.length,
        completions,
      } satisfies CompletionsView);
    },
  ),

  defineTool(
    'get-world-state',
    'Report the in-game time and weather, for a feature that only happens at a certain time of ' +
    'day. This is the clock the world ticks on, not whatever a server may draw on its HUD.',
    {},
    (_args, ctx) => {
      const { bot } = ctx;
      const time = bot.time;
      const weather = bot.thunderState > 0 ? 'thunder' : bot.isRaining ? 'rain' : 'clear';

      return structured(`tick ${time.timeOfDay}, ${weather}`, {
        timeOfDay: time.timeOfDay,
        day: time.day,
        moonPhase: time.moonPhase,
        isDay: time.isDay,
        weather,
        doDaylightCycle: time.doDaylightCycle,
      } satisfies WorldStateView);
    },
  ),
];
