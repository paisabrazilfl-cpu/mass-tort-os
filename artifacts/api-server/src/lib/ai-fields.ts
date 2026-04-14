import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

const MODEL = "claude-haiku-4-5";

export interface MedicalRecordFields {
  patient_name: string;
  date_of_birth: string;
  providers: { name: string; npi?: string; specialty?: string; role: string }[];
  diagnoses: { code: string; description: string; date?: string }[];
  medications: { name: string; dosage: string; frequency: string; prescriber?: string; start_date?: string; end_date?: string }[];
  procedures: { name: string; date?: string; provider?: string; facility?: string }[];
  timeline_events: { date: string; event: string; category: string }[];
  exposure_details: { substance?: string; location?: string; start_date?: string; end_date?: string; duration?: string }[];
  insurance_info: { provider?: string; policy_number?: string; group_number?: string };
  raw_text: string;
  confidence: number;
  document_type: string;
}

const AIFIELDS_PROMPT = `You are a medical records analysis engine for mass tort litigation. Extract ALL structured data from this document with maximum detail.

Return ONLY valid JSON with these fields:
- "patient_name": string — full patient name or ""
- "date_of_birth": string — MM/DD/YYYY or ""
- "providers": array of {name, npi?, specialty?, role} — all doctors, nurses, pharmacists mentioned
- "diagnoses": array of {code, description, date?} — ICD codes if visible, descriptions, diagnosis dates
- "medications": array of {name, dosage, frequency, prescriber?, start_date?, end_date?}
- "procedures": array of {name, date?, provider?, facility?}
- "timeline_events": array of {date, event, category} — category: "diagnosis", "treatment", "exposure", "procedure", "visit"
- "exposure_details": array of {substance?, location?, start_date?, end_date?, duration?}
- "insurance_info": {provider?, policy_number?, group_number?}
- "raw_text": string — complete transcription
- "confidence": number — 0.0 to 1.0
- "document_type": string — "medical_record", "pharmacy_record", "lab_result", "radiology", "discharge_summary", "progress_note", "operative_report", "pathology", "other"

Extract every piece of clinically and legally relevant data. For mass tort cases, pay special attention to exposure timelines, substance names, and causation evidence.
Return ONLY the JSON object.`;

export async function extractMedicalFields(
  imageBase64: string,
  mimeType: string
): Promise<MedicalRecordFields> {
  const base64Data = imageBase64.replace(/^data:[^;]+;base64,/, "");
  const validMime = (
    ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType) ? mimeType : "image/png"
  ) as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: validMime, data: base64Data } },
          { type: "text", text: AIFIELDS_PROMPT },
        ],
      }],
    });

    const content = response.content[0];
    if (content.type !== "text") return emptyFields();

    const raw = content.text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ...emptyFields(), raw_text: raw, confidence: 0.1 };

    const parsed = JSON.parse(jsonMatch[0]) as MedicalRecordFields;
    logger.info({ doc_type: parsed.document_type, providers: parsed.providers.length, meds: parsed.medications.length, confidence: parsed.confidence }, "AIFields extraction complete");
    return parsed;
  } catch (err) {
    logger.error({ err }, "AIFields extraction failed");
    return emptyFields();
  }
}

export async function analyzeDocumentText(text: string): Promise<MedicalRecordFields> {
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: `${AIFIELDS_PROMPT}\n\nDocument text:\n${text.slice(0, 8000)}`,
      }],
    });

    const content = response.content[0];
    if (content.type !== "text") return emptyFields();
    const jsonMatch = content.text.trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) return emptyFields();
    return JSON.parse(jsonMatch[0]) as MedicalRecordFields;
  } catch (err) {
    logger.error({ err }, "AIFields text analysis failed");
    return emptyFields();
  }
}

function emptyFields(): MedicalRecordFields {
  return {
    patient_name: "", date_of_birth: "", providers: [], diagnoses: [],
    medications: [], procedures: [], timeline_events: [], exposure_details: [],
    insurance_info: {}, raw_text: "", confidence: 0, document_type: "other",
  };
}
