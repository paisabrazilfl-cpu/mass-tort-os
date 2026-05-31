import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes";
import publicSitesRouter from "./routes/public-sites";
import { logger } from "./lib/logger";
import { idsMiddleware } from "./lib/ids";
import { markPublic, validateRouteTable } from "./lib/route-protection";

const app: Express = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  noSniff: true,
  xssFilter: true,
}));

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
}));

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Permissive CORS for the embeddable public web-forms surface. These
// endpoints are intentionally designed to be loaded and POSTed from any
// third-party landing page (the whole point of an embeddable form), so
// they need to allow any origin. Credentials are NOT allowed here — there
// is no auth cookie flowing; rate limiting is IP-based; the audit log
// captures the submitting Origin. This middleware is mounted BEFORE the
// strict global CORS so that preflight OPTIONS for /api/web-forms/* is
// answered correctly and the request never reaches the strict matcher.
app.use("/api/web-forms", cors({
  origin: true,
  credentials: false,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  maxAge: 86400,
}));
// Strict CORS for the CRM admin app and all other authenticated routes.
// REPL_SLUG may not be injected in autoscale; fall back to ALLOWED_ORIGIN
// and PUBLIC_BASE_URL so monitoring and the SPA still work in production
// even if the Replit env var is absent. If none resolve, lock down to false
// (deny all cross-origin) rather than silently allowing everything.
const prodOrigins: string[] = [
  process.env.REPL_SLUG ? `https://${process.env.REPL_SLUG}.replit.app` : null,
  process.env.ALLOWED_ORIGIN ?? null,
  process.env.PUBLIC_BASE_URL ?? null,
].filter((o): o is string => Boolean(o));
app.use(cors({
  origin: process.env.NODE_ENV === "production"
    ? (prodOrigins.length > 0 ? prodOrigins : false)
    : true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));
// Capture the raw request bytes for webhook routes so HMAC signature
// verification can run against the EXACT bytes the provider signed.
// Re-serializing via JSON.stringify(req.body) reorders keys / changes
// number formatting / drops insignificant whitespace and silently breaks
// signature checks on legitimate webhooks. We only attach `rawBody` for
// `/api/webhooks/*` to avoid a memory hit on every request.
// Webhook routes need 55 MB to handle large provider payloads and raw-body
// HMAC verification. All other routes get a 1 MB cap — a 55 MB global limit
// let attackers POST huge bodies to every unauthenticated endpoint (e.g.
// /api/auth/login, /api/web-forms/*) to cause OOM pressure on the API process.
app.use(express.json({
  limit: "55mb",
  verify: (req, _res, buf) => {
    const url = req.url ?? "";
    if (
      buf && buf.length > 0 &&
      (url.startsWith("/api/webhooks/") || url.startsWith("/api/automations/webhook/"))
    ) {
      (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    }
    // Enforce 1 MB limit on all non-webhook routes. The express.json limit
    // above is set high so webhooks can pass; we do a secondary check here
    // against everything else. Throwing causes Express to surface a 413.
    if (
      !url.startsWith("/api/webhooks/") &&
      !url.startsWith("/api/automations/webhook/") &&
      buf && buf.length > 1 * 1024 * 1024
    ) {
      // Cast to `any` so we can attach the HTTP status code that Express's
      // global error handler reads. `ErrnoException` doesn't carry `status`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err: any = new Error("Request body too large");
      err.status = 413;
      throw err;
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(idsMiddleware());

app.use("/api", router);

// Deny-by-default backstop: walk the freshly-mounted router and throw if
// any non-public terminal route is missing authMiddleware or a role /
// permission gate. Synchronous + at module-load so the process crashes
// before app.listen() accepts a connection.
validateRouteTable(router as unknown as import("express").Router);

// 404 for unknown /api/* routes — without this, Express falls through to
// the default HTML "Cannot GET /api/foo" page which breaks the CRM client's
// JSON parser. Mirrors the global error envelope shape.
app.use("/api", (req: express.Request, res: express.Response) => {
  res.status(404).json({
    status: "error",
    code: "not_found",
    message: `No API route matches ${req.method} ${req.path}`,
  });
});

// Public Site Maker pages — server-rendered intake (/intake/:slug) and landing
// (/c/:category/:slug) pages. Mounted BEFORE the SPA fallback so these paths
// are served by the API server (not the React shell). The router is markPublic.
// The /intake and /c path prefixes are registered to this artifact's proxy
// services so the shared proxy routes them here.
app.use(publicSitesRouter);

// Production SPA serving — when deployed to Replit Autoscale (or any
// single-process target), this same Express server also serves the built
// React CRM bundle. In dev, the Vite dev server runs separately on its
// own port and this block is a no-op (publicDir does not exist yet).
//
// Resolution: the API server is bundled to artifacts/api-server/dist/server/
// at runtime, so the CRM build sits at ../../mtos-crm/dist/public relative
// to that. We also try a project-root path so the same logic works whether
// invoked from the bundled dist or via tsx in tests.
// Resolve relative to the bundled server file location too — when Replit
// Autoscale runs `node artifacts/api-server/dist/server/index.mjs` the
// process cwd is NOT guaranteed to be the project root (it can be /app or
// the dist dir), which silently breaks process.cwd()-only resolution and
// leaves the SPA fallback unmounted — so /, /login, etc. fall through to
// the default Express 500 page. The __dirname candidate fixes that.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const candidateSpaDirs = [
  path.resolve(process.cwd(), "artifacts/mtos-crm/dist/public"),
  path.resolve(process.cwd(), "../mtos-crm/dist/public"),
  // Bundled file is at artifacts/api-server/dist/server/index.mjs → up 3
  // levels = artifacts/, then mtos-crm/dist/public.
  path.resolve(__dirname, "../../../mtos-crm/dist/public"),
  // Same idea but if the bundle ever lands one level shallower.
  path.resolve(__dirname, "../../mtos-crm/dist/public"),
];
const spaDir = candidateSpaDirs.find((p) => existsSync(p));

if (spaDir) {
  logger.info({ spa_dir: spaDir }, "Serving CRM SPA static bundle");
  app.use(express.static(spaDir, {
    index: false,
    maxAge: "1h",
    setHeaders: (res, filePath) => {
      // index.html must never be cached — it's the SPA entry and must
      // always reflect the latest deployed bundle hash.
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  }));

  // SPA fallback: any non-API GET that didn't match a static file gets
  // index.html so the React Router can take over client-side. POSTs and
  // other non-GET methods to unknown paths fall through to a JSON 404
  // below to avoid masking real client bugs. Mounted on a markPublic'd
  // sub-router so the route-protection validator recognises it as a
  // deliberately public route (serving the React shell, no PII, no auth).
  const spaRouter = markPublic(express.Router(), "spa");
  spaRouter.get(/^(?!\/api\/).*/, (req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.sendFile(path.join(spaDir, "index.html"), (err) => {
      if (err) {
        // Forward to global JSON error handler so the client gets a
        // structured error instead of Express's plain-text default page.
        next(err);
      }
    });
  });
  app.use(spaRouter);
} else {
  // Loud, structured warning so this misconfiguration is immediately
  // visible in deployment logs instead of silently 500-ing the SPA.
  logger.warn(
    { tried: candidateSpaDirs, cwd: process.cwd(), dirname: __dirname },
    "SPA bundle not found — non-API requests will return JSON 404. Did the mtos-crm build step run before deploy?",
  );
  // Mount a fallback that returns a clear JSON error for non-API requests
  // so users don't get the bare "Internal Server Error" plain-text page.
  const spaMissingRouter = markPublic(express.Router(), "spa");
  spaMissingRouter.get(/^(?!\/api\/).*/, (_req: express.Request, res: express.Response) => {
    res.status(503).json({
      status: "error",
      code: "spa_bundle_missing",
      message: "Frontend bundle not deployed. The API is up at /api/* but the React app was not built into this deployment.",
    });
  });
  app.use(spaMissingRouter);
}

// Final 404 for non-API non-static paths (e.g. POST to an unknown URL).
// Returns JSON so any accidental cross-origin call gets a parseable
// response instead of an HTML page.
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({
    status: "error",
    code: "not_found",
    message: `No route matches ${req.method} ${req.path}`,
  });
});

// Global error envelope. Every route that throws (or calls next(err)) ends
// up here. We keep the shape consistent with the explicit `badRequest()`
// helper used in routes/auth.ts so the CRM frontend has ONE error contract:
//   { status: "error", code: <stable_string>, message: <human>, details?: ... }
// We deliberately do not echo stack traces or raw error.message on 5xx —
// those can leak SQL fragments, internal paths, or PII.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const errObj = (typeof err === "object" && err !== null) ? (err as Record<string, unknown>) : {};

  const rawStatus = typeof errObj.status === "number"
    ? errObj.status
    : typeof errObj.statusCode === "number"
      ? (errObj.statusCode as number)
      : 500;
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;

  logger.error({ err: rawMessage, stack, status }, "Unhandled error");

  // Client-fault codes (400-499) get a more specific envelope when the thrown
  // error already carries a code/message; 5xx are intentionally generic.
  if (status >= 400 && status < 500) {
    const code = typeof errObj.code === "string" ? (errObj.code as string) : "request_error";
    const message = typeof errObj.message === "string" && (errObj.message as string).length > 0
      ? (errObj.message as string)
      : "Request rejected";
    const details = errObj.details;
    res.status(status).json({
      status: "error",
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    });
    return;
  }

  res.status(status).json({
    status: "error",
    code: "internal_error",
    message: "Internal server error",
  });
});

export default app;
