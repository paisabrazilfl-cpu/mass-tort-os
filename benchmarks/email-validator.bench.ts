import { validateEmail } from "../artifacts/api-server/src/lib/email-validator";

const emails = [
  "test@gmail.com",
  "user@yahoo.com",
  "invalid-email",
  "someone@tempmail.com",
  "fake@fake.com",
  "dr.smith@medical.org",
  "a@b.com",
  "very.long.email.address.that.is.quite.long@some.domain.com"
];

const iterations = 100000;

console.log(`Running email validation benchmarks with ${iterations} iterations...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  for (const email of emails) {
    validateEmail(email);
  }
}
const end = performance.now();

console.log(`Total time: ${(end - start).toFixed(4)}ms`);
console.log(`Avg time per call: ${((end - start) / (iterations * emails.length)).toFixed(6)}ms`);
