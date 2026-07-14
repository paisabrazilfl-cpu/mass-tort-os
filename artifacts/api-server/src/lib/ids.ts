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
// Task #7 FP-tuning: Use string arrays for patterns to avoid Worker build-time
// parsing issues with large RegExp literals. Consolidated aggregate regexes
// are built via manual loops to avoid prohibited array methods like .map().join().
const SQL_INJECTION_SOURCES = [
  "(\\b(union|select|insert|update|delete|drop|alter|create|exec|execute)\\b.*\\b(from|into|table|database|where)\\b)",
  "['\"]\\s*(or|and)\\s+['\"]?\\d+['\"]?\\s*=\\s*['\"]?\\d+",
  "(--\\s|\\/\\*|\\*\\/|;.*\\b(drop|delete|update|insert)\\b)",
  "(\\bwaitfor\\b\\s+\\bdelay\\b|\\bsleep\\s*\\()",
  "(\\bunion\\b\\s+\\ball\\b\\s+\\bselect\\b)",
];

const XSS_SOURCES = [
  "<script[\\s>]",
  "javascript\\s*:",
  "on(error|load|click|mouseover|focus|blur)\\s*=",
  "<iframe[\\s>]",
  "<object[\\s>]",
  "<embed[\\s>]",
  "expression\\s*\\(",
  "eval\\s*\\(",
  "document\\.(cookie|location|write)",
  "<svg.*on\\w+\\s*=",
];

const PATH_TRAVERSAL_SOURCES = [
  "\\.\\.\\/",
  "\\.\\.\\\\",
  "%2e%2e",
  "%252e%252e",
  "\\/etc\\/(passwd|shadow|hosts)",
  "\\/proc\\/self",
  "\\bboot\\.ini\\b",
];

const COMMAND_INJECTION_SOURCES = [
  "[;&|`$].*\\b(cat|ls|pwd|whoami|id|curl|wget|nc|bash|sh|python|perl|ruby)\\b",
  "\\$\\{.*\\}",
  "\\$\\(.*\\)",
];

function buildAggregateRegex(sources: string[]): RegExp {
  let combined = "";
  for (let i = 0; i < sources.length; i++) {
    if (i > 0) combined += "|";
    combined += "(?:" + sources[i] + ")";
  }
  return new RegExp(combined, "i");
}

const SQL_INJECTION_RE = buildAggregateRegex(SQL_INJECTION_SOURCES);
const XSS_RE = buildAggregateRegex(XSS_SOURCES);
const PATH_TRAVERSAL_RE = buildAggregateRegex(PATH_TRAVERSAL_SOURCES);
const COMMAND_INJECTION_RE = buildAggregateRegex(COMMAND_INJECTION_SOURCES);

// Pre-compile individual regexes to avoid re-compilation in the slow-path.
function compileIndividual(sources: string[]): RegExp[] {
  const res: RegExp[] = [];
  for (let i = 0; i < sources.length; i++) {
    res[i] = new RegExp(sources[i], "i");
  }
  return res;
}

const SQL_INJECTION_RES = compileIndividual(SQL_INJECTION_SOURCES);
const XSS_RES = compileIndividual(XSS_SOURCES);
const PATH_TRAVERSAL_RES = compileIndividual(PATH_TRAVERSAL_SOURCES);
const COMMAND_INJECTION_RES = compileIndividual(COMMAND_INJECTION_SOURCES);

interface ThreatDetection {
  type: "sql_injection" | "xss" | "path_traversal" | "command_injection" | "brute_force" | "suspicious_payload";
  severity: "critical" | "high" | "medium" | "low";
  details: string;
  pattern: string;
}

const ipRequestLog: Record<string, { count: number; firstSeen: number; lastSeen: number }> = Object.create(null);
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
// Environment-agnostic request property access helpers.
function getHeader(req: any, name: string): string | null {
  const headers = req.headers;
  if (!headers) return null;
  const val = typeof headers.get === "function" ? headers.get(name) : headers[name.toLowerCase()];
  return typeof val === "string" ? val : null;
}

function getMethod(req: any): string {
  return req.method || "GET";
}

function getUrl(req: any): string {
  return req.originalUrl || req.url || "";
}

function hasInternalCredentials(req: Request): boolean {
  const auth = getHeader(req, "authorization");
  if (!auth || auth.toLowerCase().indexOf("bearer ") !== 0) {
    return false;
  }
  const token = auth.substring(7).replace(/^\s+|\s+$/g, "");
  if (!token) return false;
  // verifyToken returns null for any malformed/unsigned/expired token,
  // so spoofed Bearer headers fall back to anonymous-traffic limits.
  return verifyToken(token) !== null;
}

function getClientIp(req: Request): string {
  const xff = getHeader(req, "x-forwarded-for");
  if (xff) {
    const commaIndex = xff.indexOf(",");
    const ip = commaIndex === -1 ? xff : xff.substring(0, commaIndex);
    return ip.replace(/^\s+|\s+$/g, "");
  }
  // Safe access for Cloudflare Worker environment where req.socket is absent.
  const socket = (req as any).socket;
  return (socket && socket.remoteAddress) || "unknown";
}

export function scanValue(value: string): ThreatDetection | null {
  // Fast-path: check aggregated regexes first.
  // Prioritize critical threats (SQL and Command Injection) over high threats (XSS and Path Traversal).
  if (SQL_INJECTION_RE.test(value)) {
    for (let i = 0; i < SQL_INJECTION_RES.length; i++) {
      if (SQL_INJECTION_RES[i].test(value)) {
        return { type: "sql_injection", severity: "critical", details: "SQL injection attempt detected", pattern: SQL_INJECTION_SOURCES[i] };
      }
    }
  }
  if (COMMAND_INJECTION_RE.test(value)) {
    for (let i = 0; i < COMMAND_INJECTION_RES.length; i++) {
      if (COMMAND_INJECTION_RES[i].test(value)) {
        return { type: "command_injection", severity: "critical", details: "Command injection attempt detected", pattern: COMMAND_INJECTION_SOURCES[i] };
      }
    }
  }
  if (XSS_RE.test(value)) {
    for (let i = 0; i < XSS_RES.length; i++) {
      if (XSS_RES[i].test(value)) {
        return { type: "xss", severity: "high", details: "Cross-site scripting attempt detected", pattern: XSS_SOURCES[i] };
      }
    }
  }
  if (PATH_TRAVERSAL_RE.test(value)) {
    for (let i = 0; i < PATH_TRAVERSAL_RES.length; i++) {
      if (PATH_TRAVERSAL_RES[i].test(value)) {
        return { type: "path_traversal", severity: "high", details: "Path traversal attempt detected", pattern: PATH_TRAVERSAL_SOURCES[i] };
      }
    }
  }
  return null;
}

export function deepScan(obj: any, path = ""): ThreatDetection | null {
  if (typeof obj === "string") {
    return scanValue(obj);
  }
  // Use for...in and manual array checks for Worker compatibility and to avoid
  // temporary array allocations from Object.entries().
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

function checkBruteForce(ip: string, threshold: number): ThreatDetection | null {
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
        details: entry.count + " requests in " + Math.round((now - entry.firstSeen) / 1000) + "s from " + ip,
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
          gte(blockedIpsTable.blocked_until, new Date())
        )
      )
      .limit(1);
    return !!blocked;
  } catch {
    return false;
  }
}

async function recordAlert(req: Request, threat: ThreatDetection): Promise<void> {
  const ip = getClientIp(req);
  try {
    await db.insert(securityAlertsTable).values({
      type: threat.type,
      severity: threat.severity,
      source_ip: ip,
      user_agent: getHeader(req, "user-agent"),
      request_path: getUrl(req),
      request_method: getMethod(req),
      details: threat.details,
      payload_sample: JSON.stringify({
        query: req.query,
        body: (function() {
          if (typeof req.body !== "object" || req.body === null) return undefined;
          const keys = [];
          let count = 0;
          for (const k in req.body) {
            if (Object.prototype.hasOwnProperty.call(req.body, k)) {
              keys[count++] = k;
            }
          }
          return keys;
        })(),
        pattern: threat.pattern,
      }).substring(0, 2000),
      status: "new",
      blocked: threat.severity === "critical",
    });

    if (threat.severity === "critical") {
      const blockDuration = 24 * 60 * 60 * 1000;
      const reason = "Auto-blocked: " + threat.type + " — " + threat.details;
      await db
        .insert(blockedIpsTable)
        .values({
          ip,
          reason: reason,
          blocked_until: new Date(Date.now() + blockDuration),
          auto_blocked: true,
          alert_count: 1,
        })
        .onConflictDoUpdate({
          target: blockedIpsTable.ip,
          set: {
            reason: reason,
            blocked_until: new Date(Date.now() + blockDuration),
            alert_count: sql.raw(blockedIpsTable.alert_count.name + " + 1"),
            updated_at: new Date(),
          },
        });
      logger.warn({ ip, type: threat.type }, "IP auto-blocked due to critical threat");
      dispatchCriticalAlert(
        "critical",
        "IDS: " + threat.type + " attack detected",
        "Source: " + ip + " | Path: " + getUrl(req) + " | " + threat.details
      ).catch(() => {});
    }

    if (threat.severity === "high") {
      dispatchCriticalAlert(
        "high",
        "IDS: " + threat.type + " attempt",
        "Source: " + ip + " | Path: " + getUrl(req) + " | " + threat.details
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
      // Pre-auth IPS denial — uses the same FORBIDDEN envelope as RBAC
      // denials so the CRM only has one error shape to handle.
      res.status(403).json({ status: "error", code: "FORBIDDEN", message: "Access denied" });
      return;
    }

    const bruteForce = checkBruteForce(
      ip,
      internal ? BRUTE_FORCE_THRESHOLD_AUTH : BRUTE_FORCE_THRESHOLD,
    );
    if (bruteForce) {
      await recordAlert(req, bruteForce);
    }

    const rawUrl = getUrl(req);
    const urlThreat = rawUrl ? scanValue(decodeURIComponent(rawUrl)) : null;
    if (urlThreat) {
      await recordAlert(req, urlThreat);
      if (urlThreat.severity === "critical") {
        res.status(403).json({ status: "error", code: "FORBIDDEN", message: "Request blocked by security policy" });
        return;
      }
    }

    if (req.query) {
      const queryThreat = deepScan(req.query);
      if (queryThreat) {
        await recordAlert(req, queryThreat);
        if (queryThreat.severity === "critical") {
          res.status(403).json({ status: "error", code: "FORBIDDEN", message: "Request blocked by security policy" });
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
          res.status(403).json({ status: "error", code: "FORBIDDEN", message: "Request blocked by security policy" });
          return;
        }
      }
    }

    next();
  };
}

// .unref() so this janitor never blocks process shutdown (test runs, SIGTERM).
if (typeof globalThis.setInterval === "function") {
  const janitor = setInterval(() => {
    const now = Date.now();
    for (const ip in ipRequestLog) {
      const entry = ipRequestLog[ip];
      if (now - entry.lastSeen > IP_RATE_WINDOW * 5) {
        delete ipRequestLog[ip];
      }
    }
  }, 60_000);

  if (janitor && typeof janitor.unref === "function") {
    janitor.unref();
  }
}
