import { FRAME_BLOB, FRAME_JSON, MAX_FRAME_BYTES, MAX_JSON_BYTES } from './protocol.ts';

const HEADER_BYTES = 4;

export interface Frame {
  type: number;
  payload: Buffer;
}

export class FramingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FramingError';
    this.code = code;
  }
}

export function encodeFrame(type: number, payload: Buffer): Buffer {
  const length = payload.length + 1;

  if (length > MAX_FRAME_BYTES) {
    throw new FramingError('FRAME_TOO_LARGE', `frame of ${length} bytes exceeds ${MAX_FRAME_BYTES}`);
  }

  const frame = Buffer.allocUnsafe(HEADER_BYTES + length);
  frame.writeUInt32BE(length, 0);
  frame.writeUInt8(type, HEADER_BYTES);
  payload.copy(frame, HEADER_BYTES + 1);

  return frame;
}

export function encodeJson(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');

  if (payload.length > MAX_JSON_BYTES) {
    throw new FramingError('FRAME_TOO_LARGE', `JSON frame of ${payload.length} bytes exceeds ${MAX_JSON_BYTES}`);
  }

  return encodeFrame(FRAME_JSON, payload);
}

export function encodeBlob(uuid: string, content: Buffer): Buffer {
  const id = Buffer.from(uuid.replace(/-/g, ''), 'hex');

  if (id.length !== 16) {
    throw new FramingError('BAD_FRAME_TYPE', `"${uuid}" is not a 16-byte UUID`);
  }

  return encodeFrame(FRAME_BLOB, Buffer.concat([id, content]));
}

/*
A read from a socket has nothing to do with a frame: one read can hold half a frame, three frames,
or the tail of one and the head of the next. The decoder holds whatever is left over and hands
back only whole frames, which is the only shape the rest of the bot ever sees.
*/
export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Buffer): Frame[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);

    const frames: Frame[] = [];

    for (;;) {
      if (this.buffered.length < HEADER_BYTES) {
        return frames;
      }

      const length = this.buffered.readUInt32BE(0);

      if (length < 1) {
        throw new FramingError('BAD_FRAME_TYPE', 'a frame must carry at least a type byte');
      }

      if (length > this.maxFrameBytes) {
        throw new FramingError('FRAME_TOO_LARGE', `frame of ${length} bytes exceeds ${this.maxFrameBytes}`);
      }

      if (this.buffered.length < HEADER_BYTES + length) {
        return frames;
      }

      frames.push({
        type: this.buffered.readUInt8(HEADER_BYTES),
        payload: this.buffered.subarray(HEADER_BYTES + 1, HEADER_BYTES + length),
      });

      this.buffered = this.buffered.subarray(HEADER_BYTES + length);
    }
  }

  get pending(): number {
    return this.buffered.length;
  }
}

export function decodeJson(frame: Frame): Record<string, unknown> {
  if (frame.type !== FRAME_JSON) {
    throw new FramingError('BAD_FRAME_TYPE', `frame type ${frame.type} is not JSON`);
  }

  if (frame.payload.length > MAX_JSON_BYTES) {
    throw new FramingError('FRAME_TOO_LARGE', `JSON frame of ${frame.payload.length} bytes exceeds ${MAX_JSON_BYTES}`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(frame.payload.toString('utf8'));
  } catch (error) {
    throw new FramingError('MALFORMED_JSON', (error as Error).message);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FramingError('MALFORMED_JSON', 'a JSON frame carries a single object');
  }

  return parsed as Record<string, unknown>;
}
