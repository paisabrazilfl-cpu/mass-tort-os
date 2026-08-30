import { validateEmail } from "../email-validator";

const testEmails = [
  "john.doe@gmail.com",
  "jane.smith@gnail.com",
  "user@tempmail.com",
  "invalid-email-at-domain.com",
  "test@example.com",
  "alice@yahoo.con",
  "bob.builder+work@subdomain.co.uk",
  "fake@company.org",
  "noemail@domain.net",
  "user@yahoo.vom",
];

const iterations = 100000;

console.log(`Running email-validator benchmark with ${iterations} iterations per email (${testEmails.length * iterations} total calls)...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  for (const email of testEmails) {
    validateEmail(email);
  }
}
const totalMs = performance.now() - start;
const totalCalls = iterations * testEmails.length;

console.log(`Total duration: ${totalMs.toFixed(2)}ms`);
console.log(`Average latency per call: ${(totalMs / totalCalls * 1000).toFixed(4)}us`);
