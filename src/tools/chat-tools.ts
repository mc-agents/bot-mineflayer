import * as z from 'zod';
import { type ToolDefinition, defineTool } from '../rpc/tool.ts';

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
];
