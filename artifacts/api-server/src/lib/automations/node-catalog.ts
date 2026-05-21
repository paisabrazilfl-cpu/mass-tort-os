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
      { key: "name", label: "Variable name", type: "string", required: true, placeholder: "qualifiedScore" },
      { key: "value", label: "Value (JSON or expression)", type: "json", required: true, placeholder: '{"score":85,"tier":"A"}' },
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
    type: "crm.npi_lookup", label: "NPI Lookup", category: "crm",
    description: "Resolve a healthcare provider via the NPPES NPI registry.",
    icon: "Stethoscope", color: "bg-violet-600",
    params: [
      { key: "npi", label: "NPI number (or path)", type: "string", required: true, placeholder: "input.npi" },
    ],
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
    description: "Run an autonomous AI agent that plans, calls automation nodes as tools, observes each result, and loops until the goal is met. Powered by Bitdeer AI.",
    icon: "Bot", color: "bg-fuchsia-600",
    params: [
      { key: "goal", label: "Goal / instructions", type: "text", required: true, placeholder: "Qualify this lead, run a background check, and route to the right paralegal." },
      { key: "tools", label: "Allowed tools (JSON array — blank = every reachable node)", type: "json", placeholder: '["crm.update_lead","comm.send_sms","io.sql_query"]', help: "Restrict the agent to these node types. Leave blank to grant the full reachable catalog. Triggers, logic nodes, End, and ai.agent itself are always excluded." },
      { key: "maxSteps", label: "Max steps", type: "number", default: 10, help: "Hard cap on plan→act→observe iterations (clamped 1–25)." },
      { key: "model", label: "Reasoning model", type: "select", default: "planner", options: [
        { label: "Planner — Nemotron-3-Super (deep reasoning)", value: "planner" },
        { label: "Chat — Devstral-2 (fast, general)", value: "chat" },
        { label: "Code — Devstral-2 (tool / structured)", value: "code" },
      ]},
      { key: "dryRun", label: "Dry run (simulate write tools)", type: "boolean", default: false, help: "When on, write tools are simulated instead of executed — read/query tools still run so the agent plans against real data." },
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
    type: "ai.rerank", label: "AI Rerank", category: "ai",
    description: "Re-score candidate documents by relevance to a query (BAAI/bge-reranker-v2-m3). Keep the top-N that actually matter.",
    icon: "ListOrdered", color: "bg-fuchsia-600",
    params: [
      { key: "query", label: "Query path/text", type: "string", required: true, placeholder: "input.question" },
      { key: "documents", label: "Documents path (string array)", type: "string", required: true, placeholder: "input.candidates" },
      { key: "topN", label: "Keep top-N", type: "number", default: 5 },
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
    ],
    // utility.end is a sink — no downstream edges are allowed. The handler
    // emits the synthetic branch name "__end__" that the executor treats as
    // a stop signal (see executor.ts → utility.end). Declaring the branch
    // here pins the contract so the catalog↔handler parity test catches any
    // future regression that adds a real outgoing edge to End.
    outputs: ["__end__"],
  },
];

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return NODE_CATALOG.find((n) => n.type === type);
}
