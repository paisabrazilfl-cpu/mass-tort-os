import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { logger } from "./logger";

export interface RedactionRule {
  type: "text" | "region";
  pattern?: string;
  page?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: string;
}

const PII_PATTERNS = [
  { name: "SSN", pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g },
  { name: "DOB", pattern: /\b(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/(?:19|20)\d{2}\b/g },
  { name: "Phone", pattern: /\b(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  { name: "Email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi },
];

export async function redactPdf(
  pdfBytes: Buffer | Uint8Array,
  rules: RedactionRule[]
): Promise<Uint8Array> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    for (const rule of rules) {
      if (rule.type === "region" && rule.page !== undefined) {
        const pageIndex = Math.min(rule.page, pages.length - 1);
        const page = pages[pageIndex];
        const x = rule.x ?? 0;
        const y = rule.y ?? 0;
        const w = rule.width ?? 100;
        const h = rule.height ?? 20;

        page.drawRectangle({ x, y, width: w, height: h, color: rgb(0, 0, 0) });

        if (rule.label) {
          page.drawText(`[${rule.label}]`, {
            x: x + 2, y: y + 4, size: 8, font, color: rgb(1, 1, 1),
          });
        }
      }
    }

    return pdfDoc.save();
  } catch (err) {
    logger.error({ err }, "PDF redaction failed");
    throw new Error("PDF redaction failed");
  }
}

export async function highlightPdfRegions(
  pdfBytes: Buffer | Uint8Array,
  highlights: { page: number; x: number; y: number; width: number; height: number; color?: string; label?: string }[]
): Promise<Uint8Array> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    for (const hl of highlights) {
      const pageIndex = Math.min(hl.page, pages.length - 1);
      const page = pages[pageIndex];

      const color = hl.color === "red" ? rgb(1, 0.8, 0.8) :
                    hl.color === "green" ? rgb(0.8, 1, 0.8) :
                    rgb(1, 1, 0.6);

      page.drawRectangle({
        x: hl.x, y: hl.y, width: hl.width, height: hl.height,
        color, opacity: 0.4,
      });

      if (hl.label) {
        page.drawText(hl.label, {
          x: hl.x + 2, y: hl.y + hl.height + 2, size: 7, font, color: rgb(0.3, 0.3, 0.3),
        });
      }
    }

    return pdfDoc.save();
  } catch (err) {
    logger.error({ err }, "PDF highlighting failed");
    throw new Error("PDF highlighting failed");
  }
}

export async function createHipaaRedactedPdf(
  pdfBytes: Buffer | Uint8Array
): Promise<Uint8Array> {
  const rules: RedactionRule[] = PII_PATTERNS.map(p => ({
    type: "text" as const,
    pattern: p.pattern.source,
    label: `REDACTED-${p.name}`,
  }));
  return redactPdf(pdfBytes, rules);
}

export async function getPdfPageCount(pdfBytes: Buffer | Uint8Array): Promise<number> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  return pdfDoc.getPageCount();
}

export async function createBlankPdfWithText(text: string, title?: string): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const lines = text.split("\n");
  let currentPage = pdfDoc.addPage([612, 792]);
  let yPos = 750;
  const margin = 50;
  const lineHeight = 14;

  if (title) {
    currentPage.drawText(title, { x: margin, y: yPos, size: 16, font: boldFont, color: rgb(0, 0, 0) });
    yPos -= 30;
  }

  for (const line of lines) {
    if (yPos < 50) {
      currentPage = pdfDoc.addPage([612, 792]);
      yPos = 750;
    }
    const displayLine = line.slice(0, 90);
    currentPage.drawText(displayLine, { x: margin, y: yPos, size: 10, font, color: rgb(0, 0, 0) });
    yPos -= lineHeight;
  }

  return pdfDoc.save();
}
