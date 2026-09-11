import type { Bot } from 'mineflayer';
import { describeError, log } from '../logger.ts';
import type { ScoreTracker } from '../minecraft/scoreboard.ts';
import { EXCLUSIVE_TOOLS } from './catalog-hashes.ts';
import { ToolError } from './protocol.ts';
import type { CallMessage, ResultMessage, WireError } from './protocol.ts';
import type { ToolContext, ToolDefinition, ToolOutput } from './tool.ts';

export interface ToolHost {
  requireBot: () => Bot;
  username: string;
  scores: ScoreTracker;
}

interface InFlight {
  tool: string;
  exclusive: boolean;
  abort: AbortController;
  settle: (error: WireError) => void;
}

function ok(id: string, output: ToolOutput, startedAt: number): ResultMessage {
  const elapsedMs = Date.now() - startedAt;

  return typeof output === 'string'
    ? { t: 'result', id, ok: true, text: output, elapsedMs }
    : { t: 'result', id, ok: true, text: output.text, data: output.data, elapsedMs };
}

function failed(id: string, error: WireError, startedAt: number): ResultMessage {
  return { t: 'result', id, ok: false, text: error.message, error, elapsedMs: Date.now() - startedAt };
}

/*
A tool body says "no window is open" by throwing a plain Error, which is the game refusing and
nothing to worry about. A TypeError is the bot being wrong about its own code, and the server
must be able to tell those apart: the first is an answer, the second is a bug worth logging.
*/
function classify(error: unknown): WireError {
  if (error instanceof ToolError) {
    return error.wire;
  }

  if (error instanceof Error && error.constructor === Error) {
    return { class: 'tool', code: 'TOOL_REFUSED', message: error.message, retryable: false };
  }

  return {
    class: 'internal',
    code: 'UNCAUGHT',
    message: describeError(error),
    retryable: false,
    ...(error instanceof Error && error.stack !== undefined ? { detail: error.stack } : {}),
  };
}

/*
One `result` per `call.id`, whatever happens. A deadline, a cancel and a tool that finishes all
race each other here, and the first one to arrive is the answer; the others are dropped. The tool
itself is not stopped, because nothing in mineflayer can be: cancellation is cooperative, and a
walk that was abandoned keeps walking until its own timeout trips.
*/
export class Dispatcher {
  private readonly tools: ReadonlyMap<string, ToolDefinition>;
  private readonly host: ToolHost;
  private readonly send: (result: ResultMessage) => void;
  private readonly inFlight = new Map<string, InFlight>();
  private readonly outcomes: Record<string, number> = { ok: 0 };

  constructor(
    tools: ReadonlyMap<string, ToolDefinition>,
    host: ToolHost,
    send: (result: ResultMessage) => void,
  ) {
    this.tools = tools;
    this.host = host;
    this.send = send;
  }

  get busy(): number {
    return this.inFlight.size;
  }

  get running(): string[] {
    return [...this.inFlight.values()].map((call) => call.tool);
  }

  get results(): Readonly<Record<string, number>> {
    return this.outcomes;
  }

  private count(result: ResultMessage): ResultMessage {
    const outcome = result.error?.class ?? 'ok';
    this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1;
    return result;
  }

  call(message: CallMessage): void {
    const startedAt = Date.now();

    if (this.inFlight.has(message.id)) {
      this.send(this.count(failed(message.id, {
        class: 'internal',
        code: 'DUPLICATE_CALL_ID',
        message: `call ${message.id} is already in flight`,
        retryable: false,
      }, startedAt)));
      return;
    }

    const tool = this.tools.get(message.tool);

    if (!tool) {
      this.send(this.count(failed(message.id, {
        class: 'unsupported',
        code: 'UNKNOWN_TOOL',
        message: `this bot does not implement ${message.tool}`,
        retryable: false,
      }, startedAt)));
      return;
    }

    const exclusive = EXCLUSIVE_TOOLS.has(message.tool);

    if (exclusive && this.holder() !== undefined) {
      this.send(this.count(failed(message.id, {
        class: 'tool',
        code: 'BOT_BUSY',
        message: `the bot is already running ${this.holder()}; only one of those may run at a time`,
        retryable: true,
      }, startedAt)));
      return;
    }

    void this.run(tool, message, exclusive, startedAt);
  }

  cancel(id: string, reason: string): void {
    /* A cancel that loses the race to a completing call is normal, not a violation. */
    this.inFlight.get(id)?.settle({
      class: 'cancelled',
      code: 'CANCELLED',
      message: `cancelled: ${reason}`,
      retryable: false,
    });
  }

  /* Answers everything still open, for a link that is going away and would otherwise leave waiters. */
  abandonAll(reason: string): void {
    for (const id of [...this.inFlight.keys()]) {
      this.inFlight.get(id)?.settle({
        class: 'bot',
        code: 'LINK_LOST',
        message: reason,
        retryable: true,
      });
    }
  }

  private holder(): string | undefined {
    return [...this.inFlight.values()].find((call) => call.exclusive)?.tool;
  }

  private async run(
    tool: ToolDefinition,
    message: CallMessage,
    exclusive: boolean,
    startedAt: number,
  ): Promise<void> {
    const abort = new AbortController();
    let done = false;

    const finish = (result: ResultMessage) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      this.inFlight.delete(message.id);
      this.send(this.count(result));
    };

    const settle = (error: WireError) => {
      abort.abort(error.message);
      finish(failed(message.id, error, startedAt));
    };

    const timer = setTimeout(() => {
      settle({
        class: 'timeout',
        code: 'DEADLINE_EXCEEDED',
        message: `${message.tool} did not finish within ${message.deadlineMs}ms`,
        retryable: true,
      });
    }, message.deadlineMs);

    this.inFlight.set(message.id, { tool: message.tool, exclusive, abort, settle });

    try {
      const context: ToolContext = {
        bot: this.host.requireBot(),
        username: this.host.username,
        scores: this.host.scores,
        signal: abort.signal,
      };

      finish(ok(message.id, await tool.run(message.args, context), startedAt));
    } catch (error) {
      const wire = classify(error);

      if (wire.class === 'internal') {
        log('error', 'tool threw', { tool: message.tool, error: wire.message, detail: wire.detail });
      }

      finish(failed(message.id, wire, startedAt));
    }
  }
}
