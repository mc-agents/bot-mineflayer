import type { Bot } from 'mineflayer';
import { simplify } from 'prismarine-nbt';
import { describeSegments, toSegments } from './text.ts';

interface SoundRegistry {
  sounds?: Record<number, { name?: string } | undefined>;
}

export interface SoundPacket {
  sound?: { soundId?: number; data?: { soundName?: string } } | number;
}

interface DialogBody {
  title?: unknown;
  body?: unknown;
  actions?: unknown;
  inputs?: unknown;
  type?: unknown;
}

function label(value: unknown): string {
  return describeSegments(toSegments(value));
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

/*
An NBT list of one is written as a bare compound, so a dialog with a single line of body arrives
shaped differently from one with two. Both are read the same way here.
*/
function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  return value === undefined || value === null ? [] : [value];
}

/*
The dialog is an NBT blob whose shape follows whichever dialog type the server picked. The parts
worth reading back are the same in all of them: what it says, and what it offers to press.

show_dialog wraps it in a registry entry holder, so the blob is under `data` when the server sends
the definition inline. Passing the holder itself to simplify yields nothing and the read of title
throws, which is how this was found.
*/
export function describeDialog(dialog: unknown): string {
  if (dialog === undefined || dialog === null) {
    return '';
  }

  const held = (dialog as { data?: unknown }).data ?? dialog;
  const plain = simplify(held as never) as DialogBody | undefined;

  if (plain === undefined || plain === null || typeof plain !== 'object') {
    return '';
  }

  const parts: string[] = [];
  const title = label(plain.title);

  if (title !== '') {
    parts.push(title);
  }

  const lines = asList(plain.body)
    .map((entry) => label((entry as { contents?: unknown }).contents ?? entry))
    .filter((line) => line !== '');

  if (lines.length > 0) {
    parts.push(lines.join(' / '));
  }

  const buttons = asList(plain.actions)
    .map((action) => label((action as { label?: unknown }).label))
    .filter((one) => one !== '');

  if (buttons.length > 0) {
    parts.push(`buttons: ${buttons.join(', ')}`);
  }

  const inputs = asList(plain.inputs);

  if (inputs.length > 0) {
    parts.push(`${inputs.length} input field(s)`);
  }

  return parts.join(' | ');
}
