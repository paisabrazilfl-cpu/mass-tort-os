import { scanValue, deepScan } from "../ids";

const iterations = 100000;
const safeValue = "normal_value";
const suspiciousValue = "select * from users where 1=1";

console.log(`Running IDS benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

// We need to export scanValue in ids.ts to test it in isolation
// Let's check if it's exported.
benchmark("scanValue (safe)", () => {
  scanValue(safeValue);
});

benchmark("scanValue (suspicious)", () => {
  scanValue(suspiciousValue);
});

benchmark("deepScan (large object)", () => {
  deepScan({
    a: "safe",
    b: {
      c: "also safe",
      d: ["safe", "safe", "safe"],
      e: {
        f: "safe"
      }
    },
    g: "safe"
  });
});
