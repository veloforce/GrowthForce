import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const rootDir = path.join(repoRoot, "dist", "renderer");
const port = getPort(process.argv.slice(2));

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const requestPath = decodeURIComponent(url.pathname);
  const filePath = resolveFilePath(rootDir, requestPath);

  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  try {
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Failed to read asset");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Static renderer server running on http://127.0.0.1:${port}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

function getPort(args) {
  const index = args.indexOf("--port");
  if (index >= 0 && args[index + 1]) return Number(args[index + 1]);
  return Number(process.env.AGENTSTUDIO_BROWSER_TEST_PORT ?? 4173);
}

function resolveFilePath(root, requestPath) {
  const target = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const normalized = path.normalize(path.join(root, target));
  if (!normalized.startsWith(root)) return null;

  if (fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
    return normalized;
  }

  if (!requestPath.startsWith("/assets/")) {
    const fallback = path.join(root, "index.html");
    if (fs.existsSync(fallback)) return fallback;
  }

  return null;
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  if (filePath.endsWith(".icns")) return "image/icns";
  return "application/octet-stream";
}
