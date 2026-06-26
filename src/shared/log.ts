import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_RETENTION_DAYS = 3;
const LOG_DIR = path.join(os.homedir(), ".agentstudio", "logs");
const MAX_VALUE_LENGTH = 2048;
const MAX_QUEUE_SIZE = 1000;
const FLUSH_INTERVAL_MS = 250;
const FLUSH_BATCH_SIZE = 64;
const REDACTED = "[REDACTED]";

const sensitiveKeyPattern = /(?:api[-_]?key|authorization|auth[-_]?token|token|secret|password|anthropic_api_key|anthropic_auth_token)/i;

interface LogOptions {
  detail?: boolean;
}

let preparedLogDayKey: string | null = null;
let queue: Array<{ line: string; detail: boolean }> = [];
let droppedLogCount = 0;
let flushTimer: NodeJS.Timeout | null = null;
let flushInFlight: Promise<void> | null = null;

export function logEvent(scope: string, data?: unknown, options: LogOptions = {}): void {
  if (options.detail && !isDebugLoggingEnabled()) return;

  const now = new Date();
  try {
    const entry = {
      ts: now.toISOString(),
      scope,
      detail: Boolean(options.detail),
      data: sanitizeValue(data)
    };
    enqueueLogLine(`${JSON.stringify(entry)}\n`, Boolean(options.detail));
  } catch (error) {
    reportLogError(scope, error);
  }
}

export async function flushLogEvents(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushQueue();
  if (flushInFlight) await flushInFlight;
}

function isDebugLoggingEnabled(): boolean {
  return process.env.AGENTSTUDIO_DEBUG_LOGS === "1";
}

function enqueueLogLine(line: string, detail: boolean): void {
  if (queue.length >= MAX_QUEUE_SIZE) {
    const detailIndex = queue.findIndex((entry) => entry.detail);
    if (detailIndex >= 0) {
      queue.splice(detailIndex, 1);
      queue.push({ line, detail });
      droppedLogCount += 1;
      return;
    }
    droppedLogCount += 1;
    return;
  }

  queue.push({ line, detail });
  if (queue.length >= FLUSH_BATCH_SIZE) {
    void flushQueue();
    return;
  }

  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushQueue();
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
}

async function flushQueue(): Promise<void> {
  if (flushInFlight) {
    await flushInFlight;
    if (queue.length === 0 && droppedLogCount === 0) return;
  }

  const now = new Date();
  const lines = drainQueue(now);
  if (!lines) return;

  flushInFlight = writeLogLines(now, lines).finally(() => {
    flushInFlight = null;
  });
  await flushInFlight;
}

function drainQueue(now: Date): string {
  const lines = queue.map((entry) => entry.line);
  queue = [];

  if (droppedLogCount > 0) {
    lines.push(
      `${JSON.stringify({
        ts: now.toISOString(),
        scope: "log.queue.dropped",
        detail: false,
        data: { count: droppedLogCount }
      })}\n`
    );
    droppedLogCount = 0;
  }

  return lines.join("");
}

async function writeLogLines(now: Date, lines: string): Promise<void> {
  try {
    ensureLogFileReady(now);
    await fsPromises.appendFile(currentLogFilePath(now), lines, "utf8");
  } catch (error) {
    reportLogError("flush", error);
  }
}

function ensureLogFileReady(now: Date): void {
  const dayKey = formatDayKey(now);
  if (preparedLogDayKey === dayKey) return;

  fs.mkdirSync(LOG_DIR, { recursive: true });
  cleanupExpiredLogs(now);
  preparedLogDayKey = dayKey;
}

function cleanupExpiredLogs(now: Date): void {
  const cutoff = now.getTime() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const entry of fs.readdirSync(LOG_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;

    const filePath = path.join(LOG_DIR, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore cleanup failures and keep logging.
    }
  }
}

function currentLogFilePath(now: Date): string {
  return path.join(LOG_DIR, `${formatDayKey(now)}.log`);
}

function formatDayKey(now: Date): string {
  return now.toISOString().slice(0, 10).replaceAll("-", "");
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  if (value === undefined) return null;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return sanitizeError(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (typeof value === "object") return sanitizeObject(value);
  return truncateString(String(value));
}

function sanitizeObject(value: object): unknown {
  try {
    return sanitizeObjectEntries(value, new WeakSet<object>());
  } catch {
    return {
      type: Object.prototype.toString.call(value),
      value: truncateString(String(value))
    };
  }
}

function sanitizeObjectEntries(value: object, seen: WeakSet<object>): unknown {
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    if (item && typeof item === "object" && !(item instanceof Error)) {
      output[key] = Array.isArray(item)
        ? item.map((child) => (child && typeof child === "object" ? sanitizeObjectEntries(child, seen) : sanitizeValue(child)))
        : sanitizeObjectEntries(item, seen);
      continue;
    }
    output[key] = sanitizeValue(item, key);
  }
  return output;
}

function sanitizeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: truncateString(error.message),
    stack: error.stack ? truncateString(error.stack) : undefined
  };
}

function isSensitiveKey(key: string): boolean {
  return sensitiveKeyPattern.test(key);
}

function truncateString(value: string): string | { value: string; truncated: true; originalLength: number } {
  if (value.length <= MAX_VALUE_LENGTH) return value;
  return {
    value: value.slice(0, MAX_VALUE_LENGTH),
    truncated: true,
    originalLength: value.length
  };
}

function reportLogError(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[agentstudio-log] ${scope}: ${message}\n`);
}
