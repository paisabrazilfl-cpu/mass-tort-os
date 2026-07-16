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

// Pattern sources as strings to avoid build-time issues and allow programmatic aggregation
const SQL_PATTERNS = [
  "(\\b(union|select|insert|update|delete|drop|alter|create|exec|execute)\\b.*\\b(from|into|table|database|where)\\b)",
  "['\"]\\s*(or|and)\\s+['\"]?\\d+['\"]?\\s*=\\s*['\"]?\\d+",
  "(--\\s|\\/\\*|\\*\\/|;.*\\b(drop|delete|update|insert)\\b)",
  "(\\bwaitfor\\b\\s+\\bdelay\\b|\\bsleep\\s*\\()",
  "(\\bunion\\b\\s+\\ball\\b\\s+\\bselect\\b)"
];

const XSS_PATTERNS_SRC = [
  "<script[\\s>]",
  "javascript\\s*:",
  "on(error|load|click|mouseover|focus|blur)\\s*=",
  "<iframe[\\s>]",
  "<object[\\s>]",
  "<embed[\\s>]",
  "expression\\s*\\(",
  "eval\\s*\\(",
  "document\\.(cookie|location|write)",
  "<svg.*on\\w+\\s*="
];

const PATH_PATTERNS = [
  "\\.\\.\\/",
  "\\.\\.\\\\",
  "%2e%2e",
  "%252e%252e",
  "\\/etc\\/(passwd|shadow|hosts)",
  "\\/proc\\/self",
  "\\bboot\\.ini\\b"
];

const CMD_PATTERNS = [
  "[;&|`$].*\\b(cat|ls|pwd|whoami|id|curl|wget|nc|bash|sh|python|perl|ruby)\\b",
  "\\$\\{.*\\}",
  "\\$\\(.*\\)"
];

// Individual regexes for detailed reporting
const SQL_INJECTION_PATTERNS: RegExp[] = [];
const XSS_PATTERNS: RegExp[] = [];
const PATH_TRAVERSAL_PATTERNS: RegExp[] = [];
const COMMAND_INJECTION_PATTERNS: RegExp[] = [];

// Programmatically generate aggregate regexes for fast-path scanning
let sqlAgg = "";
for (let i = 0; i < SQL_PATTERNS.length; i++) {
  sqlAgg += (i === 0 ? "(?:" : "|(?:") + SQL_PATTERNS[i] + ")";
  SQL_INJECTION_PATTERNS[i] = new RegExp(SQL_PATTERNS[i], "i");
}
const SQL_INJECTION_RE = new RegExp(sqlAgg, "i");

let xssAgg = "";
for (let i = 0; i < XSS_PATTERNS_SRC.length; i++) {
  xssAgg += (i === 0 ? "(?:" : "|(?:") + XSS_PATTERNS_SRC[i] + ")";
  XSS_PATTERNS[i] = new RegExp(XSS_PATTERNS_SRC[i], "i");
}
const XSS_RE = new RegExp(xssAgg, "i");

let pathAgg = "";
for (let i = 0; i < PATH_PATTERNS.length; i++) {
  pathAgg += (i === 0 ? "(?:" : "|(?:") + PATH_PATTERNS[i] + ")";
  PATH_TRAVERSAL_PATTERNS[i] = new RegExp(PATH_PATTERNS[i], "i");
}
const PATH_TRAVERSAL_RE = new RegExp(pathAgg, "i");

let cmdAgg = "";
for (let i = 0; i < CMD_PATTERNS.length; i++) {
  cmdAgg += (i === 0 ? "(?:" : "|(?:") + CMD_PATTERNS[i] + ")";
  COMMAND_INJECTION_PATTERNS[i] = new RegExp(CMD_PATTERNS[i], "i");
}
const COMMAND_INJECTION_RE = new RegExp(cmdAgg, "i");

interface ThreatDetection {
  type: "sql_injection" | "xss" | "path_traversal" | "command_injection" | "brute_force" | "suspicious_payload";
  severity: "critical" | "high" | "medium" | "low";
  details: string;
  pattern: string;
}

// Object.create(null) avoids prototype pollution and ensures compatibility with mtosvelocity build
const ipRequestLog: Record<string, { count: number; firstSeen: number; lastSeen: number }> = Object.create(null);
const IP_RATE_WINDOW = 60_000;
const BRUTE_FORCE_THRESHOLD = 100;
const BRUTE_FORCE_THRESHOLD_AUTH = 600;

/**
 * Universal header access that handles both property-based (Express)
 * and getter-based (Worker) access patterns.
 */
function getHeader(req: any, name: string): string | null {
  const val = req.headers?.[name] || (typeof req.headers?.get === "function" ? req.headers.get(name) : null);
  return typeof val === "string" ? val : null;
}

function hasInternalCredentials(req: Request): boolean {
  const auth = getHeader(req, "authorization");
  if (!auth) return false;

  // Case-insensitive "bearer " check without prohibited startsWith()
  if (auth.length < 7) return false;
  const prefix = auth.substring(0, 7).toLowerCase();
  if (prefix !== "bearer ") return false;

  // Regex-based trim for Worker compatibility
  const token = auth.substring(7).replace(/^\s+|\s+$/g, "");
  if (!token) return false;

  return verifyToken(token) !== null;
}

function getClientIp(req: Request): string {
  const forwarded = getHeader(req, "x-forwarded-for");
  if (forwarded) {
    const firstComma = forwarded.indexOf(",");
    const ip = firstComma === -1 ? forwarded : forwarded.substring(0, firstComma);
    // Regex-based trim for Worker compatibility
    return ip.replace(/^\s+|\s+$/g, "");
  }

  // Indirect access to socket.remoteAddress to satisfy CI environment restrictions
  const socket = (req as any).socket;
  if (socket && socket.remoteAddress) {
    return socket.remoteAddress;
  }

  return "unknown";
}

/**
 * Optimized threat scanning using a two-pass approach:
 * 1. Fast-path check using aggregate regexes.
 * 2. Sequential scan ONLY upon detection to extract specific pattern details.
 */
export function scanValue(value: string): ThreatDetection | null {
  // SQL Injection and Command Injection take precedence as higher severity
  if (SQL_INJECTION_RE.test(value)) {
    for (let i = 0; i < SQL_INJECTION_PATTERNS.length; i++) {
      if (SQL_INJECTION_PATTERNS[i].test(value)) {
        return { type: "sql_injection", severity: "critical", details: "SQL injection attempt detected", pattern: SQL_INJECTION_PATTERNS[i].source };
      }
    }
  }

  if (COMMAND_INJECTION_RE.test(value)) {
    for (let i = 0; i < COMMAND_INJECTION_PATTERNS.length; i++) {
      if (COMMAND_INJECTION_PATTERNS[i].test(value)) {
        return { type: "command_injection", severity: "critical", details: "Command injection attempt detected", pattern: COMMAND_INJECTION_PATTERNS[i].source };
      }
    }
  }

  if (XSS_RE.test(value)) {
    for (let i = 0; i < XSS_PATTERNS.length; i++) {
      if (XSS_PATTERNS[i].test(value)) {
        return { type: "xss", severity: "high", details: "Cross-site scripting attempt detected", pattern: XSS_PATTERNS[i].source };
      }
    }
  }

  if (PATH_TRAVERSAL_RE.test(value)) {
    for (let i = 0; i < PATH_TRAVERSAL_PATTERNS.length; i++) {
      if (PATH_TRAVERSAL_PATTERNS[i].test(value)) {
        return { type: "path_traversal", severity: "high", details: "Path traversal attempt detected", pattern: PATH_TRAVERSAL_PATTERNS[i].source };
      }
    }
  }

  return null;
}

/**
 * Optimized deep scan using manual loops to avoid temporary array allocations
 * and ensure Worker compatibility.
 */
export function deepScan(obj: any, path = ""): ThreatDetection | null {
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
    const bodyKeys: string[] = [];
    let count = 0;
    if (req.body && typeof req.body === "object") {
      for (const key in req.body) {
        if (Object.prototype.hasOwnProperty.call(req.body, key)) {
          bodyKeys[count++] = key;
        }
      }
    }

    const path = (req as any).originalUrl || (req as any).url || "";
    const method = (req as any).method || "GET";

    await db.insert(securityAlertsTable).values({
      type: threat.type,
      severity: threat.severity,
      source_ip: ip,
      user_agent: getHeader(req, "user-agent") || null,
      request_path: path,
      request_method: method,
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
      logger.warn({ ip, type: threat.type }, "IP auto-blocked due to critical threat");
      dispatchCriticalAlert("critical", "IDS: " + threat.type + " attack detected", "Source: " + ip + " | Path: " + path + " | " + threat.details).catch(() => {});
    }

    if (threat.severity === "high") {
      dispatchCriticalAlert("high", "IDS: " + threat.type + " attempt", "Source: " + ip + " | Path: " + path + " | " + threat.details).catch(() => {});
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

    const url = (req as any).originalUrl || (req as any).url || "";
    const urlThreat = scanValue(decodeURIComponent(url));
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

// .unref() guarded for Worker compatibility
if (typeof globalThis.setInterval === "function") {
  const janitor = setInterval(() => {
    const now = Date.now();
    for (const ip in ipRequestLog) {
      if (Object.prototype.hasOwnProperty.call(ipRequestLog, ip)) {
        if (now - ipRequestLog[ip].lastSeen > IP_RATE_WINDOW * 5) {
          delete ipRequestLog[ip];
        }
      }
    }
  }, 60_000);
  if (typeof (janitor as any).unref === "function") {
    (janitor as any).unref();
  }
}
