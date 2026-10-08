import { normalizeFaxNumber as optNormalizeFaxNumber } from "../fax/normalize";

export interface NormalizedFax {
  ok: true;
  tenDigit: string;
  e164: string;
}
export interface NormalizedFaxError {
  ok: false;
  code: "empty" | "too_short" | "too_long" | "invalid_digits";
  message: string;
}

// Unoptimized original implementation for comparison benchmark
export function origNormalizeFaxNumber(raw: string | null | undefined): NormalizedFax | NormalizedFaxError {
  if (raw == null) return { ok: false, code: "empty", message: "Fax number is required." };
  const s = String(raw).trim();
  if (!s) return { ok: false, code: "empty", message: "Fax number is required." };

  const noExt = s.replace(/\s*(?:ext\.?|x|#)\s*\d+\s*$/i, "");
  let digits = noExt.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);

  if (digits.length < 10) {
    return { ok: false, code: "too_short", message: `Fax number must be 10 digits (got ${digits.length}).` };
  }
  if (digits.length > 10) {
    return { ok: false, code: "too_long", message: `Fax number must be 10 digits (got ${digits.length}).` };
  }
  if (digits[0] === "0" || digits[0] === "1") {
    return { ok: false, code: "invalid_digits", message: "Invalid area code." };
  }
  if (digits[3] === "0" || digits[3] === "1") {
    return { ok: false, code: "invalid_digits", message: "Invalid exchange code." };
  }
  if (/^(\d)\1+$/.test(digits)) {
    return { ok: false, code: "invalid_digits", message: "Fax number looks invalid." };
  }
  return { ok: true, tenDigit: digits, e164: `+1${digits}` };
}

const sampleInputs = [
  "(614) 455-2138",
  "614.455.2138 ext 2",
  "+1 614 455 2138",
  "16144552138",
  "6144552138",
  "(800) 555-0199 #101",
  "invalid-fax-123",
  "1111111111",
  "",
  "  +1 (888) 123-4567 x 12  "
];

function runBench(iterations = 1000000) {
  // Equivalence check
  for (const input of sampleInputs) {
    const orig = origNormalizeFaxNumber(input);
    const opt = optNormalizeFaxNumber(input);
    if (JSON.stringify(orig) !== JSON.stringify(opt)) {
      console.error(`Mismatch for input: "${input}"`, orig, opt);
      process.exit(1);
    }
  }

  // Warmup
  for (let i = 0; i < 10000; i++) {
    for (const input of sampleInputs) {
      origNormalizeFaxNumber(input);
      optNormalizeFaxNumber(input);
    }
  }

  let start = performance.now();
  for (let i = 0; i < iterations; i++) {
    for (const input of sampleInputs) {
      origNormalizeFaxNumber(input);
    }
  }
  let end = performance.now();
  const origMs = end - start;

  start = performance.now();
  for (let i = 0; i < iterations; i++) {
    for (const input of sampleInputs) {
      optNormalizeFaxNumber(input);
    }
  }
  end = performance.now();
  const optMs = end - start;

  const totalCalls = iterations * sampleInputs.length;
  console.log(`Original:  ${origMs.toFixed(2)} ms (${(origMs / totalCalls * 1000).toFixed(4)} µs/call)`);
  console.log(`Optimized: ${optMs.toFixed(2)} ms (${(optMs / totalCalls * 1000).toFixed(4)} µs/call)`);
  console.log(`Speedup: ${(origMs / optMs).toFixed(2)}x (${((1 - optMs / origMs) * 100).toFixed(1)}% latency reduction)`);
}

runBench();
