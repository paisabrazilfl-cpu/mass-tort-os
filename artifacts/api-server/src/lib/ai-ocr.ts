/**
 * Vision OCR for faxed pharmacy/medical records.
 * Output: Legora Grid row format matching the MTOS OCR spec.
 */
import { callLLM } from "./ai-provider";
import { logger } from "./logger";

export interface LegoraGridRow {
  rx_number: string;
  drug_name: string;
  fill_date: string;
  quantity: string;
  confidence: number;
  raw_text: string;
}

const SYSTEM_PROMPT = `You are an OCR engine specialized in faxed pharmacy and medical records for mass tort litigation.

Extract structured data from faxed prescription records, pharmacy printouts, and medical documents.
Focus on: Paraquat, Camp Lejeune contamination, AFFF, NEC, talc, and other mass tort substances.

Return ONLY a valid JSON object with these fields:
- "rx_number": string — prescription number if present (e.g. "RX123456789"), or ""
- "drug_name": string — drug, chemical, or substance name (e.g. "Paraquat 2,4-D 1gal"), or ""
- "fill_date": string — fill/dispensed/purchase date in MM/DD/YYYY format, or ""
- "quantity": string — quantity dispensed (e.g. "30", "1gal"), or ""
- "confidence": number — your overall extraction confidence from 0.0 to 1.0
- "raw_text": string — complete raw transcription of all visible text in the document

If this is a medical record rather than an Rx: set rx_number to "", fill drug_name with the primary diagnosis or substance, and fill raw_text with all extracted text.

Return ONLY the JSON object. No markdown, no explanation.`;

export async function extractOcrData(
  imageBase64: string,
  mimeType: string
): Promise<LegoraGridRow> {
  const base64Data = imageBase64.replace(/^data:[^;]+;base64,/, "");

  const validMime = (
    ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType)
      ? mimeType
      : "image/png"
  ) as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

  try {
    const raw = await callLLM({
      module: "ai-ocr",
      prompt: SYSTEM_PROMPT,
      maxTokens: 2048,
      imageBase64: base64Data,
      imageMimeType: validMime,
    });

    const jsonMatch = raw.trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ raw }, "OCR: No JSON object in response");
      return { ...emptyRow(), raw_text: raw, confidence: 0.1 };
    }

    const parsed = JSON.parse(jsonMatch[0]) as LegoraGridRow;
    logger.info(
      { drug_name: parsed.drug_name, confidence: parsed.confidence },
      "OCR extraction complete"
    );
    return parsed;
  } catch (err) {
    logger.error({ err }, "OCR: Vision extraction failed");
    return emptyRow();
  }
}

/**
 * Text-only OCR path: used when we already have extracted text (e.g. from a PDF).
 * Runs the same structured extraction prompt against the provided text.
 */
export async function extractOcrDataFromText(text: string): Promise<LegoraGridRow> {
  if (!text.trim()) return emptyRow();

  try {
    const raw = await callLLM({
      module: "ai-ocr",
      prompt: SYSTEM_PROMPT,
      maxTokens: 2048,
      systemPrompt: `The following is text extracted from a faxed document. Analyze it and return structured data.\n\nDocument text:\n${text.slice(0, 8000)}`,
    });

    const jsonMatch = raw.trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ raw }, "OCR (text): No JSON in response");
      return { ...emptyRow(), raw_text: text.slice(0, 4000), confidence: 0.1 };
    }

    const parsed = JSON.parse(jsonMatch[0]) as LegoraGridRow;
    if (!parsed.raw_text) parsed.raw_text = text.slice(0, 4000);
    logger.info(
      { drug_name: parsed.drug_name, confidence: parsed.confidence },
      "OCR text extraction complete"
    );
    return parsed;
  } catch (err) {
    logger.error({ err }, "OCR: text extraction failed");
    return { ...emptyRow(), raw_text: text.slice(0, 4000) };
  }
}

function emptyRow(): LegoraGridRow {
  return {
    rx_number: "",
    drug_name: "",
    fill_date: "",
    quantity: "",
    confidence: 0,
    raw_text: "",
  };
}
