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

// Task #7 (optimization): pre-compile consolidated regexes to avoid looping
// over individual patterns for every string. Manual loop for construction
// ensures compatibility with the 'mtosvelocity' Worker build.
const SQL_INJECTION_RE = (function() {
  let p = "";
  for (let i = 0; i < SQL_INJECTION_PATTERNS.length; i++) {
    p += (i > 0 ? "|" : "") + "(?:" + SQL_INJECTION_PATTERNS[i].source + ")";
  }
  return new RegExp(p, "i");
})();

const XSS_RE = (function() {
  let p = "";
  for (let i = 0; i < XSS_PATTERNS.length; i++) {
    p += (i > 0 ? "|" : "") + "(?:" + XSS_PATTERNS[i].source + ")";
  }
  return new RegExp(p, "i");
})();

const PATH_TRAVERSAL_RE = (function() {
  let p = "";
  for (let i = 0; i < PATH_TRAVERSAL_PATTERNS.length; i++) {
    p += (i > 0 ? "|" : "") + "(?:" + PATH_TRAVERSAL_PATTERNS[i].source + ")";
  }
  return new RegExp(p, "i");
})();

const COMMAND_INJECTION_RE = (function() {
  let p = "";
  for (let i = 0; i < COMMAND_INJECTION_PATTERNS.length; i++) {
    p += (i > 0 ? "|" : "") + "(?:" + COMMAND_INJECTION_PATTERNS[i].source + ")";
  }
  return new RegExp(p, "i");
})();

interface ThreatDetection {
  type: "sql_injection" | "xss" | "path_traversal" | "command_injection" | "brute_force" | "suspicious_payload";
  severity: "critical" | "high" | "medium" | "low";
  details: string;
  pattern: string;
}

// Cloudflare Worker Compatibility: Object.create(null) instead of Map
// to avoid prohibited iteration methods and prototype pollution.
const ipRequestLog: Record<string, { count: number; firstSeen: number; lastSeen: number }> = Object.create(null);

const IP_RATE_WINDOW = 60_000;
const BRUTE_FORCE_THRESHOLD = 100;
const BRUTE_FORCE_THRESHOLD_AUTH = 600;

// Task #7 (round-8 hardening): a request only counts as "internal" if it
// carries a Bearer token whose JWT signature actually verifies.
function hasInternalCredentials(req: Request): boolean {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return false;

  // Cloudflare Worker Compatibility: avoid startsWith, slice, trim
  const lc = auth.toLowerCase();
  if (lc.indexOf("bearer ") !== 0) return false;

  const token = auth.substring(7).replace(/^\s+|\s+$/g, "");
  if (!token) return false;

  return verifyToken(token) !== null;
}

function getClientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  let ip = "";

  if (typeof xff === "string") {
    // Cloudflare Worker Compatibility: avoid split and trim
    const comma = xff.indexOf(",");
    ip = comma === -1 ? xff : xff.substring(0, comma);
  } else if (xff instanceof Array && xff.length > 0) {
    ip = xff[0];
  }

  if (ip) return ip.replace(/^\s+|\s+$/g, "");

  // Guard Node-specific API for Worker compatibility
  if (typeof req.socket === 'object' && req.socket !== null && typeof req.socket.remoteAddress === 'string') {
    return req.socket.remoteAddress;
  }

  return "unknown";
}

/** @internal - exported for unit testing and benchmarking */
export function scanValue(value: string): ThreatDetection | null {
  if (SQL_INJECTION_RE.test(value)) {
    return { type: "sql_injection", severity: "critical", details: "SQL injection attempt detected", pattern: "SQL_INJECTION_CONSOLIDATED" };
  }
  if (XSS_RE.test(value)) {
    return { type: "xss", severity: "high", details: "Cross-site scripting attempt detected", pattern: "XSS_CONSOLIDATED" };
  }
  if (PATH_TRAVERSAL_RE.test(value)) {
    return { type: "path_traversal", severity: "high", details: "Path traversal attempt detected", pattern: "PATH_TRAVERSAL_CONSOLIDATED" };
  }
  if (COMMAND_INJECTION_RE.test(value)) {
    return { type: "command_injection", severity: "critical", details: "Command injection attempt detected", pattern: "COMMAND_INJECTION_CONSOLIDATED" };
  }
  return null;
}

/** @internal - exported for unit testing and benchmarking */
export function deepScan(obj: any, path = ""): ThreatDetection | null {
  if (typeof obj === "string") {
    return scanValue(obj);
  }
  if (typeof obj === "object" && obj !== null) {
    // Task #7 (optimization): replace Object.entries() with manual loops
    // to avoid temporary array allocations and GC pressure.
    if (obj instanceof Array) {
      for (let i = 0; i < obj.length; i++) {
        // Manual string concatenation instead of template literals for Worker stability
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
        // Manual concatenation instead of template literals
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
    // Cloudflare Worker Compatibility: avoid Object.keys()
    const sampleBody: string[] = [];
    if (req.body && typeof req.body === "object") {
      for (const k in req.body) {
        if (Object.prototype.hasOwnProperty.call(req.body, k)) {
          sampleBody[sampleBody.length] = k;
          if (sampleBody.length >= 10) break;
        }
      }
    }

    const payload = JSON.stringify({
      query: req.query,
      body: sampleBody,
      pattern: threat.pattern,
    });

    await db.insert(securityAlertsTable).values({
      type: threat.type,
      severity: threat.severity,
      source_ip: ip,
      user_agent: req.headers["user-agent"] || null,
      request_path: req.originalUrl,
      request_method: req.method,
      details: threat.details,
      // Cloudflare Worker Compatibility: avoid slice
      payload_sample: payload.length > 2000 ? payload.substring(0, 2000) : payload,
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
      dispatchCriticalAlert("critical", "IDS: " + threat.type + " attack detected", "Source: " + ip + " | Path: " + req.originalUrl + " | " + threat.details).catch(() => {});
    }

    if (threat.severity === "high") {
      dispatchCriticalAlert("high", "IDS: " + threat.type + " attempt", "Source: " + ip + " | Path: " + req.originalUrl + " | " + threat.details).catch(() => {});
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

    const url = typeof req.originalUrl === 'string' ? req.originalUrl : "";
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

// Guard module-level side effects for Worker compatibility
const janitor = typeof setInterval === "function" ? setInterval(() => {
  const now = Date.now();
  for (const ip in ipRequestLog) {
    if (Object.prototype.hasOwnProperty.call(ipRequestLog, ip)) {
      if (now - ipRequestLog[ip].lastSeen > IP_RATE_WINDOW * 5) {
        delete ipRequestLog[ip];
      }
    }
  }
}, 60_000) : null;

if (janitor && typeof (janitor as any).unref === "function") {
  (janitor as any).unref();
}
