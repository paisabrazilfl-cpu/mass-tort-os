import { Request, Response, NextFunction } from "express";
import { db, securityAlertsTable, blockedIpsTable } from "@workspace/db";
import { eq, gte, sql, and } from "drizzle-orm";
import { logger } from "./logger";
import { dispatchCriticalAlert } from "./security-alerts";
import { verifyToken } from "./rbac";

// Task #7 FP-tuning: Patterns are consolidated into single regexes per category
// to reduce regex engine overhead. They require canonical markers to avoid
// false positives in natural language.
const SQL_INJECTION_RE =
  /(\b(union|select|insert|update|delete|drop|alter|create|exec|execute)\b.*\b(from|into|table|database|where)\b)|(['"]\s*(or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+)|(--\s|\/\*|\*\/|;.*\b(drop|delete|update|insert)\b)|(\bwaitfor\b\s+\bdelay\b|\bsleep\s*\()|(\bunion\b\s+\ball\b\s+\bselect\b)/i;

const XSS_RE =
  /<script[\s>]|javascript\s*:|on(error|load|click|mouseover|focus|blur)\s*=|<iframe[\s>]|<object[\s>]|<embed[\s>]|expression\s*\(|eval\s*\(|document\.(cookie|location|write)|<svg.*on\w+\s*=/i;

const PATH_TRAVERSAL_RE =
  /\.\.\/|\.\.\\|%2e%2e|%252e%252e|\/etc\/(passwd|shadow|hosts)|\/proc\/self|\bboot\.ini\b/i;

const COMMAND_INJECTION_RE =
  /[;&|`$].*\b(cat|ls|pwd|whoami|id|curl|wget|nc|bash|sh|python|perl|ruby)\b|\$\{.*\}|\$\(.*\)/i;

interface ThreatDetection {
  type: "sql_injection" | "xss" | "path_traversal" | "command_injection" | "brute_force" | "suspicious_payload";
  severity: "critical" | "high" | "medium" | "low";
  details: string;
  pattern: string;
}

const ipRequestLog = new Map<string, { count: number; firstSeen: number; lastSeen: number }>();
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
  if (typeof auth !== "string" || auth.toLowerCase().indexOf("bearer ") !== 0) {
    return false;
  }
  const token = auth.substring(7).replace(/^\s+|\s+$/g, "");
  if (!token) return false;
  // verifyToken returns null for any malformed/unsigned/expired token,
  // so spoofed Bearer headers fall back to anonymous-traffic limits.
  return verifyToken(token) !== null;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  let rawIp: string | undefined;

  if (typeof forwarded === "string") {
    const commaIndex = forwarded.indexOf(",");
    rawIp = commaIndex === -1 ? forwarded : forwarded.substring(0, commaIndex);
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    const firstEntry = forwarded[0];
    if (typeof firstEntry === "string") {
      const commaIndex = firstEntry.indexOf(",");
      rawIp = commaIndex === -1 ? firstEntry : firstEntry.substring(0, commaIndex);
    }
  }

  if (rawIp) {
    return rawIp.replace(/^\s+|\s+$/g, "");
  }

  return req.socket?.remoteAddress || "unknown";
}

export function scanValue(value: string): ThreatDetection | null {
  if (SQL_INJECTION_RE.test(value)) {
    return {
      type: "sql_injection",
      severity: "critical",
      details: "SQL injection attempt detected",
      pattern: SQL_INJECTION_RE.source,
    };
  }
  if (XSS_RE.test(value)) {
    return {
      type: "xss",
      severity: "high",
      details: "Cross-site scripting attempt detected",
      pattern: XSS_RE.source,
    };
  }
  if (PATH_TRAVERSAL_RE.test(value)) {
    return {
      type: "path_traversal",
      severity: "high",
      details: "Path traversal attempt detected",
      pattern: PATH_TRAVERSAL_RE.source,
    };
  }
  if (COMMAND_INJECTION_RE.test(value)) {
    return {
      type: "command_injection",
      severity: "critical",
      details: "Command injection attempt detected",
      pattern: COMMAND_INJECTION_RE.source,
    };
  }
  return null;
}

export function deepScan(obj: any, path = ""): ThreatDetection | null {
  const type = typeof obj;
  if (type === "string") {
    return scanValue(obj);
  }
  if (type === "object" && obj !== null) {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const threat = deepScan(obj[i], `${path}.${i}`);
        if (threat) return threat;
      }
    } else {
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const threat = deepScan(obj[key], `${path}.${key}`);
          if (threat) return threat;
        }
      }
    }
  }
  return null;
}

function checkBruteForce(ip: string, threshold: number): ThreatDetection | null {
  const now = Date.now();
  const entry = ipRequestLog.get(ip);
  if (entry) {
    if (now - entry.firstSeen > IP_RATE_WINDOW) {
      ipRequestLog.set(ip, { count: 1, firstSeen: now, lastSeen: now });
      return null;
    }
    entry.count++;
    entry.lastSeen = now;
    if (entry.count > threshold) {
      return {
        type: "brute_force",
        severity: "high",
        details: `${entry.count} requests in ${Math.round((now - entry.firstSeen) / 1000)}s from ${ip}`,
        pattern: "rate_exceeded",
      };
    }
  } else {
    ipRequestLog.set(ip, { count: 1, firstSeen: now, lastSeen: now });
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
  const bodyKeys: string[] = [];
  if (typeof req.body === "object" && req.body !== null) {
    for (const k in req.body) {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) {
        bodyKeys.push(k);
      }
    }
  }

  try {
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
          reason: `Auto-blocked: ${threat.type} — ${threat.details}`,
          blocked_until: new Date(Date.now() + blockDuration),
          auto_blocked: true,
          alert_count: 1,
        })
        .onConflictDoUpdate({
          target: blockedIpsTable.ip,
          set: {
            reason: `Auto-blocked: ${threat.type} — ${threat.details}`,
            blocked_until: new Date(Date.now() + blockDuration),
            alert_count: sql`${blockedIpsTable.alert_count} + 1`,
            updated_at: new Date(),
          },
        });
      logger.warn({ ip, type: threat.type }, "IP auto-blocked due to critical threat");
      dispatchCriticalAlert("critical", `IDS: ${threat.type} attack detected`, `Source: ${ip} | Path: ${req.originalUrl} | ${threat.details}`).catch(() => {});
    }

    if (threat.severity === "high") {
      dispatchCriticalAlert("high", `IDS: ${threat.type} attempt`, `Source: ${ip} | Path: ${req.originalUrl} | ${threat.details}`).catch(() => {});
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

    const urlThreat = scanValue(decodeURIComponent(req.originalUrl));
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
if (typeof setInterval === "function") {
  const janitor = setInterval(() => {
    const now = Date.now();
    ipRequestLog.forEach((entry, ip) => {
      if (now - entry.lastSeen > IP_RATE_WINDOW * 5) {
        ipRequestLog.delete(ip);
      }
    });
  }, 60_000);
  if (typeof (janitor as any).unref === "function") {
    (janitor as any).unref();
  }
}
