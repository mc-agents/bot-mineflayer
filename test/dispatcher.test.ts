import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod';
import type { Bot } from 'mineflayer';
import { ScoreTracker } from '../src/minecraft/scoreboard.ts';
import { Dispatcher } from '../src/rpc/dispatcher.ts';
import { botError } from '../src/rpc/protocol.ts';
import type { CallMessage, ResultMessage } from '../src/rpc/protocol.ts';
import { defineTool } from '../src/rpc/tool.ts';

const STUB_BOT = {} as Bot;

function harness(tools = sampleTools(), requireBot: () => Bot = () => STUB_BOT) {
  const results: ResultMessage[] = [];
  const dispatcher = new Dispatcher(
    new Map(tools.map((tool) => [tool.name, tool])),
    { requireBot, username: 'tester', scores: new ScoreTracker() },
    (result) => results.push(result),
  );

  return { dispatcher, results };
}

function call(tool: string, args: Record<string, unknown> = {}, deadlineMs = 1_000): CallMessage {
  return { t: 'call', id: `id-${tool}`, tool, args, deadlineMs };
}

let release: (value: string) => void = () => undefined;

function sampleTools() {
  return [
    defineTool('echo', 'repeat a word', { word: z.string() }, (args) => `said ${args.word}`),
    defineTool('refuse', 'refuse', {}, () => {
      throw new Error('no window is open');
    }),
    defineTool('crash', 'crash', {}, () => {
      throw new TypeError('cannot read properties of undefined');
    }),
    /* dig-block is exclusive in the catalogue, so it is what the exclusivity tests hold. */
    defineTool('dig-block', 'hold the bot', {}, () => new Promise<string>((resolve) => {
      release = resolve;
    })),
    defineTool('place-block', 'also exclusive', {}, () => 'placed'),
  ];
}

test('a tool that answers sends one result carrying its text', async () => {
  const { dispatcher, results } = harness();

  dispatcher.call(call('echo', { word: 'hi' }));
  await new Promise(setImmediate);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.ok, true);
  assert.equal(results[0]!.text, 'said hi');
});

/*
The class is what tells mcp-server whether to keep the session, so a game that said no and a bot
that has a bug in it must not arrive looking the same.
*/
test('the game refusing is a tool error, a bug in the bot is an internal one', async () => {
  const { dispatcher, results } = harness();

  dispatcher.call(call('refuse'));
  dispatcher.call(call('crash'));
  await new Promise(setImmediate);

  assert.equal(results[0]!.error?.class, 'tool');
  assert.equal(results[0]!.error?.message, 'no window is open');
  assert.equal(results[1]!.error?.class, 'internal');
});

test('arguments the bot cannot read fail as args, which disables only that tool', async () => {
  const { dispatcher, results } = harness();

  dispatcher.call(call('echo', { word: 42 }));
  await new Promise(setImmediate);

  assert.equal(results[0]!.error?.class, 'args');
  assert.match(results[0]!.error!.message, /^echo could not read its arguments/);
});

test('a tool named by nobody is unsupported rather than a failure of the game', async () => {
  const { dispatcher, results } = harness();

  dispatcher.call(call('screenshot'));
  await new Promise(setImmediate);

  assert.equal(results[0]!.error?.class, 'unsupported');
});

test('a bot that is not in a game fails as bot, so waiters are abandoned rather than blamed', async () => {
  const { dispatcher, results } = harness(sampleTools(), () => {
    throw botError('BOT_NOT_READY', 'the bot is disconnected');
  });

  dispatcher.call(call('echo', { word: 'hi' }));
  await new Promise(setImmediate);

  assert.equal(results[0]!.error?.class, 'bot');
});

test('a call past its deadline answers timeout and the tool finishing later changes nothing', async () => {
  const { dispatcher, results } = harness();

  dispatcher.call(call('dig-block', {}, 20));
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(results.length, 1);
  assert.equal(results[0]!.error?.class, 'timeout');
  assert.match(results[0]!.error!.message, /dig-block did not finish within 20ms/);

  release('dug it after all');
  await new Promise(setImmediate);

  assert.equal(results.length, 1, 'exactly one result per call id');
  assert.equal(dispatcher.busy, 0);
});

test('a cancel is answered as cancelled and frees the bot for the next call', async () => {
  const { dispatcher, results } = harness();

  dispatcher.call(call('dig-block', {}, 10_000));
  dispatcher.cancel('id-dig-block', 'the caller went away');
  await new Promise(setImmediate);

  assert.equal(results[0]!.error?.class, 'cancelled');
  assert.equal(dispatcher.busy, 0);

  release('done');
});

test('a cancel for an id nobody holds is ignored, since it races a completing call', () => {
  const { dispatcher, results } = harness();

  dispatcher.cancel('id-nothing', 'too late');

  assert.deepEqual(results, []);
});

test('the second exclusive tool is refused outright instead of queued behind the first', async () => {
  const { dispatcher, results } = harness();

  dispatcher.call(call('dig-block', {}, 10_000));
  dispatcher.call(call('place-block'));
  await new Promise(setImmediate);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.error?.code, 'BOT_BUSY');
  assert.equal(results[0]!.error?.retryable, true);

  release('done');
});

test('a tool that touches nothing runs while an exclusive one is still going', async () => {
  const { dispatcher, results } = harness();

  dispatcher.call(call('dig-block', {}, 10_000));
  dispatcher.call(call('echo', { word: 'meanwhile' }));
  await new Promise(setImmediate);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.ok, true);

  release('done');
});

test('a link that goes away still answers everything it was holding', async () => {
  const { dispatcher, results } = harness();

  dispatcher.call(call('dig-block', {}, 10_000));
  dispatcher.abandonAll('the link to mcp-server closed');
  await new Promise(setImmediate);

  assert.equal(results[0]!.error?.class, 'bot');
  assert.equal(dispatcher.busy, 0);

  release('done');
});
