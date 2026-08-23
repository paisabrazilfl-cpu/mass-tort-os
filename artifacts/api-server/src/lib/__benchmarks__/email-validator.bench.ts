import { validateEmail } from "../email-validator";

const testEmails = [
  "john.doe@gmail.com",
  "jane.smith@yahoo.com",
  "test@gnail.com",
  "fake@tempmail.com",
  "user@outlook.con",
  "asdf@hotmail.com",
  "invalid-email-format",
  "legit.user@company.org",
];

const iterations = 100000;

console.log(`Running email-validator benchmarks with ${iterations} iterations across ${testEmails.length} test emails...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  for (const email of testEmails) {
    validateEmail(email);
  }
}
const end = performance.now();
const totalMs = end - start;
const totalCalls = iterations * testEmails.length;

console.log(`Total time: ${totalMs.toFixed(4)}ms`);
console.log(`Avg per batch: ${(totalMs / iterations).toFixed(6)}ms`);
console.log(`Avg per call: ${(totalMs / totalCalls * 1000).toFixed(4)}µs (${(totalMs / totalCalls).toFixed(6)}ms)`);
