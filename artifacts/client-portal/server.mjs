// Production static server for the client portal.
// Serves the Vite bundle under dist/public and proxies /api/* to the API service.
//
// Env vars:
//   PORT          — bind port (Railway injects)
//   API_BASE_URL  — upstream API origin (no trailing slash)

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 5174;
const API_BASE_URL = (
  process.env.API_BASE_URL ??
  process.env.VITE_API_BASE_URL ??
  ""
).replace(/\/+$/, "");

process.stdout.write(`[client-portal] startup — PORT=${PORT} API_BASE_URL=${API_BASE_URL || "(not set)"} node=${process.version}\n`);

if (!API_BASE_URL) {
  process.stdout.write("[client-portal] FATAL: API_BASE_URL is required. Set it on the Railway service.\n");
  setTimeout(() => process.exit(1), 2000);
}

const DIST_DIR = path.resolve(__dirname, "dist", "public");
const distExists = fs.existsSync(DIST_DIR);
const INDEX_HTML = path.join(DIST_DIR, "index.html");

if (!distExists) {
  process.stdout.write(`[client-portal] FATAL: build output not found at ${DIST_DIR}.\n`);
  setTimeout(() => process.exit(1), 2000);
}

const apiOrigin = new URL(API_BASE_URL || "http://localhost");
const upstream = apiOrigin.protocol === "https:" ? https : http;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".map":  "application/json; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
};

function proxyRequest(req, res) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];

  const target = new URL(req.url, API_BASE_URL);
  const options = {
    method: req.method,
    hostname: apiOrigin.hostname,
    port: apiOrigin.port || (apiOrigin.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    headers: {
      ...headers,
      host: apiOrigin.host,
      "x-forwarded-host": req.headers.host ?? "",
      "x-forwarded-proto": "https",
      "x-forwarded-for": req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "",
    },
  };

  const upstreamReq = upstream.request(options, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "error", code: "upstream_error", message: err.message }));
  });

  req.pipe(upstreamReq);
}

function resolveStatic(reqUrl) {
  const cleanPath = decodeURIComponent(reqUrl.split("?")[0].split("#")[0]);
  if (cleanPath.includes("\0") || cleanPath.includes("\\")) return null;
  const resolved = path.resolve(DIST_DIR, "." + cleanPath);
  if (!resolved.startsWith(DIST_DIR + path.sep) && resolved !== DIST_DIR) return null;
  if (!fs.existsSync(resolved)) return null;
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return null;
  return resolved;
}

function serveFile(filePath, res, statusOverride) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] ?? "application/octet-stream";
  const stat = fs.statSync(filePath);
  const isHashed = filePath.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(statusOverride ?? 200, {
    "content-type": contentType,
    "content-length": stat.size,
    "cache-control": isHashed
      ? "public, max-age=31536000, immutable"
      : "no-cache, must-revalidate",
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  try {
    const url = req.url ?? "/";
    if (url.startsWith("/api/") || url === "/api" || url.startsWith("/healthz")) {
      return proxyRequest(req, res);
    }

    if (distExists) {
      const filePath = resolveStatic(url);
      if (filePath) return serveFile(filePath, res);
      if (fs.existsSync(INDEX_HTML)) return serveFile(INDEX_HTML, res, 200);
    }

    res.writeHead(503, { "content-type": "text/plain" });
    res.end("Service starting — dist not ready");
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal server error");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`[client-portal] listening on 0.0.0.0:${PORT}\n`);
});

process.on("SIGTERM", () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000).unref(); });
process.on("SIGINT",  () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000).unref(); });
