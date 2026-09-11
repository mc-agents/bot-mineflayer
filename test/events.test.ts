import assert from 'node:assert/strict';
import test from 'node:test';
import { EventFolder } from '../src/rpc/events.ts';

const FLUSH = 1_000;

function bar(text: string) {
  return { kind: 'actionBar' as const, source: 'actionbar', text };
}

test('an action bar redrawn twenty times a second crosses the wire once a second', () => {
  const folder = new EventFolder();
  const opened = folder.accept(bar('20/20 HP'), 0);

  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.repeats, 1);

  for (let at = 50; at < FLUSH; at += 50) {
    assert.deepEqual(folder.accept(bar('20/20 HP'), at), []);
  }

  const flushed = folder.accept(bar('20/20 HP'), FLUSH);

  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]!.seq, opened[0]!.seq, 'a re-send updates the run in place');
  assert.equal(flushed[0]!.repeats, 21, 'the count is of redraws, not of frames sent');
  assert.equal(flushed[0]!.firstTs, 0);
  assert.equal(flushed[0]!.closed, false);
});

/*
The server wakes a waiter on a seq it has not seen. Reusing the seq is what keeps
wait-for-action-bar from firing on a line that was already showing when the wait began.
*/
test('a new line closes the old run and takes a seq of its own', () => {
  const folder = new EventFolder();
  const [first] = folder.accept(bar('loading'), 0);
  const out = folder.accept(bar('ready'), 10);

  assert.equal(out.length, 2);
  assert.equal(out[0]!.seq, first!.seq);
  assert.equal(out[0]!.closed, true);
  assert.equal(out[1]!.seq, first!.seq + 1);
  assert.equal(out[1]!.text, 'ready');
  assert.equal(out[1]!.closed, false);
});

test('chat is never folded, because the same line twice is two lines', () => {
  const folder = new EventFolder();
  const line = { kind: 'chat' as const, source: 'chat', text: 'hello' };

  const first = folder.accept(line, 0);
  const second = folder.accept(line, 10);

  assert.equal(first[0]!.closed, true);
  assert.equal(second.length, 1);
  assert.notEqual(second[0]!.seq, first[0]!.seq);
});

test('a run nothing repeats stops being reported as showing', () => {
  const folder = new EventFolder();
  folder.accept(bar('quest complete'), 0);

  assert.deepEqual(folder.tick(500), [], 'nothing is due yet');

  const due = folder.tick(FLUSH);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.closed, false);

  const stale = folder.tick(FLUSH * 3);
  assert.equal(stale.length, 1);
  assert.equal(stale[0]!.closed, true);

  assert.deepEqual(folder.tick(FLUSH * 10), [], 'a closed run is gone, not re-sent forever');
});

test('a feed the server switched off sends nothing at all', () => {
  const folder = new EventFolder();
  folder.configure({ events: { effect: false } });

  assert.deepEqual(folder.accept({ kind: 'effect', source: 'sound', text: 'block.stone.step' }), []);
  assert.equal(folder.accept(bar('still on')).length, 1);
});

test('segments ride along structured so the server decides how to join them', () => {
  const folder = new EventFolder();
  const [event] = folder.accept({
    kind: 'title',
    source: 'title',
    text: '[hud] 20',
    segments: [{ text: '20', font: 'server:hud', color: undefined }],
  });

  assert.deepEqual(event!.segments, [{ text: '20', font: 'server:hud' }]);
});

test('leaving the game closes whatever was showing', () => {
  const folder = new EventFolder();
  folder.accept(bar('showing'), 0);
  folder.accept({ kind: 'dialog', source: 'dialog', text: 'pick one' }, 0);

  const closed = folder.closeAll(50);

  assert.deepEqual(closed.map((event) => event.kind), ['actionBar', 'dialog']);
  assert.ok(closed.every((event) => event.closed));
  assert.deepEqual(folder.closeAll(60), []);
});
