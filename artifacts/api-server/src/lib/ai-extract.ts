import { callLLM } from "./ai-provider";
import { type ExtractedFeatures } from "./scoring";
import { logger } from "./logger";

const MAX_TEXT_LENGTH = 8000;

export async function extractFeatures(text: string): Promise<ExtractedFeatures> {
  const truncated = text.slice(0, MAX_TEXT_LENGTH);

  const prompt = `You are a medical-legal document analyzer for mass tort cases.

Analyze the following medical/legal document text and return ONLY a valid JSON object with these fields:
- "diagnosis_present": boolean (true if a medical diagnosis is mentioned)
- "exposure": "yes" | "no" | "unclear" (was the subject exposed to the harmful substance/location?)
- "severity": number between 0.0 and 1.0 (severity of the medical condition; 1.0 = most severe)
- "contradictions": array of strings (any contradictory statements found; empty array if none)
- "tort_type": string (identified tort category, e.g. "Camp Lejeune", "AFFF", "NEC", or "unknown")
- "diagnosis_type": string (the specific diagnosis if mentioned, or "unknown")
- "exposure_period_years": number (estimated years of exposure, 0 if unknown)

Return ONLY the JSON object. No explanation, no markdown, no extra text.

DOCUMENT TEXT:
${truncated}`;

  try {
    const raw = await callLLM({ module: "ai-extract", prompt, maxTokens: 8192 });
    const jsonMatch = raw.trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ raw }, "AI extraction response has no JSON object");
      return {};
    }
    const parsed = JSON.parse(jsonMatch[0]) as ExtractedFeatures;
    logger.info({ features: parsed }, "AI extraction complete");
    return parsed;
  } catch (err) {
    logger.error({ err }, "AI extraction failed");
    return {};
  }
}
