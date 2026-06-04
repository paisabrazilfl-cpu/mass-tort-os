export interface AutomationGraphNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    params: Record<string, unknown>;
  };
}

export interface AutomationGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface AutomationGraph {
  nodes: AutomationGraphNode[];
  edges: AutomationGraphEdge[];
}

export interface AutomationStarterTemplate {
  id: string;
  name: string;
  summary: string;
  description: string;
  icon: string;
  tags: string[];
  graph: AutomationGraph;
}

function node(
  id: string,
  type: string,
  label: string,
  x: number,
  y: number,
  params: Record<string, unknown> = {},
): AutomationGraphNode {
  return { id, type, position: { x, y }, data: { label, params } };
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string | null,
  targetHandle?: string | null,
): AutomationGraphEdge {
  return { id, source, target, sourceHandle: sourceHandle ?? null, targetHandle: targetHandle ?? null };
}

export function buildBlankWorkflowGraph(): AutomationGraph {
  return {
    nodes: [node("n1", "trigger.manual", "Manual Trigger", 120, 220)],
    edges: [],
  };
}

export const AUTOMATION_STARTER_TEMPLATES: AutomationStarterTemplate[] = [
  {
    id: "web-form-intake",
    name: "Web Form Intake",
    summary: "Turn a submitted form into a qualified lead pipeline.",
    description: "Starts from a web form, creates the lead, runs qualification, then routes to qualified, review, or rejected.",
    icon: "AppWindow",
    tags: ["starter", "intake", "web-form"],
    graph: {
      nodes: [
        node("t1", "trigger.form_submitted", "Web Form Submitted", 80, 220),
        node("t2", "crm.create_lead", "Create Lead", 340, 220, {
          data: { first_name: "input.first_name", last_name: "input.last_name", email: "input.email", phone: "input.phone", tort: "input.tort", source: "web_form" },
        }),
        node("t3", "crm.decision_engine", "Score Intake", 620, 220, { leadId: "input.lead.id", tort: "input.tort" }),
        node("t4", "crm.set_lead_status", "Mark Qualified", 930, 70, { leadId: "input.lead.id", status: "qualified" }),
        node("t5", "crm.send_to_review_queue", "Send to Review", 930, 220, { entity: "lead", id: "input.lead.id", reason: "Needs human review after intake scoring.", priority: "normal" }),
        node("t6", "crm.set_lead_status", "Mark Rejected", 930, 370, { leadId: "input.lead.id", status: "rejected" }),
      ],
      edges: [
        edge("e1", "t1", "t2"),
        edge("e2", "t2", "t3"),
        edge("e3", "t3", "t4", "qualified"),
        edge("e4", "t3", "t5", "review"),
        edge("e5", "t3", "t6", "rejected"),
      ],
    },
  },
  {
    id: "intake-review",
    name: "Intake Review Queue",
    summary: "Check consent, assign the file, and escalate only the tricky cases.",
    description: "Starts when a lead is created, validates consent, assigns a paralegal when ready, or routes the intake to review.",
    icon: "ClipboardCheck",
    tags: ["starter", "intake", "review"],
    graph: {
      nodes: [
        node("t1", "trigger.lead_created", "Lead Created", 80, 220),
        node("t2", "crm.consent_gate", "Consent Check", 340, 220, { leadId: "input.lead.id" }),
        node("t3", "crm.assign_paralegal", "Assign Paralegal", 650, 100, { entity: "lead", id: "input.lead.id", paralegalId: "" }),
        node("t4", "crm.add_note", "Log Intake Note", 950, 100, { entity: "lead", id: "input.lead.id", note: "Intake assigned and consent verified." }),
        node("t5", "crm.send_to_review_queue", "Consent Review", 650, 340, { entity: "lead", id: "input.lead.id", reason: "Consent validation failed or incomplete.", priority: "high" }),
      ],
      edges: [
        edge("e1", "t1", "t2"),
        edge("e2", "t2", "t3", "verified"),
        edge("e3", "t3", "t4"),
        edge("e4", "t2", "t5", "failed"),
      ],
    },
  },
  {
    id: "lead-created-sms",
    name: "New Lead Welcome SMS",
    summary: "Send an instant welcome SMS the moment a lead is created.",
    description: "Fires on lead creation and sends a personalized SMS with next steps.",
    icon: "MessageSquare",
    tags: ["starter", "sms", "lead"],
    graph: {
      nodes: [
        node("t1", "trigger.lead_created", "Lead Created", 80, 220),
        node("t2", "messaging.send_sms", "Send Welcome SMS", 380, 220, {
          to: "input.lead.phone",
          body: "Hi {{lead.first_name}}, thanks for submitting your {{lead.tort_type}} case. Our team will reach out shortly. Reply STOP to opt out.",
        }),
      ],
      edges: [edge("e1", "t1", "t2")],
    },
  },
  {
    id: "signed-docs-followup",
    name: "Signed Docs Follow-up",
    summary: "When signatures are done, move the file forward and notify staff.",
    description: "Listens for signed documents, creates the case, and leaves an internal note.",
    icon: "FileCheck2",
    tags: ["starter", "esign", "case"],
    graph: {
      nodes: [
        node("t1", "trigger.document_signed", "Documents Signed", 80, 220),
        node("t2", "crm.create_case", "Create Case", 360, 220, { leadId: "input.lead.id", data: { matter_type: "mass_tort", priority: "normal" } }),
        node("t3", "crm.add_note", "Notify Team", 680, 220, { entity: "case", id: "input.case.id", note: "Signed packet complete. Case created automatically and ready for next-step review." }),
      ],
      edges: [edge("e1", "t1", "t2"), edge("e2", "t2", "t3")],
    },
  },
  {
    id: "npi-verify-fax",
    name: "NPI Verify + Fax Records",
    summary: "Verify the treating provider then auto-request medical records.",
    description: "After a lead is qualified, verifies the NPI, and if confirmed faxes a records request automatically.",
    icon: "Stethoscope",
    tags: ["starter", "npi", "fax", "medical-records"],
    graph: {
      nodes: [
        node("t1", "trigger.lead_created", "Lead Qualified", 80, 220),
        node("t2", "crm.npi_lookup", "Verify NPI", 360, 220, { first_name: "input.lead.provider_first_name", last_name: "input.lead.provider_last_name", state: "input.lead.state" }),
        node("t3", "messaging.send_fax", "Fax Records Request", 680, 100, { to: "input.lead.provider_fax", documentType: "medical_records_request", leadId: "input.lead.id" }),
        node("t4", "crm.send_to_review_queue", "Provider Needs Review", 680, 340, { entity: "lead", id: "input.lead.id", reason: "Provider could not be verified for medical records request.", priority: "high" }),
      ],
      edges: [
        edge("e1", "t1", "t2"),
        edge("e2", "t2", "t3", "verified"),
        edge("e3", "t2", "t4", "ambiguous"),
        edge("e4", "t2", "t4", "unavailable"),
      ],
    },
  },
];

export function getAutomationStarterTemplate(templateId: string | null | undefined) {
  return AUTOMATION_STARTER_TEMPLATES.find((t) => t.id === templateId) ?? null;
}
