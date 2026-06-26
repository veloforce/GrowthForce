import { promises as fsPromises } from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const LOG_DIR = path.join(os.homedir(), ".agentstudio", "logs");
const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024;
const REDACTED = "[REDACTED]";
const sensitiveHeaderPattern = /(?:authorization|api[-_]?key|x-api-key|cookie|token|secret|password)/i;

export interface ModelHttpLoggerRuntime {
  baseUrl: string;
  close: () => Promise<void>;
}

export interface ModelHttpLoggerOptions {
  upstreamBaseUrl: string;
  requestId: string;
  sdkSessionId?: string | null;
  model?: string | null;
  maxLogBytes?: number;
}

interface LogEntry {
  ts: string;
  event: string;
  requestId: string;
  sdkSessionId: string | null;
  model: string | null;
  data: unknown;
}

type BodyLogValue = string | { value: string; truncated: true; originalBytes: number };

export function shouldEnableModelHttpLogging(env: NodeJS.ProcessEnv, isPackagedRuntime: boolean): boolean {
  return env.AGENTSTUDIO_DEV_MODEL_HTTP_LOGS === "dev.sh" && Boolean(env.VITE_DEV_SERVER_URL) && !isPackagedRuntime;
}

export async function startModelHttpLogger(options: ModelHttpLoggerOptions): Promise<ModelHttpLoggerRuntime> {
  const upstream = normalizeUpstreamBaseUrl(options.upstreamBaseUrl);
  const maxLogBytes = resolveMaxLogBytes(options.maxLogBytes);
  const server = http.createServer((request, response) => {
    void proxyRequest(request, response, upstream, options, maxLogBytes);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Failed to start model HTTP logger on a local port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server)
  };
}

async function proxyRequest(request: IncomingMessage, response: ServerResponse, upstream: URL, options: ModelHttpLoggerOptions, maxLogBytes: number): Promise<void> {
  const startedAt = Date.now();
  const chunks: Buffer[] = [];

  try {
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const requestBody = Buffer.concat(chunks);
    const target = buildTargetUrl(upstream, request.url ?? "/");
    await safeWriteModelHttpLog("request", options, {
      method: request.method ?? "GET",
      url: redactRequestUrl(request.url ?? "/"),
      upstreamUrl: redactUrl(target),
      headers: redactHeaders(request.headers),
      body: truncateBody(requestBody, maxLogBytes)
    });

    await forwardRequest(request, response, target, requestBody, options, startedAt, maxLogBytes);
  } catch (error) {
    await safeWriteModelHttpLog("proxy_error", options, {
      method: request.method ?? "GET",
      url: redactRequestUrl(request.url ?? "/"),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error)
    });
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
    }
    if (!response.writableEnded) {
      response.end(JSON.stringify({ error: "Model HTTP logger proxy failed" }));
    }
  }
}

async function forwardRequest(
  sourceRequest: IncomingMessage,
  clientResponse: ServerResponse,
  target: URL,
  body: Buffer,
  options: ModelHttpLoggerOptions,
  startedAt: number,
  maxLogBytes: number
): Promise<void> {
  const transport = target.protocol === "https:" ? https : http;
  const headers = buildForwardHeaders(sourceRequest.headers, target);

  await new Promise<void>((resolve, reject) => {
    const upstreamRequest = transport.request(
      target,
      {
        method: sourceRequest.method,
        headers
      },
      (upstreamResponse) => {
        clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        const responseChunks: Buffer[] = [];

        upstreamResponse.on("data", (chunk: Buffer) => {
          responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          clientResponse.write(chunk);
        });

        upstreamResponse.on("end", () => {
          void (async () => {
            await safeWriteModelHttpLog("response", options, {
              statusCode: upstreamResponse.statusCode ?? null,
              statusMessage: upstreamResponse.statusMessage,
              headers: redactHeaders(upstreamResponse.headers),
              body: truncateBody(Buffer.concat(responseChunks), maxLogBytes),
              durationMs: Date.now() - startedAt
            });
            clientResponse.end();
            resolve();
          })().catch(reject);
        });

        upstreamResponse.on("error", reject);
      }
    );

    upstreamRequest.on("error", reject);
    if (body.length > 0) upstreamRequest.write(body);
    upstreamRequest.end();
  });
}

function buildTargetUrl(upstream: URL, requestUrl: string): URL {
  const target = new URL(requestUrl, upstream);
  const basePath = upstream.pathname.endsWith("/") ? upstream.pathname.slice(0, -1) : upstream.pathname;
  const requestPath = target.pathname.startsWith("/") ? target.pathname : `/${target.pathname}`;
  target.pathname = `${basePath}${requestPath}` || "/";
  return target;
}

function buildForwardHeaders(headers: IncomingHttpHeaders, target: URL): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = { ...headers };
  forwarded.host = target.host;
  delete forwarded.connection;
  delete forwarded["proxy-connection"];
  return forwarded;
}

function redactHeaders(headers: IncomingHttpHeaders): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    output[key] = sensitiveHeaderPattern.test(key) ? REDACTED : value ?? null;
  }
  return output;
}

function redactUrl(url: URL): string {
  const safe = new URL(url.toString());
  for (const key of Array.from(safe.searchParams.keys())) {
    if (sensitiveHeaderPattern.test(key)) safe.searchParams.set(key, REDACTED);
  }
  return safe.toString();
}

function redactRequestUrl(requestUrl: string): string {
  const safe = new URL(requestUrl, "http://agentstudio.local");
  for (const key of Array.from(safe.searchParams.keys())) {
    if (sensitiveHeaderPattern.test(key)) safe.searchParams.set(key, REDACTED);
  }
  return `${safe.pathname}${safe.search}`;
}

function truncateBody(body: Buffer, maxLogBytes: number): string | { value: string; truncated: true; originalBytes: number } {
  if (body.byteLength <= maxLogBytes) return body.toString("utf8");
  return {
    value: body.subarray(0, maxLogBytes).toString("utf8"),
    truncated: true,
    originalBytes: body.byteLength
  };
}

async function writeModelHttpLog(event: string, options: ModelHttpLoggerOptions, data: unknown): Promise<void> {
  const now = new Date();
  const entry: LogEntry = {
    ts: now.toISOString(),
    event,
    requestId: options.requestId,
    sdkSessionId: options.sdkSessionId ?? null,
    model: options.model ?? null,
    data
  };
  await fsPromises.mkdir(LOG_DIR, { recursive: true });
  await fsPromises.appendFile(path.join(LOG_DIR, `model-http-${formatDayKey(now)}.log`), formatLogEntry(entry), "utf8");
}

async function safeWriteModelHttpLog(event: string, options: ModelHttpLoggerOptions, data: unknown): Promise<void> {
  try {
    await writeModelHttpLog(event, options, data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[model-http-logger] failed to write ${event}: ${message}\n`);
  }
}

function formatLogEntry(entry: LogEntry): string {
  const data = entry.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>) : {};
  const rootKey = entry.event === "proxy_error" ? "proxy_error" : entry.event;
  const lines = ["---", `${rootKey}:`];

  appendScalarField(lines, "ts", entry.ts, 2);
  appendScalarField(lines, "requestId", entry.requestId, 2);
  appendScalarField(lines, "sdkSessionId", entry.sdkSessionId, 2);
  appendScalarField(lines, "model", entry.model, 2);

  if (entry.event === "request") {
    appendScalarField(lines, "method", data.method, 2);
    appendScalarField(lines, "url", data.url, 2);
    appendScalarField(lines, "upstreamUrl", data.upstreamUrl, 2);
    appendMapField(lines, "headers", data.headers, 2);
    appendBodyField(lines, "body", data.body, 2);
  } else if (entry.event === "response") {
    const status = [data.statusCode, data.statusMessage].filter((value) => value !== undefined && value !== null && String(value).length > 0).join(" ");
    appendScalarField(lines, "status", status || null, 2);
    appendScalarField(lines, "durationMs", data.durationMs, 2);
    appendMapField(lines, "headers", data.headers, 2);
    appendBodyField(lines, "body", data.body, 2);
  } else if (entry.event === "proxy_error") {
    appendScalarField(lines, "method", data.method, 2);
    appendScalarField(lines, "url", data.url, 2);
    appendScalarField(lines, "durationMs", data.durationMs, 2);
    appendMapField(lines, "error", data.error, 2);
  } else {
    appendMapField(lines, "data", data, 2);
  }

  return `${lines.join("\n")}\n\n`;
}

function appendScalarField(lines: string[], key: string, value: unknown, indent = 0): void {
  lines.push(`${spaces(indent)}${key}: ${formatNullableScalar(value)}`);
}

function appendMapField(lines: string[], key: string, value: unknown, indent = 0): void {
  if (!value || typeof value !== "object") {
    lines.push(`${spaces(indent)}${key}: {}`);
    return;
  }

  lines.push(`${spaces(indent)}${key}:`);
  for (const [childKey, childValue] of Object.entries(value)) {
    lines.push(`${spaces(indent + 2)}${childKey}: ${formatNullableScalar(childValue)}`);
  }
}

function appendBodyField(lines: string[], key: string, value: unknown, indent = 0): void {
  const body = normalizeBodyValue(value);
  if (body.truncated) {
    lines.push(`${spaces(indent)}${key}:`);
    lines.push(`${spaces(indent + 2)}truncated: true`);
    lines.push(`${spaces(indent + 2)}originalBytes: ${body.originalBytes}`);
    appendTextBlock(lines, "value", body.value, indent + 2);
    return;
  }
  appendTextBlock(lines, key, body.value, indent);
}

function normalizeBodyValue(value: unknown): { value: string; truncated: false } | { value: string; truncated: true; originalBytes: number } {
  if (isTruncatedBody(value)) {
    return {
      value: prettyPrintBody(value.value),
      truncated: true,
      originalBytes: value.originalBytes
    };
  }
  return {
    value: prettyPrintBody(typeof value === "string" ? value : stringifyUnknown(value)),
    truncated: false
  };
}

function appendTextBlock(lines: string[], key: string, value: string, indent = 0): void {
  lines.push(`${spaces(indent)}${key}: |`);
  for (const line of value.split(/\r?\n/)) {
    lines.push(`${spaces(indent + 2)}${line}`);
  }
}

function prettyPrintBody(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

function formatNullableScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return formatScalar(value);
}

function formatScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = typeof value === "string" ? value : stringifyUnknown(value);
  if (text === "") return '""';
  if (text === REDACTED) return JSON.stringify(text);
  if (/^[A-Za-z0-9._/@:+?=&%[\]-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function stringifyUnknown(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isTruncatedBody(value: unknown): value is Extract<BodyLogValue, { truncated: true }> {
  return Boolean(value && typeof value === "object" && (value as { truncated?: unknown }).truncated === true && typeof (value as { value?: unknown }).value === "string");
}

function spaces(count: number): string {
  return " ".repeat(count);
}

function normalizeUpstreamBaseUrl(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Model HTTP logger requires a provider baseUrl");
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported provider baseUrl protocol for model HTTP logger: ${url.protocol}`);
  }
  return url;
}

function resolveMaxLogBytes(explicit: number | undefined): number {
  if (explicit && Number.isInteger(explicit) && explicit > 0) return explicit;
  const parsed = Number(process.env.AGENTSTUDIO_MODEL_HTTP_LOG_MAX_BYTES);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return DEFAULT_MAX_LOG_BYTES;
}

function formatDayKey(now: Date): string {
  return now.toISOString().slice(0, 10).replaceAll("-", "");
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
