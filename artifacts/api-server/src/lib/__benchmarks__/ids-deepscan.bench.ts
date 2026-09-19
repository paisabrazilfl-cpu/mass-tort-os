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

function scanValueOriginal(value: string) {
  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(value)) return { type: "sql_injection" };
  }
  for (const pattern of XSS_PATTERNS) {
    if (pattern.test(value)) return { type: "xss" };
  }
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(value)) return { type: "path_traversal" };
  }
  for (const pattern of COMMAND_INJECTION_PATTERNS) {
    if (pattern.test(value)) return { type: "command_injection" };
  }
  return null;
}

function scanValueOptimized(value: string) {
  if (!value || value.length < 3) return null;

  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(value)) return { type: "sql_injection" };
  }

  // Fast character guard for XSS
  if (value.includes("<") || value.includes(":") || value.includes("=") || value.includes("(") || value.includes(".")) {
    for (const pattern of XSS_PATTERNS) {
      if (pattern.test(value)) return { type: "xss" };
    }
  }

  // Fast character guard for path traversal
  if (value.includes(".") || value.includes("/") || value.includes("\\") || value.includes("%") || value.includes("etc")) {
    for (const pattern of PATH_TRAVERSAL_PATTERNS) {
      if (pattern.test(value)) return { type: "path_traversal" };
    }
  }

  // Fast character guard for command injection
  if (value.includes(";") || value.includes("&") || value.includes("|") || value.includes("`") || value.includes("$")) {
    for (const pattern of COMMAND_INJECTION_PATTERNS) {
      if (pattern.test(value)) return { type: "command_injection" };
    }
  }

  return null;
}

function deepScanOriginal(obj: any, path = ""): any {
  if (typeof obj === "string") {
    return scanValueOriginal(obj);
  }
  if (typeof obj === "object" && obj !== null) {
    for (const [key, val] of Object.entries(obj)) {
      const threat = deepScanOriginal(val, `${path}.${key}`);
      if (threat) return threat;
    }
  }
  return null;
}

function deepScanOptimized(obj: any): any {
  if (typeof obj === "string") {
    return scanValueOptimized(obj);
  }
  if (typeof obj === "object" && obj !== null) {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const threat = deepScanOptimized(obj[i]);
        if (threat) return threat;
      }
    } else {
      for (const key in obj) {
        if (Object.hasOwn(obj, key)) {
          const threat = deepScanOptimized(obj[key]);
          if (threat) return threat;
        }
      }
    }
  }
  return null;
}

const samplePayloads = [
  {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@example.com",
    phone: "555-123-4567",
    tort_type: "Roundup",
    address: { street: "123 Main St", city: "Austin", state: "TX", zip: "78701" },
    custom_fields: { source: "google_ads", campaign_id: "c-10293", tags: ["web", "organic", "qualified"] },
    notes: "Patient was diagnosed in 2022 after exposure to herbicide."
  },
  {
    search: "Roundup litigation status",
    filters: { page: "1", limit: "50", sort: "created_at", order: "desc" },
    facets: ["tort_type", "status", "assigned_user"]
  },
  {
    batch: [
      { id: 101, status: "approved", metadata: { retries: 0, priority: "high" } },
      { id: 102, status: "pending", metadata: { retries: 1, priority: "low" } },
      { id: 103, status: "review_required", metadata: { retries: 0, priority: "normal" } }
    ]
  }
];

const iterations = 100000;

console.log(`Running deepScan comparison with ${iterations} iterations...`);

let start = performance.now();
for (let i = 0; i < iterations; i++) {
  for (const payload of samplePayloads) {
    deepScanOriginal(payload);
  }
}
let end = performance.now();
const origTotal = end - start;

start = performance.now();
for (let i = 0; i < iterations; i++) {
  for (const payload of samplePayloads) {
    deepScanOptimized(payload);
  }
}
end = performance.now();
const optTotal = end - start;

const totalCalls = iterations * samplePayloads.length;
console.log(`Original:  ${origTotal.toFixed(4)}ms total (${(origTotal / totalCalls).toFixed(6)}ms/call)`);
console.log(`Optimized: ${optTotal.toFixed(4)}ms total (${(optTotal / totalCalls).toFixed(6)}ms/call)`);
console.log(`Speedup:   ${(origTotal / optTotal).toFixed(2)}x (${((1 - optTotal / origTotal) * 100).toFixed(1)}% faster)`);
