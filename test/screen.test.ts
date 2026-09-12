import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { soundName } from '../src/minecraft/screen.ts';

function botWithSounds(sounds: Record<number, { name: string }>): Bot {
  return { registry: { sounds } } as unknown as Bot;
}

const REGISTRY = botWithSounds({ 147: { name: 'block.basalt.fall' } });

/* An id is namespaced, per the protocol document, and the registry hands out the bare path. */
test('a sound arrives either as a registry index or as its own name, namespaced either way', () => {
  assert.equal(soundName(REGISTRY, { soundId: 147 }), 'minecraft:block.basalt.fall');
  assert.equal(soundName(REGISTRY, 147), 'minecraft:block.basalt.fall');
  assert.equal(
    soundName(REGISTRY, { data: { soundName: 'minecraft:replaced.block.wood.step' } }),
    'minecraft:replaced.block.wood.step',
  );
});

test('an index the registry does not know still identifies itself', () => {
  assert.equal(soundName(REGISTRY, { soundId: 9999 }), 'sound #9999');
  assert.equal(soundName(REGISTRY, undefined), '');
});
