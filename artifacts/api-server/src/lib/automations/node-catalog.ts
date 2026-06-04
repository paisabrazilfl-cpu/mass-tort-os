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
  | "communication"
  | "ai"
  | "documents"
  | "forms"
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
  {
    type: "trigger.form_submitted", label: "On Web Form Submitted", category: "trigger",
    description: "Fires when a published web form receives a submission.",
    icon: "AppWindow", color: "bg-emerald-600",
    params: [
      { key: "formId", label: "Form id (optional — all if blank)", type: "string" },
      { key: "tort", label: "Tort filter (optional)", type: "string" },
    ], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.inbound_call", label: "On Inbound Call", category: "trigger",
    description: "Fires when an inbound phone call is logged.",
    icon: "PhoneIncoming", color: "bg-emerald-600",
    params: [
      { key: "didNumber", label: "DID/number filter (optional)", type: "string" },
    ], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.inbound_sms", label: "On Inbound SMS", category: "trigger",
    description: "Fires when an inbound text message is received.",
    icon: "MessageCircle", color: "bg-emerald-600",
    params: [
      { key: "keyword", label: "Keyword filter (optional)", type: "string" },
    ], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.inbound_email", label: "On Inbound Email", category: "trigger",
    description: "Fires when an inbound email is received at a monitored address.",
    icon: "MailOpen", color: "bg-emerald-600",
    params: [
      { key: "toAddress", label: "Recipient filter (optional)", type: "string" },
      { key: "subjectContains", label: "Subject contains (optional)", type: "string" },
    ], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.inbound_fax", label: "On Inbound Fax", category: "trigger",
    description: "Fires when an inbound fax is received.",
    icon: "Printer", color: "bg-emerald-600",
    params: [
      { key: "didNumber", label: "Fax DID filter (optional)", type: "string" },
    ], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.document_signed", label: "On Document Signed", category: "trigger",
    description: "Fires when a Dropbox Sign / DocuSign packet is fully executed.",
    icon: "FileCheck2", color: "bg-emerald-600",
    params: [
      { key: "templateId", label: "Template id filter (optional)", type: "string" },
    ], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.case_status_changed", label: "On Case Status Change", category: "trigger",
    description: "Fires when a case moves between pipeline stages.",
    icon: "GitBranch", color: "bg-emerald-600",
    params: [
      { key: "fromStatus", label: "From status (optional)", type: "string" },
      { key: "toStatus", label: "To status (optional)", type: "string" },
    ], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.ocr_completed", label: "On OCR Completed", category: "trigger",
    description: "Fires when an OCR job finishes for an uploaded medical record.",
    icon: "ScanText", color: "bg-emerald-600",
    params: [], inputs: 0, outputs: 1,
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
    description: "Passes the full array downstream as `items`. Note: v1 does NOT run once-per-item — downstream receives the whole array. Use a Transform node to iterate over individual elements.",
    icon: "Repeat", color: "bg-amber-500",
    params: [
      { key: "arrayPath", label: "Array path", type: "string", placeholder: "input.leads", required: true },
      { key: "maxIterations", label: "Max iterations", type: "number", default: 100 },
    ], outputs: ["item", "done"],
  },
  {
    type: "logic.delay", label: "Delay / Wait", category: "logic",
    description: "Pause the workflow inline for up to 30 seconds (hard cap). For longer waits use a scheduled trigger instead.",
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
      { key: "name", label: "Variable name", type: "string", required: true, placeholder: "qualifiedScore" },
      { key: "value", label: "Value (JSON or expression)", type: "json", required: true, placeholder: '{"score":85,"tier":"A"}' },
    ],
  },
  {
    type: "data.transform", label: "Transform (JS)", category: "data",
    description: "Run JS to reshape data inside an isolated sandbox (no Node globals, 5 s timeout). Return the new payload.",
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
      { key: "pattern", label: "Pattern", type: "string", required: true, placeholder: "\\b\\d{3}-\\d{2}-\\d{4}\\b" },
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
      { key: "patch", label: "Patch (JSON)", type: "json", required: true, placeholder: '{"status":"qualified","priority":"high"}' },
    ],
  },
  {
    type: "crm.qualify_lead", label: "Qualify Lead", category: "crm",
    description: "Run the decision-engine and set the lead's qualification status.",
    icon: "ShieldCheck", color: "bg-violet-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
    ], outputs: ["qualified", "rejected", "review"],
  },
  {
    type: "crm.create_case", label: "Create Case", category: "crm",
    description: "Create a new case file from a lead.",
    icon: "Briefcase", color: "bg-violet-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "data", label: "Case fields (JSON)", type: "json", placeholder: '{"matter_type":"mass_tort","priority":"normal"}' },
    ],
  },
  {
    type: "crm.add_note", label: "Add Note", category: "crm",
    description: "Append a timeline note to a lead or case.",
    icon: "StickyNote", color: "bg-violet-600",
    params: [
      { key: "entity", label: "Entity", type: "select", default: "lead", options: [
        { label: "Lead", value: "lead" }, { label: "Case", value: "case" },
      ], required: true },
      { key: "id", label: "Entity id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "note", label: "Note text", type: "text", required: true, placeholder: "Auto-note from workflow: {{input.summary}}" },
    ],
  },
  {
    type: "crm.audit_log", label: "Audit Log Entry", category: "crm",
    description: "Write a compliance audit log row.",
    icon: "ClipboardList", color: "bg-violet-600",
    params: [
      { key: "action", label: "Action", type: "string", required: true, placeholder: "workflow.executed" },
      { key: "entityType", label: "Entity type", type: "string", required: true, placeholder: "lead" },
      { key: "entityId", label: "Entity id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "details", label: "Details (JSON)", type: "json", placeholder: '{"workflow":"intake","step":"qualify"}' },
    ],
  },
  {
    type: "crm.assign_paralegal", label: "Assign Paralegal", category: "crm",
    description: "Assign a paralegal to a lead or case via the routing engine.",
    icon: "UserCheck", color: "bg-violet-600",
    params: [
      { key: "entity", label: "Entity", type: "select", required: true, default: "lead", options: [
        { label: "Lead", value: "lead" }, { label: "Case", value: "case" },
      ]},
      { key: "id", label: "Entity id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "paralegalId", label: "Paralegal id (blank = auto)", type: "string", help: "Leave blank for round-robin assignment." },
    ],
  },
  {
    type: "crm.set_lead_status", label: "Set Lead Status", category: "crm",
    description: "Move a lead to a new pipeline status.",
    icon: "GitBranch", color: "bg-violet-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "status", label: "Status", type: "string", required: true, placeholder: "qualified | working | rejected" },
    ],
  },
  {
    type: "crm.send_to_review_queue", label: "Send to Review Queue", category: "crm",
    description: "Push the entity into the manual review queue for an operator.",
    icon: "ShieldAlert", color: "bg-violet-600",
    params: [
      { key: "entity", label: "Entity", type: "select", required: true, default: "lead", options: [
        { label: "Lead", value: "lead" }, { label: "Case", value: "case" }, { label: "Document", value: "document" },
      ]},
      { key: "id", label: "Entity id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "reason", label: "Reason", type: "text", placeholder: "Conflicting demographic data — needs human review." },
      { key: "priority", label: "Priority", type: "select", default: "normal", options: [
        { label: "Low", value: "low" }, { label: "Normal", value: "normal" }, { label: "High", value: "high" }, { label: "Urgent", value: "urgent" },
      ]},
    ],
  },
  {
    type: "crm.background_check", label: "Run Background Check", category: "crm",
    description: "Fan out across the 9-lane background check hub for a lead.",
    icon: "Shield", color: "bg-violet-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "lanes", label: "Lanes (JSON array, blank = all)", type: "json", placeholder: '["courtlistener","ofac","npi"]' },
    ], outputs: ["clear", "flagged", "error"],
  },
  {
    type: "crm.npi_lookup", label: "Verify Provider (NPI)", category: "crm",
    description: "Verify a treating provider against the CMS NPPES registry by NPI or name + city/state. Branches verified / ambiguous / unavailable and surfaces the provider's practice fax.",
    icon: "Stethoscope", color: "bg-violet-600",
    params: [
      { key: "npi", label: "NPI number (optional, 10 digits)", type: "string", placeholder: "input.lead.npi_number" },
      { key: "name", label: "Provider name (or path)", type: "string", placeholder: "input.lead.physician_last_name" },
      { key: "organization", label: "Organization / hospital (optional)", type: "string", placeholder: "input.lead.hospital_name" },
      { key: "city", label: "City (optional)", type: "string", placeholder: "input.lead.city" },
      { key: "state", label: "State (optional)", type: "string", placeholder: "input.lead.state" },
      { key: "specialty", label: "Specialty (optional)", type: "string", placeholder: "cardiology" },
    ], outputs: ["verified", "ambiguous", "unavailable"],
  },
  {
    type: "crm.consent_gate", label: "Consent / TCPA Gate", category: "crm",
    description: "Confirm a valid consent artifact (TrustedForm cert for web/vendor, recorded call + transcript for voice) plus TCPA opt-in before any outbound contact. Branches valid / invalid.",
    icon: "ShieldCheck", color: "bg-violet-600",
    params: [
      { key: "leadId", label: "Lead id (or path)", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "channel", label: "Channel override (optional)", type: "select", options: [
        { label: "Auto (from lead)", value: "" },
        { label: "Web / Text+Email", value: "web" },
        { label: "Vendor", value: "vendor" },
        { label: "Voice / Agent", value: "voice" },
      ], help: "Leave blank to derive from the lead's contact preference / source." },
    ], outputs: ["valid", "invalid"],
  },
  {
    type: "documents.esign_all_signed", label: "All Documents Signed?", category: "documents",
    description: "Check whether the claimant's e-sign packet is fully executed. Branches all_signed / pending.",
    icon: "FileCheck2", color: "bg-indigo-600",
    params: [
      { key: "leadId", label: "Lead id (or path)", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "requiredTemplateIds", label: "Required template ids (JSON array, optional)", type: "json", placeholder: "[1,2,3]", help: "If set, every listed template must have a signed envelope. Otherwise all envelopes on the lead must be signed." },
      { key: "minSigned", label: "Minimum signed (optional)", type: "number", help: "Alternative to required ids: at least N signed." },
    ], outputs: ["all_signed", "pending"],
  },
  {
    type: "crm.decision_engine", label: "Decision Engine Score", category: "crm",
    description: "Run the deterministic decision engine and return scoring + routing.",
    icon: "Scale", color: "bg-violet-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "tort", label: "Tort code (optional)", type: "string", placeholder: "depo_provera" },
    ], outputs: ["qualified", "rejected", "review"],
  },
  {
    type: "crm.competitive_intel_lookup", label: "Competitive Intel Lookup", category: "crm",
    description: "Pull current Google Ads Transparency Center creatives for a competing advertiser (via SerpAPI).",
    icon: "Eye", color: "bg-violet-600",
    params: [
      { key: "advertiserId", label: "Advertiser id (e.g. AR12345…)", type: "string", required: true, placeholder: "AR12345678901234567" },
    ], outputs: ["found", "empty", "error"],
  },
  {
    type: "crm.create_calendar_event", label: "Create Calendar Event", category: "crm",
    description: "Create a calendar/timeline event for a lead, case, or user.",
    icon: "Clock", color: "bg-violet-600",
    params: [
      { key: "title", label: "Title", type: "string", required: true, placeholder: "Intake call with {{input.lead.first_name}}" },
      { key: "startsAt", label: "Starts at (ISO)", type: "string", required: true, placeholder: "2026-06-01T15:00:00Z" },
      { key: "endsAt", label: "Ends at (ISO)", type: "string", placeholder: "2026-06-01T15:30:00Z" },
      { key: "entity", label: "Linked entity", type: "select", default: "lead", options: [
        { label: "Lead", value: "lead" }, { label: "Case", value: "case" }, { label: "User", value: "user" },
      ]},
      { key: "id", label: "Entity id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "notes", label: "Notes", type: "text", placeholder: "Confirm injury date and treating provider." },
    ],
  },

  // ──────────────── Communication (SMS / Calls / MMS / Voicemail) ────────────────
  {
    type: "comm.send_sms", label: "Send SMS (Text)", category: "communication",
    description: "Send an SMS via the configured SMS provider (Telnyx).",
    icon: "MessageSquare", color: "bg-pink-600",
    params: [
      { key: "to", label: "To number (E.164)", type: "string", required: true, placeholder: "+15555550100" },
      { key: "from", label: "From number (optional)", type: "string", placeholder: "+15555550199" },
      { key: "body", label: "Message", type: "text", required: true, placeholder: "Hi {{input.lead.first_name}}, your case file is ready — reply YES to proceed." },
    ],
  },
  {
    type: "comm.send_mms", label: "Send MMS", category: "communication",
    description: "Send a multimedia message with an attachment.",
    icon: "Image", color: "bg-pink-600",
    params: [
      { key: "to", label: "To number", type: "string", required: true, placeholder: "+15555550100" },
      { key: "body", label: "Message", type: "text", placeholder: "See attached document." },
      { key: "mediaUrl", label: "Media URL", type: "string", required: true, placeholder: "https://files.example.com/retainer.pdf" },
    ],
  },
  {
    type: "comm.make_call", label: "Make Outbound Call", category: "communication",
    description: "Initiate an outbound voice call (optionally connect to an AI agent).",
    icon: "PhoneCall", color: "bg-pink-600",
    params: [
      { key: "to", label: "To number", type: "string", required: true, placeholder: "+15555550100" },
      { key: "from", label: "From number (optional)", type: "string", placeholder: "+15555550199" },
      { key: "agentId", label: "AI voice agent id (optional)", type: "string", placeholder: "vapi-agent-id", help: "If set, the call connects to a Vapi/AI voice agent." },
      { key: "twiml", label: "TwiML / script (optional)", type: "text", placeholder: "<Response><Say>Hello, this is the law firm calling.</Say></Response>" },
    ], outputs: ["answered", "no_answer", "failed"],
  },
  {
    type: "comm.send_voicemail", label: "Drop Voicemail", category: "communication",
    description: "Drop a pre-recorded voicemail to the recipient's mailbox.",
    icon: "Voicemail", color: "bg-pink-600",
    params: [
      { key: "to", label: "To number", type: "string", required: true, placeholder: "+15555550100" },
      { key: "audioUrl", label: "Audio URL (mp3/wav)", type: "string", required: true, placeholder: "https://files.example.com/voicemail.mp3" },
    ],
  },
  {
    type: "comm.send_calendar_invite", label: "Send Calendar Invite", category: "communication",
    description: "Send an iCal calendar invite via email.",
    icon: "CalendarPlus", color: "bg-pink-600",
    params: [
      { key: "to", label: "To email", type: "string", required: true, placeholder: "client@example.com" },
      { key: "title", label: "Title", type: "string", required: true, placeholder: "Intake call with the legal team" },
      { key: "startsAt", label: "Starts at (ISO)", type: "string", required: true, placeholder: "2026-06-01T15:00:00Z" },
      { key: "endsAt", label: "Ends at (ISO)", type: "string", placeholder: "2026-06-01T15:30:00Z" },
      { key: "location", label: "Location / link", type: "string", placeholder: "https://meet.example.com/intake" },
      { key: "body", label: "Message body", type: "text", placeholder: "Looking forward to speaking with you about your case." },
    ],
  },

  // ──────────────── Documents ────────────────
  {
    type: "documents.render_template", label: "Render Doc Template", category: "documents",
    description: "Render a document template with variables → PDF/DOCX in the file vault.",
    icon: "FileSignature", color: "bg-indigo-600",
    params: [
      { key: "templateId", label: "Template id", type: "string", required: true, placeholder: "retainer-v2" },
      { key: "variables", label: "Variables (JSON)", type: "json", required: true, placeholder: '{"client_name":"input.lead.full_name","date_of_injury":"input.lead.injury_date"}' },
      { key: "format", label: "Format", type: "select", default: "pdf", options: [
        { label: "PDF", value: "pdf" }, { label: "DOCX", value: "docx" },
      ]},
    ],
  },
  {
    type: "documents.send_dropbox_sign", label: "Send via Dropbox Sign", category: "documents",
    description: "Send a packet for e-signature via Dropbox Sign.",
    icon: "FileSignature", color: "bg-indigo-600",
    params: [
      { key: "templateId", label: "Template id", type: "string", required: true, placeholder: "retainer-v2" },
      { key: "signerEmail", label: "Signer email", type: "string", required: true, placeholder: "input.lead.email" },
      { key: "signerName", label: "Signer name", type: "string", required: true, placeholder: "input.lead.full_name" },
      { key: "fields", label: "Pre-fill fields (JSON)", type: "json", placeholder: '{"date_of_injury":"input.lead.injury_date"}' },
      { key: "notifySigner", label: "Text signing link to claimant (embedded)", type: "boolean", placeholder: "false" },
    ],
  },
  {
    type: "documents.send_docusign", label: "Send via DocuSign", category: "documents",
    description: "Send a packet for e-signature via DocuSign.",
    icon: "FileSignature", color: "bg-indigo-600",
    params: [
      { key: "templateId", label: "DocuSign template id", type: "string", required: true, placeholder: "docusign-template-id" },
      { key: "signerEmail", label: "Signer email", type: "string", required: true, placeholder: "input.lead.email" },
      { key: "signerName", label: "Signer name", type: "string", required: true, placeholder: "input.lead.full_name" },
      { key: "fields", label: "Tab values (JSON)", type: "json", placeholder: '{"DateOfInjury":"input.lead.injury_date"}' },
      { key: "notifySigner", label: "Text signing link to claimant (embedded)", type: "boolean", placeholder: "false" },
    ],
  },
  {
    type: "documents.fax_medical_records", label: "Fax Medical Records", category: "documents",
    description: "Send a medical records request fax to a provider.",
    icon: "Printer", color: "bg-indigo-600",
    params: [
      { key: "leadId", label: "Lead id (or path like input.lead.id)", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "providerFax", label: "Override fax number (defaults to lead.hospital_fax)", type: "string", help: "Leave blank to use the provider fax stored on the lead." },
      { key: "integrationId", label: "Explicit fax integration id (optional)", type: "string", help: "Leave blank to use the firm's default fax integration." },
    ], outputs: ["sent", "failed"],
  },
  {
    type: "documents.ocr_extract", label: "OCR Extract", category: "documents",
    description: "Run OCR on an uploaded document and return extracted text.",
    icon: "ScanText", color: "bg-indigo-600",
    params: [
      { key: "documentId", label: "Document id (or path)", type: "string", required: true, placeholder: "input.document.id" },
      { key: "language", label: "Language", type: "string", default: "en" },
    ],
  },
  {
    type: "documents.medical_extract", label: "AI Medical Record Extract", category: "documents",
    description: "Use AI to extract structured fields (diagnoses, medications, dates) from a medical record.",
    icon: "Brain", color: "bg-indigo-600",
    params: [
      { key: "documentId", label: "Document id", type: "string", required: true, placeholder: "input.document.id" },
      { key: "schema", label: "Field schema (JSON)", type: "json", placeholder: '{"diagnoses":["string"],"medications":["string"],"dates":["YYYY-MM-DD"]}' },
    ],
  },

  // ──────────────── Forms ────────────────
  {
    type: "forms.publish", label: "Publish Web Form", category: "forms",
    description: "Publish or re-publish a form built in the Form Engine.",
    icon: "AppWindow", color: "bg-teal-600",
    params: [
      { key: "formId", label: "Form id", type: "string", required: true, placeholder: "intake-v3" },
      { key: "version", label: "Version label (optional)", type: "string", placeholder: "2026-06-01" },
    ],
  },
  {
    type: "forms.embed_script", label: "Get Embed Script", category: "forms",
    description: "Return the embeddable JavaScript snippet for a published form.",
    icon: "Code2", color: "bg-teal-600",
    params: [
      { key: "formId", label: "Form id", type: "string", required: true, placeholder: "intake-v3" },
    ],
  },
  {
    type: "forms.validate_submission", label: "Validate Form Submission", category: "forms",
    description: "Run TCPA / TrustedForm / field validation against a payload.",
    icon: "ShieldCheck", color: "bg-teal-600",
    params: [
      { key: "formId", label: "Form id", type: "string", required: true, placeholder: "intake-v3" },
      { key: "payload", label: "Payload (JSON)", type: "json", required: true, placeholder: "input.payload" },
    ], outputs: ["valid", "invalid"],
  },
  {
    type: "forms.create_lead_from_submission", label: "Create Lead from Submission", category: "forms",
    description: "Run the standard lead-intake pipeline (dedup + create/update) for a form payload.",
    icon: "UserPlus", color: "bg-teal-600",
    params: [
      { key: "formId", label: "Form id", type: "string", required: true, placeholder: "intake-v3" },
      { key: "payload", label: "Payload (JSON)", type: "json", required: true, placeholder: "input.payload" },
    ],
  },

  // ──────────────── AI Agents (extended) ────────────────
  {
    type: "ai.agent", label: "AI Agent (Autonomous)", category: "ai",
    description: "Single-turn LLM completion. ⚠️ maxSteps > 1 is not yet implemented — requesting multiple steps routes to the `max_steps` branch for human review.",
    icon: "Bot", color: "bg-fuchsia-600",
    params: [
      { key: "goal", label: "Goal / instructions", type: "text", required: true, placeholder: "Qualify this lead, run a background check, and route to the right paralegal." },
      { key: "tools", label: "Allowed tools (JSON array)", type: "json", placeholder: '["crm.update_lead","comm.send_sms","io.sql_query"]' },
      { key: "maxSteps", label: "Max steps", type: "number", default: 10 },
      { key: "model", label: "Model", type: "select", default: "gpt-4o", options: [
        { label: "GPT-4o", value: "gpt-4o" }, { label: "GPT-4o mini", value: "gpt-4o-mini" },
        { label: "Claude 3.5 Sonnet", value: "claude-3-5-sonnet" },
      ]},
    ], outputs: ["success", "max_steps", "error"],
  },
  {
    type: "ai.classify", label: "AI Classify", category: "ai",
    description: "Classify text into one of N labels.",
    icon: "Tag", color: "bg-fuchsia-600",
    params: [
      { key: "text", label: "Text path", type: "string", required: true, placeholder: "input.body" },
      { key: "labels", label: "Labels (JSON array)", type: "json", required: true, placeholder: '["urgent","normal","spam"]' },
    ],
  },
  {
    type: "ai.chat_response", label: "AI Chat Response", category: "ai",
    description: "Generate a contextual chat reply to an inbound message.",
    icon: "MessageCircle", color: "bg-fuchsia-600",
    params: [
      { key: "message", label: "Inbound message path", type: "string", required: true, placeholder: "input.body" },
      { key: "persona", label: "Persona / system prompt", type: "text", placeholder: "You are a friendly legal intake assistant. Always confirm sensitive details before proceeding." },
      { key: "history", label: "Conversation history path (optional)", type: "string", placeholder: "input.thread.messages" },
    ],
  },
  {
    type: "ai.voice_agent", label: "AI Voice Agent (Vapi)", category: "ai",
    description: "Connect a phone call to a configured Vapi/AI voice agent.",
    icon: "Phone", color: "bg-fuchsia-600",
    params: [
      { key: "agentId", label: "Vapi agent id", type: "string", required: true, placeholder: "vapi-agent-id" },
      { key: "callId", label: "Call id (or path)", type: "string", required: true, placeholder: "input.call.id" },
      { key: "metadata", label: "Metadata (JSON)", type: "json", placeholder: '{"lead_id":"input.lead.id"}' },
    ], outputs: ["completed", "failed"],
  },
  {
    type: "ai.transcribe", label: "AI Transcribe Audio", category: "ai",
    description: "Transcribe a voicemail or call recording to text.",
    icon: "Mic", color: "bg-fuchsia-600",
    params: [
      { key: "audioUrl", label: "Audio URL", type: "string", required: true, placeholder: "input.recording_url" },
      { key: "language", label: "Language", type: "string", default: "en" },
    ],
  },

  // ──────────────── Integrations ────────────────
  {
    type: "integration.send_email", label: "Send Email", category: "integration",
    description: "Send transactional email via the configured email provider (SendGrid).",
    icon: "Mail", color: "bg-rose-600",
    params: [
      { key: "to", label: "To", type: "string", required: true, placeholder: "client@example.com" },
      { key: "subject", label: "Subject", type: "string", required: true, placeholder: "Your case update from {{firm.name}}" },
      { key: "html", label: "HTML body", type: "text", required: true, placeholder: "<p>Hi {{input.lead.first_name}},</p><p>Thank you for reaching out. Your intake has been received.</p>" },
      { key: "from", label: "From (optional)", type: "string", placeholder: "intake@example.com" },
    ],
  },
  {
    type: "integration.send_fax", label: "Send Fax", category: "integration",
    description: "Send a fax via the configured fax provider (SRFax).",
    icon: "Printer", color: "bg-rose-600",
    params: [
      { key: "to", label: "To fax number", type: "string", required: true, placeholder: "+15555550101" },
      { key: "documentUrl", label: "Document URL", type: "string", required: true, placeholder: "input.document.url" },
      { key: "coverNote", label: "Cover note", type: "text", placeholder: "Medical records request — please return within 30 days." },
    ],
  },
  {
    type: "integration.send_esign", label: "Send for E-Signature", category: "integration",
    description: "Send a document for e-signature via the configured provider.",
    icon: "FileSignature", color: "bg-rose-600",
    params: [
      { key: "templateId", label: "Document template id", type: "string", required: true, placeholder: "retainer-v2" },
      { key: "signerEmail", label: "Signer email", type: "string", required: true, placeholder: "input.lead.email" },
      { key: "signerName", label: "Signer name", type: "string", required: true, placeholder: "input.lead.full_name" },
      { key: "notifySigner", label: "Text signing link to claimant (embedded)", type: "boolean", placeholder: "false" },
    ],
  },
  {
    type: "integration.webhook_out", label: "Outbound Webhook", category: "integration",
    description: "POST a payload to a third-party webhook URL.",
    icon: "Webhook", color: "bg-rose-600",
    params: [
      { key: "url", label: "URL", type: "string", required: true, placeholder: "https://example.com/hooks/mtos" },
      { key: "method", label: "Method", type: "select", default: "POST", options: [
        { label: "POST", value: "POST" }, { label: "PUT", value: "PUT" },
        { label: "PATCH", value: "PATCH" }, { label: "DELETE", value: "DELETE" },
      ]},
      { key: "headers", label: "Headers (JSON)", type: "json", placeholder: '{"X-Source":"mtos","Content-Type":"application/json"}' },
      { key: "body", label: "Body (JSON)", type: "json", placeholder: '{"event":"lead.created","lead_id":"input.lead.id"}' },
      { key: "hmacSecret", label: "HMAC secret (optional)", type: "string", help: "Leave blank to skip request signing." },
    ],
  },
  {
    type: "integration.http_request", label: "HTTP Request", category: "integration",
    description: "Generic HTTP fetch — call any REST API.",
    icon: "Globe", color: "bg-rose-600",
    params: [
      { key: "url", label: "URL", type: "string", required: true, placeholder: "https://api.example.com/v1/resource" },
      { key: "method", label: "Method", type: "select", default: "GET", options: [
        { label: "GET", value: "GET" }, { label: "POST", value: "POST" },
        { label: "PUT", value: "PUT" }, { label: "PATCH", value: "PATCH" }, { label: "DELETE", value: "DELETE" },
      ]},
      { key: "headers", label: "Headers (JSON)", type: "json", placeholder: '{"Accept":"application/json","Authorization":"Bearer …"}' },
      { key: "body", label: "Body (JSON or string)", type: "json", placeholder: '{"key":"value"}' },
      { key: "responseType", label: "Response", type: "select", default: "json", options: [
        { label: "JSON", value: "json" }, { label: "Text", value: "text" },
      ]},
    ],
  },
  {
    type: "integration.web_search", label: "Web Search", category: "integration",
    description: "Run a Google/Bing/Yahoo search via the configured search provider (SerpAPI). Returns structured organic results.",
    icon: "Search", color: "bg-rose-600",
    params: [
      { key: "query", label: "Query", type: "string", required: true, placeholder: "input.lead.full_name OR \"asbestos verdict 2024\"" },
      { key: "engine", label: "Engine", type: "select", default: "google", options: [
        { label: "Google", value: "google" }, { label: "Bing", value: "bing" }, { label: "Yahoo", value: "yahoo" }, { label: "DuckDuckGo", value: "duckduckgo" },
      ]},
      { key: "location", label: "Location (optional)", type: "string", placeholder: "Austin, Texas, United States" },
      { key: "maxResults", label: "Max results", type: "number", default: 10, help: "1–100. Provider may cap below this." },
      { key: "provider", label: "Search provider", type: "select", default: "serpapi", options: [
        { label: "SerpAPI", value: "serpapi" },
      ], help: "Only providers with a wired adapter appear here." },
    ],
  },
  {
    type: "integration.graphql", label: "GraphQL Query", category: "integration",
    description: "Execute a GraphQL query against an endpoint.",
    icon: "Network", color: "bg-rose-600",
    params: [
      { key: "url", label: "Endpoint", type: "string", required: true, placeholder: "https://api.example.com/graphql" },
      { key: "query", label: "Query", type: "code", language: "javascript", required: true, placeholder: "query GetLead($id: ID!) { lead(id: $id) { id status } }" },
      { key: "variables", label: "Variables (JSON)", type: "json", placeholder: '{"id":"input.lead.id"}' },
      { key: "headers", label: "Headers (JSON)", type: "json", placeholder: '{"Authorization":"Bearer …"}' },
    ],
  },
  {
    type: "integration.n8n_execute", label: "Run n8n Workflow", category: "integration",
    description: "Execute a workflow in your firm's connected n8n instance (via the n8n MCP server) and return its execution id. Set your firm's n8n MCP server URL (api_url) + access token (api_key) under Integrations — each firm uses its own connection.",
    icon: "Workflow", color: "bg-rose-600",
    params: [
      { key: "workflowId", label: "n8n Workflow ID", type: "string", required: true, placeholder: "the workflow's id from n8n (e.g. from Run n8n Workflows list)" },
      { key: "inputs", label: "Inputs (JSON)", type: "json", placeholder: '{"lead_id":"input.lead.id","email":"input.lead.email"}', help: "Passed to the n8n workflow's trigger as input data. Field paths like input.lead.id are resolved before sending." },
      { key: "executionMode", label: "Mode", type: "select", default: "production", options: [
        { label: "Production", value: "production" }, { label: "Test", value: "test" },
      ]},
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
      { key: "text", label: "Text path", type: "string", required: true, placeholder: "input.body" },
      { key: "maxWords", label: "Max words", type: "number", default: 200 },
    ],
  },
  {
    type: "ai.draft", label: "AI Draft Text", category: "ai",
    description: "Generate text from a prompt template.",
    icon: "Sparkles", color: "bg-fuchsia-600",
    params: [
      { key: "prompt", label: "Prompt", type: "text", required: true, placeholder: "Write a friendly intake follow-up to {{input.lead.first_name}} confirming we received their information." },
      { key: "system", label: "System (optional)", type: "text", placeholder: "You are a paralegal writing in plain, empathetic language." },
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
      { key: "command", label: "Bash command", type: "code", language: "bash", required: true, placeholder: "echo \"hello from $(hostname) at $(date -Iseconds)\"" },
      { key: "timeoutMs", label: "Timeout (ms)", type: "number", default: 15000 },
      { key: "approved", label: "I confirm this is safe", type: "boolean", default: false, required: true },
    ],
  },
  {
    type: "script.powershell", label: "Run PowerShell", category: "script",
    description: "Run a PowerShell command (requires PowerShell installed). Approved-only.",
    icon: "TerminalSquare", color: "bg-orange-600",
    params: [
      { key: "command", label: "PowerShell command", type: "code", language: "powershell", required: true, placeholder: "Get-Date | ConvertTo-Json" },
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
      { key: "key", label: "Object key", type: "string", required: true, placeholder: "leads/{{input.lead.id}}/intake.pdf" },
    ],
  },
  {
    type: "io.write_file", label: "Write File", category: "io",
    description: "Write a payload to object storage.",
    icon: "FileUp", color: "bg-cyan-600",
    params: [
      { key: "key", label: "Object key", type: "string", required: true, placeholder: "leads/{{input.lead.id}}/note.json" },
      { key: "content", label: "Content (string or JSON)", type: "json", required: true, placeholder: '{"note":"Auto-generated by workflow"}' },
      { key: "contentType", label: "Content type", type: "string", default: "application/json" },
    ],
  },

  // ──────────────── More Triggers ────────────────
  {
    type: "trigger.lead_status_changed", label: "On Lead Status Changed", category: "trigger",
    description: "Fires when a lead is moved to a new pipeline status.",
    icon: "ArrowRightLeft", color: "bg-emerald-600",
    params: [
      { key: "toStatus", label: "To status filter (optional)", type: "string", placeholder: "qualified" },
      { key: "tort", label: "Tort filter (optional)", type: "string" },
    ], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.note_added", label: "On Note Added", category: "trigger",
    description: "Fires when a timeline note is added to a lead or case.",
    icon: "StickyNote", color: "bg-emerald-600",
    params: [
      { key: "entity", label: "Entity filter", type: "select", default: "lead", options: [
        { label: "Lead", value: "lead" }, { label: "Case", value: "case" }, { label: "Any", value: "" },
      ]},
    ], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.payment_received", label: "On Payment Received", category: "trigger",
    description: "Fires when a payment or fee is recorded on a case.",
    icon: "DollarSign", color: "bg-emerald-600",
    params: [
      { key: "minAmount", label: "Minimum amount (optional)", type: "number" },
    ], inputs: 0, outputs: 1,
  },
  {
    type: "trigger.time_since_last_contact", label: "No Contact Reminder", category: "trigger",
    description: "Fires when a lead has had no contact for N days.",
    icon: "BellOff", color: "bg-emerald-600",
    params: [
      { key: "days", label: "Days without contact", type: "number", default: 7, required: true },
      { key: "status", label: "Lead status filter (optional)", type: "string" },
    ], inputs: 0, outputs: 1,
  },

  // ──────────────── More CRM ────────────────
  {
    type: "crm.search_leads", label: "Search Leads", category: "crm",
    description: "Query leads by status, tort, date range, or custom filters.",
    icon: "Search", color: "bg-violet-600",
    params: [
      { key: "filters", label: "Filters (JSON)", type: "json", required: true, placeholder: '{"status":"qualified","tort":"roundup"}' },
      { key: "limit", label: "Max results", type: "number", default: 50 },
      { key: "orderBy", label: "Order by", type: "string", placeholder: "created_at desc" },
    ],
  },
  {
    type: "crm.tag_lead", label: "Tag / Label Lead", category: "crm",
    description: "Add one or more tags to a lead for filtering and routing.",
    icon: "Tag", color: "bg-violet-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "tags", label: "Tags (JSON array)", type: "json", required: true, placeholder: '["priority","review-needed"]' },
      { key: "mode", label: "Mode", type: "select", default: "add", options: [
        { label: "Add", value: "add" }, { label: "Replace all", value: "replace" }, { label: "Remove", value: "remove" },
      ]},
    ],
  },
  {
    type: "crm.close_lead", label: "Close / Archive Lead", category: "crm",
    description: "Mark a lead as closed with a reason code.",
    icon: "Archive", color: "bg-violet-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "reason", label: "Reason", type: "select", default: "not_qualified", options: [
        { label: "Not qualified", value: "not_qualified" }, { label: "Duplicate", value: "duplicate" },
        { label: "Client withdrew", value: "client_withdrew" }, { label: "Statute of limitations", value: "sol" },
        { label: "Lost to competitor", value: "lost" }, { label: "Settled", value: "settled" },
      ]},
      { key: "note", label: "Closing note", type: "text" },
    ],
  },
  {
    type: "crm.escalate_to_attorney", label: "Escalate to Attorney", category: "crm",
    description: "Flag a lead or case for immediate attorney review.",
    icon: "Scale", color: "bg-violet-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "reason", label: "Escalation reason", type: "text", required: true, placeholder: "High-value case — possible class action coordination." },
      { key: "urgent", label: "Mark urgent", type: "boolean", default: false },
    ],
  },
  {
    type: "crm.merge_leads", label: "Merge Duplicate Leads", category: "crm",
    description: "Merge two lead records, keeping one as the canonical record.",
    icon: "GitMerge", color: "bg-violet-600",
    params: [
      { key: "primaryId", label: "Primary lead id (keep)", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "duplicateId", label: "Duplicate lead id (discard)", type: "string", required: true, placeholder: "input.duplicate_id" },
    ], outputs: ["merged", "error"],
  },
  {
    type: "crm.send_internal_alert", label: "Send Internal Alert", category: "crm",
    description: "Notify your team via an internal bell notification inside the CRM.",
    icon: "Bell", color: "bg-violet-600",
    params: [
      { key: "title", label: "Alert title", type: "string", required: true, placeholder: "Action required: {{input.lead.full_name}}" },
      { key: "body", label: "Alert body", type: "text", placeholder: "Background check flagged. Please review before proceeding." },
      { key: "role", label: "Notify role", type: "select", default: "admin", options: [
        { label: "Admin", value: "admin" }, { label: "Attorney", value: "attorney" },
        { label: "Paralegal", value: "paralegal" }, { label: "All", value: "all" },
      ]},
      { key: "leadId", label: "Link to lead id (optional)", type: "string", placeholder: "input.lead.id" },
    ],
  },
  {
    type: "crm.export_leads", label: "Export Leads to CSV", category: "crm",
    description: "Export a set of leads to a CSV file in the vault.",
    icon: "FileDown", color: "bg-violet-600",
    params: [
      { key: "filters", label: "Filters (JSON)", type: "json", placeholder: '{"status":"qualified","tort":"roundup"}' },
      { key: "fields", label: "Fields to include (JSON array)", type: "json", placeholder: '["first_name","last_name","email","status","tort"]' },
      { key: "filename", label: "Output filename", type: "string", placeholder: "qualified-leads-{{date}}.csv" },
    ],
  },

  // ──────────────── More Communication ────────────────
  {
    type: "comm.bulk_sms", label: "Bulk SMS Campaign", category: "communication",
    description: "Send an SMS to a list of leads matching a filter.",
    icon: "MessagesSquare", color: "bg-pink-600",
    params: [
      { key: "filters", label: "Lead filters (JSON)", type: "json", required: true, placeholder: '{"status":"working","tort":"talcum"}' },
      { key: "body", label: "Message template", type: "text", required: true, placeholder: "Hi {{lead.first_name}}, important update about your case…" },
      { key: "maxBatch", label: "Max batch size", type: "number", default: 100, help: "Hard cap per run to prevent accidental mass sends." },
    ], outputs: ["sent", "partial", "error"],
  },
  {
    type: "comm.schedule_callback", label: "Schedule Callback", category: "communication",
    description: "Schedule a follow-up call to a lead at a specific time.",
    icon: "PhoneCall", color: "bg-pink-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "scheduledAt", label: "Scheduled at (ISO)", type: "string", required: true, placeholder: "2026-06-15T14:00:00Z" },
      { key: "agentId", label: "Assigned agent id (optional)", type: "string" },
      { key: "note", label: "Call notes", type: "text", placeholder: "Follow up on intake. Ask about surgery date." },
    ],
  },
  {
    type: "comm.send_email_sequence", label: "Start Email Drip Sequence", category: "communication",
    description: "Enroll a lead in a multi-step email drip campaign.",
    icon: "MailCheck", color: "bg-pink-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "sequenceId", label: "Sequence id", type: "string", required: true, placeholder: "roundup-nurture-v2" },
      { key: "startAt", label: "Start at (ISO, blank = now)", type: "string" },
    ],
  },
  {
    type: "comm.ringless_voicemail", label: "Ringless Voicemail Drop", category: "communication",
    description: "Drop a pre-recorded voicemail directly to mailbox without ringing.",
    icon: "Voicemail", color: "bg-pink-600",
    params: [
      { key: "to", label: "To number (E.164)", type: "string", required: true, placeholder: "input.lead.phone" },
      { key: "audioUrl", label: "Audio file URL (mp3/wav)", type: "string", required: true, placeholder: "https://files.example.com/vm-intro.mp3" },
      { key: "callerIdName", label: "Caller ID name", type: "string", placeholder: "Justice Legal Group" },
    ],
  },

  // ──────────────── More Documents ────────────────
  {
    type: "documents.generate_pdf", label: "Generate PDF Report", category: "documents",
    description: "Generate a formatted PDF report and save to the file vault.",
    icon: "FileText", color: "bg-indigo-600",
    params: [
      { key: "templateId", label: "Report template id", type: "string", required: true, placeholder: "case-summary-v1" },
      { key: "data", label: "Report data (JSON)", type: "json", required: true, placeholder: '{"lead_id":"input.lead.id","include_notes":true}' },
      { key: "filename", label: "Output filename", type: "string", placeholder: "case-summary-{{date}}.pdf" },
    ],
  },
  {
    type: "documents.request_medical_auth", label: "Request Medical Authorization", category: "documents",
    description: "Send a HIPAA medical authorization form to the claimant for e-signature.",
    icon: "FileLock", color: "bg-indigo-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "providerName", label: "Provider name", type: "string", placeholder: "input.lead.physician_last_name" },
      { key: "sendSms", label: "Text signing link to claimant", type: "boolean", default: true },
    ], outputs: ["sent", "error"],
  },
  {
    type: "documents.archive", label: "Archive Document", category: "documents",
    description: "Move a document to the archive tier in the file vault.",
    icon: "FolderArchive", color: "bg-indigo-600",
    params: [
      { key: "documentId", label: "Document id", type: "string", required: true, placeholder: "input.document.id" },
      { key: "reason", label: "Archive reason", type: "string", placeholder: "Superseded by updated version." },
    ],
  },

  // ──────────────── More AI ────────────────
  {
    type: "ai.risk_score", label: "AI Risk Score", category: "ai",
    description: "Score a lead's litigation risk and merit using AI analysis of their intake data.",
    icon: "AlertTriangle", color: "bg-fuchsia-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "factors", label: "Custom risk factors (JSON, optional)", type: "json", placeholder: '{"injury_severity":"high","SOL_years_remaining":2}' },
    ], outputs: ["high", "medium", "low"],
  },
  {
    type: "ai.sentiment", label: "Sentiment Analysis", category: "ai",
    description: "Detect positive, negative, or neutral sentiment from text.",
    icon: "SmilePlus", color: "bg-fuchsia-600",
    params: [
      { key: "text", label: "Text path", type: "string", required: true, placeholder: "input.message.body" },
    ], outputs: ["positive", "negative", "neutral"],
  },
  {
    type: "ai.translate", label: "Translate Text", category: "ai",
    description: "Translate text to a target language using AI.",
    icon: "Languages", color: "bg-fuchsia-600",
    params: [
      { key: "text", label: "Text path", type: "string", required: true, placeholder: "input.body" },
      { key: "targetLanguage", label: "Target language", type: "string", required: true, placeholder: "Spanish" },
    ],
  },
  {
    type: "ai.medical_summary", label: "Medical Summary", category: "ai",
    description: "Generate a plain-language medical summary from clinical records for attorney review.",
    icon: "Stethoscope", color: "bg-fuchsia-600",
    params: [
      { key: "documentId", label: "Document id", type: "string", required: true, placeholder: "input.document.id" },
      { key: "focusAreas", label: "Focus areas (JSON array, optional)", type: "json", placeholder: '["diagnoses","procedures","medications","prognosis"]' },
    ],
  },
  {
    type: "ai.fraud_detect", label: "AI Fraud Detection", category: "ai",
    description: "Analyze intake data for signs of fraud, duplicate identity, or manipulated documents.",
    icon: "ShieldAlert", color: "bg-fuchsia-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
    ], outputs: ["clear", "suspicious", "flagged"],
  },

  // ──────────────── More Integrations ────────────────
  {
    type: "integration.slack_notify", label: "Slack Notification", category: "integration",
    description: "Post a message to a Slack channel via an incoming webhook.",
    icon: "MessageSquare", color: "bg-rose-600",
    params: [
      { key: "webhookUrl", label: "Slack Incoming Webhook URL", type: "string", required: true, placeholder: "https://hooks.slack.com/services/…" },
      { key: "channel", label: "Channel (optional override)", type: "string", placeholder: "#intake-alerts" },
      { key: "text", label: "Message", type: "text", required: true, placeholder: "🚨 New qualified lead: {{input.lead.full_name}} ({{input.lead.tort}})" },
      { key: "username", label: "Bot username", type: "string", placeholder: "MTOS Bot" },
    ],
  },
  {
    type: "integration.stripe_charge", label: "Stripe Charge / Invoice", category: "integration",
    description: "Create a Stripe payment intent or invoice for a client.",
    icon: "CreditCard", color: "bg-rose-600",
    params: [
      { key: "amount", label: "Amount (cents)", type: "number", required: true, placeholder: "50000" },
      { key: "currency", label: "Currency", type: "string", default: "usd" },
      { key: "customerId", label: "Stripe customer id", type: "string", placeholder: "cus_xxxxx" },
      { key: "description", label: "Description", type: "string", placeholder: "Case filing fee — {{input.lead.full_name}}" },
      { key: "mode", label: "Mode", type: "select", default: "payment_intent", options: [
        { label: "Payment intent", value: "payment_intent" }, { label: "Invoice", value: "invoice" },
      ]},
    ], outputs: ["succeeded", "requires_action", "failed"],
  },
  {
    type: "integration.twilio_lookup", label: "Twilio Number Lookup", category: "integration",
    description: "Validate a phone number and check for TCPA wireless/landline type via Twilio Lookup.",
    icon: "Phone", color: "bg-rose-600",
    params: [
      { key: "phoneNumber", label: "Phone number (E.164)", type: "string", required: true, placeholder: "input.lead.phone" },
      { key: "lookupType", label: "Lookup types", type: "select", default: "line_type_intelligence", options: [
        { label: "Line type (wireless/landline)", value: "line_type_intelligence" },
        { label: "Caller name (CNAM)", value: "caller_name" },
        { label: "Both", value: "both" },
      ]},
    ], outputs: ["valid", "invalid", "error"],
  },
  {
    type: "integration.hubspot_sync", label: "HubSpot Contact Sync", category: "integration",
    description: "Create or update a HubSpot contact record with lead data.",
    icon: "RefreshCw", color: "bg-rose-600",
    params: [
      { key: "leadId", label: "Lead id", type: "string", required: true, placeholder: "input.lead.id" },
      { key: "portalId", label: "HubSpot portal id", type: "string", required: true, placeholder: "12345678" },
      { key: "apiKey", label: "HubSpot API key (Private App Token)", type: "string", required: true },
      { key: "extraFields", label: "Extra properties (JSON)", type: "json", placeholder: '{"hs_lead_status":"IN_PROGRESS","lifecyclestage":"lead"}' },
    ], outputs: ["created", "updated", "error"],
  },
  {
    type: "integration.zapier_trigger", label: "Zapier Trigger", category: "integration",
    description: "Hit a Zapier Catch Hook to trigger any Zap in your account.",
    icon: "Zap", color: "bg-rose-600",
    params: [
      { key: "webhookUrl", label: "Zapier Catch Hook URL", type: "string", required: true, placeholder: "https://hooks.zapier.com/hooks/catch/…" },
      { key: "payload", label: "Payload (JSON)", type: "json", required: true, placeholder: '{"lead_id":"input.lead.id","status":"input.lead.status","tort":"input.lead.tort"}' },
    ],
  },

  // ──────────────── More Logic ────────────────
  {
    type: "logic.try_catch", label: "Try / Catch", category: "logic",
    description: "Run downstream nodes; if any throw, route to the error branch instead of failing the run.",
    icon: "ShieldOff", color: "bg-amber-500",
    params: [
      { key: "errorVar", label: "Store error in variable", type: "string", placeholder: "lastError" },
    ], outputs: ["try", "catch"],
  },
  {
    type: "logic.rate_limit", label: "Rate Limit / Throttle", category: "logic",
    description: "Allow only N executions per time window; route excess to throttled branch.",
    icon: "Gauge", color: "bg-amber-500",
    params: [
      { key: "maxRuns", label: "Max runs", type: "number", default: 100, required: true },
      { key: "windowSeconds", label: "Window (seconds)", type: "number", default: 3600, required: true },
      { key: "key", label: "Rate key (e.g. per-lead, per-firm)", type: "string", placeholder: "input.lead.id" },
    ], outputs: ["allowed", "throttled"],
  },
  {
    type: "logic.wait_for_condition", label: "Wait for Condition", category: "logic",
    description: "Poll until a condition is true or until a timeout expires.",
    icon: "TimerReset", color: "bg-amber-500",
    params: [
      { key: "expression", label: "Condition (JS expression)", type: "code", language: "javascript", required: true, placeholder: "input.lead.status === 'qualified'" },
      { key: "pollEverySeconds", label: "Poll every N seconds", type: "number", default: 10 },
      { key: "timeoutSeconds", label: "Timeout (seconds)", type: "number", default: 30 },
    ], outputs: ["resolved", "timeout"],
  },

  // ──────────────── More Data ────────────────
  {
    type: "data.merge", label: "Merge Objects", category: "data",
    description: "Deep-merge two or more JSON objects into one.",
    icon: "Layers", color: "bg-sky-600",
    params: [
      { key: "base", label: "Base object path", type: "string", required: true, placeholder: "input.lead" },
      { key: "override", label: "Override object (JSON)", type: "json", required: true, placeholder: '{"status":"qualified","score":85}' },
    ],
  },
  {
    type: "data.format_date", label: "Format Date", category: "data",
    description: "Parse and reformat a date string.",
    icon: "Calendar", color: "bg-sky-600",
    params: [
      { key: "date", label: "Date path or value", type: "string", required: true, placeholder: "input.created_at" },
      { key: "outputFormat", label: "Output format", type: "string", default: "YYYY-MM-DD", placeholder: "MM/DD/YYYY" },
    ],
  },
  {
    type: "data.generate_id", label: "Generate Unique ID", category: "data",
    description: "Generate a UUID or short unique identifier.",
    icon: "Hash", color: "bg-sky-600",
    params: [
      { key: "format", label: "Format", type: "select", default: "uuid", options: [
        { label: "UUID v4", value: "uuid" }, { label: "Short (8 chars)", value: "short" }, { label: "Numeric (timestamp-based)", value: "numeric" },
      ]},
      { key: "varName", label: "Store in variable", type: "string", placeholder: "generatedId" },
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
      { key: "message", label: "Message", type: "text", required: true, placeholder: "Reached step with input={{JSON.stringify(input)}}" },
    ],
  },
  {
    type: "utility.end", label: "End Workflow", category: "utility",
    description: "Stop execution. Optional return value becomes the run output.",
    icon: "Square", color: "bg-slate-500",
    params: [
      { key: "output", label: "Return value (JSON)", type: "json", placeholder: '{"status":"done","lead_id":"input.lead.id"}' },
    ], outputs: 0,
  },
];

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return NODE_CATALOG.find((n) => n.type === type);
}
