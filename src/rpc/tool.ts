import * as z from 'zod';
import type { Bot } from 'mineflayer';
import type { RecipeBook } from '../minecraft/recipe-book.ts';
import type { ScoreTracker } from '../minecraft/scoreboard.ts';
import { ToolError } from './protocol.ts';

export interface ToolContext {
  bot: Bot;
  username: string;
  scores: ScoreTracker;
  recipes: RecipeBook;
  /* Aborts when the call is cancelled or its deadline passes. Tools that can stop early watch it. */
  signal: AbortSignal;
}

/*
A tool that reports game state sends a DTO and lets mcp-server write the sentence. Two kinds of
bot describing the same scoreboard in two ways would split the agent's behaviour by bot kind, so
the bot keeps the game knowledge (unwrapping NBT, splitting font segments) and gives up the
wording. `text` stays as a one-line fallback for anyone reading the wire by hand.
*/
export interface StructuredOutput {
  text: string;
  data: unknown;
}

export type ToolOutput = string | StructuredOutput;

export function structured(text: string, data: unknown): StructuredOutput {
  return { text, data };
}

export interface ToolDefinition {
  name: string;
  description: string;
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolOutput>;
}

export const coordinateArgs = {
  x: z.coerce.number().describe('X coordinate'),
  y: z.coerce.number().describe('Y coordinate'),
  z: z.coerce.number().describe('Z coordinate'),
};

export function floorCoordinates(x: number, y: number, z: number): { x: number; y: number; z: number } {
  for (const [label, value] of [['x', x], ['y', y], ['z', z]] as const) {
    if (!Number.isFinite(value)) {
      throw new Error(`Coordinate ${label} must be a finite number, got ${value}`);
    }
  }
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

/*
A field the server left out arrives as null from some encoders and as a missing key from others.
Both mean "the caller did not say", and the tool bodies read that as their own default, so the
two are made to look the same before zod ever sees them.
*/
function dropNulls(args: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value !== null) {
      kept[key] = value;
    }
  }

  return kept;
}

/*
The server normalises arguments against the catalogue before they reach here: defaults filled,
values clamped, coordinates floored, no `bot` field. What is left for the bot is decoding, not
validation, and a shape that refuses to read its input means the two disagree about the
catalogue rather than that the caller asked for something silly. That is why the failure is
`args`, which disables this one tool, and not `tool`, which would blame the game.
*/
export function defineTool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: Shape,
  run: (args: z.infer<z.ZodObject<Shape>>, context: ToolContext) => ToolOutput | Promise<ToolOutput>,
): ToolDefinition {
  const schema = z.object(shape);

  return {
    name,
    description,
    run: async (args, context) => {
      const decoded = schema.safeParse(dropNulls(args));

      if (!decoded.success) {
        throw new ToolError({
          class: 'args',
          code: 'ARGS_REJECTED',
          message: `${name} could not read its arguments: ${z.prettifyError(decoded.error)}`,
          retryable: false,
          detail: decoded.error.issues,
        });
      }

      return run(decoded.data as z.infer<z.ZodObject<Shape>>, context);
    },
  };
}
