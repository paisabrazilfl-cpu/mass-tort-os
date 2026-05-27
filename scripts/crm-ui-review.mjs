/**
 * Comprehensive CRM UI Review — v2
 * Mocks auth + all API endpoints with correct shapes.
 * Visits every authenticated route and captures screenshots.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:5173";
const OUT_DIR = "/tmp/crm-screenshots";
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Stub data ──────────────────────────────────────────────────────────────

const mockUser = {
  id: 1,
  email: "admin@mtosvelocity.com",
  name: "Admin User",
  role: "admin",
  mfa_enabled: false,
};

const mockLead = {
  id: 1,
  firm_id: 1,
  first_name: "Jane",
  last_name: "Doe",
  email: "jane@example.com",
  phone: "+15555550100",
  tort_type: "camp-lejeune",
  status: "new",
  state: "FL",
  created_at: new Date().toISOString(),
};

const mockCase = {
  id: "MTOS-2024-001",
  data: { tort_type: "camp-lejeune", lead_id: 1 },
  status: "active",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const mockDocument = {
  id: 1,
  lead_id: 1,
  document_type: "hipaa_authorization",
  file_name: "intake_form.pdf",
  file_url: "/api/documents/1/download",
  signed: false,
  signed_at: null,
  notes: null,
  created_at: new Date().toISOString(),
};

const mockVendor = {
  id: 1,
  firm_id: 1,
  name: "ACME Legal Solutions",
  type: "litigation_funder",
  status: "active",
  contact_email: "contact@acme.com",
  created_at: new Date().toISOString(),
};

const mockParalegal = {
  id: 1,
  name: "Sarah Paralegal",
  email: "sarah@firm.com",
  role: "Senior Paralegal",
  active_cases: 12,
  signed_cases: 8,
  total_assigned: 25,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const mockBuyer = {
  id: 1,
  firm_id: 1,
  name: "Mass Tort Buyers Inc",
  contact_email: "buyer@company.com",
  status: "active",
  created_at: new Date().toISOString(),
};

const mockDashboardStats = {
  total_leads: 1250,
  qualified_leads: 875,
  signed_retainers: 340,
  rejected_leads: 120,
  new_leads: 87,
  total_ad_spend: 180000,
  cpsr: 529.41,
  qualification_rate: 70.0,
  conversion_rate: 27.2,
  leads_today: 12,
  leads_this_week: 45,
};

const mockPipelineBreakdown = {
  by_status: [
    { status: "new", count: 450 },
    { status: "qualified", count: 280 },
    { status: "retained", count: 120 },
    { status: "closed", count: 400 },
  ],
  by_tort_type: [
    { tort_type: "camp-lejeune", count: 350 },
    { tort_type: "roundup", count: 280 },
    { tort_type: "talcum", count: 210 },
    { tort_type: "paraquat", count: 160 },
    { tort_type: "other", count: 250 },
  ],
};

const mockActivityItems = [
  {
    id: 1,
    lead_id: 1,
    lead_name: "Jane Doe",
    event_type: "lead_created",
    description: "New lead Jane Doe added from Camp Lejeune campaign",
    occurred_at: new Date().toISOString(),
    tort_type: "camp-lejeune",
  },
];

const mockFunnelStages = [
  { stage: "Inquiry", count: 1250, conversion_rate: 100 },
  { stage: "Qualified", count: 875, conversion_rate: 70 },
  { stage: "Retained", count: 350, conversion_rate: 40 },
  { stage: "Filed", count: 280, conversion_rate: 80 },
];

const mockTrendPoints = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(2025, i, 1);
  return {
    period: `2025-${String(i + 1).padStart(2, "0")}`,
    date: d.toISOString(),
    total: 80 + i * 5,
    qualified: 55 + i * 4,
    signed: 20 + i * 2,
    leads: 80 + i * 5,
    cases: 20 + i * 2,
  };
});

const mockTortBreakdown = [
  { tort_type: "camp-lejeune", count: 350, percentage: 28 },
  { tort_type: "roundup", count: 280, percentage: 22.4 },
  { tort_type: "talcum", count: 210, percentage: 16.8 },
  { tort_type: "paraquat", count: 160, percentage: 12.8 },
];

const mockLeaderboard = [
  { id: 1, name: "Sarah Paralegal", role: "Senior Paralegal", total_assigned: 45, signed: 32, qualified: 40, rejected: 3, conversion_rate: 71.1 },
  { id: 2, name: "Mike Turner", role: "Paralegal", total_assigned: 38, signed: 28, qualified: 35, rejected: 2, conversion_rate: 73.7 },
];

const mockAuditEntries = [
  {
    id: 1,
    entity_type: "lead",
    entity_id: "1",
    action: "created",
    details: { ip: "127.0.0.1" },
    ip_address: "127.0.0.1",
    occurred_at: new Date().toISOString(),
  },
  {
    id: 2,
    entity_type: "case",
    entity_id: "MTOS-2024-001",
    action: "updated",
    details: { field: "status", from: "active", to: "filed" },
    ip_address: "127.0.0.1",
    occurred_at: new Date(Date.now() - 3600000).toISOString(),
  },
];

const mockAuditSummary = {
  by_entity: [
    { entity_type: "lead", count: 650 },
    { entity_type: "case", count: 320 },
    { entity_type: "document", count: 270 },
  ],
  by_action: [
    { action: "created", count: 450 },
    { action: "updated", count: 520 },
    { action: "deleted", count: 270 },
  ],
  total_events: 1240,
  last_24h: 23,
  last_7d: 156,
};

const mockQueueStats = {
  total: 145,
  pending: 12,
  running: 3,
  completed: 120,
  failed: 10,
  dead_letter: 2,
};

const mockQueueJobs = [
  {
    id: "job_001",
    type: "send_welcome_email",
    status: "completed",
    payload: {},
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    error: null,
  },
];

const mockReviewQueueItems = [
  {
    id: 1,
    lead_id: 1,
    conflict_type: "duplicate",
    severity: "medium",
    status: "pending",
    data: {},
    created_at: new Date().toISOString(),
  },
];

const mockReviewQueueStats = {
  total: 12,
  pending: 8,
  resolved: 4,
  by_severity: [{ severity: "medium", count: 8 }, { severity: "high", count: 4 }],
  by_conflict_type: [{ conflict_type: "duplicate", count: 10 }, { conflict_type: "data_quality", count: 2 }],
  by_resolution: [],
  by_failsafe_mode: [],
};

const mockFaxResults = [
  {
    id: 1,
    firm_id: 1,
    filename: "intake_fax_001.pdf",
    status: "processed",
    ocr_text: "Patient: John Smith...",
    created_at: new Date().toISOString(),
  },
];

const mockBillingState = {
  status: "ok",
  data: {
    firm_id: 1,
    firm_name: "Test Firm",
    stripe_configured: true,
    stripe_customer_id: "cus_test123",
    stripe_subscription_id: "sub_test123",
    subscription_status: "active",
    current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
    plan_price_id: "price_pro",
  },
};

const mockBillingInvoices = {
  status: "ok",
  data: [
    {
      id: "inv_001",
      number: "MTOS-2024-001",
      status: "paid",
      amount_due: 29900,
      currency: "usd",
      created: Math.floor(Date.now() / 1000),
      hosted_invoice_url: null,
    },
  ],
};

const mockBillingFirmStatus = {
  status: "ok",
  data: {
    subscription_status: "active",
    current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
    has_firm: true,
  },
};

const mockCallsEnvelope = {
  status: "ok",
  data: {
    rows: [
      {
        id: 1,
        firm_id: 1,
        lead_id: 1,
        direction: "outbound",
        status: "completed",
        duration: 245,
        created_at: new Date().toISOString(),
      },
    ],
    page: 1,
    page_size: 20,
    total: 1,
  },
};

const mockWebhookDeliveries = {
  status: "ok",
  data: {
    rows: [
      {
        id: 1,
        integration_id: 1,
        event: "lead.created",
        delivery_id: "del_001abc-1234-5678-abcd",
        status_code: 200,
        response_ms: 145,
        attempt: 1,
        last_error: null,
        payload_hash: "sha256_abc123",
        is_test: 0,
        occurred_at: new Date().toISOString(),
        integration_name: "DocuSign Production",
        integration_provider: "docusign",
      },
    ],
    page: 1,
    page_size: 50,
    total: 1,
  },
};

const mockFormConfigList = {
  tort_campaigns: [
    {
      id: "camp-lejeune",
      label: "Camp Lejeune Water Contamination",
      category: "Environmental",
      active: true,
      intro_text: "If you or a loved one were exposed to contaminated water at Camp Lejeune, you may be eligible for compensation.",
      fields: ["first_name", "last_name", "email", "phone", "dob", "ssn4", "state", "city", "street", "zip", "exposed_from", "exposed_to"],
      rules: ["diagnosis_required", "exposure_min_1yr"],
      valid_diagnoses: ["bladder_cancer", "kidney_cancer", "leukemia", "parkinson"],
      avg_settlement_low: 100000,
      avg_settlement_high: 500000,
      mdl_status: "active",
      sol_months: 24,
      updated_at: new Date().toISOString(),
    },
  ],
};

const mockAnalyticsOverview = {
  leads: { total: 1250, new_this_week: 45 },
  cases: { total: 340, new_this_week: 12 },
  analysis: { pending: 23, completed: 317 },
  faxes: { processed: 89, pending: 5 },
};

const mockWorkflowProviders = {
  esign: [{ id: "docusign", name: "DocuSign" }],
  fax: [{ id: "twilio_fax", name: "Twilio Fax" }],
  email: [{ id: "sendgrid", name: "SendGrid" }],
  sms: [{ id: "twilio", name: "Twilio SMS" }],
  voice: [{ id: "vapi", name: "Vapi" }],
  llm: [{ id: "openai", name: "OpenAI" }],
};

const mockIntegration = {
  id: 1,
  firm_id: 1,
  provider: "docusign",
  label: "DocuSign Production",
  credentials: {},
  enabled: true,
  created_at: new Date().toISOString(),
};

const mockIntegrationPreset = {
  provider: "docusign",
  name: "DocuSign",
  description: "Electronic signature platform",
  fields: [{ key: "api_key", label: "API Key", type: "password", required: true }],
};

const mockDocumentTemplate = {
  id: 1,
  name: "Retainer Agreement",
  template_type: "retainer",
  description: "Standard retainer agreement for mass tort cases",
  source: "pdf",
  storage_path: "/templates/retainer.pdf",
  ai_prompt: null,
  requires_signature: true,
  signer_role: "lead",
  delivery_subject: null,
  delivery_message: null,
  triggers_med_records_request: false,
  active: true,
};

const mockAutomation = {
  id: "wf_001",
  firm_id: 1,
  name: "Welcome Email Sequence",
  trigger: "lead.created",
  enabled: true,
  created_at: new Date().toISOString(),
};

const mockBatch = {
  id: "batch_001",
  firm_id: 1,
  filename: "leads_import_jan.csv",
  status: "completed",
  total_rows: 150,
  imported: 148,
  errors: 2,
  created_at: new Date().toISOString(),
};

const mockDecisionPortfolio = {
  total_spend_usd: 180000,
  tort_count: 4,
  convex_count: 2,
  concave_count: 1,
  ruin_risk_lead_count: 3,
  concentration_warning: null,
  rows: [
    {
      tort_id: "camp-lejeune",
      label: "Camp Lejeune",
      lead_count: 350,
      total_spend_usd: 87500,
      qualified_count: 245,
      retained_count: 98,
      qualified_rate: 0.70,
      retained_rate: 0.40,
      classification: "convex",
      action: "execute",
      rationale: "Strong qualification rates with manageable risk profile.",
      ruin_flag_count: 1,
      spend_pct: 48.6,
    },
  ],
};

const mockDecisionSettings = {
  enabled: true,
  min_score_to_retain: 70,
  auto_disqualify_below: 30,
  weights: { age: 0.2, exposure: 0.4, medical: 0.4 },
};

const mockLeadSources = [
  { id: 1, firm_id: 1, name: "Google Ads", type: "paid_search", cost_per_lead: 250 },
  { id: 2, firm_id: 1, name: "Facebook", type: "social", cost_per_lead: 180 },
];

const mockPortalSettings = [
  {
    id: 1,
    tort_type: "camp-lejeune",
    enabled: true,
    custom_domain: null,
    logo_url: null,
    primary_color: "#1a56db",
  },
];

const mockSecurityStats = {
  threat_level: "normal",
  total_alerts_24h: 3,
  critical_alerts_24h: 0,
  alerts_last_hour: 1,
  blocked_ips: 2,
  by_severity: [
    { severity: "low", count: 2 },
    { severity: "medium", count: 1 },
  ],
  by_type: [
    { type: "failed_login", count: 2 },
    { type: "rate_limit_exceeded", count: 1 },
  ],
};

const mockSecurityAlerts = [
  {
    id: 1,
    type: "failed_login",
    severity: "low",
    source_ip: "192.168.1.100",
    user_agent: "Mozilla/5.0",
    request_path: "/api/auth/login",
    request_method: "POST",
    details: "5 failed login attempts from this IP",
    payload_sample: null,
    ai_analysis: null,
    status: "new",
    blocked: false,
    created_at: new Date().toISOString(),
  },
];

const mockBlockedIps = [
  { id: 1, ip: "10.0.0.1", reason: "brute_force", blocked_until: null, auto_blocked: true, alert_count: 10, created_at: new Date().toISOString() },
];

const mockAdminForms = {
  base_path: "/api/forms-public/submit",
  total: 2,
  active: 2,
  forms: [
    {
      id: "camp-lejeune",
      label: "Camp Lejeune Water Contamination",
      category: "Environmental",
      active: true,
      web_form_enabled: true,
      intro_text: "File a claim for water contamination at Camp Lejeune.",
      submit_path: "/api/forms-public/submit/camp-lejeune",
      method: "POST",
      content_type: "application/json",
      auth: "anonymous_rate_limited",
      fields: [
        { key: "first_name", label: "First Name", type: "text", required: true, section: "contact", source: "web_form" },
        { key: "last_name", label: "Last Name", type: "text", required: true, section: "contact", source: "web_form" },
        { key: "email", label: "Email", type: "email", required: true, section: "contact", source: "web_form" },
      ],
      sample_payload: { first_name: "Jane", last_name: "Doe", email: "jane@example.com" },
      curl_example: 'curl -X POST "{ORIGIN}/api/forms-public/submit/camp-lejeune" -H "Content-Type: application/json" -d \'{"first_name":"Jane","last_name":"Doe"}\'',
    },
  ],
};

const mockWebFormConfig = {
  web_forms: [
    {
      tort_id: "camp-lejeune",
      tort_label: "Camp Lejeune Water Contamination",
      category: "Environmental",
      active: true,
      web_form_enabled: true,
      field_count: 12,
      rule_count: 3,
      send_confirmation_email: true,
      configured: true,
      updated_at: new Date().toISOString(),
    },
  ],
};

const mockWorkflowGlobal = {
  id: 1,
  firm_id: 1,
  esign_provider: "docusign",
  fax_provider: "twilio_fax",
  email_provider: "sendgrid",
  sms_provider: "twilio",
  voice_provider: "vapi",
  llm_provider: "openai",
};

const mockNewsItems = [
  {
    title: "Camp Lejeune Settlement Update",
    link: "https://example.com/news/camp-lejeune",
    source: "Reuters",
    published: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    description: "DOJ announces new settlement procedures for Camp Lejeune water contamination claims.",
    category: "mass_tort",
  },
];

const mockPredictiveBatch = [
  {
    lead_id: 1,
    conversion_probability: 0.85,
    risk_score: 0.22,
    quality_tier: "high",
    factors: [
      { name: "Medical Documentation", impact: 0.9, description: "Strong medical evidence" },
      { name: "Exposure Duration", impact: 0.8, description: "Long-term exposure" },
    ],
  },
  {
    lead_id: 2,
    conversion_probability: 0.62,
    risk_score: 0.45,
    quality_tier: "medium",
    factors: [
      { name: "Age at Exposure", impact: 0.6, description: "Age factor moderate" },
    ],
  },
];

const mockPredictiveByTort = [
  { tort_type: "camp-lejeune", avg_conversion: 0.72, avg_risk: 0.28, count: 350 },
  { tort_type: "roundup", avg_conversion: 0.68, avg_risk: 0.35, count: 280 },
];

const mockPredictiveModel = {
  version: "2.1.0",
  last_trained: new Date().toISOString(),
  accuracy: 0.87,
  features: ["age", "exposure_duration", "medical_diagnosis"],
};

const mockAdminStats = {
  total_firms: 12,
  total_users: 89,
  total_leads: 15420,
  total_cases: 4320,
  mrr: 24500,
};

const mockAdminFirms = [
  { id: 1, name: "Smith & Associates", plan: "pro", leads: 1250, cases: 340, mrr: 2990 },
  { id: 2, name: "Johnson Law Group", plan: "enterprise", leads: 3400, cases: 890, mrr: 9900 },
];

const mockAdminUsers = {
  rows: [
    { id: 1, email: "admin@firm1.com", name: "Admin One", role: "admin", firm_id: 1 },
    { id: 2, email: "atty@firm1.com", name: "Attorney One", role: "attorney", firm_id: 1 },
  ],
  total: 2,
};

const mockSnapshots = [
  {
    id: 1,
    firm_id: 1,
    name: "Pre-migration snapshot",
    byte_size: 204800,
    payload_sha256: "abc123",
    notes: "Before v2 migration",
    created_at: new Date().toISOString(),
    summary: { tables: 12, rows: 15420 },
  },
];

const mockApiKeys = [
  {
    id: 1,
    name: "n8n Integration",
    key_prefix: "mtos_",
    scopes: ["leads:read", "leads:write"],
    created_at: new Date().toISOString(),
    last_used_at: null,
  },
];

const mockApiKeyScopes = {
  scopes: ["leads:read", "leads:write", "cases:read", "cases:write", "automations:run", "documents:read"],
};

const mockFirmUsers = [
  { id: 1, email: "admin@firm.com", name: "Admin User", role: "admin", firm_id: 1, mfa_enabled: true, email_verified_at: new Date().toISOString(), last_login_at: new Date().toISOString(), created_at: new Date().toISOString() },
  { id: 2, email: "atty@firm.com", name: "Attorney Bob", role: "attorney", firm_id: 1, mfa_enabled: false, email_verified_at: new Date().toISOString(), last_login_at: null, created_at: new Date().toISOString() },
];

const mockFirmInvites = [
  { id: 1, email: "new@firm.com", role: "paralegal", status: "pending", created_at: new Date().toISOString() },
];

const mockFirmSettings = {
  id: 1,
  firm_id: 1,
  name: "Smith & Associates",
  slug: "smith-associates",
  primary_color: "#1a56db",
  logo_url: null,
  timezone: "America/New_York",
  default_tort_type: "camp-lejeune",
};

const mockDarkRoomLinks = [
  { id: 1, user_id: 1, label: "Confidential Case File", url: "https://docs.example.com/secret", sort_order: 0 },
];

const mockAutomationDeliveries = [
  {
    id: 1,
    automation_id: "wf_001",
    automation_name: "Welcome Email",
    lead_id: 1,
    status: "delivered",
    triggered_at: new Date().toISOString(),
  },
];

// ── Route table ─────────────────────────────────────────────────────────────

const ROUTES = [
  { path: "/", label: "Dashboard" },
  { path: "/pipeline", label: "Pipeline" },
  { path: "/leads", label: "Leads" },
  { path: "/leads/new", label: "Lead Intake" },
  { path: "/paralegals", label: "Paralegals" },
  { path: "/documents", label: "Documents" },
  { path: "/ocr-inbox", label: "OCR Inbox" },
  { path: "/npi-lookup", label: "NPI Lookup" },
  { path: "/review-queue", label: "Review Queue" },
  { path: "/cases", label: "Cases" },
  { path: "/cases/new", label: "Case New" },
  { path: "/analytics", label: "Analytics" },
  { path: "/compliance", label: "Compliance" },
  { path: "/form-engine", label: "Form Engine" },
  { path: "/vendors", label: "Vendors" },
  { path: "/security", label: "Security" },
  { path: "/firm-settings", label: "Firm Settings" },
  { path: "/users", label: "Users" },
  { path: "/doc-review", label: "Doc Review" },
  { path: "/timeline", label: "Timeline" },
  { path: "/drafting", label: "Drafting" },
  { path: "/predictive", label: "Predictive" },
  { path: "/integrations", label: "Integrations" },
  { path: "/billing", label: "Billing" },
  { path: "/calls", label: "Calls" },
  { path: "/news", label: "News" },
  { path: "/financial-news", label: "Financial News" },
  { path: "/lead-import", label: "Lead Import" },
  { path: "/decision-engine", label: "Decision Engine" },
  { path: "/decision-engine/settings", label: "Decision Engine Settings" },
  { path: "/buyers", label: "Buyers" },
  { path: "/document-templates", label: "Document Templates" },
  { path: "/template-assignments", label: "Template Assignments" },
  { path: "/workflow-settings", label: "Workflow Settings" },
  { path: "/web-forms", label: "Web Forms" },
  { path: "/job-queue", label: "Job Queue" },
  { path: "/dark-room", label: "Dark Room" },
  { path: "/automations", label: "Automations" },
  { path: "/automation-docs", label: "Automation Docs" },
  { path: "/automation-deliveries", label: "Automation Deliveries" },
  { path: "/n8n-setup", label: "N8N Setup (API)" },
  { path: "/forms-api", label: "Forms API" },
  { path: "/self-heal", label: "Self Heal" },
  { path: "/competitive-intel", label: "Competitive Intel" },
  { path: "/user-manual", label: "User Manual" },
  { path: "/ads-libraries", label: "Ads Libraries" },
  { path: "/ai-agents", label: "AI Agents" },
  { path: "/abby", label: "Abby AI" },
  { path: "/portal-settings", label: "Portal Settings" },
  { path: "/medical-records", label: "Medical Records" },
];

// ── API route stubs ──────────────────────────────────────────────────────────

function routeMatches(url, pattern) {
  const u = new URL(url);
  const pathname = u.pathname;
  // Simple glob: replace * with regex
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
  return regex.test(pathname);
}

async function setupMocks(page) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    const u = new URL(url);
    const path = u.pathname;
    const method = req.method();

    // ── Auth endpoints ──
    if (path === "/api/auth/me") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockUser) });
    }
    if (path === "/api/auth/refresh" || path === "/api/auth/login") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ user: mockUser, token: "fake_access_token", refresh_token: "fake_refresh_token" }),
      });
    }

    // ── Leads ──
    if (path === "/api/leads" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([mockLead]) });
    }
    if (path.match(/^\/api\/leads\/\d+$/) && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockLead) });
    }
    if (path === "/api/leads/export") {
      return route.fulfill({ status: 200, contentType: "text/csv", body: "id,first_name,last_name\n1,Jane,Doe" });
    }

    // ── Cases ──
    if (path === "/api/cases" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([mockCase]) });
    }
    if (path.match(/^\/api\/cases\/\d+$/)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...mockCase, lead: mockLead }) });
    }

    // ── Documents ──
    if (path === "/api/documents" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([mockDocument]) });
    }

    // ── Vendors ──
    if (path === "/api/vendors" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([mockVendor]) });
    }
    if (path.match(/^\/api\/vendors\/\d+$/) && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockVendor) });
    }

    // ── Buyers ──
    if (path === "/api/buyers" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([mockBuyer]) });
    }

    // ── Paralegals ──
    if (path === "/api/paralegals" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([mockParalegal]) });
    }
    if (path.match(/^\/api\/paralegals\/\d+$/) && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockParalegal) });
    }

    // ── Dashboard ──
    if (path === "/api/dashboard/stats") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockDashboardStats) });
    }
    if (path === "/api/dashboard/pipeline") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockPipelineBreakdown) });
    }
    if (path === "/api/dashboard/recent-activity") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockActivityItems) });
    }
    if (path === "/api/analytics/paralegal-leaderboard") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockLeaderboard) });
    }

    // ── Analytics ──
    if (path === "/api/analytics/overview") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockAnalyticsOverview) });
    }
    if (path === "/api/analytics/conversion-funnel") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockFunnelStages) });
    }
    if (path === "/api/analytics/pipeline-trend") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockTrendPoints) });
    }
    if (path === "/api/analytics/tort-breakdown") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockTortBreakdown) });
    }
    if (path === "/api/analytics/predictive/batch") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockPredictiveBatch) });
    }
    if (path === "/api/analytics/predictive/by-tort") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockPredictiveByTort) });
    }
    if (path === "/api/analytics/predictive/model") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockPredictiveModel) });
    }
    if (path.match(/^\/api\/analytics\/predictive\/lead\//)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ lead_id: 1, score: 85 }) });
    }

    // ── Audit / Compliance ──
    if (path === "/api/compliance/audit-trail") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockAuditEntries) });
    }
    if (path === "/api/compliance/audit-summary") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockAuditSummary) });
    }

    // ── Review Queue ──
    if (path === "/api/review-queue" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockReviewQueueItems) });
    }
    if (path === "/api/review-queue/stats") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockReviewQueueStats) });
    }

    // ── Job Queue (uses /api/cases/worker/* paths) ──
    if (path === "/api/cases/worker/queue-stats") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockQueueStats) });
    }
    if (path === "/api/cases/worker/jobs") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockQueueJobs) });
    }

    // ── OCR / Fax ──
    if (path === "/api/ocr/results") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockFaxResults) });
    }
    if (path === "/api/ocr/queue-stats") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 5, pending: 2, running: 0, completed: 80, failed: 1, dead_letter: 0 }) });
    }

    // ── Billing ──
    if (path === "/api/billing/state") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockBillingState) });
    }
    if (path === "/api/billing/invoices") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockBillingInvoices) });
    }
    if (path === "/api/billing/firm-status") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockBillingFirmStatus) });
    }

    // ── Calls ──
    if (path === "/api/calls" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockCallsEnvelope) });
    }
    if (path.match(/^\/api\/calls\/\d+$/)) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ status: "ok", data: { ...mockCallsEnvelope.data.rows[0], transcript: null, recording_url: null } }),
      });
    }

    // ── Webhook log (admin path) ──
    if (path === "/api/admin/webhook-deliveries") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockWebhookDeliveries) });
    }

    // ── Integrations ──
    if (path === "/api/integrations" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([mockIntegration]) });
    }
    if (path === "/api/integrations/presets") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([mockIntegrationPreset]) });
    }
    if (path.match(/^\/api\/integrations\/\d+\/test$/)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }

    // ── Forms ──
    if (path === "/api/forms/config" || path === "/api/forms/configs") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockFormConfigList) });
    }
    if (path === "/api/forms/web-config") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockWebFormConfig) });
    }
    if (path.match(/^\/api\/forms\/config\/\d+$/) || path.match(/^\/api\/forms\/configs\/\d+$/)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockFormConfigList.tort_campaigns[0]) });
    }
    if (path.match(/^\/api\/forms\/web-config\/.+\/toggle$/)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }

    // ── Admin: forms-api-directory ──
    if (path === "/api/admin/forms-api-directory") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockAdminForms) });
    }

    // ── Decision Engine ──
    if (path === "/api/decision-engine/portfolio") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockDecisionPortfolio) });
    }
    if (path === "/api/decision-engine/settings") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockDecisionSettings) });
    }
    if (path === "/api/decision-engine/recompute-all" && method === "POST") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ queued: 150 }) });
    }

    // ── Lead Sources ──
    if (path === "/api/lead-sources") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockLeadSources) });
    }

    // ── Lead Import ──
    if (path === "/api/lead-import/batches" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([mockBatch]) });
    }
    if (path.match(/^\/api\/lead-import\/batches\/.+$/) && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockBatch) });
    }

    // ── Document Templates ──
    if (path === "/api/document-templates" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([mockDocumentTemplate]) });
    }
    if (path === "/api/document-templates/assignments/all") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
    }

    // ── Automations ──
    if (path === "/api/automations" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([mockAutomation]) });
    }
    if (path === "/api/automation-deliveries") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockAutomationDeliveries) });
    }

    // ── Workflow Settings ──
    if (path === "/api/workflow-settings/global") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockWorkflowGlobal) });
    }
    if (path === "/api/workflow-settings/_options/providers") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockWorkflowProviders) });
    }

    // ── Portal Settings ──
    if (path === "/api/portal-settings") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockPortalSettings) });
    }
    if (path.match(/^\/api\/portal-settings\/.+$/) && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockPortalSettings[0]) });
    }

    // ── Security ──
    if (path === "/api/security/stats") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockSecurityStats) });
    }
    if (path === "/api/security/alerts") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockSecurityAlerts) });
    }
    if (path === "/api/security/blocked-ips") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockBlockedIps) });
    }

    // ── Medical Records Requests ──
    if (path.startsWith("/api/mrr")) {
      if (method === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          results: [
            { id: 1, lead_id: 1, lead_name: "Jane Doe", hospital_name: "Naval Hospital Camp Lejeune",
              fax_number: "+19105551234", status: "fulfilled", sent_at: new Date(Date.now() - 7*86400000).toISOString(),
              expected_by: new Date(Date.now() + 7*86400000).toISOString(), fulfilled_at: new Date().toISOString(),
              attempt_count: 1, last_attempt_at: new Date().toISOString(), notes: null,
              envelope_id: 42, fax_delivery_status: "delivered", fax_delivery_checked_at: new Date().toISOString() },
          ],
          total: 1, page: 1, page_size: 25, has_more: false,
        }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }

    // ── Competitive Intel ──
    if (path === "/api/admin/competitive-intel/config") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ google: false, meta: false, tiktok: false }) });
    }
    if (path === "/api/admin/competitive-intel/watchlist") {
      if (method === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ advertisers: [] }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, ad_count: 0 }) });
    }

    // ── Firm Settings ──
    if (path === "/api/firm-settings" || path === "/api/firms/settings") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockFirmSettings) });
    }

    // ── Users ──
    if (path === "/api/users" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", data: { rows: mockFirmUsers } }) });
    }
    if (path === "/api/auth/users") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", data: { rows: mockFirmUsers } }) });
    }
    if (path === "/api/auth/firm-invites" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockFirmInvites) });
    }

    // ── Dark Room ──
    if (path === "/api/admin/dark-room" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockDarkRoomLinks) });
    }

    // ── Admin Platform ──
    if (path === "/api/admin/platform/stats") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockAdminStats) });
    }
    if (path === "/api/admin/platform/firms") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockAdminFirms) });
    }
    if (path === "/api/admin/platform/users") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockAdminUsers) });
    }

    // ── Admin Snapshots ──
    if (path === "/api/admin/snapshots" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockSnapshots) });
    }

    // ── API Keys (page expects { keys: [...] } wrapper) ──
    if (path === "/api/admin/api-keys" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ keys: mockApiKeys }) });
    }
    if (path === "/api/admin/api-keys/_meta/scopes") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockApiKeyScopes) });
    }

    // ── NPI ──
    if (path === "/api/npi/search") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ providers: [], total: 0 }),
      });
    }

    // ── News ──
    if (path === "/api/news/mass-tort") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockNewsItems) });
    }
    if (path === "/api/news/financial") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockNewsItems) });
    }

    // ── Tort categories ──
    if (path === "/api/torts" || path === "/api/tort-categories") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify(["camp-lejeune", "roundup", "talcum", "paraquat"]),
      });
    }

    // ── Drafting / Doc Review ──
    if (path.startsWith("/api/drafting") || path.startsWith("/api/doc-review")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
    }

    // ── Admin event catalog (Catalog shape for automation-docs page) ──
    if (path === "/api/admin/event-catalog") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          events: [
            { event: "lead.created", description: "Fired when a lead is created", payload_schema: {} },
            { event: "case.updated", description: "Fired when a case is updated", payload_schema: {} },
          ],
          api_surface: [
            { method: "GET", path: "/api/leads", scope: "leads:read", description: "List leads" },
          ],
          available_scopes: ["leads:read", "leads:write", "cases:read"],
          auth: {
            header: "Authorization: Bearer <token>",
            token_types: [
              { type: "access_token", description: "Short-lived JWT" },
              { type: "api_key", description: "Long-lived API key prefixed mtos_" },
            ],
            api_key_admin_url: "/n8n-setup",
          },
          webhook_signing: {
            header: "x-mtos-signature",
            algorithm: "HMAC-SHA256",
            secret_source: "Integration webhook_secret field",
            headers: ["x-mtos-signature", "x-mtos-timestamp"],
          },
          openapi: {
            url: "/api/openapi.yaml",
            format: "OpenAPI 3.0",
            description: "Full API specification",
          },
          internal_automation: {
            description: "37-node internal automation catalog for n8n",
            categories: [
              { category: "Lead Management", count: 8 },
              { category: "Case Management", count: 6 },
              { category: "Communication", count: 5 },
            ],
            nodes: [
              { id: "lead-create", category: "Lead Management", name: "Create Lead", description: "Creates a new lead record", icon: "user-plus", inputs: [], outputs: [] },
              { id: "lead-update", category: "Lead Management", name: "Update Lead", description: "Updates lead fields", icon: "user-edit", inputs: [], outputs: [] },
            ],
            editor_url: "https://n8n.example.com",
            catalog_url: "/api/admin/event-catalog",
          },
        }),
      });
    }

    // ── Drafting templates ──
    if (path === "/api/drafting/templates") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify([
          { id: "retainer", name: "Retainer Agreement", description: "Standard mass tort retainer" },
          { id: "hipaa", name: "HIPAA Authorization", description: "Medical records release" },
          { id: "demand_letter", name: "Demand Letter", description: "Initial demand to defendant" },
        ]),
      });
    }

    // ── Medical Records ──
    if (path.startsWith("/api/medical-records") || path.startsWith("/api/records")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
    }

    // ── Competitive Intel / Self Heal / AI ──
    if (path.startsWith("/api/competitive") || path.startsWith("/api/self-heal") || path.startsWith("/api/ai")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: null }) });
    }

    // ── Abby / AI chat ──
    if (path === "/api/ai-chat") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "Hello!" }) });
    }

    // ── Pass non-API requests through (assets, HTML, JS) ──
    return route.continue();
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: {
      cookies: [],
      origins: [{
        origin: BASE,
        localStorage: [
          { name: "mtos.refresh", value: "fake_refresh_token" },
          { name: "mtos.uid", value: "1" },
        ],
      }],
    },
  });

  const results = [];

  for (const route of ROUTES) {
    const page = await ctx.newPage();
    const pageErrors = [];
    const consoleErrors = [];

    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await setupMocks(page);

    let status = "ok";
    let note = "";

    try {
      await page.goto(`${BASE}${route.path}`, { waitUntil: "networkidle", timeout: 15000 });
      await page.waitForTimeout(800);

      // Check if redirected to login (auth guard fired)
      const finalUrl = page.url();
      if (finalUrl.includes("/login")) {
        status = "auth_redirect";
        note = `Redirected to login from ${route.path}`;
      } else if (pageErrors.length > 0) {
        status = "error";
        note = pageErrors.slice(0, 2).join(" | ");
      } else if (consoleErrors.some(e =>
        e.includes("TypeError") || e.includes("is not a function") ||
        e.includes("Cannot read") || e.includes("RangeError") ||
        e.includes("ReferenceError") || e.includes("RouteErrorBoundary caught")
      )) {
        status = "console_error";
        const badErrors = consoleErrors.filter(e =>
          e.includes("TypeError") || e.includes("Cannot read") ||
          e.includes("RangeError") || e.includes("RouteErrorBoundary caught")
        );
        note = badErrors.slice(0, 1).join(" | ").slice(0, 200);
      }

      const slug = route.path.replace(/\//g, "_").replace(/^_/, "") || "dashboard";
      const screenshotPath = path.join(OUT_DIR, `${slug}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });

      results.push({ ...route, status, note, screenshot: screenshotPath, pageErrors, consoleErrors });
    } catch (err) {
      status = "timeout";
      note = err.message.slice(0, 120);
      results.push({ ...route, status, note, screenshot: null, pageErrors, consoleErrors });
    } finally {
      await page.close();
    }
  }

  await browser.close();

  // Print summary
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  MTOS CRM UI REVIEW — RESULTS");
  console.log("═══════════════════════════════════════════════════════════\n");

  const ok = results.filter(r => r.status === "ok");
  const errors = results.filter(r => r.status !== "ok");

  console.log(`✅  OK: ${ok.length}/${results.length}`);
  console.log(`⚠️  Issues: ${errors.length}/${results.length}\n`);

  if (errors.length > 0) {
    console.log("── Issues ──────────────────────────────────────────────────");
    for (const r of errors) {
      console.log(`[${r.status.toUpperCase()}] ${r.label} (${r.path})`);
      if (r.note) console.log(`       → ${r.note}`);
      if (r.pageErrors.length) console.log(`       PAGE ERRORS: ${r.pageErrors.slice(0, 2).join(" | ")}`);
      if (r.consoleErrors.length) console.log(`       CONSOLE: ${r.consoleErrors.slice(0, 2).join(" | ")}`);
    }
    console.log();
  }

  console.log("── All Pages ───────────────────────────────────────────────");
  for (const r of results) {
    const icon = r.status === "ok" ? "✅" : r.status === "auth_redirect" ? "🔒" : "❌";
    console.log(`${icon} ${r.label.padEnd(30)} ${r.path}`);
  }

  fs.writeFileSync("/tmp/crm-review-out.json", JSON.stringify(results, null, 2));
  console.log("\nDetailed results: /tmp/crm-review-out.json");
  console.log(`Screenshots: ${OUT_DIR}/`);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
