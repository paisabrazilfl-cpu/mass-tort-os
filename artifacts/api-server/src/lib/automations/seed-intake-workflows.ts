/**
 * Seed the intake → medical-records automation suite.
 *
 * The pipeline is split into FIVE cooperating, trigger-driven workflows so each
 * stage runs only when its prerequisites actually exist. The original design ran
 * provider (NPI) verification and the e-sign packet immediately after a voice or
 * vendor lead was created — but at that point the claimant has not yet supplied
 * their treating-provider details (those are collected on the intake form), so
 * NPI had nothing to verify. The corrected architecture qualifies the lead, then
 * texts them the intake form, then — once the form comes back — verifies the
 * provider and sends documents.
 *
 *   WF-A (voice)   trigger.inbound_call   → qualify → TEXT intake form → wait
 *   WF-A (vendor)  trigger.lead_created   → qualify → TEXT intake form → wait
 *   WF-B           trigger.form_submitted → validate → NPI → e-sign packet
 *                  (UNIFIED: serves self-service AND the voice/vendor leads once
 *                   their form is returned — the form re-matches the existing
 *                   lead via intake dedup, so all three sources converge here)
 *   WF-C           trigger.document_signed→ all-signed → fax HIPAA → route
 *   WF-D           trigger.inbound_fax    → extract medical record → review
 *
 * Owner decisions encoded here:
 *  - NO in-pipeline consent/TCPA gate. Consent is established upstream (web-form
 *    TrustedForm cert, recorded call + transcript, or vendor-supplied cert URL).
 *  - Claimant communication is SMS-ONLY. No claimant email anywhere. Internal
 *    notifications to firm staff (WF-C attorney email) are the only email.
 *  - The real e-sign signing link is delivered INSIDE the text. Because e-sign
 *    is an async worker job, the WORKER sends that SMS once the signing URL
 *    exists (see workflow-handlers `handleSendEsignPacket`, notify_signer). WF-B
 *    therefore does NOT itself text a signing link — it would not have the URL.
 *
 * `crm.create_case` is intentionally NOT used: the cases table requires a
 * NOT NULL `created_by_user_id`, and an automation run has no user actor, so
 * formal case creation stays in the app (which has a real user) — the pipeline
 * advances the lead's status and timeline instead.
 *
 * Every gate has an explicit branch to the Review Queue so a lead is NEVER
 * auto-advanced on uncertain evidence — humans only do final review.
 *
 * The workflows are seeded **disabled** and **system-wide** (firm_id = NULL):
 * the e-sign template ids, intake-form URL, and attorney address are per-firm
 * and must be filled in by an operator before the flow is enabled.
 *
 * Idempotent + self-refreshing: identified by stable tags (seed tag + per-flow
 * tag). A flow is inserted when its tag is absent. An already-seeded flow is
 * refreshed to the latest template graph ONLY when it is still disabled AND its
 * stored fingerprint matches the current graph (operator edits are never
 * clobbered). The three original flow keys (self_service / ai_agent / vendor)
 * are REUSED with new graphs, and two keys are added — so no rows are orphaned.
 */
import { createHash } from "node:crypto";
import { db, automationWorkflowsTable } from "@workspace/db";
import { isNull, and, arrayContains, eq } from "drizzle-orm";
import { logger } from "../logger";

const SEED_TAG = "seed:intake-pipeline";
/** Bump when the template graphs change so already-seeded, unedited rows refresh. */
const SEED_VERSION = 5;

type FlowKey = "self_service" | "ai_agent" | "vendor" | "document_signed" | "inbound_fax";

interface FlowSpec {
  key: FlowKey;
  name: string;
  description: string;
  triggerType: string;
  triggerLabel: string;
}

const FLOWS: FlowSpec[] = [
  {
    key: "ai_agent",
    name: "Intake Stage 1 — Voice Lead Qualification (Text intake form)",
    description:
      "Inbound call → transcribe + summarize the recording → SMS acknowledgement → background check → TEXT the claimant their secure intake form link → mark the lead 'waiting_for_intake_form'. NPI verification and the e-sign packet deliberately do NOT run here — the treating-provider details needed for NPI are collected on the intake form, which the claimant has not filled out yet. When they submit it, the 'Intake Form → E-Sign' workflow takes over. All claimant touchpoints are SMS. Consent is the recorded call + transcript, established upstream, so there is no in-pipeline consent gate.",
    triggerType: "trigger.inbound_call",
    triggerLabel: "On Inbound Call",
  },
  {
    key: "vendor",
    name: "Intake Stage 1 — Vendor Lead Qualification (Text intake form)",
    description:
      "Vendor / imported lead created → require a TrustedForm certificate URL (consent provenance) → SMS acknowledgement → background check → TEXT the claimant their secure intake form link → mark the lead 'waiting_for_intake_form'. NPI and e-sign do NOT run here for the same reason as the voice flow — provider details arrive on the intake form. When the form is returned, the 'Intake Form → E-Sign' workflow continues. All claimant touchpoints are SMS.",
    triggerType: "trigger.lead_created",
    triggerLabel: "On Lead Created",
  },
  {
    key: "self_service",
    name: "Intake Stage 2 — Intake Form → E-Sign Packet (all sources)",
    description:
      "Fires when ANY intake form is submitted — the self-service web claimant AND the voice/vendor leads whose Stage-1 text they have now completed (the submission re-matches the existing lead via intake dedup, so all sources converge here). Validate submission → background check → qualify / decision engine → verify treating provider against the NPI registry → send the 3-document e-sign packet (HIPAA + Retainer + Personal Truth Affidavit) → mark the lead 'pending_signature'. The claimant is texted the actual signing link by the e-sign worker once the embedded signing URL exists (notify_signer), so this graph sends no signing SMS itself. Review-queue branch at every gate. Claimant comms are SMS-only.",
    triggerType: "trigger.form_submitted",
    triggerLabel: "On Web Form Submitted",
  },
  {
    key: "document_signed",
    name: "Intake Stage 3 — Documents Signed → Fax & Route",
    description:
      "Fires when an e-sign packet is executed. Confirms the full packet is signed (partial signatures just log and wait) → faxes the HIPAA-authorized medical-records request to the verified provider → adds a timeline note → marks the lead 'medical_records_requested' → notifies the assigned attorney by INTERNAL email (the only email in the suite; the signed PDF itself is stored by the e-sign webhook). Fax failure routes to the review queue.",
    triggerType: "trigger.document_signed",
    triggerLabel: "On Document Signed",
  },
  {
    key: "inbound_fax",
    name: "Intake Stage 4 — Inbound Medical Records Fax",
    description:
      "Fires when a provider faxes medical records back (the inbound-fax webhook already OCRs the document and matches it to the claimant). AI-extracts the structured medical fields → adds a timeline note → marks the lead 'medical_records_received' → routes to the review queue so a human verifies completeness and attaches the records to the case. A fax with no readable document is routed to review.",
    triggerType: "trigger.inbound_fax",
    triggerLabel: "On Inbound Fax",
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

// ── Reusable transform snippets (run inside data.transform via new Function) ──
// 1) Capture trigger-payload fields into vars (input is replaced downstream).
//    Works for lead_created / form_submitted / inbound_call / document_signed.
const STASH_TRIGGER = [
  "const i = input || {};",
  "vars.leadId = (i.lead && i.lead.id != null) ? i.lead.id : i.lead_id;",
  "vars.formPayload = i.payload || null;",
  "vars.recordingUrl = i.recording_url || '';",
  "vars.callId = (i.call && i.call.id) || i.call_id || '';",
  "return input;",
].join("\n");
// 1b) Inbound-fax variant: also capture the OCR'd document vault key.
const STASH_FAX = [
  "const i = input || {};",
  "vars.leadId = i.lead_id;",
  "vars.documentId = i.documentId || i.vault_path || '';",
  "vars.faxResultId = i.fax_result_id || null;",
  "return input;",
].join("\n");
// 2) Capture the hydrated lead row (output of crm.update_lead) into vars.
const STASH_LEAD = [
  "const l = (input && input.lead) || {};",
  "if (l.id != null) vars.leadId = l.id;",
  "vars.leadEmail = l.email || '';",
  "vars.leadPhone = l.phone || '';",
  "vars.leadFirstName = l.first_name || '';",
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

// Layout constants — main path advances left→right; reviews sit in a lane below.
const COL = 240;
const MAIN_Y = 240;
const REVIEW_Y = 470;

/** A small per-graph builder so each workflow gets its own node/edge namespace. */
function makeBuilder() {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let col = 0;
  const x = () => col++ * COL;
  const node = (
    id: string,
    type: string,
    xPos: number,
    yPos: number,
    label: string,
    params?: Record<string, unknown>,
  ): string => {
    nodes.push({ id, type, position: { x: xPos, y: yPos }, data: params ? { label, params } : { label } });
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
  const xOf = (id: string) => nodes.find((n) => n.id === id)!.position.x;
  const review = (id: string, atX: number, atY: number, reason: string, priority = "high") =>
    node(id, "crm.send_to_review_queue", atX, atY, "Review Queue", {
      entity: "lead",
      id: "vars.leadId",
      reason,
      priority,
    });
  return { nodes, edges, x, node, edge, xOf, review };
}

/** Shared front-matter: trigger → capture payload → hydrate lead → capture fields → log. */
function frontMatter(
  b: ReturnType<typeof makeBuilder>,
  spec: FlowSpec,
  stashCode: string,
): string {
  const trigger = b.node("trigger", spec.triggerType, b.x(), MAIN_Y, spec.triggerLabel);
  const stash = b.node("stash_trigger", "data.transform", b.x(), MAIN_Y, "Capture trigger payload", {
    code: stashCode,
  });
  b.edge(trigger, stash);
  const hydrate = b.node("hydrate_lead", "crm.update_lead", b.x(), MAIN_Y, "Load lead record", {
    leadId: "vars.leadId",
    patch: {},
  });
  b.edge(stash, hydrate);
  const stashLead = b.node("stash_lead", "data.transform", b.x(), MAIN_Y, "Capture lead fields", {
    code: STASH_LEAD,
  });
  b.edge(hydrate, stashLead);
  const log = b.node("log_start", "utility.log", b.x(), MAIN_Y, "Log stage start", {
    level: "info",
    message: `[${spec.key}] ${spec.name} started.`,
  });
  b.edge(stashLead, log);
  return log;
}

const INTAKE_FORM_SMS_BODY =
  "Thanks! To move your case forward, please complete your secure intake form here: https://REPLACE-WITH-YOUR-INTAKE-FORM-URL — it only takes a few minutes and lets us verify your treating provider. Reply STOP to opt out.";

/** WF-A (voice): inbound call → qualify → text intake form → wait. */
function buildVoiceQualification(spec: FlowSpec): Graph {
  const b = makeBuilder();
  let cursor = frontMatter(b, spec, STASH_TRIGGER);

  const hasRec = b.node("has_recording", "logic.if", b.x(), MAIN_Y, "Call recording present?", {
    expression: "!!vars.recordingUrl",
  });
  b.edge(cursor, hasRec);
  const transcribe = b.node("transcribe_call", "ai.transcribe", b.x(), MAIN_Y, "Transcribe call audio", {
    audioUrl: "vars.recordingUrl",
    language: "en",
  });
  b.edge(hasRec, transcribe, "true");
  const summarize = b.node("summarize_call", "ai.summarize", b.x(), MAIN_Y, "Summarize call", {
    text: "input.text",
    maxWords: 150,
  });
  b.edge(transcribe, summarize);
  const ack = b.node("ack_sms", "comm.send_sms", b.x(), MAIN_Y, "Acknowledgement SMS", {
    to: "vars.leadPhone",
    body: "Thanks for calling. We have your information and we're getting started on your case. Reply STOP to opt out.",
    leadId: "vars.leadId",
  });
  b.edge(summarize, ack);
  b.edge("has_recording", ack, "false");

  const bg = b.node("background_check", "crm.background_check", b.x(), MAIN_Y, "Background Check Hub", {
    leadId: "vars.leadId",
  });
  b.edge(ack, bg);
  b.review("rq_bg_flagged", b.xOf(bg), REVIEW_Y, "Background check flagged — needs human review before contact.");
  b.edge(bg, "rq_bg_flagged", "flagged");
  b.review("rq_bg_error", b.xOf(bg), REVIEW_Y + 130, "Background check could not complete (error) — needs human review.");
  b.edge(bg, "rq_bg_error", "error");

  const sendForm = b.node("send_intake_form_sms", "comm.send_sms", b.x(), MAIN_Y, "Text intake form link", {
    to: "vars.leadPhone",
    body: INTAKE_FORM_SMS_BODY,
    leadId: "vars.leadId",
  });
  b.edge(bg, sendForm, "clear");
  const setStatus = b.node("set_status_waiting", "crm.set_lead_status", b.x(), MAIN_Y, "Mark waiting for intake form", {
    leadId: "vars.leadId",
    status: "waiting_for_intake_form",
  });
  b.edge(sendForm, setStatus);
  const audit = b.node("audit_form_sent", "crm.audit_log", b.x(), MAIN_Y, "Audit: intake form requested", {
    action: "automation.intake_form_requested",
    entityType: "lead",
    entityId: "vars.leadId",
    details: { flow: spec.key, channel: "voice" },
  });
  b.edge(setStatus, audit);
  const end = b.node("end", "utility.end", b.x(), MAIN_Y, "End (await intake form)", {
    output: { status: "awaiting_intake_form", flow: spec.key },
  });
  b.edge(audit, end);
  return { nodes: b.nodes, edges: b.edges };
}

/** WF-A (vendor): lead created → cert gate → qualify → text intake form → wait. */
function buildVendorQualification(spec: FlowSpec): Graph {
  const b = makeBuilder();
  let cursor = frontMatter(b, spec, STASH_TRIGGER);

  const certGate = b.node("cert_present", "logic.if", b.x(), MAIN_Y, "TrustedForm cert present?", {
    expression: "!!vars.trustedformCertUrl",
  });
  b.edge(cursor, certGate);
  b.review("rq_cert_missing", b.xOf(certGate), REVIEW_Y,
    "Vendor lead missing TrustedForm certificate URL — cannot establish TCPA consent provenance. Reject or request cert.");
  b.edge(certGate, "rq_cert_missing", "false");

  const certScript = b.node("validate_cert", "script.javascript", b.x(), MAIN_Y, "Validate cert URL (script)", {
    code: "const u = String(vars.trustedformCertUrl||'');\nreturn { cert_url: u, looks_valid: /^https?:\\/\\/cert\\.trustedform\\.com\\//.test(u) };",
    timeoutMs: 3000,
    approved: true,
  });
  b.edge(certGate, certScript, "true");
  const certAudit = b.node("audit_cert", "crm.audit_log", b.x(), MAIN_Y, "Audit cert recorded", {
    action: "automation.trustedform_cert_recorded",
    entityType: "lead",
    entityId: "vars.leadId",
    details: { flow: "vendor", note: "TrustedForm certificate URL present on vendor lead." },
  });
  b.edge(certScript, certAudit);
  const ack = b.node("ack_sms", "comm.send_sms", b.x(), MAIN_Y, "Acknowledgement SMS", {
    to: "vars.leadPhone",
    body: "Thanks — we received your information and our intake team is reviewing your case. Reply STOP to opt out.",
    leadId: "vars.leadId",
  });
  b.edge(certAudit, ack);

  const bg = b.node("background_check", "crm.background_check", b.x(), MAIN_Y, "Background Check Hub", {
    leadId: "vars.leadId",
  });
  b.edge(ack, bg);
  b.review("rq_bg_flagged", b.xOf(bg), REVIEW_Y, "Background check flagged — needs human review before contact.");
  b.edge(bg, "rq_bg_flagged", "flagged");
  b.review("rq_bg_error", b.xOf(bg), REVIEW_Y + 130, "Background check could not complete (error) — needs human review.");
  b.edge(bg, "rq_bg_error", "error");

  const sendForm = b.node("send_intake_form_sms", "comm.send_sms", b.x(), MAIN_Y, "Text intake form link", {
    to: "vars.leadPhone",
    body: INTAKE_FORM_SMS_BODY,
    leadId: "vars.leadId",
  });
  b.edge(bg, sendForm, "clear");
  const setStatus = b.node("set_status_waiting", "crm.set_lead_status", b.x(), MAIN_Y, "Mark waiting for intake form", {
    leadId: "vars.leadId",
    status: "waiting_for_intake_form",
  });
  b.edge(sendForm, setStatus);
  const audit = b.node("audit_form_sent", "crm.audit_log", b.x(), MAIN_Y, "Audit: intake form requested", {
    action: "automation.intake_form_requested",
    entityType: "lead",
    entityId: "vars.leadId",
    details: { flow: spec.key, channel: "vendor" },
  });
  b.edge(setStatus, audit);
  const end = b.node("end", "utility.end", b.x(), MAIN_Y, "End (await intake form)", {
    output: { status: "awaiting_intake_form", flow: spec.key },
  });
  b.edge(audit, end);
  return { nodes: b.nodes, edges: b.edges };
}

/** WF-B: form submitted → validate → bg → qualify → NPI → e-sign packet. */
function buildFormToEsign(spec: FlowSpec): Graph {
  const b = makeBuilder();
  let cursor = frontMatter(b, spec, STASH_TRIGGER);

  const validate = b.node("validate_form", "forms.validate_submission", b.x(), MAIN_Y, "Validate Submission", {
    formId: "",
    payload: "vars.formPayload",
  });
  b.edge(cursor, validate);
  b.review("rq_form_invalid", b.xOf(validate), REVIEW_Y,
    "Form submission failed TCPA / TrustedForm / field validation. Do not contact.");
  b.edge(validate, "rq_form_invalid", "invalid");

  // Background check is the self-service safety net (voice/vendor leads were
  // already cleared in Stage 1; re-running just re-confirms clear).
  const bg = b.node("background_check", "crm.background_check", b.x(), MAIN_Y, "Background Check Hub", {
    leadId: "vars.leadId",
  });
  b.edge(validate, bg, "valid");
  b.review("rq_bg_flagged", b.xOf(bg), REVIEW_Y, "Background check flagged — needs human review before contact.");
  b.edge(bg, "rq_bg_flagged", "flagged");
  b.review("rq_bg_error", b.xOf(bg), REVIEW_Y + 130, "Background check could not complete (error) — needs human review.");
  b.edge(bg, "rq_bg_error", "error");

  const qual = b.node("qualify", "crm.qualify_lead", b.x(), MAIN_Y, "Qualify Lead", { leadId: "vars.leadId" });
  b.edge(bg, qual, "clear");
  b.review("rq_qual_review", b.xOf(qual), REVIEW_Y, "Qualification returned 'review' — uncertain. Hold for human decision.");
  b.edge(qual, "rq_qual_review", "review");
  b.review("rq_qual_rejected", b.xOf(qual), REVIEW_Y + 130,
    "Auto-qualification declined this lead. Confirm the decline before closing — do not auto-reject.", "normal");
  b.edge(qual, "rq_qual_rejected", "rejected");

  const npi = b.node("npi_verify", "crm.npi_lookup", b.x(), MAIN_Y, "Verify Provider (NPI)", {
    leadId: "vars.leadId",
  });
  b.edge(qual, npi, "qualified");
  b.review("rq_npi_ambiguous", b.xOf(npi), REVIEW_Y,
    "NPI verification ambiguous — provider did not match cleanly. Do not auto-advance.");
  b.edge(npi, "rq_npi_ambiguous", "ambiguous");
  b.review("rq_npi_unavailable", b.xOf(npi), REVIEW_Y + 130,
    "NPI registry unavailable — could not verify provider. Do not auto-advance.");
  b.edge(npi, "rq_npi_unavailable", "unavailable");

  // 3-document e-sign packet. Each send reads input.lead.id, so an inject
  // transform precedes it. Exactly ONE send carries notify_signer:true so the
  // worker texts the claimant a single signing link (covering all 3 docs) once
  // the embedded signing URL exists. Template ids are per-firm (left blank).
  const esignDoc = (
    idBase: string,
    label: string,
    fromId: string,
    fromHandle: string | undefined,
    notifySigner: boolean,
  ): string => {
    const inj = b.node(`inject_${idBase}`, "data.transform", b.x(), MAIN_Y, `Prep lead (${label})`, { code: INJECT_LEAD });
    b.edge(fromId, inj, fromHandle);
    const send = b.node(`esign_${idBase}`, "documents.send_dropbox_sign", b.x(), MAIN_Y, `E-Sign: ${label}`, {
      templateId: "",
      signerEmail: "vars.leadEmail",
      signerName: "vars.leadFullName",
      ...(notifySigner ? { notifySigner: true } : {}),
    });
    b.edge(inj, send);
    return send;
  };
  const hipaa = esignDoc("hipaa", "HIPAA Authorization", npi, "verified", false);
  const retainer = esignDoc("retainer", "Retainer Agreement", hipaa, undefined, true);
  const affidavit = esignDoc("affidavit", "Personal Truth Affidavit", retainer, undefined, false);

  const setStatus = b.node("set_status_pending", "crm.set_lead_status", b.x(), MAIN_Y, "Mark pending signature", {
    leadId: "vars.leadId",
    status: "pending_signature",
  });
  b.edge(affidavit, setStatus);
  const audit = b.node("audit_packet_sent", "crm.audit_log", b.x(), MAIN_Y, "Audit: e-sign packet sent", {
    action: "automation.esign_packet_sent",
    entityType: "lead",
    entityId: "vars.leadId",
    details: { flow: spec.key, documents: ["hipaa", "retainer", "affidavit"] },
  });
  b.edge(setStatus, audit);
  const end = b.node("end", "utility.end", b.x(), MAIN_Y, "End (await signatures)", {
    output: { status: "pending_signature", flow: spec.key },
  });
  b.edge(audit, end);
  return { nodes: b.nodes, edges: b.edges };
}

/** WF-C: document signed → all-signed gate → fax HIPAA → route + notify attorney. */
function buildDocumentsSigned(spec: FlowSpec): Graph {
  const b = makeBuilder();
  let cursor = frontMatter(b, spec, STASH_TRIGGER);

  const allSigned = b.node("esign_all_signed", "documents.esign_all_signed", b.x(), MAIN_Y, "All Documents Signed?", {
    leadId: "vars.leadId",
  });
  b.edge(cursor, allSigned);
  // Partial signature is expected (the trigger fires per signed document) —
  // log and wait for the rest, do not treat as an error.
  const waiting = b.node("audit_partial", "crm.audit_log", b.xOf(allSigned), REVIEW_Y, "Audit: partial signature", {
    action: "automation.esign_partial",
    entityType: "lead",
    entityId: "vars.leadId",
    details: { note: "A document was signed but the packet is not yet complete; waiting for remaining signatures." },
  });
  b.edge(allSigned, waiting, "pending");
  const endPending = b.node("end_pending", "utility.end", b.xOf(allSigned), REVIEW_Y + 110, "End (await rest)", {
    output: { status: "awaiting_remaining_signatures" },
  });
  b.edge(waiting, endPending);

  const fax = b.node("fax_records", "documents.fax_medical_records", b.x(), MAIN_Y, "Fax HIPAA Medical-Records Request", {
    leadId: "vars.leadId",
  });
  b.edge(allSigned, fax, "all_signed");
  b.review("rq_fax_failed", b.xOf(fax), REVIEW_Y,
    "Medical-records fax failed to send — provider fax invalid or transport error. Human follow-up.");
  b.edge(fax, "rq_fax_failed", "failed");

  const note = b.node("add_note", "crm.add_note", b.x(), MAIN_Y, "Timeline note", {
    entity: "lead",
    id: "vars.leadId",
    note: "All case documents signed. HIPAA medical-records request faxed to the verified provider.",
  });
  b.edge(fax, note, "sent");
  const setStatus = b.node("set_status_mrr", "crm.set_lead_status", b.x(), MAIN_Y, "Mark medical records requested", {
    leadId: "vars.leadId",
    status: "medical_records_requested",
  });
  b.edge(note, setStatus);
  // Internal attorney notification — the ONLY email in the suite (firm staff,
  // not the claimant). Address is per-firm; operator sets it before enabling.
  const email = b.node("notify_attorney", "integration.send_email", b.x(), MAIN_Y, "Notify attorney (internal email)", {
    to: "attorney@REPLACE-WITH-FIRM-DOMAIN",
    subject: "Signed packet — medical records requested",
    html: "<p>The claimant has signed the full e-sign packet (HIPAA + Retainer + Affidavit). The HIPAA medical-records request has been faxed to the verified provider. The signed PDFs are stored on the lead.</p>",
  });
  b.edge(setStatus, email);
  const audit = b.node("audit_signed", "crm.audit_log", b.x(), MAIN_Y, "Audit: documents signed processed", {
    action: "automation.documents_signed_processed",
    entityType: "lead",
    entityId: "vars.leadId",
    details: { flow: spec.key },
  });
  b.edge(email, audit);
  const end = b.node("end", "utility.end", b.x(), MAIN_Y, "End", {
    output: { status: "medical_records_requested", flow: spec.key },
  });
  b.edge(audit, end);
  return { nodes: b.nodes, edges: b.edges };
}

/** WF-D: inbound fax → extract medical record → note → status → review. */
function buildInboundFax(spec: FlowSpec): Graph {
  const b = makeBuilder();
  let cursor = frontMatter(b, spec, STASH_FAX);

  const hasDoc = b.node("has_document", "logic.if", b.x(), MAIN_Y, "Readable document present?", {
    expression: "!!vars.documentId",
  });
  b.edge(cursor, hasDoc);
  b.review("rq_no_document", b.xOf(hasDoc), REVIEW_Y,
    "Inbound fax has no readable OCR document — assign and review manually.");
  b.edge(hasDoc, "rq_no_document", "false");

  const extract = b.node("medical_extract", "documents.medical_extract", b.x(), MAIN_Y, "AI Medical Record Extract", {
    documentId: "vars.documentId",
    schema: { diagnoses: ["string"], medications: ["string"], dates: ["YYYY-MM-DD"], provider: "string" },
  });
  b.edge(hasDoc, extract, "true");

  const note = b.node("add_note", "crm.add_note", b.x(), MAIN_Y, "Timeline note", {
    entity: "lead",
    id: "vars.leadId",
    note: "Inbound medical records received from provider and AI-extracted. Pending human verification.",
  });
  b.edge(extract, note);
  const setStatus = b.node("set_status_received", "crm.set_lead_status", b.x(), MAIN_Y, "Mark medical records received", {
    leadId: "vars.leadId",
    status: "medical_records_received",
  });
  b.edge(note, setStatus);
  const reviewVerify = b.node("rq_verify_records", "crm.send_to_review_queue", b.x(), MAIN_Y, "Review Queue", {
    entity: "lead",
    id: "vars.leadId",
    reason: "Inbound medical records received — verify completeness and attach to the case.",
    priority: "normal",
  });
  b.edge(setStatus, reviewVerify);
  const audit = b.node("audit_received", "crm.audit_log", b.x(), MAIN_Y, "Audit: medical records received", {
    action: "automation.medical_records_received",
    entityType: "lead",
    entityId: "vars.leadId",
    details: { flow: spec.key },
  });
  b.edge(reviewVerify, audit);
  const end = b.node("end", "utility.end", b.x(), MAIN_Y, "End (await verification)", {
    output: { status: "medical_records_received", flow: spec.key },
  });
  b.edge(audit, end);
  return { nodes: b.nodes, edges: b.edges };
}

function buildGraph(spec: FlowSpec): Graph {
  switch (spec.key) {
    case "ai_agent":
      return buildVoiceQualification(spec);
    case "vendor":
      return buildVendorQualification(spec);
    case "self_service":
      return buildFormToEsign(spec);
    case "document_signed":
      return buildDocumentsSigned(spec);
    case "inbound_fax":
      return buildInboundFax(spec);
  }
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

    // Already seeded. Only auto-refresh a DISABLED row whose graph the operator
    // has not edited since we last wrote it (fingerprint match). Legacy rows with
    // no stored sha predate versioning and are treated as managed/unedited.
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
