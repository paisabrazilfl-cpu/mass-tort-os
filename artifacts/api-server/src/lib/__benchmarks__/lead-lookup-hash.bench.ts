import { leadLookupHash } from "../lead-lookup-hash";

const tortType = "camp_lejeune";
const email = "  Jane.Doe@Example.com  ";
const phone = "+1 (555) 019-2834";

const iterations = 500000;

console.log(`Running leadLookupHash benchmark with ${iterations} iterations...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  leadLookupHash(tortType, email, phone);
}
const end = performance.now();

console.log(`leadLookupHash: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
