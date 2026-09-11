import assert from 'node:assert/strict';
import test from 'node:test';
import { plainName } from '../src/minecraft/names.ts';

test('the default namespace is dropped, because minecraft-data indexes without it', () => {
  assert.equal(plainName('minecraft:stone'), 'stone');
  assert.equal(plainName('  MINECRAFT:Diamond_Sword '), 'diamond_sword');
  assert.equal(plainName('stone'), 'stone');
});

/* A plugin's id is not in the vanilla registry, and the failure should name what was asked for. */
test('another namespace is kept whole, so the lookup fails on the id the caller gave', () => {
  assert.equal(plainName('hyperfarm:gathering_rod'), 'hyperfarm:gathering_rod');
  assert.equal(plainName('minecraftia:stone'), 'minecraftia:stone');
});
