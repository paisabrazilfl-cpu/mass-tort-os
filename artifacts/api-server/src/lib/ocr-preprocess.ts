/**
 * Fax image preprocessing for OCR accuracy.
 * Mirrors the OpenCV pipeline from the Python spec using Sharp:
 * 1. Grayscale conversion
 * 2. 2x upsample (Rx labels need detail)
 * 3. Sharpen (replaces CLAHE + median blur)
 * 4. Normalize contrast
 *
 * Sharp provides pre-compiled binaries — no build toolchain required.
 */
import { logger } from "./logger";

export async function preprocessFaxBuffer(input: Buffer): Promise<Buffer> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(input).metadata();
    const targetWidth = meta.width ? meta.width * 2 : undefined;
    const processed = await sharp(input)
      .grayscale()
      .resize({ width: targetWidth })
      .sharpen({ sigma: 1.5, m1: 0, m2: 3 })
      .normalize()
      .png()
      .toBuffer();

    logger.info(
      { inputBytes: input.length, outputBytes: processed.length },
      "Fax preprocessing complete"
    );

    return processed;
  } catch (err) {
    logger.warn({ err }, "Fax preprocessing failed — using raw input");
    return input;
  }
}

export function base64ToBuffer(base64: string): Buffer {
  const withoutHeader = base64.replace(/^data:image\/[a-z]+;base64,/, "");
  return Buffer.from(withoutHeader, "base64");
}

export function bufferToBase64(buf: Buffer, mimeType = "image/png"): string {
  return `data:${mimeType};base64,${buf.toString("base64")}`;
}

export function detectMimeType(base64: string): string {
  if (base64.startsWith("data:")) {
    const match = base64.match(/^data:([^;]+);/);
    return match ? match[1] : "image/png";
  }
  return "image/png";
}
