import { generateSecret, generateTOTP, verifyTOTP } from "../totp.js";

const secret = "HEE47IM3F4EBF2JKRATDKRBMCBMT3N65";
const token = generateTOTP(secret);

const iterations = 50000;

console.log(`Running TOTP benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  const totalMs = end - start;
  const avgUs = (totalMs / iterations) * 1000;
  const opsSec = Math.round((iterations / totalMs) * 1000);
  console.log(`${name}: ${totalMs.toFixed(2)}ms (total), ${avgUs.toFixed(3)}µs (avg), ${opsSec.toLocaleString()} ops/sec`);
}

benchmark("generateSecret", () => {
  generateSecret();
});

benchmark("generateTOTP", () => {
  generateTOTP(secret);
});

benchmark("verifyTOTP (valid code)", () => {
  verifyTOTP(secret, token);
});

benchmark("verifyTOTP (invalid code)", () => {
  verifyTOTP(secret, "999999");
});
