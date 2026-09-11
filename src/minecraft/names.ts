/*
Minecraft ids are namespaced: `minecraft:stone`. minecraft-data indexes everything by the name
alone, so a caller writing the canonical form -- which is what commands, the wiki, and every
datapack use -- was told "Unknown block type minecraft:stone" about a block that plainly exists.

Dropping the default namespace is what the game does when one is left out. Any other namespace
belongs to a plugin and genuinely is not in the vanilla registry, so it is kept whole and the
lookup fails naming the id the caller actually gave.
*/
const VANILLA = 'minecraft:';

export function plainName(id: string): string {
  const trimmed = id.trim().toLowerCase();

  return trimmed.startsWith(VANILLA) ? trimmed.slice(VANILLA.length) : trimmed;
}
