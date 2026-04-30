import { logger } from "./logger";

// pdf-lib is heavy (~830 KB with transitives). Loaded on demand inside
// redactPdf() so the API server boot doesn't pay for it on routes that
// never redact a PDF. Externalized in build.mjs.
type PdfLib = typeof import("pdf-lib");
let pdfLibModule: PdfLib | undefined;
async function loadPdfLib(): Promise<PdfLib> {
  if (!pdfLibModule) pdfLibModule = await import("pdf-lib");
  return pdfLibModule;
}

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

// Sentinel thrown when a caller asks for a redaction mode the lib cannot
// honour (today: text-pattern rules, malformed region rules). Routes can
// catch this specifically and surface a 422 with a stable `code`, instead
// of letting it bubble up as a generic 500 — that's how the CRM client
// distinguishes "we couldn't do this" from "the server crashed".
export class RedactionNotImplementedError extends Error {
  readonly code = "redaction_not_implemented";
  constructor(message: string) {
    super(message);
    this.name = "RedactionNotImplementedError";
  }
}

export async function redactPdf(
  pdfBytes: Buffer | Uint8Array,
  rules: RedactionRule[]
): Promise<Uint8Array> {
  // Pre-flight ALL rules before mutating the PDF. Doing this up front means
  // a mixed batch (e.g. one valid region + one text rule) fails atomically:
  // either every rule applies cleanly or none do. Partial-success would be
  // a silent-pass-style honesty bug — the caller would think the file was
  // fully redacted when only half its rules ran.
  //
  // Refuse text-pattern rules. pdf-lib does not expose per-glyph text
  // extraction with bounding boxes, so we cannot honour a `type: "text"`
  // rule. The previous behaviour silently dropped these — a caller asking
  // for PII redaction got back an UNREDACTED PDF and a 200 OK, with no
  // indication nothing happened.
  const textRules = rules.filter((r) => r.type === "text");
  if (textRules.length > 0) {
    throw new RedactionNotImplementedError(
      `text-pattern redaction is not implemented (received ${textRules.length} text rule(s)). ` +
        `Use type: "region" with explicit x/y/width/height bounds, or extract text with bounding boxes ` +
        `via a dedicated PDF text-extraction toolchain before calling redactPdf().`,
    );
  }
  // Refuse malformed region rules. A region rule with no `page` was
  // previously skipped silently by `if (rule.type === "region" && rule.page !== undefined)`.
  // Same honesty problem as text rules: caller thinks redaction ran when
  // it didn't. x/y/w/h all fall back to defaults — those defaults are a
  // worse problem (they redact a 100×20 box at the page origin, which is
  // almost never what was intended) — so demand them explicitly too.
  const malformed = rules
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.type === "region")
    .filter(({ r }) => r.page === undefined || r.x === undefined || r.y === undefined || r.width === undefined || r.height === undefined);
  if (malformed.length > 0) {
    throw new RedactionNotImplementedError(
      `region redaction rules must include page, x, y, width, and height. ` +
        `Got ${malformed.length} malformed rule(s) at index(es) ${malformed.map(({ i }) => i).join(", ")}. ` +
        `Defaulting these would silently redact the wrong area of the PDF.`,
    );
  }

  const { PDFDocument, rgb, StandardFonts } = await loadPdfLib();
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    for (const rule of rules) {
      if (rule.type === "region" && rule.page !== undefined) {
        const pageIndex = Math.min(rule.page, pages.length - 1);
        const page = pages[pageIndex];
        // Coords are required by pre-flight above — non-null asserted for clarity.
        const x = rule.x!;
        const y = rule.y!;
        const w = rule.width!;
        const h = rule.height!;

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
    // Do NOT swallow RedactionNotImplementedError into a generic 500-equivalent.
    if (err instanceof RedactionNotImplementedError) throw err;
    logger.error({ err }, "PDF redaction failed");
    throw new Error("PDF redaction failed");
  }
}

export async function highlightPdfRegions(
  pdfBytes: Buffer | Uint8Array,
  highlights: { page: number; x: number; y: number; width: number; height: number; color?: string; label?: string }[]
): Promise<Uint8Array> {
  const { PDFDocument, rgb, StandardFonts } = await loadPdfLib();
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

// NOTE: a previous `createHipaaRedactedPdf(pdfBytes)` helper was removed in
// the lib audit (Task #41, defect #8). It built `type: "text"` rules from
// PII regexes and called `redactPdf`, which silently ignored every text rule
// — so the function returned an UNREDACTED PDF while pretending to be a
// HIPAA-safe redactor. Resurrecting this requires a real text-extraction
// toolchain (e.g. pdfjs glyph layout) that produces bounding boxes the
// region-based redactor can consume. Do not re-add a stub.

export async function getPdfPageCount(pdfBytes: Buffer | Uint8Array): Promise<number> {
  const { PDFDocument } = await loadPdfLib();
  const pdfDoc = await PDFDocument.load(pdfBytes);
  return pdfDoc.getPageCount();
}

export async function createBlankPdfWithText(text: string, title?: string): Promise<Uint8Array> {
  const { PDFDocument, rgb, StandardFonts } = await loadPdfLib();
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
