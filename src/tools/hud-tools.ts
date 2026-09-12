import * as z from 'zod';
import type { BossBar, Bot, ScoreBoard } from 'mineflayer';
import { type ToolDefinition, defineTool, structured } from '../rpc/tool.ts';
import type { TextSegment } from '../minecraft/text.ts';
import { plainSegments, rawComponentOf, toPlainText, toSegments } from '../minecraft/text.ts';
import { blockPoint } from '../minecraft/view.ts';
import type { Point } from '../minecraft/view.ts';

const DISPLAY_SLOTS = ['sidebar', 'list', 'belowName'] as const;

const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'] as const;

type BossBarHost = Bot & { bossBars?: readonly BossBar[] };

interface ScoreboardItemLike {
  name: string;
  value: number;
  displayName?: unknown;
}

interface ScoreboardLike {
  title?: unknown;
  items: readonly ScoreboardItemLike[];
}

interface BossBarLike {
  title?: unknown;
  health?: number;
  color?: string;
  dividers?: number;
}

interface PlayerLike {
  username: string;
  gamemode?: number;
  ping?: number;
  displayName?: unknown;
}

export interface ScoreboardEntry {
  name: string;
  score: number;
  nameComponent: unknown;
}

export interface ScoreboardView {
  title: string;
  entries: ScoreboardEntry[];
  titleComponent: unknown;
}

export interface BossBarView {
  title: string;
  progress: number;
  color: string;
  dividers: number;
  segments: TextSegment[];
  component: unknown;
}

export interface PlayerView {
  name: string;
  gameMode: string;
  ping: number | null;
  self: boolean;
  /* What the tab list draws, which is where a server puts a rank. Null when it set none. */
  displayName: string | null;
  displayNameComponent: unknown;
}

export interface ScoreboardSlotView {
  slot: string;
  board: ScoreboardView | null;
}

export interface BossBarsView {
  bars: BossBarView[];
}

export interface PlayerListView {
  players: PlayerView[];
}

export interface PlayerStateView {
  health: number;
  food: number;
  saturation: number;
  experience: { level: number; progress: number; points: number };
  gameMode: string;
  dimension: string;
  position: Point | null;
  oxygen: number | null;
}

export function viewScoreboard(board: ScoreboardLike): ScoreboardView {
  const entries = board.items
    .map((item) => ({
      name: toPlainText(item.displayName) || toPlainText(item.name),
      score: item.value,
      nameComponent: rawComponentOf(item.displayName ?? item.name),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return { title: toPlainText(board.title), entries, titleComponent: rawComponentOf(board.title) };
}

/*
A boss bar is stacked labels on a real server, the same as an action bar: a place, a date and a
channel side by side read as one word when they are joined into a string. The pieces travel and
mcp-server writes the line.
*/
export function viewBossBar(bar: BossBarLike): BossBarView {
  const segments = toSegments(bar.title);

  return {
    title: plainSegments(segments),
    segments,
    component: rawComponentOf(bar.title),
    progress: bar.health ?? 0,
    color: bar.color ?? 'unknown',
    dividers: bar.dividers ?? 0,
  };
}

export function viewPlayerList(players: Record<string, PlayerLike>, selfUsername: string): PlayerView[] {
  return Object.values(players)
    .map((player) => ({
      name: player.username,
      gameMode: GAME_MODES[player.gamemode ?? -1] ?? 'unknown',
      ping: player.ping ?? null,
      self: player.username === selfUsername,
      displayName: player.displayName === undefined || player.displayName === null
        ? null
        : toPlainText(player.displayName),
      displayNameComponent: rawComponentOf(player.displayName),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const hudTools: ToolDefinition[] = [
  defineTool(
    'read-scoreboard',
    'Read the scoreboard the server draws on screen, which most servers use for stats and quest progress.',
    {
      slot: z.enum(DISPLAY_SLOTS).optional()
        .describe("Which display slot to read (default: 'sidebar')"),
    },
    (args, ctx) => {
      const { bot } = ctx;
      const slot = args.slot ?? 'sidebar';
      const board: ScoreBoard | undefined = bot.scoreboard[slot];

      if (!board) {
        return structured(`no ${slot} scoreboard`, { slot, board: null } satisfies ScoreboardSlotView);
      }

      const view = viewScoreboard(board);
      const tracked = ctx.scores.entriesFor(board.name);
      const entries = view.entries.length === 0 ? tracked : view.entries;

      return structured(`${entries.length} entries`, {
        slot,
        board: { ...view, entries },
      } satisfies ScoreboardSlotView);
    },
  ),

  defineTool(
    'read-boss-bars',
    'Read every boss bar the server is showing above the hotbar.',
    {},
    (_args, ctx) => {
      const bot = ctx.bot as BossBarHost;
      const bars = bot.bossBars ?? [];

      return structured(`${bars.length} boss bars`, { bars: bars.map(viewBossBar) } satisfies BossBarsView);
    },
  ),

  defineTool(
    'read-player-list',
    'List the players on the tab list, with their game mode and ping.',
    {},
    (_args, ctx) => {
      const { bot } = ctx;
      const players = viewPlayerList(bot.players, bot.username);

      return structured(`${players.length} players`, { players } satisfies PlayerListView);
    },
  ),

  defineTool(
    'get-player-state',
    'Report the health, hunger, experience and position the bot sees for itself.',
    {},
    (_args, ctx) => {
      const { bot } = ctx;
      const position = bot.entity?.position;
      const experience = bot.experience;

      return structured(`health ${bot.health}, food ${bot.food}`, {
        health: bot.health,
        food: bot.food,
        saturation: bot.foodSaturation,
        experience: { level: experience.level, progress: experience.progress, points: experience.points },
        gameMode: bot.game.gameMode,
        dimension: bot.game.dimension,
        position: position ? blockPoint(position) : null,
        oxygen: bot.oxygenLevel ?? null,
      } satisfies PlayerStateView);
    },
  ),
];
