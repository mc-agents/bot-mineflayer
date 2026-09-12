import * as z from 'zod';
import type { Entity } from 'prismarine-entity';
import { type ToolDefinition, defineTool, structured } from '../rpc/tool.ts';
import type { TextSegment } from '../minecraft/text.ts';
import { glyphPieces, plainSegments, toSegments } from '../minecraft/text.ts';
import { customName, plainName } from '../minecraft/names.ts';
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
  segments: TextSegment[];
  glyphPieces: number;
}

export interface DisplaysView {
  maxDistance: number;
  displays: DisplayView[];
}

/*
type is the entity's id and not prismarine's coarse category. A custom name replaces the label, so
with the category there the answer for the fixture cow was "Probe Cow (mob)" and nothing said it was
a cow. The other kind of bot reports the id, and the catalogue now says that is what the field is.
*/
function viewEntity(entity: Entity, distance: number): EntityView {
  return {
    label: customName(entity) ?? entity.username ?? entity.name ?? entity.type,
    type: entity.name ?? entity.type,
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
      const filter = args.type === undefined ? '' : plainName(args.type);

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

function displayed(entity: Entity): { segments: TextSegment[]; glyphPieces: number; text: string } {
  const metadata = (entity as unknown as { metadata?: Record<number, unknown> }).metadata ?? {};
  const raw = metadata[DISPLAY_TEXT_SLOT];
  const segments = toSegments(raw);
  const named = customName(entity);

  if (segments.length === 0 && named !== null) {
    return { segments: [{ text: named, font: undefined, color: undefined }], glyphPieces: 0, text: named };
  }

  return { segments, glyphPieces: glyphPieces(raw), text: plainSegments(segments) };
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
          said: displayed(entity),
          distance: bot.entity.position.distanceTo(entity.position),
        }))
        /*
        A display drawn only from glyphs is an icon and is kept: something is there. Dropping it for
        having no readable text hid a real server's nameplates entirely, while the other kind of bot
        reported them, and the two disagreed about how many things were floating in the same spot.
        */
        .filter((one) => (one.said.text !== '' || one.said.glyphPieces > 0) && one.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, args.count ?? 20);

      return structured(`${found.length} displayed`, {
        maxDistance,
        displays: found.map(({ entity, said, distance }) => ({
          text: said.text,
          entity: entity.name ?? entity.type,
          position: blockPoint(entity.position),
          distance,
          segments: said.segments,
          glyphPieces: said.glyphPieces,
        })),
      } satisfies DisplaysView);
    },
  ),
];
