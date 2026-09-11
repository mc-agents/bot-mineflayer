export const PROTOCOL_VERSION = 1;

export const FRAME_JSON = 0x00;
export const FRAME_BLOB = 0x01;

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_JSON_BYTES = 1 * 1024 * 1024;

export type EventKind = 'chat' | 'actionBar' | 'title' | 'dialog' | 'effect';

export const EVENT_KINDS: readonly EventKind[] = ['chat', 'actionBar', 'title', 'dialog', 'effect'];

export type BotState = 'connecting' | 'ready' | 'disconnected' | 'faulted';

/*
The class decides what the server does with the session, so picking the wrong one is worse than
a bad message: `bot` abandons every waiter, `args` disables the tool until versions agree, and
`tool` means nothing more than that the game said no.
*/
export type ErrorClass =
  | 'tool'
  | 'timeout'
  | 'cancelled'
  | 'unsupported'
  | 'args'
  | 'bot'
  | 'internal';

export interface WireError {
  class: ErrorClass;
  code: string;
  message: string;
  retryable: boolean;
  detail?: unknown;
}

export interface Capability {
  tool: string;
  argsHash: string;
}

export interface TextSegmentWire {
  text: string;
  font?: string;
  color?: string;
}

export interface HelloMessage {
  t: 'hello';
  protocols: number[];
  botName: string;
  kind: string;
  agentVersion: string;
  mcVersion: string;
  catalogVersion: string;
  capabilities: Capability[];
  features: string[];
}

/* What a result says about a blob frame it was sent with. Dimensions are for an image. */
export interface BlobDescriptor {
  id: string;
  mime: string;
  bytes: number;
  name?: string;
  width?: number;
  height?: number;
}

export interface ResultMessage {
  t: 'result';
  id: number;
  ok: boolean;
  text: string;
  data?: unknown;
  blobs?: BlobDescriptor[];
  error?: WireError;
  elapsedMs: number;
}

export interface EventMessage {
  t: 'event';
  seq: number;
  kind: EventKind;
  source: string;
  text: string;
  segments?: TextSegmentWire[];
  data?: unknown;
  ts: number;
  firstTs: number;
  repeats: number;
  closed: boolean;
}

export interface StatusMessage {
  t: 'status';
  state: BotState;
  ts: number;
  address?: string;
  username?: string;
  mcVersion?: string;
  serverBrand?: string;
  gameMode?: string;
  dimension?: string;
  position?: { x: number; y: number; z: number };
  health?: number;
  food?: number;
  reason?: string;
  lastError?: string;
}

export interface LogMessage {
  t: 'log';
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

export interface PongMessage {
  t: 'pong';
  nonce: number;
  ts: number;
  busy: number;
}

export type BotMessage =
  | HelloMessage
  | ResultMessage
  | EventMessage
  | StatusMessage
  | LogMessage
  | PongMessage;

export interface HelloOkMessage {
  t: 'helloOk';
  protocol: number;
  sessionId: string;
  heartbeatMs: number;
  repeatFlushMs: number;
  limits?: Record<string, number>;
  acceptedTools: string[];
  rejectedTools: string[];
  events?: Partial<Record<EventKind, boolean>>;
}

export interface HelloErrMessage {
  t: 'helloErr';
  code: string;
  message: string;
}

export interface ConnectMessage {
  t: 'connect';
  id: number;
  host: string;
  port: number;
  username: string;
  version?: string;
  spawnTimeoutMs: number;
}

export interface CallMessage {
  t: 'call';
  id: number;
  tool: string;
  args: Record<string, unknown>;
  deadlineMs: number;
  traceId?: string;
}

export interface CancelMessage {
  t: 'cancel';
  id: number;
  reason: string;
}

export interface DisconnectMessage {
  t: 'disconnect';
  id: number;
  reason: string;
  quitMessage?: string;
}

export interface ShutdownMessage {
  t: 'shutdown';
  reason: string;
  graceMs: number;
}

export interface PingMessage {
  t: 'ping';
  nonce: number;
  ackEventSeq?: number;
}

/*
A breach of the wire contract rather than a tool that failed. The link closes behind it, so there
is nothing to answer -- only something to log, which is the point of it carrying a code.
*/
export interface FaultMessage {
  t: 'fault';
  code: string;
  message: string;
}

export type ServerMessage =
  | HelloOkMessage
  | HelloErrMessage
  | ConnectMessage
  | CallMessage
  | CancelMessage
  | DisconnectMessage
  | ShutdownMessage
  | PingMessage
  | FaultMessage;

export class ToolError extends Error {
  readonly wire: WireError;

  constructor(wire: WireError) {
    super(wire.message);
    this.name = 'ToolError';
    this.wire = wire;
  }
}

export function toolError(code: string, message: string): ToolError {
  return new ToolError({ class: 'tool', code, message, retryable: false });
}

export function botError(code: string, message: string): ToolError {
  return new ToolError({ class: 'bot', code, message, retryable: true });
}
