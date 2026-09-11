import type { TextSegment } from '../minecraft/text.ts';
import type { EventKind, EventMessage, TextSegmentWire } from './protocol.ts';

export const DEFAULT_REPEAT_FLUSH_MS = 1_000;

/* A run that has not been repeated for this long has stopped showing, whatever the server meant. */
const STALE_FLUSHES = 3;

export interface RawEvent {
  kind: EventKind;
  source: string;
  text: string;
  segments?: TextSegment[];
  data?: unknown;
}

interface Run {
  seq: number;
  kind: EventKind;
  source: string;
  text: string;
  segments?: TextSegmentWire[];
  data?: unknown;
  firstTs: number;
  ts: number;
  repeats: number;
  sentAt: number;
}

function wireSegments(segments: TextSegment[] | undefined): TextSegmentWire[] | undefined {
  if (segments === undefined || segments.length === 0) {
    return undefined;
  }

  return segments.map((segment) => ({
    text: segment.text,
    ...(segment.font === undefined ? {} : { font: segment.font }),
    ...(segment.color === undefined ? {} : { color: segment.color }),
  }));
}

function frame(run: Run, closed: boolean): EventMessage {
  return {
    t: 'event',
    seq: run.seq,
    kind: run.kind,
    source: run.source,
    text: run.text,
    ...(run.segments === undefined ? {} : { segments: run.segments }),
    ...(run.data === undefined ? {} : { data: run.data }),
    ts: run.ts,
    firstTs: run.firstTs,
    repeats: run.repeats,
    closed,
  };
}

/*
An action bar redrawn twenty times a second is one thing showing, not twenty things happening.
The run carries a seq of its own, and every re-send reuses it, so the server updates that entry
in place instead of waking a waiter on each frame. `chat` is exempt: the same line twice is two
lines, and collapsing them would lose the only thing worth knowing about the second one.

A run is re-sent at most once a flush interval while it stays open, which is what keeps the
server's answer to "how long has this been showing" current without paying for the redraws.
*/
export class EventFolder {
  private readonly open = new Map<EventKind, Run>();
  private readonly enabled = new Map<EventKind, boolean>();
  private seq = 0;
  private flushMs = DEFAULT_REPEAT_FLUSH_MS;

  configure(options: { events?: Partial<Record<EventKind, boolean>>; repeatFlushMs?: number }): void {
    for (const [kind, on] of Object.entries(options.events ?? {})) {
      this.enabled.set(kind as EventKind, on);
    }

    if (options.repeatFlushMs !== undefined && options.repeatFlushMs > 0) {
      this.flushMs = options.repeatFlushMs;
    }
  }

  reset(): void {
    this.open.clear();
    this.seq = 0;
  }

  /* Returns what should go on the wire: nothing, the run that just closed, the new one, or both. */
  accept(event: RawEvent, now = Date.now()): EventMessage[] {
    if (this.enabled.get(event.kind) === false || event.text === '') {
      return [];
    }

    if (event.kind === 'chat') {
      return [frame(this.start(event, now), true)];
    }

    const running = this.open.get(event.kind);

    if (running && running.text === event.text && running.source === event.source) {
      running.repeats += 1;
      running.ts = now;

      if (now - running.sentAt < this.flushMs) {
        return [];
      }

      running.sentAt = now;
      return [frame(running, false)];
    }

    const out: EventMessage[] = [];

    if (running) {
      out.push(frame(running, true));
    }

    out.push(frame(this.start(event, now), false));
    return out;
  }

  /* Re-sends open runs that are due, and closes the ones nothing has repeated in a while. */
  tick(now = Date.now()): EventMessage[] {
    const out: EventMessage[] = [];

    for (const [kind, run] of this.open) {
      if (now - run.ts >= this.flushMs * STALE_FLUSHES) {
        this.open.delete(kind);
        out.push(frame(run, true));
        continue;
      }

      if (now - run.sentAt >= this.flushMs) {
        run.sentAt = now;
        out.push(frame(run, false));
      }
    }

    return out;
  }

  /* Closes every open run, for when the bot leaves the game and nothing is showing any more. */
  closeAll(now = Date.now()): EventMessage[] {
    const out: EventMessage[] = [];

    for (const run of this.open.values()) {
      run.ts = now;
      out.push(frame(run, true));
    }

    this.open.clear();
    return out;
  }

  private start(event: RawEvent, now: number): Run {
    this.seq += 1;

    const run: Run = {
      seq: this.seq,
      kind: event.kind,
      source: event.source,
      text: event.text,
      segments: wireSegments(event.segments),
      data: event.data,
      firstTs: now,
      ts: now,
      repeats: 1,
      sentAt: now,
    };

    if (event.kind !== 'chat') {
      this.open.set(event.kind, run);
    }

    return run;
  }
}
