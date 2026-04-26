import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { idsMiddleware } from "./lib/ids";
import { validateRouteTable } from "./lib/route-protection";

const app: Express = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
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

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
  keyGenerator: (req) => {
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.socket.remoteAddress
      || "unknown";
  },
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
app.use(cors({
  origin: process.env.NODE_ENV === "production"
    ? [process.env.REPL_SLUG ? `https://${process.env.REPL_SLUG}.replit.app` : ""].filter(Boolean)
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
app.use(express.json({
  limit: "55mb",
  verify: (req, _res, buf) => {
    if (req.url?.startsWith("/api/webhooks/") && buf && buf.length > 0) {
      (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: "55mb" }));

app.use(idsMiddleware());

app.use("/api", router);

// Boot-time route table validator (Task #10). Walks the freshly-mounted
// router and throws if any non-public terminal route is missing
// authMiddleware or a requireRole/requirePermission gate. This is the
// deny-by-default backstop — a contributor cannot ship an unprotected
// handler, even if every other code review and lint rule misses it.
// Synchronous + at module-load time so the process crashes BEFORE
// app.listen() ever accepts a connection.
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
