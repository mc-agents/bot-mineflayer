import * as z from 'zod';
import type { Bot } from 'mineflayer';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { simplify } from 'prismarine-nbt';
import { describeError, log } from '../logger.ts';
import { rawComponentOf, toSegments } from '../minecraft/text.ts';
import { plainName } from '../minecraft/names.ts';
import { walkTo } from '../minecraft/navigate.ts';
import { blockPoint } from '../minecraft/view.ts';
import type { Point } from '../minecraft/view.ts';
import { type ToolDefinition, coordinateArgs, defineTool, floorCoordinates, structured } from '../rpc/tool.ts';

const MAX_FIND_BLOCKS_COUNT = 256;

/* How many extra findBlocks has to return before the nearest count of them are really the nearest. */
const OVERSCAN = 8;
const REACH_RANGE = 2;
const MAX_BLOCK_ENTITY_JSON = 2_000;

export interface BlockInfoView {
  position: Point;
  block: { name: string; type: number; position: Point } | null;
}

export interface FoundBlocksView {
  blockType: string;
  maxDistance: number;
  positions: Point[];
}

export interface SignFaceView {
  face: string;
  lines: string[];
  lineComponents: unknown[];
}

export interface BlockEntityView {
  block: string;
  position: Point;
  present: boolean;
  signFaces: SignFaceView[];
  raw: string | null;
}

const FACES = {
  down: new Vec3(0, -1, 0),
  up: new Vec3(0, 1, 0),
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0),
} as const;

type FaceName = keyof typeof FACES;

async function approach(bot: Bot, target: Vec3): Promise<void> {
  await walkTo(bot, target, REACH_RANGE);
}

export const blockTools: ToolDefinition[] = [
  defineTool(
    'get-block-info',
    'Describe the block at a position.',
    coordinateArgs,
    (args, ctx) => {
      const { bot } = ctx;
      const target = floorCoordinates(args.x, args.y, args.z);
      const block = bot.blockAt(new Vec3(target.x, target.y, target.z));

      const view: BlockInfoView = {
        position: target,
        block: block
          ? { name: block.name, type: block.type, position: blockPoint(block.position) }
          : null,
      };

      return structured(view.block === null ? 'not loaded' : view.block.name, view);
    },
  ),

  defineTool(
    'find-blocks',
    'Find nearby blocks of a given type.',
    {
      blockType: z.string().min(1).describe('Block name, for example oak_log'),
      maxDistance: z.coerce.number().finite().min(1).optional().describe('Search radius (default: 16)'),
      count: z.coerce.number().int().min(1).optional()
        .describe(`How many to return (default: 1, clamped to ${MAX_FIND_BLOCKS_COUNT})`),
    },
    (args, ctx) => {
      const { bot } = ctx;
      const mcData = minecraftData(bot.version);
      const blockInfo = mcData.blocksByName[plainName(args.blockType)];

      if (!blockInfo) {
        throw new Error(`Unknown block type "${args.blockType}"`);
      }

      const maxDistance = args.maxDistance ?? 16;
      const count = Math.min(args.count ?? 1, MAX_FIND_BLOCKS_COUNT);
      /*
      The catalogue says nearest first, and findBlocks does not promise that: it walks columns in
      order of horizontal distance and takes the first count it meets, so asking for three diamond
      blocks out of a nine-block patch returned three that were not the three closest. Over-fetching
      and sorting is what makes the promise true, and the other kind of bot sorts.
      */
      const found = bot.findBlocks({
        point: bot.entity.position,
        matching: blockInfo.id,
        maxDistance,
        count: Math.min(count * OVERSCAN, MAX_FIND_BLOCKS_COUNT * OVERSCAN),
      });

      /*
      Between block positions, not to the middle of a block, and ties broken by coordinate: both
      are what the fabric bot does, and two bots standing on one block have to answer with the
      same list or the comparison suite reports where they were standing as a finding.
      */
      const from = bot.entity.position.floored();
      const nearest = found
        .map((position) => ({ position, distance: from.distanceTo(position) }))
        .sort((a, b) => a.distance - b.distance
          || a.position.x - b.position.x
          || a.position.y - b.position.y
          || a.position.z - b.position.z)
        .slice(0, count)
        .map(({ position }) => blockPoint(position));

      const view: FoundBlocksView = {
        blockType: args.blockType,
        maxDistance,
        positions: nearest,
      };

      return structured(`${nearest.length} found`, view);
    },
  ),

  defineTool(
    'dig-block',
    'Break the block at a position, walking to it first when out of reach.',
    coordinateArgs,
    async (args, ctx) => {
      const { bot } = ctx;
      const target = floorCoordinates(args.x, args.y, args.z);
      const position = new Vec3(target.x, target.y, target.z);
      const block = bot.blockAt(position);

      if (!block || block.name === 'air') {
        return `Nothing to dig at (${target.x}, ${target.y}, ${target.z}).`;
      }

      if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
        await approach(bot, position);
      }

      await bot.dig(block);
      return `Dug ${block.name} at (${target.x}, ${target.y}, ${target.z}).`;
    },
  ),

  defineTool(
    'place-block',
    'Place the held block at a position, using an adjacent block as reference.',
    {
      ...coordinateArgs,
      faceDirection: z.enum(Object.keys(FACES) as [FaceName, ...FaceName[]]).optional()
        .describe("Which neighbouring face to try first (default: 'down')"),
    },
    async (args, ctx) => {
      const { bot } = ctx;
      const target = floorCoordinates(args.x, args.y, args.z);
      const placePos = new Vec3(target.x, target.y, target.z);
      const botPos = bot.entity.position.floored();

      if (placePos.equals(botPos) || placePos.equals(botPos.offset(0, 1, 0))) {
        throw new Error('Cannot place a block inside the bot itself');
      }

      const existing = bot.blockAt(placePos);
      if (existing && existing.name !== 'air') {
        return `(${target.x}, ${target.y}, ${target.z}) already holds ${existing.name}.`;
      }

      const preferred = args.faceDirection ?? 'down';
      const order: FaceName[] = [
        preferred,
        ...(Object.keys(FACES) as FaceName[]).filter((face) => face !== preferred),
      ];

      const failures: string[] = [];

      for (const face of order) {
        const offset = FACES[face];
        const referencePos = placePos.plus(offset);
        const reference = bot.blockAt(referencePos);

        if (!reference || reference.name === 'air') {
          continue;
        }

        if (!bot.canSeeBlock(reference)) {
          await approach(bot, referencePos);
        }

        await bot.lookAt(placePos, true);

        try {
          await bot.placeBlock(reference, offset.scaled(-1));
          return `Placed a block at (${target.x}, ${target.y}, ${target.z}) against its ${face} face.`;
        } catch (error) {
          const reason = describeError(error);
          failures.push(`${face}: ${reason}`);
          log('debug', 'place-block face attempt failed', { face, reason });
        }
      }

      throw new Error(
        failures.length === 0
          ? `No solid block next to (${target.x}, ${target.y}, ${target.z}) to place against`
          : `Every reference face failed. ${failures.join('; ')}`,
      );
    },
  ),

  defineTool(
    'read-block-entity',
    'Read the data a block carries beyond its type: sign text, a container\'s custom name, a ' +
    'banner\'s pattern. Signs are the common case, since that is where servers write instructions ' +
    'into the world itself.',
    {
      ...coordinateArgs,
    },
    (args, ctx) => {
      const { bot } = ctx;
      const { x, y, z } = floorCoordinates(args.x, args.y, args.z);
      const block = bot.blockAt(new Vec3(x, y, z));

      if (!block) {
        throw new Error(`No block is loaded at (${x}, ${y}, ${z}); the bot may be too far away.`);
      }

      const carrier = block as unknown as { entity?: unknown; blockEntity?: unknown };
      const data = carrier.entity ?? carrier.blockEntity;
      const position = { x, y, z };

      if (data === undefined || data === null) {
        return structured('no block entity', {
          block: block.name,
          position,
          present: false,
          signFaces: [],
          raw: null,
        } satisfies BlockEntityView);
      }

      const signFaces = readSignFaces(data);

      return structured(signFaces.length > 0 ? 'sign' : 'block entity', {
        block: block.name,
        position,
        present: true,
        signFaces,
        raw: signFaces.length > 0
          ? null
          : JSON.stringify(simplify(data as never), null, 1).slice(0, MAX_BLOCK_ENTITY_JSON),
      } satisfies BlockEntityView);
    },
  ),
];

/*
A sign keeps two faces since 1.20, each holding four lines that arrive as separate chat
components. Flattening a face to one string would lose the line breaks that carry its meaning.
*/
function readSignFaces(data: unknown): SignFaceView[] {
  const plain = simplify(data as never) as Record<string, unknown>;
  const faces: SignFaceView[] = [];

  for (const face of ['front_text', 'back_text']) {
    const side = plain[face] as { messages?: unknown[] } | undefined;

    if (!side?.messages) {
      continue;
    }

    /*
    Joined with nothing between the pieces, which is what a Minecraft client's own getString()
    does and what the other kind of bot sends. It used to be the rendered form, font markers and
    separators included, so a sign written in the pack's own font read differently on the two
    kinds. Those markers are the renderer's, and the component beside the line is what it reads.
    */
    const lines = side.messages.map(
      (message) => toSegments(message).map((piece) => piece.text).join(''),
    );

    if (lines.some((one) => one !== '')) {
      faces.push({ face, lines, lineComponents: side.messages.map(rawComponentOf) });
    }
  }

  return faces;
}
