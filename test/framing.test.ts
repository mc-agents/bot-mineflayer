import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameDecoder, decodeJson, encodeBlob, encodeFrame, encodeJson } from '../src/rpc/framing.ts';
import type { FramingError } from '../src/rpc/framing.ts';
import { FRAME_BLOB, FRAME_JSON } from '../src/rpc/protocol.ts';

function frames(decoder: FrameDecoder, bytes: Buffer) {
  return decoder.push(bytes);
}

test('length counts the type byte, which is what the other end reads back', () => {
  const frame = encodeFrame(FRAME_JSON, Buffer.from('hi'));

  assert.equal(frame.readUInt32BE(0), 3);
  assert.equal(frame.readUInt8(4), FRAME_JSON);
  assert.equal(frame.subarray(5).toString(), 'hi');
});

test('a frame split across three reads is delivered once, whole', () => {
  const decoder = new FrameDecoder();
  const frame = encodeJson({ t: 'ping', nonce: 'abc' });

  assert.deepEqual(frames(decoder, frame.subarray(0, 2)), []);
  assert.deepEqual(frames(decoder, frame.subarray(2, 7)), []);

  const out = frames(decoder, frame.subarray(7));

  assert.equal(out.length, 1);
  assert.deepEqual(decodeJson(out[0]!), { t: 'ping', nonce: 'abc' });
});

test('several frames arriving in one read come back in order', () => {
  const decoder = new FrameDecoder();
  const chunk = Buffer.concat([
    encodeJson({ t: 'a' }),
    encodeJson({ t: 'b' }),
    encodeJson({ t: 'c' }),
  ]);

  const out = frames(decoder, chunk);

  assert.deepEqual(out.map((frame) => decodeJson(frame).t), ['a', 'b', 'c']);
  assert.equal(decoder.pending, 0);
});

/*
The tail of one frame and the head of the next arrive in the same read constantly, and holding
the head until the next read is the whole job of the decoder.
*/
test('the head of the next frame is held rather than dropped', () => {
  const decoder = new FrameDecoder();
  const first = encodeJson({ t: 'a' });
  const second = encodeJson({ t: 'b' });

  const out = frames(decoder, Buffer.concat([first, second.subarray(0, 3)]));

  assert.equal(out.length, 1);
  assert.equal(decoder.pending, 3);
  assert.equal(decodeJson(frames(decoder, second.subarray(3))[0]!).t, 'b');
});

test('a length past the ceiling is refused before anything is allocated for it', () => {
  const decoder = new FrameDecoder(1_024);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(2_048, 0);

  assert.throws(() => decoder.push(header), (error: FramingError) => error.code === 'FRAME_TOO_LARGE');
});

test('a zero length carries no type byte and is a violation, not an empty frame', () => {
  const decoder = new FrameDecoder();
  const header = Buffer.alloc(4);

  assert.throws(() => decoder.push(header), (error: FramingError) => error.code === 'BAD_FRAME_TYPE');
});

test('a JSON frame carries one object, so an array is refused', () => {
  const frame = { type: FRAME_JSON, payload: Buffer.from('[1,2]') };

  assert.throws(() => decodeJson(frame), (error: FramingError) => error.code === 'MALFORMED_JSON');
});

test('unreadable JSON is named as such instead of surfacing as a parse error', () => {
  const frame = { type: FRAME_JSON, payload: Buffer.from('{oh no') };

  assert.throws(() => decodeJson(frame), (error: FramingError) => error.code === 'MALFORMED_JSON');
});

test('a blob frame puts the id ahead of the content so the reader can route it', () => {
  const uuid = '00112233-4455-6677-8899-aabbccddeeff';
  const frame = encodeBlob(uuid, Buffer.from('png'));
  const decoder = new FrameDecoder();
  const [decoded] = decoder.push(frame);

  assert.equal(decoded!.type, FRAME_BLOB);
  assert.equal(decoded!.payload.subarray(0, 16).toString('hex'), uuid.replace(/-/g, ''));
  assert.equal(decoded!.payload.subarray(16).toString(), 'png');
});
