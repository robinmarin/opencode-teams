import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogCategory = "plugin" | "tool" | "messaging" | "state" | "sdk";

export type LogEntry = {
  id: string;
  ts: string;
  level: LogLevel;
  category: LogCategory;
  sessionId: string | null;
  teamName: string | null;
  memberName: string | null;
  correlationId: string | null;
  message: string;
  context?: Record<string, unknown>;
};

type LogDestination = (entry: LogEntry) => void;

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_MIN_LEVEL: LogLevel = "info";

export type LoggerConfig = {
  minLevel?: LogLevel;
  maxBufferSize?: number;
  correlationId?: string | null;
  sessionId?: string | null;
  teamName?: string | null;
  memberName?: string | null;
};

function makeEntry(
  level: LogLevel,
  category: LogCategory,
  message: string,
  config: LoggerConfig,
  context?: Record<string, unknown>,
): LogEntry {
  return {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    level,
    category,
    sessionId: config.sessionId ?? null,
    teamName: config.teamName ?? null,
    memberName: config.memberName ?? null,
    correlationId: config.correlationId ?? null,
    message,
    ...(context !== undefined ? { context } : {}),
  };
}

export function createLogger(
  client: PluginInput["client"],
  config: LoggerConfig = {},
) {
  const minLevel = config.minLevel ?? DEFAULT_MIN_LEVEL;
  const maxBufferSize = config.maxBufferSize ?? 1000;

  const destinations: LogDestination[] = [];

  const ringBuffer: LogEntry[] = [];
  let ringIndex = 0;

  function addToRingBuffer(entry: LogEntry) {
    if (ringBuffer.length < maxBufferSize) {
      ringBuffer.push(entry);
    } else {
      ringBuffer[ringIndex] = entry;
      ringIndex = (ringIndex + 1) % maxBufferSize;
    }
  }

  function dispatch(entry: LogEntry) {
    for (const dest of destinations) {
      try {
        dest(entry);
      } catch (err) {
        console.error("[logger] destination error:", err);
      }
    }
  }

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
  }

  function log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    context?: Record<string, unknown>,
  ) {
    if (!shouldLog(level)) return;
    const entry = makeEntry(level, category, message, config, context);
    addToRingBuffer(entry);
    dispatch(entry);
  }

  function child(overrides: LoggerConfig): ReturnType<typeof createLogger> {
    return createLogger(client, { ...config, ...overrides });
  }

  const logger = {
    debug(
      category: LogCategory,
      message: string,
      context?: Record<string, unknown>,
    ) {
      log("debug", category, message, context);
    },
    info(
      category: LogCategory,
      message: string,
      context?: Record<string, unknown>,
    ) {
      log("info", category, message, context);
    },
    warn(
      category: LogCategory,
      message: string,
      context?: Record<string, unknown>,
    ) {
      log("warn", category, message, context);
    },
    error(
      category: LogCategory,
      message: string,
      context?: Record<string, unknown>,
    ) {
      log("error", category, message, context);
    },

    addDestination(dest: LogDestination) {
      destinations.push(dest);
    },

    removeDestination(dest: LogDestination) {
      const idx = destinations.indexOf(dest);
      if (idx !== -1) destinations.splice(idx, 1);
    },

    getBuffer(): LogEntry[] {
      if (ringBuffer.length < maxBufferSize) {
        return [...ringBuffer];
      }
      const result: LogEntry[] = [];
      for (let i = 0; i < ringBuffer.length; i++) {
        const idx = (ringIndex + i) % ringBuffer.length;
        const entry = ringBuffer[idx];
        if (entry !== undefined) result.push(entry);
      }
      return result;
    },

    child,

    config: { ...config },
  };

  return logger;
}

export type Logger = ReturnType<typeof createLogger>;

export function createFileSink(
  _teamName: string,
  logPath: string,
): LogDestination {
  let buffer: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush() {
    if (buffer.length === 0) return;
    const lines = buffer.join("");
    buffer = [];
    try {
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.appendFile(logPath, lines, "utf-8");
    } catch (err) {
      console.error(`[logger:FileSink] failed to write to ${logPath}:`, err);
    }
  }

  return (entry: LogEntry) => {
    buffer.push(`${JSON.stringify(entry)}\n`);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, 100);
  };
}

export function createConsoleSink(minLevel: LogLevel = "info"): LogDestination {
  const COLORS: Record<LogLevel, string> = {
    debug: "\x1b[90m",
    info: "\x1b[36m",
    warn: "\x1b[33m",
    error: "\x1b[31m",
  };
  const RESET = "\x1b[0m";

  return (entry: LogEntry) => {
    if (LOG_LEVELS[entry.level] < LOG_LEVELS[minLevel]) return;
    const color = COLORS[entry.level];
    const meta = [
      entry.ts,
      entry.level.toUpperCase(),
      entry.category,
      entry.teamName ?? "-",
      entry.memberName ?? "-",
    ].join(" ");
    const ctx =
      entry.context !== undefined ? ` ${JSON.stringify(entry.context)}` : "";
    console.log(`${color}[${meta}]${RESET} ${entry.message}${ctx}`);
  };
}
