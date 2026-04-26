import { Request, Response, NextFunction } from "express";
import { db, securityAlertsTable, blockedIpsTable } from "@workspace/db";
import { eq, gte, sql, and } from "drizzle-orm";
import { logger } from "./logger";
import { dispatchCriticalAlert } from "./security-alerts";

const SQL_INJECTION_PATTERNS = [
  /(\b(union|select|insert|update|delete|drop|alter|create|exec|execute)\b.*\b(from|into|table|database|where)\b)/i,
  /(\b(or|and)\b\s+[\d'"].*[=<>])/i,
  /(--\s|\/\*|\*\/|;.*\b(drop|delete|update|insert)\b)/i,
  /(\bwaitfor\b\s+\bdelay\b|\bsleep\s*\()/i,
  /(\'.*\bor\b.*\'.*=.*\')/i,
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

interface ThreatDetection {
  type: "sql_injection" | "xss" | "path_traversal" | "command_injection" | "brute_force" | "suspicious_payload";
  severity: "critical" | "high" | "medium" | "low";
  details: string;
  pattern: string;
}

const ipRequestLog = new Map<string, { count: number; firstSeen: number; lastSeen: number }>();
const IP_RATE_WINDOW = 60_000;
const BRUTE_FORCE_THRESHOLD = 100;

function getClientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() 
    || req.socket.remoteAddress 
    || "unknown";
}

function scanValue(value: string): ThreatDetection | null {
  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(value)) {
      return { type: "sql_injection", severity: "critical", details: `SQL injection attempt detected`, pattern: pattern.source };
    }
  }
  for (const pattern of XSS_PATTERNS) {
    if (pattern.test(value)) {
      return { type: "xss", severity: "high", details: `Cross-site scripting attempt detected`, pattern: pattern.source };
    }
  }
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(value)) {
      return { type: "path_traversal", severity: "high", details: `Path traversal attempt detected`, pattern: pattern.source };
    }
  }
  for (const pattern of COMMAND_INJECTION_PATTERNS) {
    if (pattern.test(value)) {
      return { type: "command_injection", severity: "critical", details: `Command injection attempt detected`, pattern: pattern.source };
    }
  }
  return null;
}

function deepScan(obj: any, path = ""): ThreatDetection | null {
  if (typeof obj === "string") {
    return scanValue(obj);
  }
  if (typeof obj === "object" && obj !== null) {
    for (const [key, val] of Object.entries(obj)) {
      const threat = deepScan(val, `${path}.${key}`);
      if (threat) return threat;
    }
  }
  return null;
}

function checkBruteForce(ip: string): ThreatDetection | null {
  const now = Date.now();
  const entry = ipRequestLog.get(ip);
  if (entry) {
    if (now - entry.firstSeen > IP_RATE_WINDOW) {
      ipRequestLog.set(ip, { count: 1, firstSeen: now, lastSeen: now });
      return null;
    }
    entry.count++;
    entry.lastSeen = now;
    if (entry.count > BRUTE_FORCE_THRESHOLD) {
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
        body: typeof req.body === "object" ? Object.keys(req.body) : undefined,
        pattern: threat.pattern,
      }).slice(0, 2000),
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

    const blocked = await isBlocked(ip);
    if (blocked) {
      logger.warn({ ip }, "Blocked IP attempted access");
      // Pre-auth IPS denial — uses the same FORBIDDEN envelope as RBAC
      // denials so the CRM only has one error shape to handle.
      res.status(403).json({ status: "error", code: "FORBIDDEN", message: "Access denied" });
      return;
    }

    const bruteForce = checkBruteForce(ip);
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

    if (req.body && typeof req.body === "object") {
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

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipRequestLog.entries()) {
    if (now - entry.lastSeen > IP_RATE_WINDOW * 5) {
      ipRequestLog.delete(ip);
    }
  }
}, 60_000);
