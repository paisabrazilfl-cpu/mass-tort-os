import { validateEmail } from "../email-validator";

const TEST_EMAILS = [
  "john.doe@gmail.com",
  "jane.smith@yahoo.com",
  "support@gnail.com",
  "user@tempmail.com",
  "test@example.com",
  "invalid-email-format",
  "claimant@outlook.com",
  "contact@hotmail.con",
  "alex@icloud.com",
  "info@protonmail.com",
];

const ITERATIONS = 100000;

console.log(`Running email validator benchmark with ${ITERATIONS} iterations across ${TEST_EMAILS.length} sample emails...`);

const start = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  for (const email of TEST_EMAILS) {
    validateEmail(email);
  }
}
const end = performance.now();
const totalCalls = ITERATIONS * TEST_EMAILS.length;

console.log(`Total time: ${(end - start).toFixed(4)}ms`);
console.log(`Average time per email validation: ${((end - start) / totalCalls).toFixed(6)}ms`);
