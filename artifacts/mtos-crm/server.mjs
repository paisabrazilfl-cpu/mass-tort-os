// Production server for the SPA service on Railway. Serves the built Vite
// bundle under dist/public and proxies /api/* + /healthz to the API service.
//
// Why this exists: the SPA's fetch calls use path-relative URLs (`/api/...`)
// so it can be served same-origin as the API. On Railway each service has
// its own *.up.railway.app host, so we need a reverse proxy in front of
// the static bundle. Built with Node's stdlib `http`/`https` modules so we
// don't introduce a new runtime dependency just for proxying.
//
// Env vars:
//   PORT                 — bind port (Railway injects)
//   API_BASE_URL         — upstream API origin (no trailing slash).
//                          Example: https://api-server-production-8349.up.railway.app
//   VITE_API_BASE_URL    — accepted as a fallback alias since the Vite build
//                          step already uses that name; lets you set one
//                          env var in Railway and have both the build and
//                          the runtime read it.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 4173;
const API_BASE_URL = (
  process.env.API_BASE_URL ??
  process.env.VITE_API_BASE_URL ??
  ""
).replace(/\/+$/, "");

process.stdout.write(`[mtos-crm] startup — PORT=${PORT} API_BASE_URL=${API_BASE_URL || "(not set)"} node=${process.version}\n`);

if (!API_BASE_URL) {
  process.stdout.write(
    "[mtos-crm] FATAL: API_BASE_URL (or VITE_API_BASE_URL) is required. Set it on the Railway service so /api/* requests can be proxied to the api-server.\n",
  );
  // Keep process alive briefly so Railway captures the log before exit
  setTimeout(() => process.exit(1), 2000);
}

const DIST_DIR = path.resolve(__dirname, "dist", "public");
const distExists = fs.existsSync(DIST_DIR);
process.stdout.write(`[mtos-crm] dist dir: ${DIST_DIR} — exists=${distExists}\n`);

if (!distExists) {
  process.stdout.write(
    `[mtos-crm] FATAL: build output not found at ${DIST_DIR}. Run \`pnpm --filter @workspace/mtos-crm build\` first.\n`,
  );
  // Keep process alive briefly so Railway captures the log before exit
  setTimeout(() => process.exit(1), 2000);
}

const INDEX_HTML = path.join(DIST_DIR, "index.html");

const apiOrigin = new URL(API_BASE_URL || "http://localhost");
const upstream = apiOrigin.protocol === "https:" ? https : http;

// Conservative mime-type table covering everything Vite emits. Unknown
// extensions fall through to application/octet-stream so the browser at
// least downloads instead of trying to render.
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
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".map":  "application/json; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
  ".pdf":  "application/pdf",
};

function proxyRequest(req, res) {
  if (!API_BASE_URL) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "API_BASE_URL not configured" }));
    return;
  }
  // Strip hop-by-hop headers + the inbound Host so Railway routes the
  // upstream by its own host header (otherwise the request looks like it
  // came from the SPA host and Railway routes it back to us — infinite loop).
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["content-length"]; // let the upstream library recompute

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
      "x-forwarded-for": (req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? ""),
    },
  };

  const upstreamReq = upstream.request(options, (upstreamRes) => {
    // Pass through the upstream status + headers verbatim. CORS isn't an
    // issue because the SPA is now talking to its OWN origin.
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on("error", (err) => {
    process.stdout.write(`proxy: upstream error for ${req.method} ${req.url}: ${err.message}\n`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ status: "error", code: "upstream_error", message: err.message }));
  });

  req.pipe(upstreamReq);
}

// Resolve a request URL to a real path under DIST_DIR, refusing any path
// that escapes via `..` segments. Returns null on miss so the caller can
// SPA-fallback to index.html.
function resolveStatic(reqUrl) {
  // Strip query string + decode URL-encoded segments. URL-encoded `..`
  // wouldn't escape thanks to path.resolve, but we strip queries so cache
  // busters like `index.js?v=2` resolve.
  const cleanPath = decodeURIComponent(reqUrl.split("?")[0].split("#")[0]);
  // Reject paths containing NUL or backslash early — common smuggling shapes.
  if (cleanPath.includes("\0") || cleanPath.includes("\\")) return null;
  const resolved = path.resolve(DIST_DIR, "." + cleanPath);
  // Containment check: must stay under DIST_DIR.
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
  // Long cache for everything under /assets/ (Vite emits hashed filenames
  // there) and no-cache for index.html so users see new bundles on next load.
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
    // Proxy: /api/*, /healthz, /webhook/* (some providers post here without
    // the /api prefix). Anything else falls through to static serving.
    const url = req.url ?? "/";
    if (
      url.startsWith("/api/") ||
      url === "/api" ||
      url.startsWith("/healthz") ||
      url.startsWith("/webhook/")
    ) {
      return proxyRequest(req, res);
    }

    // Static file lookup.
    if (distExists) {
      const filePath = resolveStatic(url);
      if (filePath) return serveFile(filePath, res);

      // SPA fallback — every non-asset path renders index.html so the
      // client-side router can take over.
      if (fs.existsSync(INDEX_HTML)) return serveFile(INDEX_HTML, res, 200);
    }

    res.writeHead(503, { "content-type": "text/plain" });
    res.end("Service starting — dist not ready");
  } catch (err) {
    process.stdout.write(`request handler error: ${err}\n`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal server error");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`[mtos-crm] server listening on 0.0.0.0:${PORT}\n`);
  process.stdout.write(`[mtos-crm] dist: ${DIST_DIR} (exists=${distExists})\n`);
  process.stdout.write(`[mtos-crm] /api/* → ${API_BASE_URL || "(not proxied)"}\n`);
});

function shutdown(sig) {
  process.stdout.write(`[mtos-crm] ${sig} received — closing server\n`);
  server.close(() => process.exit(0));
  // Forced exit if the server doesn't drain in 10 s.
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
