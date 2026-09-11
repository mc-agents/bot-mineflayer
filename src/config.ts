import { hostname } from 'node:os';
import type { LogLevel } from './logger.ts';

/*
A bot is one process in one pod with one job, started by the operator and never by hand. Flags
would be a second way to say everything the pod spec already says, so there are none: the
environment is the whole surface.
*/
export interface BotConfig {
  server: { host: string; port: number };
  botName: string;
  mcVersion: string;
  logLevel: LogLevel;
  health: { host: string; port: number };
  reconnect: { minMs: number; maxMs: number };
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envNumber(name: string, fallback: number): number {
  const value = envString(name, '');

  if (value === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got "${value}"`);
  }

  return parsed;
}

function envLogLevel(name: string, fallback: LogLevel): LogLevel {
  const value = envString(name, fallback);

  if (!LOG_LEVELS.includes(value as LogLevel)) {
    throw new Error(`${name} must be one of ${LOG_LEVELS.join(', ')}, got "${value}"`);
  }

  return value as LogLevel;
}

function envPort(name: string, fallback: number): number {
  const port = envNumber(name, fallback);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a valid port number, got ${port}`);
  }

  return port;
}

export function loadConfig(): BotConfig {
  return {
    server: {
      host: envString('MCP_SERVER_HOST', '127.0.0.1'),
      port: envPort('MCP_SERVER_PORT', 8765),
    },
    /* The pod name is the bot name: the operator names the pod, so nothing else has to agree. */
    botName: envString('BOT_NAME', envString('POD_NAME', hostname())),
    mcVersion: envString('MC_VERSION', 'auto'),
    logLevel: envLogLevel('LOG_LEVEL', 'info'),
    health: {
      host: envString('HEALTH_BIND_HOST', '0.0.0.0'),
      port: envPort('HEALTH_PORT', 8080),
    },
    reconnect: {
      minMs: envNumber('RECONNECT_MIN_MS', 500),
      maxMs: envNumber('RECONNECT_MAX_MS', 15_000),
    },
  };
}
