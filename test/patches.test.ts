import assert from 'node:assert/strict';
import test from 'node:test';
import minecraftData from 'minecraft-data';
import { acceptResourcePacks, fixRecipeDisplayStacks } from '../src/bot/patches.ts';
import type { ResourcePackClient } from '../src/bot/patches.ts';

function fakeClient(): {
  client: ResourcePackClient;
  writes: [string, unknown][];
  emit: (data: { uuid: string }) => void;
} {
  const writes: [string, unknown][] = [];
  let listener: ((data: { uuid: string }) => void) | undefined;

  const client: ResourcePackClient = {
    on: (_event, handler) => {
      listener = handler;
      return client;
    },
    write: (name, params) => {
      writes.push([name, params]);
    },
  };

  return {
    client,
    writes,
    emit: (data) => {
      assert.ok(listener, 'no add_resource_pack listener was registered');
      listener(data);
    },
  };
}

test('a resource pack offer is answered as accepted then loaded', () => {
  const { client, writes, emit } = fakeClient();

  acceptResourcePacks(client, 'probe');
  emit({ uuid: 'f34a0914-0988-37e0-9077-ba0b67ac3cf2' });

  assert.deepEqual(writes, [
    ['resource_pack_receive', { uuid: 'f34a0914-0988-37e0-9077-ba0b67ac3cf2', result: 3 }],
    ['resource_pack_receive', { uuid: 'f34a0914-0988-37e0-9077-ba0b67ac3cf2', result: 0 }],
  ]);
});

test('the uuid is echoed as the string the server sent, not re-encoded', () => {
  const { client, writes, emit } = fakeClient();

  acceptResourcePacks(client, 'probe');
  emit({ uuid: '00000000-0000-0000-0000-000000000001' });

  for (const [, params] of writes) {
    const { uuid } = params as { uuid: unknown };
    assert.equal(typeof uuid, 'string');
    assert.equal(uuid, '00000000-0000-0000-0000-000000000001');
  }
});

test('every offer is answered, so a second pack does not stall configuration', () => {
  const { client, writes, emit } = fakeClient();

  acceptResourcePacks(client, 'probe');
  emit({ uuid: 'pack-one' });
  emit({ uuid: 'pack-two' });

  assert.deepEqual(writes.map(([, params]) => (params as { uuid: string }).uuid), [
    'pack-one',
    'pack-one',
    'pack-two',
    'pack-two',
  ]);
});

/*
The swap this corrects is silent: both fields are varints, so nothing fails to parse and a recipe
for four sticks reads as recipe 947 for one stick. What can break is the walk through the protocol
definition to the field, which is why it is walked here against the data the bot actually ships.
*/
test('the stack inside a recipe display is read item first, count second', () => {
  fixRecipeDisplayStacks('26.1');

  const types = minecraftData('26.1').protocol.play.toClient.types as Record<string, unknown>;
  const display = types.SlotDisplay as [string, { name?: string; type?: unknown }[]];
  const data = display[1].find((field) => field.name === 'data');
  const fields = (data?.type as ['switch', { fields: Record<string, unknown> }])[1].fields;

  assert.equal(fields.item_stack, 'SlotDisplayStack');

  const stack = types.SlotDisplayStack as [string, { name: string; type: unknown }[]];

  assert.deepEqual(stack[1].slice(0, 2).map((field) => field.name), ['itemId', 'itemCount']);
});

test('correcting a version twice leaves the definition alone the second time', () => {
  fixRecipeDisplayStacks('26.1');
  fixRecipeDisplayStacks('26.1');

  const types = minecraftData('26.1').protocol.play.toClient.types as Record<string, unknown>;
  const stack = types.SlotDisplayStack as [string, { name: string }[]];

  assert.equal(stack[1][0]?.name, 'itemId');
});
