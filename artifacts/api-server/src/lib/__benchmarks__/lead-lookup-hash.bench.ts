import { leadLookupHash } from "../lead-lookup-hash";

const iterations = 100000;

console.log(`Running leadLookupHash benchmark with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("complete input (tort, email, phone)", () => {
  leadLookupHash("Camp Lejeune", "john.doe@example.com", "+1 (512) 555-0199");
});

benchmark("missing phone (partial input)", () => {
  leadLookupHash("Camp Lejeune", "john.doe@example.com", null);
});

benchmark("missing email (partial input)", () => {
  leadLookupHash("Camp Lejeune", null, "+1 (512) 555-0199");
});
