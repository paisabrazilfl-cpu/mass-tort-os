/**
 * Threat scanning logic for Intrusion Detection System (IDS).
 * This module is designed to be lightweight and compatible with Cloudflare Workers.
 */

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

// Optimized regex combinations to reduce .test() calls.
const SQL_RE = new RegExp(SQL_INJECTION_PATTERNS.map((p) => `(?:${p.source})`).join("|"), "i");
const XSS_RE = new RegExp(XSS_PATTERNS.map((p) => `(?:${p.source})`).join("|"), "i");
const PATH_RE = new RegExp(PATH_TRAVERSAL_PATTERNS.map((p) => `(?:${p.source})`).join("|"), "i");
const CMD_RE = new RegExp(COMMAND_INJECTION_PATTERNS.map((p) => `(?:${p.source})`).join("|"), "i");

export interface ThreatDetection {
  type: "sql_injection" | "xss" | "path_traversal" | "command_injection" | "brute_force" | "suspicious_payload";
  severity: "critical" | "high" | "medium" | "low";
  details: string;
  pattern: string;
}

/**
 * Scans a single string for security threats.
 */
export function scanValue(value: string): ThreatDetection | null {
  if (SQL_RE.test(value)) {
    return { type: "sql_injection", severity: "critical", details: `SQL injection attempt detected`, pattern: "multiple" };
  }
  if (XSS_RE.test(value)) {
    return { type: "xss", severity: "high", details: `Cross-site scripting attempt detected`, pattern: "multiple" };
  }
  if (PATH_RE.test(value)) {
    return { type: "path_traversal", severity: "high", details: `Path traversal attempt detected`, pattern: "multiple" };
  }
  if (CMD_RE.test(value)) {
    return { type: "command_injection", severity: "critical", details: `Command injection attempt detected`, pattern: "multiple" };
  }
  return null;
}

/**
 * Recursively scans objects and arrays for security threats.
 */
export function deepScan(obj: any): ThreatDetection | null {
  if (typeof obj === "string") {
    return scanValue(obj);
  }
  if (typeof obj === "object" && obj !== null) {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const threat = deepScan(obj[i]);
        if (threat) return threat;
      }
    } else {
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const threat = deepScan(obj[key]);
          if (threat) return threat;
        }
      }
    }
  }
  return null;
}
