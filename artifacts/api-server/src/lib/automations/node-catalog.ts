/**
 * Public catalog of node types available in the visual workflow builder.
 * Each entry describes one draggable node — its label, category, color hint,
 * input/output shape (free-form jsonb), and the parameter fields the UI
 * should render in the node config panel.
 *
 * The runtime executor in `executor.ts` looks up handlers by `type`. Every
 * type listed here MUST have a matching entry in NODE_HANDLERS.
 */

export type NodeCategory =
  | "trigger"
  | "logic"
  | "data"
  | "crm"
  | "integration"
  | "ai"
  | "script"
  | "io"
  | "utility";

export interface NodeParamSpec {
  key: string;
  label: string;
  type: "string" | "text" | "number" | "boolean" | "json" | "select" | "code";
  language?: "javascript" | "python" | "bash" | "powershell" | "sql";
  options?: { label: string; value: string }[];
  placeholder?: string;
  default?: unknown;
  required?: boolean;
  help?: string;
}

export interface NodeDefinition {
  type: string;
  label: string;
  category: NodeCategory;
  description: string;
  icon: string; // lucide icon name
  color: string; // tailwind class for accent
  params: NodeParamSpec[];
  inputs?: number; // default 1
  outputs?: number | string[]; // number, or named outputs (e.g. ["true","false"])
}

export const NODE_CATALOG: NodeDefinition[] = [
  // ──────────────── Triggers ────────────────
  {
    type: "trigger.manual", label: "Manual Trigger", category: "trigger",
    description: "Workflow starts when an operator clicks Run.",
    icon: "Play", color: "bg-emerald-600",
    params: [], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.webhook", label: "Webhook Trigger", category: "trigger",
    description: "Workflow starts when an HTTP request hits the workflow's webhook URL.",
    icon: "Webhook", color: "bg-emerald-600",
    params: [
      { key: "path", label: "Path slug", type: "string", placeholder: "lead-created", required: true },
      { key: "secret", label: "HMAC secret (optional)", type: "string" },
    ], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.schedule", label: "Schedule (Cron)", category: "trigger",
    description: "Run on a recurring schedule using cron syntax.",
    icon: "Clock", color: "bg-emerald-600",
    params: [
      { key: "cron", label: "Cron expression", type: "string", placeholder: "0 9 * * 1-5", required: true, help: "Standard 5-field cron, server timezone." },
    ], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.lead_created", label: "On Lead Created", category: "trigger",
    description: "Fires when a new lead is saved in the CRM.",
    icon: "UserPlus", color: "bg-emerald-600",
    params: [
      { key: "tort", label: "Tort filter (optional)", type: "string" },
    ], inputs: 0, outputs: 1,
  },

  // ──────────────── Logic ────────────────
  {
    type: "logic.if", label: "If / Else", category: "logic",
    description: "Branch based on a JS expression evaluated against the input.",
    icon: "GitBranch", color: "bg-amber-500",
    params: [
      { key: "expression", label: "Expression", type: "code", language: "javascript", placeholder: "input.score > 70", required: true, help: "Plain JS. Available: input, ctx, vars." },
    ], outputs: ["true", "false"],
  },
  {
    type: "logic.switch", label: "Switch", category: "logic",
    description: "Route to a labelled branch based on the value of a key.",
    icon: "Shuffle", color: "bg-amber-500",
    params: [
      { key: "key", label: "Key to read", type: "string", placeholder: "input.status", required: true },
      { key: "cases", label: "Branches (JSON map of value→label)", type: "json", placeholder: '{"qualified":"qualified","rejected":"rejected"}' },
    ], outputs: ["match", "default"],
  },
  {
    type: "logic.loop", label: "Loop (forEach)", category: "logic",
    description: "Iterate an array. The branch downstream runs once per item.",
    icon: "Repeat", color: "bg-amber-500",
    params: [
      { key: "arrayPath", label: "Array path", type: "string", placeholder: "input.leads", required: true },
      { key: "maxIterations", label: "Max iterations", type: "number", default: 100 },
    ], outputs: ["item", "done"],
  },
  {
    type: "logic.delay", label: "Delay / Wait", category: "logic",
    description: "Pause the workflow for N seconds.",
    icon: "Hourglass", color: "bg-amber-500",
    params: [
      { key: "seconds", label: "Seconds", type: "number", default: 5, required: true },
    ],
  },

  // ──────────────── Data / Transform ────────────────
  {
    type: "data.set", label: "Set Variable", category: "data",
    description: "Store a value in workflow variables.",
    icon: "Variable", color: "bg-sky-600",
    params: [
      { key: "name", label: "Variable name", type: "string", required: true },
      { key: "value", label: "Value (JSON or expression)", type: "json", required: true },
    ],
  },
  {
    type: "data.transform", label: "Transform (JS)", category: "data",
    description: "Run arbitrary JS to reshape data. Return the new payload.",
    icon: "Wand2", color: "bg-sky-600",
    params: [
      { key: "code", label: "Body of `(input, vars) => …`", type: "code", language: "javascript", placeholder: "return { ...input, full_name: input.first + ' ' + input.last };", required: true },
    ],
  },
  {
    type: "data.regex", label: "Regex Extract", category: "data",
    description: "Match a regex against text and return the captures.",
    icon: "Scissors", color: "bg-sky-600",
    params: [
      { key: "text", label: "Text path", type: "string", placeholder: "input.body", required: true },
      { key: "pattern", label: "Pattern", type: "string", required: true },
      { key: "flags", label: "Flags", type: "string", default: "g" },
    ],
  },
  {
    type: "data.json_path", label: "JSONPath / Pick", category: "data",
    description: "Pick a field by dotted path.",
    icon: "Crosshair", color: "bg-sky-600",
    params: [
      { key: "path", label: "Path", type: "string", placeholder: "input.data.items[0].id", required: true },
    ],
  },
  {
    type: "data.csv_parse", label: "CSV → JSON", category: "data",
    description: "Parse CSV text into an array of objects.",
    icon: "Table2", color: "bg-sky-600",
    params: [
      { key: "text", label: "CSV text path", type: "string", placeholder: "input.csv", required: true },
      { key: "delimiter", label: "Delimiter", type: "string", default: "," },
    ],
  },

  // ──────────────── CRM ────────────────
  {
    type: "crm.create_lead", label: "Create Lead", category: "crm",
    description: "Create a new lead in the CRM with intake data.",
    icon: "UserPlus", color: "bg-violet-600",
    params: [
      { key: "data", label: "Lead fields (JSON)", type: "json", required: true, placeholder: '{"first_name":"...","last_name":"...","tort":"..."}' },
    ],
  },
  {
    type: "crm.update_lead", label: "Update Lead", category: "crm",
    description: "Patch fields on an existing lead.",
    icon: "UserCog", color: "bg-violet-600",
    params: [
      { key: "leadId", label: "Lead id (or path)", type: "string", required: true, placeholder: "input.lead_id" },
      { key: "patch", label: "Patch (JSON)", type: "json", required: true },
    ],
  },
  {
    type: "crm.qualify_lead", label: "Qualify Lead", category: "crm",
    description: "Run the decision-engine and set the lead's qualification status.",
    icon: "ShieldCheck", color: "bg-violet-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true },
    ], outputs: ["qualified", "rejected", "review"],
  },
  {
    type: "crm.create_case", label: "Create Case", category: "crm",
    description: "Create a new case file from a lead.",
    icon: "Briefcase", color: "bg-violet-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true },
      { key: "data", label: "Case fields (JSON)", type: "json" },
    ],
  },
  {
    type: "crm.add_note", label: "Add Note", category: "crm",
    description: "Append a timeline note to a lead or case.",
    icon: "StickyNote", color: "bg-violet-600",
    params: [
      { key: "entity", label: "Entity", type: "select", options: [
        { label: "Lead", value: "lead" }, { label: "Case", value: "case" },
      ], required: true },
      { key: "id", label: "Entity id", type: "string", required: true },
      { key: "note", label: "Note text", type: "text", required: true },
    ],
  },
  {
    type: "crm.audit_log", label: "Audit Log Entry", category: "crm",
    description: "Write a compliance audit log row.",
    icon: "ClipboardList", color: "bg-violet-600",
    params: [
      { key: "action", label: "Action", type: "string", required: true },
      { key: "entityType", label: "Entity type", type: "string", required: true },
      { key: "entityId", label: "Entity id", type: "string", required: true },
      { key: "details", label: "Details (JSON)", type: "json" },
    ],
  },

  // ──────────────── Integrations ────────────────
  {
    type: "integration.send_email", label: "Send Email", category: "integration",
    description: "Send transactional email via the configured email provider (SendGrid).",
    icon: "Mail", color: "bg-rose-600",
    params: [
      { key: "to", label: "To", type: "string", required: true },
      { key: "subject", label: "Subject", type: "string", required: true },
      { key: "html", label: "HTML body", type: "text", required: true },
      { key: "from", label: "From (optional)", type: "string" },
    ],
  },
  {
    type: "integration.send_fax", label: "Send Fax", category: "integration",
    description: "Send a fax via the configured fax provider (SRFax).",
    icon: "Printer", color: "bg-rose-600",
    params: [
      { key: "to", label: "To fax number", type: "string", required: true },
      { key: "documentUrl", label: "Document URL", type: "string", required: true },
      { key: "coverNote", label: "Cover note", type: "text" },
    ],
  },
  {
    type: "integration.send_esign", label: "Send for E-Signature", category: "integration",
    description: "Send a document for e-signature via the configured provider.",
    icon: "FileSignature", color: "bg-rose-600",
    params: [
      { key: "templateId", label: "Document template id", type: "string", required: true },
      { key: "signerEmail", label: "Signer email", type: "string", required: true },
      { key: "signerName", label: "Signer name", type: "string", required: true },
    ],
  },
  {
    type: "integration.webhook_out", label: "Outbound Webhook", category: "integration",
    description: "POST a payload to a third-party webhook URL.",
    icon: "Webhook", color: "bg-rose-600",
    params: [
      { key: "url", label: "URL", type: "string", required: true },
      { key: "method", label: "Method", type: "select", default: "POST", options: [
        { label: "POST", value: "POST" }, { label: "PUT", value: "PUT" },
        { label: "PATCH", value: "PATCH" }, { label: "DELETE", value: "DELETE" },
      ]},
      { key: "headers", label: "Headers (JSON)", type: "json" },
      { key: "body", label: "Body (JSON)", type: "json" },
      { key: "hmacSecret", label: "HMAC secret (optional)", type: "string" },
    ],
  },
  {
    type: "integration.http_request", label: "HTTP Request", category: "integration",
    description: "Generic HTTP fetch — call any REST API.",
    icon: "Globe", color: "bg-rose-600",
    params: [
      { key: "url", label: "URL", type: "string", required: true },
      { key: "method", label: "Method", type: "select", default: "GET", options: [
        { label: "GET", value: "GET" }, { label: "POST", value: "POST" },
        { label: "PUT", value: "PUT" }, { label: "PATCH", value: "PATCH" }, { label: "DELETE", value: "DELETE" },
      ]},
      { key: "headers", label: "Headers (JSON)", type: "json" },
      { key: "body", label: "Body (JSON or string)", type: "json" },
      { key: "responseType", label: "Response", type: "select", default: "json", options: [
        { label: "JSON", value: "json" }, { label: "Text", value: "text" },
      ]},
    ],
  },
  {
    type: "integration.graphql", label: "GraphQL Query", category: "integration",
    description: "Execute a GraphQL query against an endpoint.",
    icon: "Network", color: "bg-rose-600",
    params: [
      { key: "url", label: "Endpoint", type: "string", required: true },
      { key: "query", label: "Query", type: "code", language: "javascript", required: true },
      { key: "variables", label: "Variables (JSON)", type: "json" },
      { key: "headers", label: "Headers (JSON)", type: "json" },
    ],
  },

  // ──────────────── AI ────────────────
  {
    type: "ai.extract_fields", label: "AI Extract Fields", category: "ai",
    description: "Use the configured LLM to pull structured fields from text.",
    icon: "Brain", color: "bg-fuchsia-600",
    params: [
      { key: "text", label: "Text path", type: "string", required: true, placeholder: "input.body" },
      { key: "schema", label: "Field schema (JSON)", type: "json", required: true, placeholder: '{"name":"string","dob":"YYYY-MM-DD"}' },
      { key: "model", label: "Model", type: "select", default: "gpt-4o-mini", options: [
        { label: "GPT-4o mini", value: "gpt-4o-mini" }, { label: "GPT-4o", value: "gpt-4o" },
        { label: "Claude 3.5 Sonnet", value: "claude-3-5-sonnet" },
      ]},
    ],
  },
  {
    type: "ai.summarize", label: "AI Summarize", category: "ai",
    description: "Generate a short summary of a long text block.",
    icon: "FileText", color: "bg-fuchsia-600",
    params: [
      { key: "text", label: "Text path", type: "string", required: true },
      { key: "maxWords", label: "Max words", type: "number", default: 200 },
    ],
  },
  {
    type: "ai.draft", label: "AI Draft Text", category: "ai",
    description: "Generate text from a prompt template.",
    icon: "Sparkles", color: "bg-fuchsia-600",
    params: [
      { key: "prompt", label: "Prompt", type: "text", required: true },
      { key: "system", label: "System (optional)", type: "text" },
    ],
  },

  // ──────────────── Scripts ────────────────
  {
    type: "script.javascript", label: "Run JavaScript", category: "script",
    description: "Run a JS snippet inside an isolated VM. Return value becomes the output.",
    icon: "Code2", color: "bg-orange-600",
    params: [
      { key: "code", label: "JS code", type: "code", language: "javascript", required: true, placeholder: "return input.value * 2;" },
      { key: "timeoutMs", label: "Timeout (ms)", type: "number", default: 5000 },
    ],
  },
  {
    type: "script.python", label: "Run Python", category: "script",
    description: "Run a Python script. Reads JSON from stdin, prints JSON to stdout.",
    icon: "Terminal", color: "bg-orange-600",
    params: [
      { key: "code", label: "Python code", type: "code", language: "python", required: true, placeholder: "import sys, json\\ndata = json.load(sys.stdin)\\nprint(json.dumps({'doubled': data['value'] * 2}))" },
      { key: "timeoutMs", label: "Timeout (ms)", type: "number", default: 15000 },
    ],
  },
  {
    type: "script.bash", label: "Run Bash", category: "script",
    description: "Run a bash command on the worker host. Requires admin approval.",
    icon: "TerminalSquare", color: "bg-orange-600",
    params: [
      { key: "command", label: "Bash command", type: "code", language: "bash", required: true },
      { key: "timeoutMs", label: "Timeout (ms)", type: "number", default: 15000 },
      { key: "approved", label: "I confirm this is safe", type: "boolean", default: false, required: true },
    ],
  },
  {
    type: "script.powershell", label: "Run PowerShell", category: "script",
    description: "Run a PowerShell command (requires PowerShell installed). Approved-only.",
    icon: "TerminalSquare", color: "bg-orange-600",
    params: [
      { key: "command", label: "PowerShell command", type: "code", language: "powershell", required: true },
      { key: "timeoutMs", label: "Timeout (ms)", type: "number", default: 15000 },
      { key: "approved", label: "I confirm this is safe", type: "boolean", default: false, required: true },
    ],
  },

  // ──────────────── I/O ────────────────
  {
    type: "io.sql_query", label: "SQL Query", category: "io",
    description: "Run a read-only SQL query against the CRM database.",
    icon: "Database", color: "bg-cyan-600",
    params: [
      { key: "sql", label: "SQL", type: "code", language: "sql", required: true, placeholder: "SELECT id, status FROM leads WHERE firm_id = $1" },
      { key: "params", label: "Params (JSON array)", type: "json", default: "[]" },
    ],
  },
  {
    type: "io.read_file", label: "Read File", category: "io",
    description: "Read a file from object storage (file vault).",
    icon: "FileDown", color: "bg-cyan-600",
    params: [
      { key: "key", label: "Object key", type: "string", required: true },
    ],
  },
  {
    type: "io.write_file", label: "Write File", category: "io",
    description: "Write a payload to object storage.",
    icon: "FileUp", color: "bg-cyan-600",
    params: [
      { key: "key", label: "Object key", type: "string", required: true },
      { key: "content", label: "Content (string or JSON)", type: "json", required: true },
      { key: "contentType", label: "Content type", type: "string", default: "application/json" },
    ],
  },

  // ──────────────── Utility ────────────────
  {
    type: "utility.log", label: "Log Message", category: "utility",
    description: "Print a message to the run log for debugging.",
    icon: "MessageSquare", color: "bg-slate-500",
    params: [
      { key: "level", label: "Level", type: "select", default: "info", options: [
        { label: "info", value: "info" }, { label: "warn", value: "warn" }, { label: "error", value: "error" },
      ]},
      { key: "message", label: "Message", type: "text", required: true },
    ],
  },
  {
    type: "utility.end", label: "End Workflow", category: "utility",
    description: "Stop execution. Optional return value becomes the run output.",
    icon: "Square", color: "bg-slate-500",
    params: [
      { key: "output", label: "Return value (JSON)", type: "json" },
    ], outputs: 0,
  },
];

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return NODE_CATALOG.find((n) => n.type === type);
}
