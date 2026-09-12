import net from 'node:net';
import type { BotHost } from '../bot/bot.ts';
import { JoinError } from '../bot/bot.ts';
import { describeError, log } from '../logger.ts';
import { CATALOG_VERSION, TOOLS, capabilities } from './catalog.ts';
import { Dispatcher } from './dispatcher.ts';
import { DEFAULT_REPEAT_FLUSH_MS, EventFolder } from './events.ts';
import { FrameDecoder, decodeJson, encodeJson } from './framing.ts';
import { FRAME_JSON, PROTOCOL_VERSION } from './protocol.ts';
import type {
  BotMessage,
  CallMessage,
  ConnectMessage,
  DisconnectMessage,
  HelloOkMessage,
  ResultMessage,
  ServerMessage,
} from './protocol.ts';

const FEATURES = ['eventFold'];

export interface ClientOptions {
  host: string;
  port: number;
  botName: string;
  kind: string;
  agentVersion: string;
  mcVersion: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
}

function backoff(attempt: number, minMs: number, maxMs: number): number {
  const window = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 10));
  /* Jitter so a whole pool of bots restarted together does not dial in lockstep. */
  return Math.round(window / 2 + Math.random() * (window / 2));
}

export class RpcClient {
  readonly dispatcher: Dispatcher;

  private readonly options: ClientOptions;
  private readonly bot: BotHost;
  private readonly events = new EventFolder();
  private socket: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private session: string | null = null;
  private attempt = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: ClientOptions, bot: BotHost) {
    this.options = options;
    this.bot = bot;
    this.dispatcher = new Dispatcher(
      TOOLS,
      { requireBot: () => bot.requireBot(), get username() { return bot.username; }, scores: bot.scores, recipes: bot.recipes },
      (result) => this.write(result),
    );

    bot.on('event', (event) => {
      for (const message of this.events.accept(event)) {
        this.write(message);
      }
    });

    bot.on('status', (status) => this.write(status));
  }

  get linked(): boolean {
    return this.session !== null;
  }

  get sessionId(): string | null {
    return this.session;
  }

  start(): void {
    this.stopped = false;
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.destroy();
    this.socket = null;
    this.session = null;
  }

  private clearTimers(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private dial(): void {
    if (this.stopped) {
      return;
    }

    const socket = net.createConnection({ host: this.options.host, port: this.options.port });
    /* The latency of a frame is the latency of a tool, so nothing waits for Nagle. */
    socket.setNoDelay(true);
    this.socket = socket;
    this.decoder = new FrameDecoder();

    socket.once('connect', () => {
      this.attempt = 0;
      log('info', 'linked to mcp-server', { address: `${this.options.host}:${this.options.port}` });
      this.events.reset();
      this.sendHello();
    });

    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', (error) => {
      log('warn', 'rpc link error', { error: describeError(error) });
    });
    socket.once('close', () => this.dropped());
  }

  private dropped(): void {
    if (this.socket === null) {
      return;
    }

    this.socket = null;
    this.session = null;
    this.clearTimers();
    this.dispatcher.abandonAll('the link to mcp-server closed');

    if (this.stopped) {
      return;
    }

    const wait = backoff(this.attempt, this.options.reconnectMinMs, this.options.reconnectMaxMs);
    this.attempt += 1;
    log('info', 'reconnecting to mcp-server', { inMs: wait, attempt: this.attempt });
    this.retryTimer = setTimeout(() => this.dial(), wait);
  }

  private write(message: BotMessage): void {
    const socket = this.socket;

    if (!socket || socket.destroyed) {
      return;
    }

    try {
      socket.write(encodeJson(message));
    } catch (error) {
      log('warn', 'could not write a frame', { t: message.t, error: describeError(error) });
      socket.destroy();
    }
  }

  private sendHello(): void {
    this.write({
      t: 'hello',
      protocols: [PROTOCOL_VERSION],
      botName: this.options.botName,
      kind: this.options.kind,
      agentVersion: this.options.agentVersion,
      mcVersion: this.options.mcVersion,
      catalogVersion: CATALOG_VERSION,
      capabilities: capabilities(),
      features: FEATURES,
    });
  }

  private receive(chunk: Buffer): void {
    let frames;

    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      log('error', 'the link sent something unreadable', { error: describeError(error) });
      this.socket?.destroy();
      return;
    }

    for (const frame of frames) {
      if (frame.type !== FRAME_JSON) {
        log('error', 'the server sent a non-JSON frame', { type: frame.type });
        this.socket?.destroy();
        return;
      }

      try {
        this.handle(decodeJson(frame) as unknown as ServerMessage);
      } catch (error) {
        log('error', 'could not read a frame', { error: describeError(error) });
        this.socket?.destroy();
        return;
      }
    }
  }

  private handle(message: ServerMessage): void {
    switch (message.t) {
      case 'helloOk':
        this.accepted(message);
        return;
      case 'helloErr':
        log('error', 'mcp-server refused the link', { code: message.code, message: message.message });
        this.socket?.destroy();
        return;
      case 'connect':
        void this.join(message);
        return;
      case 'call':
        this.dispatcher.call(message as CallMessage);
        return;
      case 'cancel':
        this.dispatcher.cancel(message.id, message.reason);
        return;
      case 'disconnect':
        this.leave(message);
        return;
      case 'shutdown':
        log('info', 'mcp-server asked the bot to shut down', { reason: message.reason });
        this.bot.quit(message.reason);
        this.stop();
        setTimeout(() => process.exit(0), Math.min(message.graceMs, 5_000)).unref();
        return;
      case 'ping':
        this.write({ t: 'pong', nonce: message.nonce, ts: Date.now(), busy: this.dispatcher.busy });
        return;
      case 'fault':
        log('error', 'mcp-server closed the link on a protocol fault',
          { code: message.code, message: message.message });
        this.socket?.destroy();
        return;
      default:
        log('warn', 'unknown message from mcp-server', { t: (message as { t: string }).t });
    }
  }

  private accepted(message: HelloOkMessage): void {
    this.session = message.sessionId;
    this.events.configure({
      events: message.events,
      repeatFlushMs: message.repeatFlushMs ?? DEFAULT_REPEAT_FLUSH_MS,
    });

    log('info', 'hello accepted', {
      sessionId: message.sessionId,
      accepted: message.acceptedTools?.length ?? 0,
      rejected: message.rejectedTools ?? [],
    });

    if ((message.rejectedTools ?? []).length > 0) {
      log('warn', 'the catalogue disagrees about these tools', { tools: message.rejectedTools });
    }

    this.write(this.bot.status('linked'));
    this.startFlushing(message.repeatFlushMs ?? DEFAULT_REPEAT_FLUSH_MS);
  }

  /*
  An open run is re-sent on a timer, not only when the server redraws it, so "how long has this
  been showing" stays true even for a HUD line the server stopped repeating.
  */
  private startFlushing(everyMs: number): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    this.flushTimer = setInterval(() => {
      for (const message of this.events.tick()) {
        this.write(message);
      }
    }, Math.max(everyMs, 100));

    this.flushTimer.unref();
  }

  private result(id: number, text: string, startedAt: number): ResultMessage {
    return { t: 'result', id, ok: true, text, elapsedMs: Date.now() - startedAt };
  }

  private async join(message: ConnectMessage): Promise<void> {
    const startedAt = Date.now();

    try {
      await this.bot.join({
        host: message.host,
        port: message.port,
        username: message.username,
        version: message.version,
        spawnTimeoutMs: message.spawnTimeoutMs,
      });

      this.write(this.result(message.id, `Joined ${message.host}:${message.port} as ${message.username}.`, startedAt));
    } catch (error) {
      const stage = error instanceof JoinError ? error.stage : 'dial';

      this.write({
        t: 'result',
        id: message.id,
        ok: false,
        text: describeError(error),
        error: {
          class: 'bot',
          code: `JOIN_FAILED_${stage.toUpperCase()}`,
          message: describeError(error),
          retryable: stage !== 'login',
          detail: { stage },
        },
        elapsedMs: Date.now() - startedAt,
      });
    }
  }

  private leave(message: DisconnectMessage): void {
    const startedAt = Date.now();

    for (const closed of this.events.closeAll()) {
      this.write(closed);
    }

    this.bot.quit(message.quitMessage ?? message.reason);
    this.write(this.result(message.id, `Left the game: ${message.reason}.`, startedAt));
  }
}
