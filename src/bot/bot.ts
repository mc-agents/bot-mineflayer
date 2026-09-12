import { EventEmitter } from 'node:events';
import mineflayer from 'mineflayer';
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { describeError, log } from '../logger.ts';
import { connectOverride } from '../minecraft/connect.ts';
import { RecipeBook } from '../minecraft/recipe-book.ts';
import type { RecipeBookClient } from '../minecraft/recipe-book.ts';
import { ScoreTracker } from '../minecraft/scoreboard.ts';
import type { PacketSource } from '../minecraft/scoreboard.ts';
import { plainSegments, rawComponentOf, toSegments } from '../minecraft/text.ts';
import { describeDialog, soundName } from '../minecraft/screen.ts';
import { useTranslations } from '../minecraft/text.ts';
import type { SoundPacket } from '../minecraft/screen.ts';
import type { RawEvent } from '../rpc/events.ts';
import { botError } from '../rpc/protocol.ts';
import type { BotState, StatusMessage } from '../rpc/protocol.ts';
import { applyProtocolPatches } from './patches.ts';

const { pathfinder, Movements } = pathfinderPkg;

export interface JoinSpec {
  host: string;
  port: number;
  username: string;
  version: string | undefined;
  spawnTimeoutMs: number;
}

/*
"connection failed" covers a pod that cannot reach the host, a server that refused the login and a
server that took too long, and those three want three different things done about them. The stage
is what separates them, so it rides along with the failure.
*/
export type JoinStage = 'dial' | 'login' | 'spawn';

export class JoinError extends Error {
  readonly stage: JoinStage;

  constructor(stage: JoinStage, message: string) {
    super(message);
    this.name = 'JoinError';
    this.stage = stage;
  }
}

type Events = {
  event: [RawEvent];
  status: [StatusMessage];
};

/*
The protocol library follows the game rather than leading it, and a server newer than the newest
version it speaks fails with a sentence about missing data. That reads like a broken install. What
it means is that this kind of bot cannot talk to that server at all, and that the other kind -- a
real client, handed its protocol by Mojang -- can.
*/
const UNSUPPORTED_VERSION = /No data available for version (\S+)|Unsupported protocol version/i;

function dialFailure(error: Error): string {
  const described = describeError(error);
  const unsupported = UNSUPPORTED_VERSION.exec(described);

  if (unsupported === null) {
    return `could not reach the server: ${described}`;
  }

  return `this bot cannot speak Minecraft ${unsupported[1] ?? 'that version'}. `
    + `Its protocol library stops at ${mineflayer.latestSupportedVersion}, and a server past that `
    + 'is one it has no packets for. A fabric bot is a real client and follows the game; '
    + 'join-server with kind "fabric".';
}

export class BotHost extends EventEmitter<Events> {
  readonly scores = new ScoreTracker();
  readonly recipes = new RecipeBook();

  private bot: Bot | null = null;
  private spec: JoinSpec | null = null;
  private state: BotState = 'idle';
  private lastError: string | null = null;

  get currentState(): BotState {
    return this.state;
  }

  get username(): string {
    return this.spec?.username ?? '';
  }

  get connected(): boolean {
    return this.state === 'ready' && this.bot !== null;
  }

  /*
  Every tool reaches the game through here, so a tool that runs while the bot is between worlds
  fails as `bot` rather than as whatever undefined property it happened to touch first.
  */
  requireBot(): Bot {
    if (this.state !== 'ready' || !this.bot) {
      throw botError(
        'BOT_NOT_READY',
        `the bot is ${this.state}${this.lastError === null ? '' : ` (${this.lastError})`}`,
      );
    }

    return this.bot;
  }

  status(reason?: string): StatusMessage {
    const bot = this.bot;
    const position = bot?.entity?.position;

    return {
      t: 'status',
      state: this.state,
      ts: Date.now(),
      ...(this.spec === null ? {} : {
        address: `${this.spec.host}:${this.spec.port}`,
        username: this.spec.username,
      }),
      ...(bot?.version === undefined ? {} : { mcVersion: bot.version }),
      ...(bot?.game?.serverBrand == null ? {} : { serverBrand: bot.game.serverBrand }),
      ...(bot?.game?.gameMode === undefined ? {} : { gameMode: bot.game.gameMode }),
      ...(bot?.game?.dimension === undefined ? {} : { dimension: bot.game.dimension }),
      ...(position === undefined ? {} : {
        position: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) },
      }),
      ...(bot?.health === undefined ? {} : { health: bot.health }),
      ...(bot?.food === undefined ? {} : { food: bot.food }),
      ...(reason === undefined ? {} : { reason }),
      ...(this.lastError === null ? {} : { lastError: this.lastError }),
    };
  }

  async join(spec: JoinSpec): Promise<void> {
    if (this.bot) {
      this.quit('rejoining');
    }

    this.spec = spec;
    this.lastError = null;
    this.setState('connecting');

    const bot = mineflayer.createBot({
      host: spec.host,
      port: spec.port,
      username: spec.username,
      auth: 'offline',
      logErrors: false,
      hideErrors: true,
      ...connectOverride(spec.host, spec.port),
      ...(spec.version === undefined ? {} : { version: spec.version }),
      plugins: { pathfinder },
    });

    this.bot = bot;
    this.scores.attach(bot._client as unknown as PacketSource);
    this.recipes.attach(bot._client as unknown as RecipeBookClient);
    applyProtocolPatches(bot, spec.username);
    this.registerHandlers(bot);

    try {
      await this.awaitSpawn(bot, spec.spawnTimeoutMs);
      /* The table comes with the version, and the version is only settled once the handshake is. */
      useTranslations((bot.registry as unknown as { language?: Record<string, string> }).language);
    } catch (error) {
      this.lastError = describeError(error);
      this.quit('join failed');
      throw error;
    }
  }

  quit(reason: string): void {
    const bot = this.bot;
    this.bot = null;
    /* Told to leave, so nothing went wrong: the bot is linked and in no world, which is idle. */
    this.setState('idle', reason);

    if (!bot) {
      return;
    }

    try {
      bot.quit(reason);
    } catch (error) {
      log('warn', 'error while quitting the bot', { error: describeError(error) });
    }

    bot.removeAllListeners();
  }

  private setState(state: BotState, reason?: string): void {
    this.state = state;
    this.emit('status', this.status(reason));
  }

  private send(kind: RawEvent['kind'], source: string, text: string, extra?: Partial<RawEvent>): void {
    if (text === '') {
      return;
    }

    this.emit('event', { kind, source, text, ...extra });
  }

  private awaitSpawn(bot: Bot, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const settle = (error?: Error) => {
        clearTimeout(timer);
        bot.removeListener('spawn', onSpawn);
        bot.removeListener('error', onFailure);
        bot.removeListener('kicked', onKicked);
        bot.removeListener('end', onEnd);

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const onSpawn = () => settle();
      const onFailure = (error: Error) => settle(new JoinError('dial', dialFailure(error)));
      const onKicked = (reason: string) => settle(new JoinError('login', `the server refused the login: ${describeError(reason)}`));
      const onEnd = (reason: string) => settle(new JoinError('login', `the connection closed before spawn: ${describeError(reason)}`));

      const timer = setTimeout(
        () => settle(new JoinError('spawn', `logged in but did not spawn within ${timeoutMs}ms`)),
        timeoutMs,
      );

      bot.once('spawn', onSpawn);
      bot.once('error', onFailure);
      bot.once('kicked', onKicked);
      bot.once('end', onEnd);
    });
  }

  private registerHandlers(bot: Bot): void {
    bot.once('spawn', () => {
      this.lastError = null;
      bot.pathfinder.setMovements(new Movements(bot));
      this.setState('ready');
      log('info', 'bot spawned', {
        username: bot.username,
        address: `${this.spec?.host}:${this.spec?.port}`,
        version: bot.version,
      });
    });

    /*
    source is who produced the line, not where the client drew it: mineflayer's position is
    "chat"/"system"/"game_info", which says what kind already says, and reporting it there left
    this bot and the fabric one describing the same chat log differently.

    Only the 'chat' event carries a username, and it fires before 'messagestr' for the same line,
    so the last one seen names the sender of the line that follows it.
    */
    let lastSender: string | null = null;
    /* 'message' carries the component for the same line and fires before 'messagestr'. */
    let lastComponent: unknown = null;

    bot.on('chat', (username) => {
      lastSender = username;
    });

    bot.on('message', (message) => {
      lastComponent = rawComponentOf(message);
    });

    bot.on('messagestr', (message) => {
      this.send('chat', lastSender ?? 'system', message, { component: lastComponent });
      lastSender = null;
      lastComponent = null;
    });

    const recordActionBar = (value: unknown) => {
      const segments = toSegments(value);
      /*
      The plain text, not the rendered one: separators and font markers are how mcp-server writes
      a line, and putting them in the field a bot sends made the two kinds disagree about a feed
      they had both read correctly.
      */
      this.send('actionBar', 'actionbar', plainSegments(segments), {
        segments,
        component: rawComponentOf(value),
      });
    };

    bot.on('actionBar', recordActionBar);
    bot._client.on('action_bar' as never, ((packet: { text?: unknown }) => {
      recordActionBar(packet.text);
    }) as never);

    /*
    mineflayer emits its own 'title' event, but parseTitle there reaches for parsed.text and
    drops extra, so a title built from several pieces arrives as the first one or as raw JSON.
    Reading the packet keeps every piece, the same reason the action bar is read this way.
    */
    const recordTitle = (source: string) => (packet: { text?: unknown }) => {
      const segments = toSegments(packet.text);
      this.send('title', source, plainSegments(segments), {
        segments,
        component: rawComponentOf(packet.text),
      });
    };

    bot._client.on('set_title_text' as never, recordTitle('title') as never);
    bot._client.on('set_title_subtitle' as never, recordTitle('subtitle') as never);

    /*
    show_dialog is new in 26.1 and mineflayer does not know it. Reading it is all that is on
    offer: custom_click_action, the packet that answers a dialog, is listed in the protocol
    mappings but carries no field definition, so it cannot be serialised to press a button.
    */
    bot._client.on('show_dialog' as never, ((packet: { dialog?: unknown }) => {
      this.send('dialog', 'dialog', describeDialog(packet.dialog));
    }) as never);

    /*
    Without this the last dialog read as though it were still up long after the server took it
    away, which is the wrong answer to the only question worth asking of this feed.
    */
    bot._client.on('clear_dialog' as never, (() => {
      this.send('dialog', 'closed', 'the dialog was closed');
    }) as never);

    const recordSound = (packet: SoundPacket) => {
      this.send('effect', 'sound', soundName(bot, packet.sound));
    };

    bot._client.on('sound_effect' as never, recordSound as never);
    bot._client.on('entity_sound_effect' as never, recordSound as never);

    bot._client.on('world_particles' as never, ((packet: { particle?: { type?: unknown } }) => {
      const type = packet.particle?.type;
      if (typeof type === 'string') {
        /* Namespaced, like every other id: minecraft-data gives the bare name for a vanilla one. */
        this.send('effect', 'particle', type.includes(':') ? type : `minecraft:${type}`);
      }
    }) as never);

    bot.on('death', () => {
      this.send('chat', 'system', 'The bot died.');
      log('warn', 'bot died');
    });

    bot.on('kicked', (reason) => {
      this.lastError = `kicked: ${describeError(reason)}`;
      this.setState('disconnected', this.lastError);
      log('warn', 'bot kicked', { reason: describeError(reason) });
    });

    bot.on('error', (error) => {
      this.lastError = describeError(error);
      log('warn', 'bot error', { error: this.lastError });
    });

    bot.on('end', (reason) => {
      /* A deliberate quit already said idle; the end event that follows must not overwrite it. */
      if (this.state !== 'disconnected' && this.state !== 'idle') {
        this.lastError ??= `disconnected: ${describeError(reason)}`;
        this.setState('disconnected', describeError(reason));
      }
      log('info', 'bot disconnected', { reason: describeError(reason) });
    });
  }
}
