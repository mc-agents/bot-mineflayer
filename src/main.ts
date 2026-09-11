#!/usr/bin/env node
import { createRequire } from 'node:module';
import { BotHost } from './bot/bot.ts';
import { loadConfig } from './config.ts';
import { startHealthServer } from './health.ts';
import { describeError, log, setLogLevel } from './logger.ts';
import { TOOL_NAMES, unhashedTools, unimplementedTools } from './rpc/catalog.ts';
import { RpcClient } from './rpc/client.ts';

const KIND = 'mineflayer';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

const config = loadConfig();
setLogLevel(config.logLevel);

const bot = new BotHost();
const client = new RpcClient(
  {
    host: config.server.host,
    port: config.server.port,
    botName: config.botName,
    kind: KIND,
    agentVersion: pkg.version,
    mcVersion: config.mcVersion,
    reconnectMinMs: config.reconnect.minMs,
    reconnectMaxMs: config.reconnect.maxMs,
  },
  bot,
);

const health = startHealthServer(config.health, () => ({
  version: pkg.version,
  botName: config.botName,
  kind: KIND,
  linked: client.linked,
  gameState: bot.currentState,
  inFlight: client.dispatcher.busy,
  results: client.dispatcher.results,
}));

/*
A tool with no hash in the catalogue is one this bot can run and no server will ever call, which
is a build that forgot to re-run sync-catalog rather than anything the operator can fix at
runtime. Saying so at boot is cheaper than finding out from a tool that is quietly missing.
*/
for (const tool of unhashedTools()) {
  log('warn', 'implemented but absent from the catalogue', { tool });
}

log('info', 'bot starting', {
  version: pkg.version,
  bot: config.botName,
  tools: TOOL_NAMES.length,
  awaiting: unimplementedTools().length,
  server: `${config.server.host}:${config.server.port}`,
});

client.start();

let leaving = false;

function shutdown(signal: string): void {
  if (leaving) {
    return;
  }

  leaving = true;
  log('info', 'shutting down', { signal });
  client.stop();
  bot.quit(`the bot process received ${signal}`);
  health.close();
  setTimeout(() => process.exit(0), 250).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/*
A bot that throws in a packet handler must not take the process with it: mcp-server can only see
`state: disconnected` if something is still alive to report it.
*/
process.on('uncaughtException', (error) => {
  log('error', 'uncaught exception', { error: describeError(error), stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  log('error', 'unhandled rejection', { error: describeError(reason) });
});
