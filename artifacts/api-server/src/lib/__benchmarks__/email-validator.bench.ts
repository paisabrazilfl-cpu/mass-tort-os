import { validateEmail } from "../email-validator";

const TEST_EMAILS = [
  "john.doe@gmail.com",
  "jane.smith@gnail.com",
  "robert.johnson@yahoo.com",
  "alex.smith@mailinator.com",
  "user.test@domain.con",
  "test@company.org",
  "invalid-email-address",
  "user@gmaill.com",
  "contact@outlook.com",
  "fake@provider.net",
];

const iterations = 500000;

console.log(`Running email-validator benchmark with ${iterations} iterations (${TEST_EMAILS.length} emails per loop)...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  const email = TEST_EMAILS[i % TEST_EMAILS.length];
  validateEmail(email);
}
const end = performance.now();

const totalTimeMs = end - start;
const totalValidations = iterations;
const avgPerCallMs = totalTimeMs / totalValidations;

console.log(`Total time: ${totalTimeMs.toFixed(2)} ms`);
console.log(`Average time per validateEmail call: ${(avgPerCallMs * 1000).toFixed(4)} µs`);
console.log(`Throughput: ${Math.round(totalValidations / (totalTimeMs / 1000))} ops/sec`);
