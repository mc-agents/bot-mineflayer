/*
A dialog arrives as a reference into a registry far more often than as a definition. `/dialog show`
names one the datapack declared, and the packet then carries an index into the `minecraft:dialog`
registry the server sent during configuration -- nothing else. Reading only the inline shape meant
every dialog a datapack declares was dropped, and the feed said the server had not sent one while
the dialog was on screen.

mineflayer does not model the registry, so it is kept here the same way the recipe book is.
*/
import { simplify } from 'prismarine-nbt';
import { toPlainText } from './text.ts';

const DIALOG_REGISTRY = 'minecraft:dialog';

interface RegistryPacket {
  id?: string;
  entries?: { key?: string; value?: unknown }[];
}

/** What show_dialog carries: an index into the registry, or the definition itself. */
interface Reference {
  dialog?: number;
  data?: unknown;
}

export interface DialogRegistryClient {
  on: (event: 'registry_data', listener: (packet: never) => void) => unknown;
}

export class DialogRegistry {
  private entries: unknown[] = [];

  attach(client: DialogRegistryClient): void {
    this.entries = [];

    client.on('registry_data', ((packet: RegistryPacket) => {
      if (packet.id !== DIALOG_REGISTRY) {
        return;
      }
      this.entries = (packet.entries ?? []).map((entry) => entry.value);
    }) as never);
  }

  get size(): number {
    return this.entries.length;
  }

  /** The dialog the packet meant, or null when it names one this bot was never sent. */
  resolve(reference: unknown): unknown {
    if (reference === null || reference === undefined || typeof reference !== 'object') {
      return null;
    }

    const held = reference as Reference;

    if (held.data !== undefined && held.data !== null) {
      return held.data;
    }
    if (typeof held.dialog !== 'number') {
      return null;
    }

    return this.entries[held.dialog] ?? null;
  }
}

/*
The dialog as the game serialises it, with the NBT wrappers taken off. mcp-server reads the parts
worth reading and writes the line: a dialog is a title, some body and a row of buttons rather than
one piece of text, and which of those to say in what order is presentation. This bot used to build
that sentence itself and the other kind had no dialog feed at all, so one dialog read two ways.
*/
export function plainDialog(dialog: unknown): Record<string, unknown> | null {
  if (dialog === undefined || dialog === null) {
    return null;
  }

  const plain = simplify(dialog as never) as Record<string, unknown> | undefined;

  return plain === undefined || plain === null || typeof plain !== 'object' ? null : plain;
}

/** What the feed's text field falls back to when mcp-server has no dialog to read. */
export function dialogTitle(plain: Record<string, unknown> | null): string {
  return plain === null ? '' : toPlainText(plain.title);
}
