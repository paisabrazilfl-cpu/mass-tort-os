/**
 * Claude Vision OCR for faxed pharmacy/medical records.
 * Replaces PaddleOCR (not available in Node.js) with Claude Haiku vision.
 *
 * Output: Legora Grid row format matching the MTOS OCR spec.
 */
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

const MODEL = "claude-haiku-4-5";

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
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: validMime,
                data: base64Data,
              },
            },
            {
              type: "text",
              text: SYSTEM_PROMPT,
            },
          ],
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      logger.warn("OCR: Claude returned non-text content");
      return emptyRow();
    }

    const raw = content.text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ raw }, "OCR: No JSON object in Claude response");
      return { ...emptyRow(), raw_text: raw, confidence: 0.1 };
    }

    const parsed = JSON.parse(jsonMatch[0]) as LegoraGridRow;
    logger.info(
      { drug_name: parsed.drug_name, confidence: parsed.confidence },
      "OCR extraction complete"
    );
    return parsed;
  } catch (err) {
    logger.error({ err }, "OCR: Claude Vision extraction failed");
    return emptyRow();
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
