/**
 * PDF text extraction for OCR pipeline.
 * Uses pdf-parse's PDFParse class to get all text from a PDF buffer.
 */
import { logger } from "./logger";

export async function extractPdfText(pdfBuffer: Buffer): Promise<string> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
    const result = await parser.getText();
    const text = (result.text ?? "").trim();
    logger.info(
      { pages: result.total, chars: text.length },
      "PDF text extraction complete"
    );
    return text;
  } catch (err) {
    logger.warn({ err }, "PDF text extraction failed — returning empty string");
    return "";
  }
}
