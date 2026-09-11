import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { BotHost } from '../src/bot/bot.ts';
import { setLogLevel } from '../src/logger.ts';
import { RpcClient } from '../src/rpc/client.ts';
import { FrameDecoder, decodeJson, encodeJson } from '../src/rpc/framing.ts';

/*
Everything below the tools, over a real socket: the bot dials, says hello, is accepted, answers a
call and answers a ping. No game is involved, so a tool that needs one fails as `bot`, which is
the answer the server has to be able to act on.
*/
setLogLevel('error');

interface Fake {
  port: number;
  received: Record<string, unknown>[];
  waitFor: (t: string, predicate?: (message: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
  send: (message: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

async function fakeServer(port = 0): Promise<Fake> {
  const received: Record<string, unknown>[] = [];
  const waiters: { t: string; predicate: (message: Record<string, unknown>) => boolean; resolve: (message: Record<string, unknown>) => void }[] = [];
  let link: net.Socket | null = null;

  const server = net.createServer((socket) => {
    link = socket;
    const decoder = new FrameDecoder();

    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        const message = decodeJson(frame);
        received.push(message);

        for (const waiter of [...waiters]) {
          if (waiter.t === message.t && waiter.predicate(message)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(message);
          }
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port: (server.address() as net.AddressInfo).port,
    received,
    waitFor: (t, predicate = () => true) => {
      const already = received.find((message) => message.t === t && predicate(message));

      if (already) {
        return Promise.resolve(already);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${t} frame arrived`)), 5_000);
        waiters.push({
          t,
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
    send: (message) => link?.write(encodeJson(message)),
    close: () => new Promise((resolve) => {
      link?.destroy();
      server.close(() => resolve());
    }),
  };
}

function clientFor(fake: Fake, bot: BotHost): RpcClient {
  return new RpcClient(
    {
      host: '127.0.0.1',
      port: fake.port,
      botName: 'test-bot',
      kind: 'mineflayer',
      agentVersion: '0.0.0-test',
      mcVersion: 'auto',
      reconnectMinMs: 20,
      reconnectMaxMs: 40,
    },
    bot,
  );
}

test('the bot dials, introduces itself and takes a call to a result', async (t) => {
  const fake = await fakeServer();
  const bot = new BotHost();
  const client = clientFor(fake, bot);

  t.after(async () => {
    client.stop();
    await fake.close();
  });

  client.start();

  const hello = await fake.waitFor('hello');

  assert.deepEqual(hello.protocols, [1]);
  assert.equal(hello.botName, 'test-bot');
  assert.equal(hello.kind, 'mineflayer');
  assert.ok((hello.capabilities as unknown[]).length > 0);

  fake.send({
    t: 'helloOk',
    protocol: 1,
    sessionId: 's1',
    heartbeatMs: 5_000,
    repeatFlushMs: 1_000,
    acceptedTools: [],
    rejectedTools: [],
  });

  /* Accepting the link makes the bot say where it stands before anyone asks. */
  await fake.waitFor('status');
  assert.equal(client.linked, true);

  fake.send({ t: 'call', id: 'c1', tool: 'get-position', args: {}, deadlineMs: 1_000 });

  const result = await fake.waitFor('result', (message) => message.id === 'c1');

  assert.equal(result.ok, false);
  assert.equal((result.error as { class: string }).class, 'bot');

  fake.send({ t: 'ping', nonce: 'n1' });

  const pong = await fake.waitFor('pong');

  assert.equal(pong.nonce, 'n1');
  assert.equal(pong.busy, 0);
});

test('a tool the catalogue knows and this bot does not is unsupported, not silence', async (t) => {
  const fake = await fakeServer();
  const bot = new BotHost();
  const client = clientFor(fake, bot);

  t.after(async () => {
    client.stop();
    await fake.close();
  });

  client.start();
  await fake.waitFor('hello');
  fake.send({
    t: 'helloOk',
    protocol: 1,
    sessionId: 's1',
    heartbeatMs: 5_000,
    repeatFlushMs: 1_000,
    acceptedTools: [],
    rejectedTools: [],
  });

  fake.send({ t: 'call', id: 'c1', tool: 'screenshot', args: {}, deadlineMs: 1_000 });

  const result = await fake.waitFor('result', (message) => message.id === 'c1');

  assert.equal((result.error as { class: string }).class, 'unsupported');
});

/*
The whole point of the bot dialling is that it finds the server again on its own. A pod that
needed a human after every mcp-server restart would not survive a rolling update.
*/
test('the bot dials again after the link drops', async (t) => {
  const fake = await fakeServer();
  const bot = new BotHost();
  const client = clientFor(fake, bot);

  t.after(async () => {
    client.stop();
    await fake.close();
  });

  client.start();
  await fake.waitFor('hello');
  assert.equal(fake.received.filter((message) => message.t === 'hello').length, 1);

  fake.send({ t: 'nothing-you-know', reason: 'go away' });
  fake.close().catch(() => undefined);

  const second = await fakeServerOn(fake.port);

  t.after(() => second.close());

  await second.waitFor('hello');
});

/* Rebinds the port the client is already retrying, so the reconnect has something to find. */
async function fakeServerOn(port: number): Promise<Fake> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await fakeServer(port);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(`could not take port ${port} back`);
}
