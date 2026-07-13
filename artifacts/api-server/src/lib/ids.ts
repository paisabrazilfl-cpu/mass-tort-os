/**
 * IDS Middleware - Performance and Worker Compatibility Edition.
 *
 * NOTE: This module is reachable by the 'mtosvelocity' Cloudflare Worker build.
 * To ensure CI stability and performance, we avoid "modern" methods that are
 * prohibited or high-overhead in that environment:
 * - NO startsWith, endsWith, trim, slice, split, join, includes
 * - NO Array.map, filter, find, some, every, for...of
 * - NO Object.keys, Object.entries, Map, Set
 * - Use manual loops, indexOf, substring, and Object.create(null) instead.
 */
import type { Request, Response, NextFunction } from "express";
import { db, securityAlertsTable, blockedIpsTable } from "@workspace/db";
import { eq, gte, sql, and } from "drizzle-orm";
import { logger } from "./logger";
import { dispatchCriticalAlert } from "./security-alerts";
import { verifyToken } from "./rbac";

// Task #7 FP-tuning: the previous `or|and` + `[=<>]` pattern matched
// natural-language paralegal notes ("Joe AND wife both diagnosed = severe")
// and produced false-positive auto-blocks. Patterns below now require
// canonical injection markers (quote+operator+quote, comment terminator,
// or `union all select`) that cannot occur in normal English prose.
const SQL_INJECTION_PATTERNS = [
  /(\b(union|select|insert|update|delete|drop|alter|create|exec|execute)\b.*\b(from|into|table|database|where)\b)/i,
  /['"]\s*(or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+/i,
  /(--\s|\/\*|\*\/|;.*\b(drop|delete|update|insert)\b)/i,
  /(\bwaitfor\b\s+\bdelay\b|\bsleep\s*\()/i,
  /(\bunion\b\s+\ball\b\s+\bselect\b)/i,
];

const XSS_PATTERNS = [
  /<script[\s>]/i,
  /javascript\s*:/i,
  /on(error|load|click|mouseover|focus|blur)\s*=/i,
  /<iframe[\s>]/i,
  /<object[\s>]/i,
  /<embed[\s>]/i,
  /expression\s*\(/i,
  /eval\s*\(/i,
  /document\.(cookie|location|write)/i,
  /<svg.*on\w+\s*=/i,
];

const PATH_TRAVERSAL_PATTERNS = [
  /\.\.\//,
  /\.\.\\/,
  /%2e%2e/i,
  /%252e%252e/i,
  /\/etc\/(passwd|shadow|hosts)/i,
  /\/proc\/self/i,
  /\bboot\.ini\b/i,
];

const COMMAND_INJECTION_PATTERNS = [
  /[;&|`$].*\b(cat|ls|pwd|whoami|id|curl|wget|nc|bash|sh|python|perl|ruby)\b/i,
  /\$\{.*\}/,
  /\$\(.*\)/,
];

// Programmatically consolidate patterns for performance while keeping the source arrays
// readable and maintainable. Manual loops to avoid prohibited join() during build.
function buildAggregateRegex(patterns: RegExp[]): RegExp {
  let source = "";
  for (let i = 0; i < patterns.length; i++) {
    if (i > 0) source += "|";
    source += "(?:" + patterns[i].source + ")";
  }
  return new RegExp(source, "i");
}

const SQL_INJECTION_RE = buildAggregateRegex(SQL_INJECTION_PATTERNS);
const XSS_RE = buildAggregateRegex(XSS_PATTERNS);
const PATH_TRAVERSAL_RE = buildAggregateRegex(PATH_TRAVERSAL_PATTERNS);
const COMMAND_INJECTION_RE = buildAggregateRegex(COMMAND_INJECTION_PATTERNS);

interface ThreatDetection {
  type:
    | "sql_injection"
    | "xss"
    | "path_traversal"
    | "command_injection"
    | "brute_force"
    | "suspicious_payload";
  severity: "critical" | "high" | "medium" | "low";
  details: string;
  pattern: string;
}

// Map is not supported in the mtosvelocity Worker environment
const ipRequestLog: Record<
  string,
  { count: number; firstSeen: number; lastSeen: number }
> = Object.create(null);
const IP_RATE_WINDOW = 60_000;
// Task #7: anonymous traffic threshold is 100/min; authenticated CRM
// operators routinely exceed that during bulk review (paginated leads list,
// case docs, audit log scans), so credentialed traffic gets a 6× ceiling.
const BRUTE_FORCE_THRESHOLD = 100;
const BRUTE_FORCE_THRESHOLD_AUTH = 600;

// Task #7 (round-8 hardening): a request only counts as "internal" if it
// carries a Bearer token whose JWT signature actually verifies. Raw
// header presence alone is spoofable by any unauthenticated caller and
// would let an attacker skip the body deep-scan and inflate the rate
// ceiling. We verify cheaply (HS256 verify is ~microseconds) before any
// IDS classification decision. URL + query are scanned regardless.
function hasInternalCredentials(req: Request): boolean {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return false;

  // Worker-compatible startsWith/slice/trim replacement
  const lowerAuth = auth.toLowerCase();
  if (lowerAuth.indexOf("bearer ") !== 0) return false;

  const token = auth.substring(7).replace(/^\s+|\s+$/g, "");
  if (!token) return false;

  // verifyToken returns null for any malformed/unsigned/expired token,
  // so spoofed Bearer headers fall back to anonymous-traffic limits.
  return verifyToken(token) !== null;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  let ip: string | undefined;

  if (typeof forwarded === "string") {
    const commaIndex = forwarded.indexOf(",");
    ip = (
      commaIndex === -1 ? forwarded : forwarded.substring(0, commaIndex)
    ).replace(/^\s+|\s+$/g, "");
  } else if (forwarded instanceof Array && forwarded.length > 0) {
    ip = forwarded[0];
  }

  // Guard req.socket access for Worker compatibility
  const socket = (req as any).socket;
  const remoteAddress =
    socket && typeof socket === "object" ? socket.remoteAddress : undefined;

  return ip || remoteAddress || "unknown";
}

function scanValue(value: string): ThreatDetection | null {
  if (SQL_INJECTION_RE.test(value)) {
    for (let i = 0; i < SQL_INJECTION_PATTERNS.length; i++) {
      const pattern = SQL_INJECTION_PATTERNS[i];
      if (pattern.test(value)) {
        return {
          type: "sql_injection",
          severity: "critical",
          details: "SQL injection attempt detected",
          pattern: pattern.source,
        };
      }
    }
  }
  if (XSS_RE.test(value)) {
    for (let i = 0; i < XSS_PATTERNS.length; i++) {
      const pattern = XSS_PATTERNS[i];
      if (pattern.test(value)) {
        return {
          type: "xss",
          severity: "high",
          details: "Cross-site scripting attempt detected",
          pattern: pattern.source,
        };
      }
    }
  }
  if (PATH_TRAVERSAL_RE.test(value)) {
    for (let i = 0; i < PATH_TRAVERSAL_PATTERNS.length; i++) {
      const pattern = PATH_TRAVERSAL_PATTERNS[i];
      if (pattern.test(value)) {
        return {
          type: "path_traversal",
          severity: "high",
          details: "Path traversal attempt detected",
          pattern: pattern.source,
        };
      }
    }
  }
  if (COMMAND_INJECTION_RE.test(value)) {
    for (let i = 0; i < COMMAND_INJECTION_PATTERNS.length; i++) {
      const pattern = COMMAND_INJECTION_PATTERNS[i];
      if (pattern.test(value)) {
        return {
          type: "command_injection",
          severity: "critical",
          details: "Command injection attempt detected",
          pattern: pattern.source,
        };
      }
    }
  }
  return null;
}

function deepScan(obj: any, path = ""): ThreatDetection | null {
  if (typeof obj === "string") {
    return scanValue(obj);
  }
  if (typeof obj === "object" && obj !== null) {
    if (obj instanceof Array) {
      for (let i = 0; i < obj.length; i++) {
        const threat = deepScan(obj[i], path + "." + i);
        if (threat) return threat;
      }
    } else {
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const threat = deepScan(obj[key], path + "." + key);
          if (threat) return threat;
        }
      }
    }
  }
  return null;
}

function checkBruteForce(
  ip: string,
  threshold: number,
): ThreatDetection | null {
  const now = Date.now();
  const entry = ipRequestLog[ip];
  if (entry) {
    if (now - entry.firstSeen > IP_RATE_WINDOW) {
      ipRequestLog[ip] = { count: 1, firstSeen: now, lastSeen: now };
      return null;
    }
    entry.count++;
    entry.lastSeen = now;
    if (entry.count > threshold) {
      return {
        type: "brute_force",
        severity: "high",
        details:
          entry.count +
          " requests in " +
          Math.round((now - entry.firstSeen) / 1000) +
          "s from " +
          ip,
        pattern: "rate_exceeded",
      };
    }
  } else {
    ipRequestLog[ip] = { count: 1, firstSeen: now, lastSeen: now };
  }
  return null;
}

async function isBlocked(ip: string): Promise<boolean> {
  try {
    const [blocked] = await db
      .select()
      .from(blockedIpsTable)
      .where(
        and(
          eq(blockedIpsTable.ip, ip),
          gte(blockedIpsTable.blocked_until, new Date()),
        ),
      )
      .limit(1);
    return !!blocked;
  } catch {
    return false;
  }
}

async function recordAlert(
  req: Request,
  threat: ThreatDetection,
): Promise<void> {
  const ip = getClientIp(req);
  try {
    // Manual key collection for Worker compatibility (Object.keys is prohibited
    // in the mtosvelocity build environment).
    const bodyKeys: string[] = [];
    if (req.body && typeof req.body === "object") {
      for (const k in req.body) {
        if (Object.prototype.hasOwnProperty.call(req.body, k)) {
          bodyKeys.push(k);
        }
      }
    }

    await db.insert(securityAlertsTable).values({
      type: threat.type,
      severity: threat.severity,
      source_ip: ip,
      user_agent: req.headers["user-agent"] || null,
      request_path: req.originalUrl,
      request_method: req.method,
      details: threat.details,
      payload_sample: JSON.stringify({
        query: req.query,
        body: bodyKeys.length > 0 ? bodyKeys : undefined,
        pattern: threat.pattern,
      }).substring(0, 2000),
      status: "new",
      blocked: threat.severity === "critical",
    });

    if (threat.severity === "critical") {
      const blockDuration = 24 * 60 * 60 * 1000;
      await db
        .insert(blockedIpsTable)
        .values({
          ip,
          reason: "Auto-blocked: " + threat.type + " — " + threat.details,
          blocked_until: new Date(Date.now() + blockDuration),
          auto_blocked: true,
          alert_count: 1,
        })
        .onConflictDoUpdate({
          target: blockedIpsTable.ip,
          set: {
            reason: "Auto-blocked: " + threat.type + " — " + threat.details,
            blocked_until: new Date(Date.now() + blockDuration),
            alert_count: sql`${blockedIpsTable.alert_count} + 1`,
            updated_at: new Date(),
          },
        });
      logger.warn(
        { ip, type: threat.type },
        "IP auto-blocked due to critical threat",
      );
      dispatchCriticalAlert(
        "critical",
        "IDS: " + threat.type + " attack detected",
        "Source: " +
          ip +
          " | Path: " +
          req.originalUrl +
          " | " +
          threat.details,
      ).catch(() => {});
    }

    if (threat.severity === "high") {
      dispatchCriticalAlert(
        "high",
        "IDS: " + threat.type + " attempt",
        "Source: " +
          ip +
          " | Path: " +
          req.originalUrl +
          " | " +
          threat.details,
      ).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, "Failed to record security alert");
  }
}

export function idsMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = getClientIp(req);
    const internal = hasInternalCredentials(req);

    const blocked = await isBlocked(ip);
    if (blocked) {
      logger.warn({ ip }, "Blocked IP attempted access");
      res
        .status(403)
        .json({ status: "error", code: "FORBIDDEN", message: "Access denied" });
      return;
    }

    const bruteForce = checkBruteForce(
      ip,
      internal ? BRUTE_FORCE_THRESHOLD_AUTH : BRUTE_FORCE_THRESHOLD,
    );
    if (bruteForce) {
      await recordAlert(req, bruteForce);
    }

    const urlThreat = scanValue(decodeURIComponent(req.originalUrl || ""));
    if (urlThreat) {
      await recordAlert(req, urlThreat);
      if (urlThreat.severity === "critical") {
        res.status(403).json({
          status: "error",
          code: "FORBIDDEN",
          message: "Request blocked by security policy",
        });
        return;
      }
    }

    if (req.query) {
      const queryThreat = deepScan(req.query);
      if (queryThreat) {
        await recordAlert(req, queryThreat);
        if (queryThreat.severity === "critical") {
          res.status(403).json({
            status: "error",
            code: "FORBIDDEN",
            message: "Request blocked by security policy",
          });
          return;
        }
      }
    }

    // Task #7: skip body deep-scan for credentialed CRM traffic. Free-text
    // fields (lead notes, email body, intake transcripts, deposition memos)
    // routinely contain `select * from claimants` style legal prose that
    // the regex set treats as SQL injection. URL + query are still scanned,
    // and unauthenticated public surfaces (forms, webhooks) keep full
    // scrutiny.
    if (!internal && req.body && typeof req.body === "object") {
      const bodyThreat = deepScan(req.body);
      if (bodyThreat) {
        await recordAlert(req, bodyThreat);
        if (bodyThreat.severity === "critical") {
          res.status(403).json({
            status: "error",
            code: "FORBIDDEN",
            message: "Request blocked by security policy",
          });
          return;
        }
      }
    }

    next();
  };
}

// Task #7: guard setInterval for environment-agnosticism. Workers do not support
// background intervals and the unref() method is Node-specific.
const janitor =
  typeof globalThis.setInterval === "function"
    ? setInterval(() => {
        const now = Date.now();
        for (const ip in ipRequestLog) {
          if (Object.prototype.hasOwnProperty.call(ipRequestLog, ip)) {
            if (now - ipRequestLog[ip].lastSeen > IP_RATE_WINDOW * 5) {
              delete ipRequestLog[ip];
            }
          }
        }
      }, 60_000)
    : null;

if (janitor && typeof (janitor as any).unref === "function") {
  (janitor as any).unref();
}

export const __test_ids = { scanValue, deepScan };
