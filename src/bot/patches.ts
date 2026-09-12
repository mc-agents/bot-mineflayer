import minecraftData from 'minecraft-data';
import type { Bot } from 'mineflayer';
import { log } from '../logger.ts';

const ACCEPTED = 3;
const SUCCESSFULLY_LOADED = 0;

export interface ResourcePackClient {
  on: (event: 'add_resource_pack', listener: (data: { uuid: string }) => void) => unknown;
  write: (name: string, params: unknown) => void;
}

export function acceptResourcePacks(client: ResourcePackClient, botName: string): void {
  client.on('add_resource_pack', (data) => {
    client.write('resource_pack_receive', { uuid: data.uuid, result: ACCEPTED });
    client.write('resource_pack_receive', { uuid: data.uuid, result: SUCCESSFULLY_LOADED });
    log('debug', 'accepted resource pack', { bot: botName, uuid: data.uuid });
  });
}

/*
The stack inside a recipe display is written item first and count second, and minecraft-data points
that field at `Slot`, which is written count first because a count of zero is how an empty slot is
spelt. Nothing errors: the two varints simply swap, so a recipe for four sticks read as recipe 947
for one stick, and an index of recipes by result named the wrong item for every entry.

Only the one field is named here rather than the whole of SlotDisplay, so a version that adds a
variant to it keeps working.
*/
const RECIPE_STACK = 'SlotDisplayStack';

interface ProtocolType {
  name?: string;
  type?: unknown;
}

type Switch = ['switch', { compareTo: string; fields: Record<string, unknown> }];

function resultFields(types: Record<string, unknown>): Record<string, unknown> | null {
  const display = types.SlotDisplay;

  if (!Array.isArray(display) || !Array.isArray(display[1])) {
    return null;
  }

  const data = (display[1] as ProtocolType[]).find((field) => field.name === 'data');
  const chooser = data?.type as Switch | undefined;

  if (!Array.isArray(chooser) || chooser[0] !== 'switch') {
    return null;
  }

  return chooser[1].fields;
}

const patched = new Set<string>();

export function fixRecipeDisplayStacks(version: string): void {
  if (patched.has(version)) {
    return;
  }
  patched.add(version);

  const data = minecraftData(version);
  const types = data?.protocol?.play?.toClient?.types as Record<string, unknown> | undefined;
  const fields = types === undefined ? null : resultFields(types);

  if (types === undefined || fields === null || fields.item_stack === undefined) {
    log('debug', 'no recipe display stack to correct', { version });
    return;
  }

  types[RECIPE_STACK] = ['container', [
    { name: 'itemId', type: 'varint' },
    { name: 'itemCount', type: 'varint' },
    { name: 'addedComponentCount', type: 'varint' },
    { name: 'removedComponentCount', type: 'varint' },
    { name: 'components', type: ['array', { count: 'addedComponentCount', type: 'SlotComponent' }] },
    {
      name: 'removeComponents',
      type: ['array', {
        count: 'removedComponentCount',
        type: ['container', [{ name: 'type', type: 'SlotComponentType' }]],
      }],
    },
  ]];
  fields.item_stack = RECIPE_STACK;
}

interface Versioned {
  version: string;
  setSerializer: (state: string) => void;
}

/*
The protocol is compiled once per state, from minecraft-data as it stands at that moment, and the
version is only settled after the handshake when the caller did not name one. Correcting it here
means it is corrected for whichever version this connection turns out to speak, before the packets
of the play state are read.
*/
function correctOnEachState(client: Versioned): void {
  const setSerializer = client.setSerializer.bind(client);

  client.setSerializer = (state) => {
    fixRecipeDisplayStacks(client.version);
    setSerializer(state);
  };
}

export function applyProtocolPatches(bot: Bot, botName: string): void {
  acceptResourcePacks(bot._client as unknown as ResourcePackClient, botName);
  correctOnEachState(bot._client as unknown as Versioned);
}
