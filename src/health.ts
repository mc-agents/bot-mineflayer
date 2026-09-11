import http from 'node:http';
import { describeError, log } from './logger.ts';

export interface HealthSnapshot {
  version: string;
  botName: string;
  kind: string;
  /* Linked to mcp-server. Readiness hangs on this, because a bot nobody can call is no use. */
  linked: boolean;
  gameState: string;
  inFlight: number;
  results: Record<string, number>;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/*
Five numbers, so a text exposition by hand is smaller than the client library that would produce
it. Anything that needs a histogram belongs in mcp-server, which sees every call anyway.
*/
export function renderMetrics(snapshot: HealthSnapshot): string {
  const labels = `bot="${escapeLabel(snapshot.botName)}",kind="${escapeLabel(snapshot.kind)}"`;
  const lines = [
    '# HELP bot_build_info Always 1, labelled with the running version',
    '# TYPE bot_build_info gauge',
    `bot_build_info{${labels},version="${escapeLabel(snapshot.version)}"} 1`,
    '# HELP bot_linked Whether the bot holds a link to mcp-server',
    '# TYPE bot_linked gauge',
    `bot_linked{${labels}} ${snapshot.linked ? 1 : 0}`,
    '# HELP bot_game_state Which state the game connection is in',
    '# TYPE bot_game_state gauge',
  ];

  for (const state of ['connecting', 'ready', 'disconnected', 'faulted']) {
    lines.push(`bot_game_state{${labels},state="${state}"} ${snapshot.gameState === state ? 1 : 0}`);
  }

  lines.push(
    '# HELP bot_calls_in_flight Tool calls the bot is running right now',
    '# TYPE bot_calls_in_flight gauge',
    `bot_calls_in_flight{${labels}} ${snapshot.inFlight}`,
    '# HELP bot_results_total Tool results sent, split by how they ended',
    '# TYPE bot_results_total counter',
  );

  for (const [outcome, count] of Object.entries(snapshot.results)) {
    lines.push(`bot_results_total{${labels},outcome="${escapeLabel(outcome)}"} ${count}`);
  }

  return `${lines.join('\n')}\n`;
}

export function startHealthServer(
  bind: { host: string; port: number },
  snapshot: () => HealthSnapshot,
): http.Server {
  const server = http.createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const now = snapshot();

    if (path === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
      return;
    }

    if (path === '/readyz') {
      const ready = now.linked;
      response
        .writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' })
        .end(ready ? 'ready\n' : 'not linked to mcp-server\n');
      return;
    }

    if (path === '/metrics') {
      response
        .writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
        .end(renderMetrics(now));
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
  });

  server.on('error', (error) => {
    log('error', 'the health server failed', { error: describeError(error) });
  });

  server.listen(bind.port, bind.host, () => {
    log('info', 'health server listening', { address: `${bind.host}:${bind.port}` });
  });

  return server;
}
