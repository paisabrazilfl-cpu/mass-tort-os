/**
 * Seed the three intake-to-medical-records automation workflows — one per
 * lead-entry flow (self-service / AI-agent / vendor) — that all feed the same
 * shared backbone described in the task plan:
 *
 *   trigger → consent + TCPA gate → background-check hub → NPI name/city/state
 *   verification → send the 3-document e-sign packet (HIPAA + Retainer +
 *   Personal Truth Affidavit).
 *
 * Every gate has an explicit branch to the Review Queue (consent invalid,
 * background check flagged/errored, NPI ambiguous/unavailable) so a lead is
 * NEVER auto-advanced on uncertain evidence — humans only do final review,
 * per the AI Constitution failure protocol.
 *
 * The workflows are seeded **disabled** and **system-wide** (firm_id = NULL):
 * the e-sign send nodes carry per-firm document-template ids that an operator
 * must fill in (and then enable the workflow) from the Automations editor.
 * Post-signature routing (fax the signed HIPAA to the verified doctor + copy
 * the Retainer to the attorney) is handled deterministically by the e-sign
 * webhook path (`onEnvelopeSigned`) and is intentionally not duplicated here.
 *
 * Idempotent: identified by a stable tag, the seed inserts a workflow only
 * when its tag is absent. Operator edits (graph, enabled, template ids) are
 * never overwritten on a later boot.
 */
import { db, automationWorkflowsTable } from "@workspace/db";
import { eq, isNull, and, arrayContains } from "drizzle-orm";
import { logger } from "../logger";
import type { ConsentChannel } from "./gates";

const SEED_TAG = "seed:intake-pipeline";

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
      "Self-service flow (contact_preference=text_email). Consent artifact is the web-form TrustedForm certificate. Backbone: consent gate → background check → NPI verify → 3-doc e-sign packet, with review-queue branches at every gate.",
    triggerType: "trigger.form_submitted",
    triggerLabel: "On Web Form Submitted",
    channel: "web",
  },
  {
    key: "ai_agent",
    name: "Intake → Med Records — AI Agent (Voice)",
    description:
      "AI voice/chat agent flow (contact_preference=agent). Consent artifact is the recorded call + transcript on the claimant. Backbone: consent gate → background check → NPI verify → 3-doc e-sign packet, with review-queue branches at every gate.",
    triggerType: "trigger.inbound_call",
    triggerLabel: "On Inbound Call",
    channel: "voice",
  },
  {
    key: "vendor",
    name: "Intake → Med Records — Vendor Leads",
    description:
      "Vendor / lead-import flow. Vendor must supply a TrustedForm certificate URL per lead. Backbone: consent gate → background check → NPI verify → 3-doc e-sign packet, with review-queue branches at every gate.",
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

/**
 * Build the shared backbone graph for a flow. Template ids on the e-sign nodes
 * are left blank for the operator to fill per firm.
 */
function buildGraph(spec: FlowSpec): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const at = (x: number, y: number) => ({ x, y });

  const node = (n: GraphNode) => {
    nodes.push(n);
    return n.id;
  };
  const edge = (source: string, target: string, sourceHandle?: string) => {
    edges.push({
      id: `e_${source}_${sourceHandle ?? "out"}_${target}`,
      source,
      target,
      sourceHandle: sourceHandle ?? null,
    });
  };

  // Entry trigger.
  const trigger = node({
    id: "trigger",
    type: spec.triggerType,
    position: at(0, 200),
    data: { label: spec.triggerLabel },
  });

  // 1. Consent + TCPA gate.
  const consent = node({
    id: "consent_gate",
    type: "crm.consent_gate",
    position: at(280, 200),
    data: {
      label: "Consent / TCPA Gate",
      params: { leadId: "input.lead.id", channel: spec.channel },
    },
  });
  edge(trigger, consent);

  // 2. Background check hub.
  const bg = node({
    id: "background_check",
    type: "crm.background_check",
    position: at(560, 160),
    data: { label: "Background Check", params: { leadId: "input.lead.id" } },
  });
  edge(consent, bg, "valid");

  // 3. NPI name/city/state verification.
  const npi = node({
    id: "npi_verify",
    type: "crm.npi_lookup",
    position: at(840, 120),
    data: {
      // No params: the handler loads the lead by id (firm-scoped) and pulls the
      // physician name + hospital + city/state from the lead row, so this works
      // for every trigger payload shape (form/voice/vendor).
      label: "Verify Provider (NPI)",
      params: {},
    },
  });
  edge(bg, npi, "clear");

  // 4. The 3-document e-sign packet. Template ids are per-firm — operator fills
  //    them in before enabling. requiredTemplateIds on the all-signed gate
  //    (documents.esign_all_signed) can reference these once set.
  const hipaa = node({
    id: "esign_hipaa",
    type: "documents.send_dropbox_sign",
    position: at(1120, 60),
    data: {
      label: "E-Sign: HIPAA Authorization",
      params: {
        templateId: "",
        signerEmail: "input.lead.email",
        signerName: "input.lead.name",
      },
    },
  });
  edge(npi, hipaa, "verified");

  const retainer = node({
    id: "esign_retainer",
    type: "documents.send_dropbox_sign",
    position: at(1120, 200),
    data: {
      label: "E-Sign: Retainer Agreement",
      params: {
        templateId: "",
        signerEmail: "input.lead.email",
        signerName: "input.lead.name",
      },
    },
  });
  edge(hipaa, retainer);

  const affidavit = node({
    id: "esign_affidavit",
    type: "documents.send_dropbox_sign",
    position: at(1120, 340),
    data: {
      label: "E-Sign: Personal Truth Affidavit",
      params: {
        templateId: "",
        signerEmail: "input.lead.email",
        signerName: "input.lead.name",
      },
    },
  });
  edge(retainer, affidavit);

  const audit = node({
    id: "audit_sent",
    type: "crm.audit_log",
    position: at(1400, 340),
    data: {
      label: "Audit: packet sent",
      params: {
        action: "automation.intake_packet_sent",
        entityType: "lead",
        entityId: "input.lead.id",
        details: { flow: spec.key, channel: spec.channel },
      },
    },
  });
  edge(affidavit, audit);

  // Review-queue branches — one per gate. Each is terminal (no outgoing edge).
  const reviewNode = (id: string, y: number, reason: string) =>
    node({
      id,
      type: "crm.send_to_review_queue",
      position: at(840, y),
      data: {
        label: "Review Queue",
        params: { entity: "lead", id: "input.lead.id", reason, priority: "high" },
      },
    });

  const rqConsent = reviewNode("rq_consent", 360, `Consent/TCPA gate failed (${spec.channel} flow) — missing or invalid consent artifact.`);
  edge(consent, rqConsent, "invalid");

  const rqBgFlagged = reviewNode("rq_bg_flagged", 460, "Background check flagged — needs human review before contact.");
  edge(bg, rqBgFlagged, "flagged");
  const rqBgError = reviewNode("rq_bg_error", 560, "Background check errored — could not complete, needs human review.");
  edge(bg, rqBgError, "error");

  const rqNpiAmbig = reviewNode("rq_npi_ambiguous", 460, "NPI verification ambiguous — provider did not match cleanly. Do not auto-advance.");
  edge(npi, rqNpiAmbig, "ambiguous");
  const rqNpiUnavail = reviewNode("rq_npi_unavailable", 560, "NPI registry unavailable — could not verify provider. Do not auto-advance.");
  edge(npi, rqNpiUnavail, "unavailable");

  return { nodes, edges };
}

export interface SeedIntakeWorkflowsResult {
  inserted: number;
  skipped: number;
}

export async function seedIntakeWorkflows(): Promise<SeedIntakeWorkflowsResult> {
  let inserted = 0;
  let skipped = 0;

  for (const spec of FLOWS) {
    const flowTag = `flow:${spec.key}`;
    // Idempotency: a system-wide (firm_id IS NULL) workflow already carrying
    // both our seed tag and this flow's tag means it's already seeded.
    const existing = await db
      .select({ id: automationWorkflowsTable.id })
      .from(automationWorkflowsTable)
      .where(
        and(
          isNull(automationWorkflowsTable.firm_id),
          arrayContains(automationWorkflowsTable.tags, [SEED_TAG, flowTag]),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      skipped++;
      continue;
    }

    await db.insert(automationWorkflowsTable).values({
      firm_id: null,
      name: spec.name,
      description: spec.description,
      graph: buildGraph(spec) as { nodes: unknown[]; edges: unknown[] },
      enabled: false,
      trigger_type: spec.triggerType,
      trigger_config: {},
      tags: [SEED_TAG, flowTag],
    } as typeof automationWorkflowsTable.$inferInsert);
    inserted++;
  }

  logger.info({ inserted, skipped }, "Intake automation workflows seed");
  return { inserted, skipped };
}
