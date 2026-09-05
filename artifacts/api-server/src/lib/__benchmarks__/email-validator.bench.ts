import { validateEmail } from "../email-validator";

const sampleEmails = [
  "john.doe@gmail.com",
  "user@tempmail.com",
  "gnail_user@gnail.com",
  "test@example.com",
  "invalid-email-format",
  "someone@yahoo.con",
  "fake@domain.org",
  "alice.smith@hotmail.com",
];

const iterations = 100000;

console.log(`Running email validator benchmark with ${iterations} iterations per sample...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  for (const email of sampleEmails) {
    validateEmail(email);
  }
}
const end = performance.now();
const totalMs = end - start;
const avgMs = totalMs / (iterations * sampleEmails.length);

console.log(`Total time: ${totalMs.toFixed(4)}ms`);
console.log(`Average per call: ${avgMs.toFixed(6)}ms`);
