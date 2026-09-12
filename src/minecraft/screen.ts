import type { Bot } from 'mineflayer';

interface SoundRegistry {
  sounds?: Record<number, { name?: string } | undefined>;
}

export interface SoundPacket {
  sound?: { soundId?: number; data?: { soundName?: string } } | number;
}

/*
A sound arrives either as an index into the registry or as its own name, depending on whether the
server is playing something vanilla or something a resource pack added.

The protocol document says an id is namespaced -- it is what the server said and what a caller would
type back -- and the registry hands out the bare path, so a chest closing reached a caller as
block.chest.close from this bot and minecraft:block.chest.close from the other one.
*/
export function soundName(bot: Bot, sound: SoundPacket['sound']): string {
  const registry = bot.registry as unknown as SoundRegistry;
  const byId = (id: number): string => registry.sounds?.[id]?.name ?? `sound #${id}`;

  if (typeof sound === 'number') {
    return namespaced(byId(sound));
  }

  if (sound?.data?.soundName !== undefined) {
    return namespaced(sound.data.soundName);
  }

  if (sound?.soundId !== undefined) {
    return namespaced(byId(sound.soundId));
  }

  return '';
}

function namespaced(id: string): string {
  return id === '' || id.includes(':') || id.startsWith('sound #') ? id : `minecraft:${id}`;
}
