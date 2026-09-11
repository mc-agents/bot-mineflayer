import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_NAMES, capabilities, unhashedTools, unimplementedTools } from '../src/rpc/catalog.ts';
import { WIRE_SCHEMA_HASHES } from '../src/rpc/catalog-hashes.ts';

/*
The list is written out rather than counted. A tool that quietly stops being registered is
invisible in a count, and "the bot no longer does X" is exactly the failure this catches.
*/
const EXPECTED = [
  'activate-block',
  'attack-entity',
  'can-craft',
  'click-slot',
  'close-window',
  'complete-command',
  'craft-item',
  'dig-block',
  'drop-held-item',
  'equip-item',
  'find-blocks',
  'find-entity',
  'find-item',
  'fish',
  'fly-to',
  'get-block-info',
  'get-player-state',
  'get-position',
  'get-recipe',
  'get-world-state',
  'give-item',
  'interact-entity',
  'jump',
  'list-inventory',
  'list-recipes',
  'look-at',
  'move-in-direction',
  'move-to-position',
  'open-container',
  'place-block',
  'read-block-entity',
  'read-boss-bars',
  'read-displays',
  'read-player-list',
  'read-scoreboard',
  'read-window',
  'send-chat',
  'set-stance',
  'smelt-item',
  'use-held-item',
  'wait-for-window',
  'wait-ticks',
];

test('the bot implements exactly the tools it is meant to', () => {
  assert.deepEqual([...TOOL_NAMES], EXPECTED);
});

/*
The catalogue has 44 tools routed to a bot; two of them are fabric's. Being unable and being
unwritten look the same to the server, so the gap has to be deliberate rather than discovered.
*/
test('nothing in the catalogue is left unimplemented by accident', () => {
  assert.deepEqual(unimplementedTools(), []);
});

test('every tool reports a hash that came from the catalogue, not from the bot', () => {
  assert.deepEqual(unhashedTools(), []);

  for (const { tool, argsHash } of capabilities()) {
    assert.equal(argsHash, WIRE_SCHEMA_HASHES[tool]);
    assert.match(argsHash, /^sha256:[0-9a-f]{64}$/);
  }
});

test('capabilities cover every implemented tool', () => {
  assert.deepEqual(capabilities().map((one) => one.tool), EXPECTED);
});
