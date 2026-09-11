#!/usr/bin/env node
import net from 'node:net';
import readline from 'node:readline';
import { FrameDecoder, decodeJson, encodeJson } from '../src/rpc/framing.ts';
import { FRAME_JSON } from '../src/rpc/protocol.ts';

/*
Stands in for mcp-server so the bot can be driven by hand. It listens, says hello back to
whatever dials in, and sends whatever is typed at it. It does not normalise arguments the way the
real server does, which is the point: a tool called with half its arguments is how the bot's
defensive decoding gets exercised.
*/

const PORT = Number(process.env.RPC_PORT ?? 8765);
const HOST = process.env.RPC_HOST ?? '0.0.0.0';

const HELP = `
  connect <host> <port> <username> [version]   join a game
  disconnect [reason]                          leave the game, keep the process
  call <tool> [json]                           call a tool, or just: <tool> [json]
  cancel <id> [reason]                         cancel a call in flight
  ping                                         round-trip the link
  configure <json>                             send a configure frame
  shutdown [reason]                            ask the bot to exit
  tools [filter]                               list what the bot reported
  events on|off                                show or hide the event feed
  quit                                         stop this CLI
`;

interface Link {
  socket: net.Socket;
  name: string;
  tools: string[];
}

let link: Link | null = null;
let showEvents = true;
let nextId = 1;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
  rl.prompt();
}

function send(message: Record<string, unknown>): void {
  if (!link) {
    out('no bot is linked yet');
    return;
  }

  link.socket.write(encodeJson(message));
}

function summarise(message: Record<string, unknown>): void {
  switch (message.t) {
    case 'result': {
      const head = message.ok === true ? 'ok' : `FAILED [${(message.error as { class?: string })?.class}]`;
      out(`< result ${String(message.id)} ${head} (${String(message.elapsedMs)}ms)\n${String(message.text)}`);
      return;
    }
    case 'event':
      if (showEvents) {
        out(`< event #${String(message.seq)} ${String(message.kind)}/${String(message.source)}` +
          `${message.closed === true ? ' [closed]' : ''} x${String(message.repeats)}: ${String(message.text)}`);
      }
      return;
    case 'status':
      out(`< status ${String(message.state)}${message.reason === undefined ? '' : ` (${String(message.reason)})`}` +
        `${message.position === undefined ? '' : ` at ${JSON.stringify(message.position)}`}`);
      return;
    case 'pong':
      out(`< pong ${String(message.nonce)} busy=${String(message.busy)}`);
      return;
    case 'log':
      out(`< log [${String(message.level)}] ${String(message.message)}`);
      return;
    default:
      out(`< ${JSON.stringify(message)}`);
  }
}

function greet(socket: net.Socket, hello: Record<string, unknown>): void {
  const capabilities = (hello.capabilities ?? []) as { tool: string }[];

  link = {
    socket,
    name: String(hello.botName),
    tools: capabilities.map((one) => one.tool).sort(),
  };

  out(`< hello from ${link.name} (${String(hello.kind)} ${String(hello.agentVersion)}, ` +
    `catalogue ${String(hello.catalogVersion)}, ${link.tools.length} tools)`);

  socket.write(encodeJson({
    t: 'helloOk',
    protocol: 1,
    sessionId: `cli-${Date.now().toString(36)}`,
    heartbeatMs: 5_000,
    repeatFlushMs: 1_000,
    limits: {},
    acceptedTools: link.tools,
    rejectedTools: [],
  }));
}

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  const decoder = new FrameDecoder();
  let greeted = false;

  socket.on('data', (chunk) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.type !== FRAME_JSON) {
        out(`< blob frame, ${frame.payload.length} bytes`);
        continue;
      }

      const message = decodeJson(frame);

      if (!greeted && message.t === 'hello') {
        greeted = true;
        greet(socket, message);
        continue;
      }

      summarise(message);
    }
  });

  socket.on('error', (error) => out(`link error: ${error.message}`));
  socket.once('close', () => {
    out('the bot went away');
    link = null;
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`listening for a bot on ${HOST}:${PORT}\ntype "help" for what this understands\n`);
  rl.prompt();
});

function call(tool: string, raw: string | undefined, deadlineMs: number): void {
  let args: Record<string, unknown> = {};

  if (raw !== undefined && raw.trim() !== '') {
    try {
      args = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      out(`that is not JSON: ${(error as Error).message}`);
      return;
    }
  }

  const id = `c${nextId}`;
  nextId += 1;
  out(`> call ${id} ${tool} ${JSON.stringify(args)}`);
  send({ t: 'call', id, tool, args, deadlineMs });
}

function run(line: string): void {
  const [verb, ...rest] = line.trim().split(/\s+/);
  const tail = line.trim().slice((verb ?? '').length).trim();

  switch (verb) {
    case undefined:
    case '':
      rl.prompt();
      return;
    case 'help':
      out(HELP);
      return;
    case 'quit':
    case 'exit':
      process.exit(0);
      return;
    case 'events':
      showEvents = rest[0] !== 'off';
      out(`events ${showEvents ? 'on' : 'off'}`);
      return;
    case 'tools': {
      const filter = rest[0] ?? '';
      const listed = (link?.tools ?? []).filter((tool) => tool.includes(filter));
      out(listed.length === 0 ? 'nothing matches' : listed.join('\n'));
      return;
    }
    case 'connect': {
      const [host, port, username, version] = rest;
      if (host === undefined || port === undefined || username === undefined) {
        out('connect <host> <port> <username> [version]');
        return;
      }
      const id = `j${nextId}`;
      nextId += 1;
      send({
        t: 'connect',
        id,
        host,
        port: Number(port),
        username,
        ...(version === undefined ? {} : { version }),
        spawnTimeoutMs: 30_000,
      });
      out(`> connect ${id} ${host}:${port} as ${username}`);
      return;
    }
    case 'disconnect': {
      const id = `d${nextId}`;
      nextId += 1;
      send({ t: 'disconnect', id, reason: tail === '' ? 'asked by the CLI' : tail });
      return;
    }
    case 'cancel': {
      const [id, ...reason] = rest;
      if (id === undefined) {
        out('cancel <id> [reason]');
        return;
      }
      send({ t: 'cancel', id, reason: reason.join(' ') || 'asked by the CLI' });
      return;
    }
    case 'ping':
      send({ t: 'ping', nonce: `n${Date.now().toString(36)}` });
      return;
    case 'shutdown':
      send({ t: 'shutdown', reason: tail === '' ? 'asked by the CLI' : tail, graceMs: 2_000 });
      return;
    case 'configure':
      try {
        send({ t: 'configure', ...(JSON.parse(tail) as Record<string, unknown>) });
      } catch (error) {
        out(`that is not JSON: ${(error as Error).message}`);
      }
      return;
    case 'call': {
      const [tool] = rest;
      if (tool === undefined) {
        out('call <tool> [json]');
        return;
      }
      call(tool, tail.slice(tool.length).trim(), 60_000);
      return;
    }
    default:
      call(verb, tail, 60_000);
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });

rl.on('line', (line) => {
  run(line);
  rl.prompt();
});

rl.on('close', () => process.exit(0));
