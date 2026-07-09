import { scanValue, deepScan } from "../ids";

const safeValue = "This is a normal string with no security threats. It should be processed quickly.";
const sqlInjection = "SELECT * FROM users WHERE id = '1' OR '1'='1'--";
const xss = "<script>alert('xss');</script>";
const pathTraversal = "../../../../etc/passwd";
const commandInjection = "; cat /etc/passwd";

const iterations = 100000;

console.log(`Running IDS benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("scanValue (safe)", () => {
  scanValue(safeValue);
});

benchmark("scanValue (SQLi)", () => {
  scanValue(sqlInjection);
});

benchmark("scanValue (XSS)", () => {
  scanValue(xss);
});

const payload = {
  user: {
    name: "John Doe",
    email: "john@example.com",
    profile: {
      bio: "Just a regular user bio",
      nested: {
        key: "value",
        more: "data"
      }
    }
  },
  items: [
    { id: 1, name: "item 1" },
    { id: 2, name: "item 2" }
  ]
};

benchmark("deepScan (safe object)", () => {
  deepScan(payload);
});
