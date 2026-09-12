/*
Minecraft ids are namespaced: `minecraft:stone`. minecraft-data indexes everything by the name
alone, so a caller writing the canonical form -- which is what commands, the wiki, and every
datapack use -- was told "Unknown block type minecraft:stone" about a block that plainly exists.

Dropping the default namespace is what the game does when one is left out. Any other namespace
belongs to a plugin and genuinely is not in the vanilla registry, so it is kept whole and the
lookup fails naming the id the caller actually gave.
*/
import { describeSegments, toSegments } from './text.ts';

const VANILLA = 'minecraft:';

export function plainName(id: string): string {
  const trimmed = id.trim().toLowerCase();

  return trimmed.startsWith(VANILLA) ? trimmed.slice(VANILLA.length) : trimmed;
}

/*
A server's name for a thing arrives in entity metadata slot 2, as a component. Nothing mineflayer
exposes carries it -- username is for players and name is the id -- so a cow a server had called
"Probe Cow" was reported as "cow", and looking for it by the name on its tag found nothing. The
other kind of bot reads the component the client was handed, which is how the gap showed up.
*/
const CUSTOM_NAME_SLOT = 2;

export interface MaybeNamed {
  metadata?: Record<number, unknown>;
}

export function customName(entity: MaybeNamed): string | null {
  const named = describeSegments(toSegments(entity.metadata?.[CUSTOM_NAME_SLOT]));

  return named === '' ? null : named;
}
