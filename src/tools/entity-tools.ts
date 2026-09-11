import * as z from 'zod';
import type { Entity } from 'prismarine-entity';
import { type ToolDefinition, defineTool, structured } from '../rpc/tool.ts';
import { describeSegments, toSegments } from '../minecraft/text.ts';
import { blockPoint } from '../minecraft/view.ts';
import type { Point } from '../minecraft/view.ts';

export interface EntityView {
  label: string;
  type: string;
  position: Point;
  distance: number;
}

export interface FoundEntitiesView {
  query: string | null;
  maxDistance: number;
  entities: EntityView[];
}

export interface DisplayView {
  text: string;
  entity: string;
  position: Point;
  distance: number;
}

export interface DisplaysView {
  maxDistance: number;
  displays: DisplayView[];
}

function viewEntity(entity: Entity, distance: number): EntityView {
  return {
    label: entity.username ?? entity.name ?? entity.type,
    type: entity.type,
    position: blockPoint(entity.position),
    distance,
  };
}

export const entityTools: ToolDefinition[] = [
  defineTool(
    'find-entity',
    'Find nearby entities, optionally filtered by type or name.',
    {
      type: z.string().optional()
        .describe('"player", "mob", or part of an entity name. Omit to match anything.'),
      maxDistance: z.coerce.number().finite().min(1).optional().describe('Search radius (default: 16)'),
      count: z.coerce.number().int().min(1).max(50).optional().describe('How many to return (default: 1)'),
    },
    (args, ctx) => {
      const { bot } = ctx;
      const maxDistance = args.maxDistance ?? 16;
      const count = args.count ?? 1;
      const filter = args.type?.trim().toLowerCase() ?? '';

      const matches = Object.values(bot.entities)
        .filter((entity) => entity !== bot.entity)
        .filter((entity) => {
          if (filter === '') {
            return true;
          }
          if (filter === 'player' || filter === 'mob') {
            return entity.type === filter;
          }
          return (entity.name ?? '').includes(filter) || (entity.username ?? '').toLowerCase().includes(filter);
        })
        .map((entity) => ({ entity, distance: bot.entity.position.distanceTo(entity.position) }))
        .filter(({ distance }) => distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, count);

      return structured(`${matches.length} found`, {
        query: args.type ?? null,
        maxDistance,
        entities: matches.map(({ entity, distance }) => viewEntity(entity, distance)),
      } satisfies FoundEntitiesView);
    },
  ),
];

/*
A display entity keeps its text in metadata slot 23 on 26.1. Servers draw name tags, holograms and
NPC labels with them, so without this they show up as "text_display" and nothing else.
*/
const DISPLAY_TEXT_SLOT = 23;
const CUSTOM_NAME_SLOT = 2;

function displayText(entity: Entity): string {
  const metadata = (entity as unknown as { metadata?: Record<number, unknown> }).metadata ?? {};

  return describeSegments(toSegments(metadata[DISPLAY_TEXT_SLOT] ?? metadata[CUSTOM_NAME_SLOT]));
}

export const displayTools: ToolDefinition[] = [
  defineTool(
    'read-displays',
    'Read the text floating in the world: holograms, name tags and NPC labels. They are display ' +
    'entities, so find-entity only reports that they exist.',
    {
      maxDistance: z.coerce.number().finite().min(1).optional().describe('Search radius (default: 24)'),
      count: z.coerce.number().int().min(1).max(50).optional().describe('How many to return (default: 20)'),
    },
    (args, ctx) => {
      const { bot } = ctx;
      const maxDistance = args.maxDistance ?? 24;

      const found = Object.values(bot.entities)
        .filter((entity) => entity !== bot.entity)
        .map((entity) => ({
          entity,
          text: displayText(entity),
          distance: bot.entity.position.distanceTo(entity.position),
        }))
        .filter((one) => one.text !== '' && one.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, args.count ?? 20);

      return structured(`${found.length} displayed`, {
        maxDistance,
        displays: found.map(({ entity, text, distance }) => ({
          text,
          entity: entity.name ?? entity.type,
          position: blockPoint(entity.position),
          distance,
        })),
      } satisfies DisplaysView);
    },
  ),
];
