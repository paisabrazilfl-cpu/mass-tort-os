import { validateEmail } from "../email-validator";

const testEmails = [
  "john.doe@gmail.com",
  "jane.smith@gnail.com",
  "user@tempmail.com",
  "test@example.com",
  "invalid.email.without.at",
  "user@yahoo.con",
  "support@unknown-domain-12345.com",
  "alex@hotmail.com",
  "asdf12345@outlook.com",
  "someone@protonmail.com",
];

const ITERATIONS = 200_000;

console.time("validateEmail benchmark");
for (let i = 0; i < ITERATIONS; i++) {
  const email = testEmails[i % testEmails.length];
  validateEmail(email);
}
console.timeEnd("validateEmail benchmark");
