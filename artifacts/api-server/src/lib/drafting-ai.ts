import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

const MODEL = "claude-haiku-4-5";

export interface DraftInput {
  template_type: string;
  lead_data: Record<string, any>;
  firm_name?: string;
  attorney_name?: string;
  custom_instructions?: string;
}

export interface DraftOutput {
  title: string;
  content: string;
  template_type: string;
  generated_at: string;
  fields_used: string[];
}

const TEMPLATE_PROMPTS: Record<string, string> = {
  hipaa_authorization: `Generate a HIPAA Authorization form for the patient below. Include:
- Patient identification section
- Description of information to be disclosed
- Purpose of disclosure (legal representation in mass tort litigation)
- Authorized recipients
- Expiration clause
- Right to revoke
- Signature lines with date fields
Format as a professional legal document.`,

  retainer_agreement: `Generate a legal retainer agreement for mass tort representation. Include:
- Client identification
- Scope of representation (specific tort type)
- Fee arrangement (contingency basis, typical 33-40%)
- Client obligations
- Attorney obligations
- Termination clause
- Governing law
- Signature blocks
Format as a professional legal document.`,

  medical_records_request: `Generate a medical records request letter. Include:
- Patient authorization reference
- Specific records requested (related to diagnosis/exposure)
- Date range for records
- Preferred format (electronic/paper)
- Return address and contact
- HIPAA compliance notice
Format as a professional business letter.`,

  demand_letter: `Generate a demand letter template for mass tort litigation. Include:
- Identification of parties
- Statement of facts (exposure, diagnosis, causation)
- Legal basis for claims
- Damages summary
- Settlement demand framework
- Response deadline
Format as a professional legal document.`,

  client_intake_summary: `Generate a client intake summary document. Include:
- Client demographics
- Tort type and exposure details
- Medical history relevant to claim
- Diagnosis and treatment timeline
- Qualification status
- Key evidence summary
- Next steps
Format as an internal case management document.`,
};

export async function generateDraft(input: DraftInput): Promise<DraftOutput> {
  const templatePrompt = TEMPLATE_PROMPTS[input.template_type];
  if (!templatePrompt) {
    throw new Error(`Unknown template type: ${input.template_type}`);
  }

  const leadContext = Object.entries(input.lead_data)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const fieldsUsed = Object.keys(input.lead_data).filter(k => input.lead_data[k] !== null && input.lead_data[k] !== undefined && input.lead_data[k] !== "");

  const systemPrompt = `You are a legal document drafting assistant for mass tort law firms. Generate professional, legally sound documents. Use formal legal language. Include all standard legal provisions. Leave [BLANK] placeholders for any information not provided.

${input.custom_instructions ? `Additional instructions: ${input.custom_instructions}` : ""}`;

  const userPrompt = `${templatePrompt}

Firm: ${input.firm_name || "[LAW FIRM NAME]"}
Attorney: ${input.attorney_name || "[ATTORNEY NAME]"}

Client/Lead Data:
${leadContext}

Generate the complete document now.`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const content = response.content[0];
    const text = content.type === "text" ? content.text : "";

    const titleMap: Record<string, string> = {
      hipaa_authorization: "HIPAA Authorization Form",
      retainer_agreement: "Retainer Agreement",
      medical_records_request: "Medical Records Request",
      demand_letter: "Demand Letter",
      client_intake_summary: "Client Intake Summary",
    };

    logger.info({ template_type: input.template_type, length: text.length }, "Draft generated");

    return {
      title: titleMap[input.template_type] || "Legal Document",
      content: text,
      template_type: input.template_type,
      generated_at: new Date().toISOString(),
      fields_used: fieldsUsed,
    };
  } catch (err) {
    logger.error({ err, template_type: input.template_type }, "Draft generation failed");
    throw new Error("Failed to generate document draft");
  }
}

export function getAvailableTemplates() {
  return [
    { id: "hipaa_authorization", name: "HIPAA Authorization", description: "Patient authorization for medical records disclosure" },
    { id: "retainer_agreement", name: "Retainer Agreement", description: "Contingency fee retainer for mass tort representation" },
    { id: "medical_records_request", name: "Medical Records Request", description: "Letter requesting patient medical records" },
    { id: "demand_letter", name: "Demand Letter", description: "Pre-litigation demand letter template" },
    { id: "client_intake_summary", name: "Client Intake Summary", description: "Internal case intake summary document" },
  ];
}
