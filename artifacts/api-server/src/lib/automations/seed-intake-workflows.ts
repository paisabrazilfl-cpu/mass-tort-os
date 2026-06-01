/**
 * Seed the three intake-to-medical-records automation workflows — one per
 * lead-entry flow (self-service / AI-agent / vendor) — that all feed the same
 * mandated compliance backbone:
 *
 *   trigger → background-check hub → qualification
 *   (decision engine / qualify) → NPI provider verification → 3-document
 *   e-sign packet (HIPAA + Retainer + Personal Truth Affidavit) → all-signed
 *   gate → fax medical-records request to the verified provider → assign +
 *   activate + notify.
 *
 * NOTE: The in-pipeline consent/TCPA gate was removed from all three flows per
 * owner decision — consent is established upstream (web-form TrustedForm cert,
 * recorded call + transcript, or vendor-supplied TrustedForm cert URL) before a
 * lead reaches this pipeline.
 *
 * Every remaining gate has an explicit branch to the Review Queue (form invalid,
 * background flagged/errored, decision rejected/review, NPI ambiguous/unavailable,
 * e-sign pending, fax failed) so a lead is NEVER auto-advanced on uncertain
 * evidence — humans only do final review, per the AI Constitution failure protocol.
 *
 * Each flow is deliberately exhaustive, exercising a broad slice of the node
 * catalog (triggers, logic, data transforms, scripts, AI voice/transcribe/
 * summarize, SQL, e-sign, fax, SMS, calendar, webhooks, audit) so an operator
 * has a complete, working template to clone and tune per firm.
 *
 * Claimant communication is SMS-first across all three flows: every
 * claimant-facing touchpoint — acknowledgement, "documents ready to sign",
 * e-sign reminder, and final confirmation — is delivered via comm.send_sms.
 * The AI Agent (Voice) flow additionally has the Vapi voice agent confirm the
 * claimant's details before any documents are sent, and re-engage by voice when
 * the e-sign packet is still pending. The ai.voice_agent nodes leave agentId
 * blank on purpose — the executor resolves the lead's per-tort provisioned Vapi
 * assistant (tort_voice_agents) at runtime, so the template stays firm-agnostic.
 *
 * State-passing contract: the trigger payload (lead id, form payload, call
 * recording url) is captured into `vars` by the first two transform nodes, so
 * every downstream node references `vars.*` and survives the input being
 * replaced as the pipeline advances. The three e-sign nodes read the lead id
 * from `input.lead.id`, so a small "inject lead" transform precedes each one
 * to rebuild `input.lead` from `vars`.
 *
 * The workflows are seeded **disabled** and **system-wide** (firm_id = NULL):
 * the e-sign send nodes (and the self-service form id + vendor postback url)
 * carry per-firm ids/urls an operator must fill in before enabling.
 *
 * Idempotent + self-refreshing: identified by a stable tag. A new flow is
 * inserted when its tag is absent. An already-seeded flow is refreshed to the
 * latest template graph ONLY when its current graph still matches what the
 * seed last wrote (fingerprint match) — operator edits are detected via the
 * stored fingerprint and never overwritten.
 */
import { createHash } from "node:crypto";
import { db, automationWorkflowsTable } from "@workspace/db";
import { isNull, and, arrayContains, eq } from "drizzle-orm";
import { logger } from "../logger";
import type { ConsentChannel } from "./gates";

const SEED_TAG = "seed:intake-pipeline";
/** Bump when the template graphs change so already-seeded, unedited rows refresh. */
const SEED_VERSION = 4;

type FlowKey = "self_service" | "ai_agent" | "vendor";

interface FlowSpec {
  key: FlowKey;
  name: string;
  description: string;
  triggerType: string;
  triggerLabel: string;
  channel: ConsentChannel;
}

const FLOWS: FlowSpec[] = [
  {
    key: "self_service",
    name: "Intake → Med Records — Self-Service (Text/Email)",
    description:
      "Self-service web flow (contact_preference=text_email). Consent is enforced upstream by the web form (TrustedForm certificate), so there is no in-pipeline consent gate. Validate submission → SMS acknowledgement → background check → qualify → NPI verify → 3-doc e-sign packet → docs-ready SMS → all-signed gate → fax provider → assign/activate → SMS confirmation, with review-queue branches at every remaining gate. All claimant touchpoints are via SMS/text.",
    triggerType: "trigger.form_submitted",
    triggerLabel: "On Web Form Submitted",
    channel: "web",
  },
  {
    key: "ai_agent",
    name: "Intake → Med Records — AI Agent (Voice)",
    description:
      "AI voice/chat agent flow (contact_preference=agent). Consent artifact is the recorded call + transcript on the claimant, established upstream, so there is no in-pipeline consent gate. Transcribe + summarize the call → SMS acknowledgement → background check → qualify → NPI verify → AI voice agent confirms details (Vapi; the lead's per-tort assistant is auto-resolved) → 3-doc e-sign packet → docs-ready SMS → all-signed gate (voice re-engagement on pending) → fax provider → assign/activate → SMS confirmation, with review-queue branches at every remaining gate. The Vapi voice agent confirms the claimant's details before any documents are sent.",
    triggerType: "trigger.inbound_call",
    triggerLabel: "On Inbound Call",
    channel: "voice",
  },
  {
    key: "vendor",
    name: "Intake → Med Records — Vendor Leads",
    description:
      "Vendor / lead-import flow. Vendor must supply a TrustedForm certificate URL per lead (the consent artifact), so there is no separate in-pipeline consent gate. Cert presence gate → SMS acknowledgement → background check → decision engine → NPI verify → 3-doc e-sign packet → docs-ready SMS → all-signed gate → fax provider → assign/activate → vendor postback + SMS confirmation, with review-queue branches at every remaining gate. All claimant touchpoints are via SMS/text.",
    triggerType: "trigger.lead_created",
    triggerLabel: "On Lead Created",
    channel: "vendor",
  },
];

interface GraphNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { label?: string; params?: Record<string, unknown> };
}
interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}
interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Reusable transform snippets (run inside data.transform via new Function).
// 1) Capture trigger-payload fields into vars (input is replaced downstream).
const STASH_TRIGGER = [
  "const i = input || {};",
  "vars.leadId = (i.lead && i.lead.id != null) ? i.lead.id : i.lead_id;",
  "vars.formPayload = i.payload || null;",
  "vars.recordingUrl = i.recording_url || '';",
  "vars.callId = (i.call && i.call.id) || i.call_id || '';",
  "return input;",
].join("\n");
// 2) Capture the hydrated lead row (output of crm.update_lead) into vars.
const STASH_LEAD = [
  "const l = (input && input.lead) || {};",
  "if (l.id != null) vars.leadId = l.id;",
  "vars.leadEmail = l.email || '';",
  "vars.leadPhone = l.phone || '';",
  "vars.leadFullName = [l.first_name, l.last_name].filter(Boolean).join(' ');",
  "vars.trustedformCertUrl = l.trustedform_cert_url || '';",
  "return input;",
].join("\n");
// 3) Rebuild input.lead from vars for nodes that read input.lead.id directly.
const INJECT_LEAD = [
  "return Object.assign({}, input, {",
  "  lead_id: vars.leadId,",
  "  lead: { id: vars.leadId, email: vars.leadEmail, full_name: vars.leadFullName },",
  "});",
].join("\n");
// 4) Compute a follow-up timestamp (2 days out) for calendar nodes.
const COMPUTE_FOLLOWUP = "vars.followupAt = new Date(Date.now() + 2*864e5).toISOString();\nreturn input;";

/**
 * Build the full per-flow graph. Operator-specific ids (e-sign templateId,
 * self-service formId, vendor postback url) are intentionally left blank.
 */
function buildGraph(spec: FlowSpec): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const node = (
    id: string,
    type: string,
    x: number,
    y: number,
    label: string,
    params?: Record<string, unknown>,
  ): string => {
    nodes.push({ id, type, position: { x, y }, data: params ? { label, params } : { label } });
    return id;
  };
  const edge = (source: string, target: string, sourceHandle?: string) => {
    edges.push({
      id: `e_${source}_${sourceHandle ?? "out"}_${target}`,
      source,
      target,
      sourceHandle: sourceHandle ?? null,
    });
  };
  const review = (id: string, x: number, y: number, reason: string, priority = "high") =>
    node(id, "crm.send_to_review_queue", x, y, "Review Queue", {
      entity: "lead",
      id: "vars.leadId",
      reason,
      priority,
    });

  // Main-path columns advance left→right; reviews sit in a lane below.
  const COL = 240;
  const MAIN_Y = 240;
  const REVIEW_Y = 470;
  let col = 0;
  const x = () => col++ * COL;

  // ───────── Shared front-matter: trigger → capture → hydrate → capture ─────────
  const trigger = node("trigger", spec.triggerType, x(), MAIN_Y, spec.triggerLabel);

  const stashTrigger = node(
    "stash_trigger",
    "data.transform",
    x(),
    MAIN_Y,
    "Capture trigger payload",
    { code: STASH_TRIGGER },
  );
  edge(trigger, stashTrigger);

  const hydrate = node("hydrate_lead", "crm.update_lead", x(), MAIN_Y, "Load lead record", {
    leadId: "vars.leadId",
    patch: {},
  });
  edge(stashTrigger, hydrate);

  const stashLead = node("stash_lead", "data.transform", x(), MAIN_Y, "Capture lead fields", {
    code: STASH_LEAD,
  });
  edge(hydrate, stashLead);

  node("log_start", "utility.log", x(), MAIN_Y, "Log intake start", {
    level: "info",
    message: `[${spec.key}] intake pipeline started.`,
  });
  edge(stashLead, "log_start");
  let cursor = "log_start";

  // ───────── Flow-specific head ─────────
  if (spec.key === "self_service") {
    const validate = node("validate_form", "forms.validate_submission", x(), MAIN_Y, "Validate Submission", {
      formId: "",
      payload: "vars.formPayload",
    });
    edge(cursor, validate);
    review("rq_form_invalid", nodes.find((n) => n.id === validate)!.position.x, REVIEW_Y,
      "Form submission failed TCPA / TrustedForm / field validation. Do not contact.");
    edge(validate, "rq_form_invalid", "invalid");

    const ackSms = node("ack_sms", "comm.send_sms", x(), MAIN_Y, "Acknowledgement SMS", {
      to: "vars.leadPhone",
      body: "Thanks for reaching out. Our intake team has your information and will contact you shortly. Reply STOP to opt out.",
      leadId: "vars.leadId",
    });
    edge(validate, ackSms, "valid");

    const normalize = node("normalize_contact", "script.javascript", x(), MAIN_Y, "Normalize contact (script)", {
      code: "const digits = String(vars.leadPhone||'').replace(/\\D/g,'');\nreturn { phone_digits: digits, has_email: !!vars.leadEmail };",
      timeoutMs: 3000,
      approved: true,
    });
    edge(ackSms, normalize);
    cursor = normalize;
  } else if (spec.key === "ai_agent") {
    const hasRec = node("has_recording", "logic.if", x(), MAIN_Y, "Call recording present?", {
      expression: "!!vars.recordingUrl",
    });
    edge(cursor, hasRec);

    const transcribe = node("transcribe_call", "ai.transcribe", x(), MAIN_Y, "Transcribe call audio", {
      audioUrl: "vars.recordingUrl",
      language: "en",
    });
    edge(hasRec, transcribe, "true");

    const summarize = node("summarize_call", "ai.summarize", x(), MAIN_Y, "Summarize call", {
      text: "input.text",
      maxWords: 150,
    });
    edge(transcribe, summarize);

    const logAi = node("log_call_summary", "utility.log", x(), MAIN_Y, "Log call analysis", {
      level: "info",
      message: "[ai_agent] call transcribed + summarized for run audit.",
    });
    edge(summarize, logAi);

    // Both branches of the recording check converge on an acknowledgement SMS,
    // then flow into the shared Background Check Hub. The false branch (no
    // recording) skips transcription/summarization and lands here directly.
    const ackSms = node("ack_sms", "comm.send_sms", x(), MAIN_Y, "Acknowledgement SMS", {
      to: "vars.leadPhone",
      body: "Thanks for calling. We have your information and we're getting started on your case. Reply STOP to opt out.",
      leadId: "vars.leadId",
    });
    edge("has_recording", ackSms, "false");
    edge(logAi, ackSms);
    cursor = ackSms;
  } else {
    // vendor
    const certGate = node("cert_present", "logic.if", x(), MAIN_Y, "TrustedForm cert present?", {
      expression: "!!vars.trustedformCertUrl",
    });
    edge(cursor, certGate);
    review("rq_cert_missing", nodes.find((n) => n.id === certGate)!.position.x, REVIEW_Y,
      "Vendor lead missing TrustedForm certificate URL — cannot establish TCPA consent provenance. Reject or request cert.");
    edge(certGate, "rq_cert_missing", "false");

    const certScript = node("validate_cert", "script.javascript", x(), MAIN_Y, "Validate cert URL (script)", {
      code: "const u = String(vars.trustedformCertUrl||'');\nreturn { cert_url: u, looks_valid: /^https?:\\/\\/cert\\.trustedform\\.com\\//.test(u) };",
      timeoutMs: 3000,
      approved: true,
    });
    edge(certGate, certScript, "true");

    const history = node("lead_history", "io.sql_query", x(), MAIN_Y, "Firm lead history (SQL)", {
      sql: "SELECT count(*)::int AS firm_lead_count FROM leads WHERE firm_id = (current_setting('mtos.firm_id', true))::int",
      params: [],
    });
    edge(certScript, history);

    const certAudit = node("audit_cert", "crm.audit_log", x(), MAIN_Y, "Audit cert recorded", {
      action: "automation.trustedform_cert_recorded",
      entityType: "lead",
      entityId: "vars.leadId",
      details: { flow: "vendor", note: "TrustedForm certificate URL present on vendor lead." },
    });
    edge(history, certAudit);

    const ackSms = node("ack_sms", "comm.send_sms", x(), MAIN_Y, "Acknowledgement SMS", {
      to: "vars.leadPhone",
      body: "Thanks — we received your information and our intake team is reviewing your case. Reply STOP to opt out.",
      leadId: "vars.leadId",
    });
    edge(certAudit, ackSms);
    cursor = ackSms;
  }

  // ───────── Shared backbone: bg → qualify → npi → e-sign → fax → done ─────────
  // NOTE: The in-pipeline consent/TCPA gate was removed from ALL THREE flows per
  // owner decision. Consent is established upstream before a lead ever reaches
  // this pipeline (web-form TrustedForm certificate, recorded call + transcript,
  // or vendor-supplied TrustedForm cert URL), so re-gating here was redundant and
  // could wrongly stall already-consented leads. Each flow's head now runs
  // straight into the Background Check Hub.
  const bg = node("background_check", "crm.background_check", x(), MAIN_Y, "Background Check Hub", {
    leadId: "vars.leadId",
  });
  // Every flow's head now ends at `cursor` — self-service: normalize script;
  // ai_agent: acknowledgement SMS where the recording-check branches converge;
  // vendor: cert audit → acknowledgement SMS — so all three feed the hub here.
  edge(cursor, bg);
  const bgX = nodes.find((n) => n.id === bg)!.position.x;
  review("rq_bg_flagged", bgX, REVIEW_Y,
    "Background check flagged — needs human review before contact.");
  edge(bg, "rq_bg_flagged", "flagged");
  review("rq_bg_error", bgX, REVIEW_Y + 130,
    "Background check could not complete (error) — needs human review.");
  edge(bg, "rq_bg_error", "error");

  // Qualification: vendor uses the scoring decision engine; the human-facing
  // flows use the lead's existing qualification status.
  const qualType = spec.key === "vendor" ? "crm.decision_engine" : "crm.qualify_lead";
  const qual = node("qualify", qualType, x(), MAIN_Y,
    spec.key === "vendor" ? "Decision Engine (score)" : "Qualify Lead", { leadId: "vars.leadId" });
  edge(bg, qual, "clear");
  const qualX = nodes.find((n) => n.id === qual)!.position.x;
  review("rq_qual_review", qualX, REVIEW_Y,
    "Qualification returned 'review' — uncertain. Hold for human decision.");
  edge(qual, "rq_qual_review", "review");
  // Rejected → review queue too. Never auto-decline a potential claimant on the
  // engine's say-so: a human confirms the decline before the lead is closed.
  review("rq_qual_rejected", qualX, REVIEW_Y + 130,
    "Auto-qualification declined this lead. Confirm the decline before closing — do not auto-reject.", "normal");
  edge(qual, "rq_qual_rejected", "rejected");

  const npi = node("npi_verify", "crm.npi_lookup", x(), MAIN_Y, "Verify Provider (NPI)", {
    leadId: "vars.leadId",
  });
  edge(qual, npi, "qualified");
  const npiX = nodes.find((n) => n.id === npi)!.position.x;
  review("rq_npi_ambiguous", npiX, REVIEW_Y,
    "NPI verification ambiguous — provider did not match cleanly. Do not auto-advance.");
  edge(npi, "rq_npi_ambiguous", "ambiguous");
  review("rq_npi_unavailable", npiX, REVIEW_Y + 130,
    "NPI registry unavailable — could not verify provider. Do not auto-advance.");
  edge(npi, "rq_npi_unavailable", "unavailable");

  // ── 3-document e-sign packet. Each send reads input.lead.id, so an inject
  //    transform precedes each one to rebuild input.lead from vars. Template
  //    ids are per-firm and left blank for the operator.
  const esignDoc = (
    idBase: string,
    label: string,
    fromId: string,
    fromHandle: string | undefined,
  ): string => {
    const inj = node(`inject_${idBase}`, "data.transform", x(), MAIN_Y, `Prep lead (${label})`, {
      code: INJECT_LEAD,
    });
    edge(fromId, inj, fromHandle);
    const send = node(`esign_${idBase}`, "documents.send_dropbox_sign", x(), MAIN_Y, `E-Sign: ${label}`, {
      templateId: "",
      signerEmail: "vars.leadEmail",
      signerName: "vars.leadFullName",
    });
    edge(inj, send);
    return send;
  };
  // AI Voice Agent flow: before any documents go out, the Vapi voice agent
  // calls the claimant to confirm their captured details. The synchronous
  // dispatch ack maps to `completed` (the spoken confirmation itself is
  // reported back via the voice webhook into the run trail); a dispatch failure
  // routes to review so a human confirms before documents are sent. agentId is
  // left blank on purpose — the handler resolves the lead's per-tort
  // provisioned Vapi assistant at runtime.
  let esignFrom = npi;
  let esignHandle: string | undefined = "verified";
  if (spec.key === "ai_agent") {
    const voiceConfirm = node("voice_confirm", "ai.voice_agent", x(), MAIN_Y, "Voice confirm details", {
      agentId: "",
      callId: "vars.callId",
      to: "vars.leadPhone",
      metadata: { lead_id: "vars.leadId", purpose: "confirm_intake" },
    });
    edge(npi, voiceConfirm, "verified");
    const vcX = nodes.find((n) => n.id === voiceConfirm)!.position.x;
    review("rq_voice_confirm_failed", vcX, REVIEW_Y,
      "Voice confirmation call could not be placed — confirm the claimant's details manually before sending documents.");
    edge(voiceConfirm, "rq_voice_confirm_failed", "failed");
    esignFrom = voiceConfirm;
    esignHandle = "completed";
  }

  const hipaa = esignDoc("hipaa", "HIPAA Authorization", esignFrom, esignHandle);
  const retainer = esignDoc("retainer", "Retainer Agreement", hipaa, undefined);
  const affidavit = esignDoc("affidavit", "Personal Truth Affidavit", retainer, undefined);

  // "Documents ready to sign" SMS — the e-sign packet has been dispatched, so
  // text the claimant to go sign (every claimant touchpoint is via text).
  const docsReady = node("docs_ready_sms", "comm.send_sms", x(), MAIN_Y, "Docs ready to sign SMS", {
    to: "vars.leadPhone",
    body: "We just sent your case documents for signature. Please open the request we sent and sign all 3 to keep things moving. Reply STOP to opt out.",
    leadId: "vars.leadId",
  });
  edge(affidavit, docsReady);

  const allSigned = node("esign_all_signed", "documents.esign_all_signed", x(), MAIN_Y, "All Documents Signed?", {
    leadId: "vars.leadId",
  });
  edge(docsReady, allSigned);
  const allSignedX = nodes.find((n) => n.id === allSigned)!.position.x;

  // Pending branch: re-engage, then route to review (never behave like signed).
  if (spec.key === "ai_agent") {
    const voiceRemind = node("esign_voice_remind", "ai.voice_agent", allSignedX, REVIEW_Y, "Voice re-engage (pending)", {
      agentId: "",
      callId: "vars.callId",
      to: "vars.leadPhone",
      metadata: { lead_id: "vars.leadId", purpose: "esign_reminder" },
    });
    edge(allSigned, voiceRemind, "pending");
    review("rq_esign_pending", allSignedX + COL, REVIEW_Y, "E-sign packet still pending after voice re-engagement. Human follow-up.");
    edge(voiceRemind, "rq_esign_pending", "completed");
    edge(voiceRemind, "rq_esign_pending", "failed");
  } else {
    const remind = node("esign_remind_sms", "comm.send_sms", allSignedX, REVIEW_Y, "E-sign reminder SMS", {
      to: "vars.leadPhone",
      body: "Reminder: we still need your signature to proceed. Please open the signing request we sent and complete all documents. Reply STOP to opt out.",
      leadId: "vars.leadId",
    });
    edge(allSigned, remind, "pending");
    review("rq_esign_pending", allSignedX + COL, REVIEW_Y, "E-sign packet still pending after SMS reminder. Human follow-up.");
    edge(remind, "rq_esign_pending");
  }

  const fax = node("fax_records", "documents.fax_medical_records", x(), MAIN_Y, "Fax Medical-Records Request", {
    leadId: "vars.leadId",
  });
  edge(allSigned, fax, "all_signed");
  const faxX = nodes.find((n) => n.id === fax)!.position.x;
  review("rq_fax_failed", faxX, REVIEW_Y, "Medical-records fax failed to send — provider fax invalid or transport error. Human follow-up.");
  edge(fax, "rq_fax_failed", "failed");

  const assign = node("assign_paralegal", "crm.assign_paralegal", x(), MAIN_Y, "Assign Paralegal", {
    entity: "lead",
    id: "vars.leadId",
  });
  edge(fax, assign, "sent");

  const setActive = node("set_status_active", "crm.set_lead_status", x(), MAIN_Y, "Mark Active", {
    leadId: "vars.leadId",
    status: "active",
  });
  edge(assign, setActive);

  const sched = node("compute_followup", "data.transform", x(), MAIN_Y, "Compute follow-up time", {
    code: COMPUTE_FOLLOWUP,
  });
  edge(setActive, sched);

  const cal = node("calendar_event", "crm.create_calendar_event", x(), MAIN_Y, "Schedule Follow-up", {
    title: "Intake follow-up call",
    startsAt: "vars.followupAt",
    entity: "lead",
    id: "vars.leadId",
    notes: `Auto-scheduled by ${spec.key} intake pipeline.`,
  });
  edge(sched, cal);

  // Flow-specific notification tail.
  let notifyTail: string;
  if (spec.key === "self_service") {
    const confirmSms = node("notify_sms", "comm.send_sms", x(), MAIN_Y, "Confirmation SMS", {
      to: "vars.leadPhone",
      body: "All set — your documents are in and your case is moving forward. We've scheduled your follow-up call and a paralegal will be in touch. Reply STOP to opt out.",
      leadId: "vars.leadId",
    });
    edge(cal, confirmSms);
    notifyTail = confirmSms;
  } else if (spec.key === "ai_agent") {
    const sms = node("notify_sms", "comm.send_sms", x(), MAIN_Y, "Confirmation SMS", {
      to: "vars.leadPhone",
      body: "Your documents are in and your case is moving forward. A paralegal will be in touch. Reply STOP to opt out.",
      leadId: "vars.leadId",
    });
    edge(cal, sms);
    notifyTail = sms;
  } else {
    // vendor: postback to the vendor (machine-to-machine), then a claimant
    // confirmation SMS.
    const postback = node("vendor_postback", "integration.webhook_out", x(), MAIN_Y, "Vendor Postback (set URL)", {
      url: "https://example.com/hooks/vendor-postback",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { event: "lead.qualified", flow: "vendor" },
    });
    edge(cal, postback);
    const confirmSms = node("notify_sms", "comm.send_sms", x(), MAIN_Y, "Confirmation SMS", {
      to: "vars.leadPhone",
      body: "Thank you — your documents are complete and your case is now active. A paralegal will reach out shortly. Reply STOP to opt out.",
      leadId: "vars.leadId",
    });
    edge(postback, confirmSms);
    notifyTail = confirmSms;
  }

  const auditDone = node("audit_complete", "crm.audit_log", x(), MAIN_Y, "Audit: pipeline complete", {
    action: "automation.intake_pipeline_complete",
    entityType: "lead",
    entityId: "vars.leadId",
    details: { flow: spec.key, channel: spec.channel },
  });
  edge(notifyTail, auditDone);

  const end = node("end", "utility.end", x(), MAIN_Y, "End", {
    output: { status: "complete", flow: spec.key },
  });
  edge(auditDone, end);

  return { nodes, edges };
}

/** Stable JSON stringify (sorted keys) so a graph fingerprint is order-independent. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function graphFingerprint(graph: Graph): string {
  return createHash("sha256").update(stableStringify(graph)).digest("hex");
}

export interface SeedIntakeWorkflowsResult {
  inserted: number;
  refreshed: number;
  skipped: number;
}

export async function seedIntakeWorkflows(): Promise<SeedIntakeWorkflowsResult> {
  let inserted = 0;
  let refreshed = 0;
  let skipped = 0;

  for (const spec of FLOWS) {
    const flowTag = `flow:${spec.key}`;
    const graph = buildGraph(spec);
    const fingerprint = graphFingerprint(graph);

    // Idempotency: a system-wide (firm_id IS NULL) workflow already carrying
    // both our seed tag and this flow's tag means it's already seeded.
    const [existing] = await db
      .select({
        id: automationWorkflowsTable.id,
        graph: automationWorkflowsTable.graph,
        trigger_config: automationWorkflowsTable.trigger_config,
        enabled: automationWorkflowsTable.enabled,
      })
      .from(automationWorkflowsTable)
      .where(
        and(
          isNull(automationWorkflowsTable.firm_id),
          arrayContains(automationWorkflowsTable.tags, [SEED_TAG, flowTag]),
        ),
      )
      .limit(1);

    if (!existing) {
      await db.insert(automationWorkflowsTable).values({
        firm_id: null,
        name: spec.name,
        description: spec.description,
        graph: graph as { nodes: unknown[]; edges: unknown[] },
        enabled: false,
        trigger_type: spec.triggerType,
        trigger_config: { seed_version: SEED_VERSION, seed_graph_sha: fingerprint },
        tags: [SEED_TAG, flowTag],
      } as typeof automationWorkflowsTable.$inferInsert);
      inserted++;
      continue;
    }

    // Already seeded. We only auto-refresh a DISABLED row: once an operator has
    // enabled a workflow they have adopted it as live, so we never clobber it.
    // For disabled rows we refresh to the latest template ONLY if the operator
    // has not edited the graph since we last wrote it, detected by comparing the
    // stored fingerprint against the current graph's fingerprint. Legacy rows
    // (seeded before fingerprinting) have no stored sha; since they are still
    // disabled and predate versioning we treat them as managed/unedited and
    // upgrade them once.
    const storedSha =
      (existing.trigger_config as Record<string, unknown> | null)?.["seed_graph_sha"] as
        | string
        | undefined;
    const currentSha = graphFingerprint(existing.graph as Graph);
    const unedited = storedSha == null ? true : storedSha === currentSha;

    if (!existing.enabled && unedited && fingerprint !== currentSha) {
      await db
        .update(automationWorkflowsTable)
        .set({
          name: spec.name,
          description: spec.description,
          graph: graph as { nodes: unknown[]; edges: unknown[] },
          trigger_type: spec.triggerType,
          trigger_config: {
            ...((existing.trigger_config as Record<string, unknown>) ?? {}),
            seed_version: SEED_VERSION,
            seed_graph_sha: fingerprint,
          },
          updated_at: new Date(),
        } as Partial<typeof automationWorkflowsTable.$inferInsert>)
        .where(eq(automationWorkflowsTable.id, existing.id));
      refreshed++;
    } else {
      skipped++;
    }
  }

  logger.info({ inserted, refreshed, skipped, seedVersion: SEED_VERSION }, "Intake automation workflows seed");
  return { inserted, refreshed, skipped };
}
