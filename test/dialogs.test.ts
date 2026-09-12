import assert from 'node:assert/strict';
import test from 'node:test';
import { DialogRegistry, dialogTitle, plainDialog } from '../src/minecraft/dialogs.ts';
import type { DialogRegistryClient } from '../src/minecraft/dialogs.ts';

function nbt(value: string): unknown {
  return { type: 'string', value };
}

function compound(value: Record<string, unknown>): unknown {
  return { type: 'compound', value };
}

function list(values: unknown[]): unknown {
  return { type: 'list', value: { type: 'compound', value: values } };
}

function fakeClient(): { client: DialogRegistryClient; emit: (packet: unknown) => void } {
  let listener: ((packet: never) => void) | undefined;

  const client: DialogRegistryClient = {
    on: (_event, handler) => {
      listener = handler;
      return client;
    },
  };

  return {
    client,
    emit: (packet) => {
      assert.ok(listener, 'no registry_data listener was registered');
      listener(packet as never);
    },
  };
}

/*
The dialog travels as the game serialises it, with the NBT wrappers taken off: mcp-server reads the
parts worth reading and writes the line. What this holds is that the shape survives the unwrapping,
because a reader on the other side is looking for those field names.
*/
test('a dialog is unwrapped to the shape the game serialises it in', () => {
  const dialog = compound({
    type: nbt('minecraft:multi_action'),
    title: nbt('Notice'),
    body: list([
      { type: nbt('minecraft:plain_message'), contents: nbt('Cast from the bank only') },
      { type: nbt('minecraft:plain_message'), contents: nbt('Bait required') },
    ]),
    actions: list([{ label: nbt('Got it') }, { label: nbt('Later') }]),
    inputs: list([{ key: nbt('name') }]),
  });

  assert.deepEqual(plainDialog(dialog), {
    type: 'minecraft:multi_action',
    title: 'Notice',
    body: [
      { type: 'minecraft:plain_message', contents: 'Cast from the bank only' },
      { type: 'minecraft:plain_message', contents: 'Bait required' },
    ],
    actions: [{ label: 'Got it' }, { label: 'Later' }],
    inputs: [{ key: 'name' }],
  });
});

/* A title is drawn in the pack's own fonts on a real server, so it has to survive as a component
   rather than as the string this bot would have made of it. */
test('a styled title keeps its pieces and their fonts', () => {
  const title = compound({
    text: nbt(''),
    extra: list([
      { font: nbt('server:space'), text: nbt('') },
      { font: nbt('server:dialog/head'), text: nbt('Shop') },
    ]),
  });

  assert.deepEqual(plainDialog(compound({ title }))?.title, {
    text: '',
    extra: [{ font: 'server:space', text: '' }, { font: 'server:dialog/head', text: 'Shop' }],
  });
});

/* The fallback text only, for a bot that sent no dialog: the line itself is mcp-server's. */
test('the title is what the feed falls back to', () => {
  assert.equal(dialogTitle(plainDialog(compound({ title: nbt('§aNotice') }))), 'Notice');
  assert.equal(dialogTitle(null), '');
});

test('nothing to read is null rather than an empty dialog', () => {
  assert.equal(plainDialog(undefined), null);
  assert.equal(plainDialog(null), null);
});

/*
The bug this module exists for. `/dialog show` names a dialog the datapack declared, so the packet
carries an index into the registry and nothing else: reading only the inline shape left the feed
saying the server had not sent a dialog while one was on the screen.
*/
test('a dialog named by registry index is resolved to the one the server sent', () => {
  const { client, emit } = fakeClient();
  const registry = new DialogRegistry();

  registry.attach(client);
  emit({
    id: 'minecraft:dialog',
    entries: [
      { key: 'mcagents:check', value: compound({ title: nbt('Bot check') }) },
      { key: 'minecraft:quick_actions', value: compound({ title: nbt('Quick Actions') }) },
    ],
  });

  assert.equal(registry.size, 2);
  assert.equal(plainDialog(registry.resolve({ dialog: 0 }))?.title, 'Bot check');
  assert.equal(plainDialog(registry.resolve({ dialog: 1 }))?.title, 'Quick Actions');
});

test('a definition sent inline is used as it is', () => {
  const registry = new DialogRegistry();

  assert.equal(
    plainDialog(registry.resolve({ data: compound({ title: nbt('Inline') }) }))?.title,
    'Inline',
  );
});

test('an index the bot was never sent resolves to nothing rather than to the wrong dialog', () => {
  const { client, emit } = fakeClient();
  const registry = new DialogRegistry();

  registry.attach(client);
  emit({ id: 'minecraft:dialog', entries: [{ key: 'a', value: compound({ title: nbt('A') }) }] });

  assert.equal(registry.resolve({ dialog: 7 }), null);
  assert.equal(registry.resolve({}), null);
});

/* Every registry crosses the wire on the same packet, and only one of them is this one. */
test('another registry does not become the dialog registry', () => {
  const { client, emit } = fakeClient();
  const registry = new DialogRegistry();

  registry.attach(client);
  emit({ id: 'minecraft:chat_type', entries: [{ key: 'chat', value: compound({}) }] });

  assert.equal(registry.size, 0);
});
