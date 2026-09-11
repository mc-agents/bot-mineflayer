import * as z from 'zod';
import type { Bot } from 'mineflayer';
import { type ToolDefinition, defineTool } from '../rpc/tool.ts';
import { toPlainText } from '../minecraft/text.ts';

/* What a Velocity-style proxy says when it will not move the bot. */
const ALREADY_THERE = /already connected/i;
const SWITCH_REFUSED = /(does ?n[o']t exist|unable to connect|no available server|not a valid server)/i;

const POSITION_SETTLE_MS = 5_000;

/*
A backend switch looks like a fresh login on the same connection, so the login event is what says
the bot arrived. The proxy answering in chat is the other outcome, and it arrives first when it
happens, which is why the two race rather than run in sequence.
*/
function nextBackendLogin(bot: Bot, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (arrived: boolean) => {
      clearTimeout(timer);
      bot.removeListener('login', onLogin);
      resolve(arrived);
    };

    const onLogin = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);

    bot.once('login', onLogin);
  });
}

function nextProxyReply(bot: Bot, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (text: string | null) => {
      clearTimeout(timer);
      bot.removeListener('message', onMessage);
      resolve(text);
    };

    const onMessage = (message: unknown) => {
      const text = toPlainText(message);
      if (ALREADY_THERE.test(text) || SWITCH_REFUSED.test(text)) {
        done(text);
      }
    };

    const timer = setTimeout(() => done(null), timeoutMs);
    bot.on('message', onMessage);
  });
}

/*
The position the server sends on arrival lands a moment after the login, and reporting the one
from before it would name the coordinates on the server the bot just left.
*/
function nextPositionUpdate(bot: Bot, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      bot._client.removeListener('position', done);
      resolve();
    };

    const timer = setTimeout(done, timeoutMs);
    bot._client.once('position', done);
  });
}

export const chatTools: ToolDefinition[] = [
  defineTool(
    'send-chat',
    'Say something in chat as the bot. Use run-command for slash commands.',
    {
      message: z.string().min(1).max(256).describe('Text to say'),
    },
    (args, ctx) => {
      const { bot } = ctx;

      if (args.message.startsWith('/')) {
        throw new Error('send-chat is for plain chat. Use run-command to send a slash command.');
      }

      bot.chat(args.message);
      return `Sent as ${ctx.username}: ${args.message}`;
    },
  ),

  defineTool(
    'run-command',
    'Run a slash command as the bot.',
    {
      command: z.string().min(1).max(256).describe('Command with or without the leading slash'),
    },
    (args, ctx) => {
      const { bot } = ctx;
      const command = args.command.startsWith('/') ? args.command : `/${args.command}`;

      /*
      Sending is the whole of the bot's half. What the server says back is chat, and the buffer
      that catches it belongs to mcp-server, which marks it before the call and reads past the
      mark afterwards. Waiting here as well would only make the tool take twice as long.
      */
      bot.chat(command);
      return `Ran ${command}.`;
    },
  ),

  defineTool(
    'switch-server',
    'Send the bot to another backend server through the proxy and wait until it spawns there.',
    {
      target: z.string().min(1).max(64).describe('Backend server name the proxy knows'),
      timeoutMs: z.coerce.number().int().min(1_000).max(120_000).describe('Give up after this long'),
    },
    async (args, ctx) => {
      const { bot } = ctx;
      const arrival = nextBackendLogin(bot, args.timeoutMs);
      const refusal = nextProxyReply(bot, args.timeoutMs);

      bot.chat(`/server ${args.target}`);

      const first = await Promise.race([
        arrival.then(() => ({ kind: 'login' as const })),
        refusal.then((text) => ({ kind: 'chat' as const, text })),
      ]);

      /* Both settle at the deadline, so a chat outcome only counts when it carries a line. */
      if (first.kind === 'chat' && first.text !== null) {
        if (ALREADY_THERE.test(first.text)) {
          const here = bot.entity.position;
          return `Already on "${args.target}" at ` +
            `(${Math.floor(here.x)}, ${Math.floor(here.y)}, ${Math.floor(here.z)}).`;
        }
        throw new Error(`The proxy refused the switch: ${first.text}`);
      }

      if (!await arrival) {
        throw new Error(
          `The bot did not arrive on "${args.target}" within ${args.timeoutMs}ms. ` +
          'Check read-chat for what the proxy said and get-bot-status for the connection state.',
        );
      }

      await nextPositionUpdate(bot, POSITION_SETTLE_MS);

      const { x, y, z } = bot.entity.position;
      return `Now on "${args.target}" at (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}) ` +
        `in ${bot.game.dimension}.`;
    },
  ),
];
