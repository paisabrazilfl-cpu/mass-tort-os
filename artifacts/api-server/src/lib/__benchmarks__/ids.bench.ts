import { scanValue, deepScan } from "../ids";

const iterations = 50000;

const SAFE_STRING = "This is a safe string with no threats.";
const SQLI_STRING = "SELECT * FROM users WHERE id = '1' OR '1'='1'";
const XSS_STRING = "<script>alert('XSS')</script>";
const PATH_TRAVERSAL = "../../../etc/passwd";
const CMD_INJECTION = "; cat /etc/passwd";

const DEEP_OBJECT = {
  a: "safe",
  b: {
    c: "also safe",
    d: [
      "still safe",
      {
        e: "SELECT * FROM secrets",
      }
    ]
  },
  f: "final safe string"
};

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
  scanValue(SAFE_STRING);
});

benchmark("scanValue (SQLi)", () => {
  scanValue(SQLI_STRING);
});

benchmark("scanValue (XSS)", () => {
  scanValue(XSS_STRING);
});

benchmark("scanValue (Path Traversal)", () => {
  scanValue(PATH_TRAVERSAL);
});

benchmark("scanValue (Cmd Injection)", () => {
  scanValue(CMD_INJECTION);
});

benchmark("deepScan (recursive object)", () => {
  deepScan(DEEP_OBJECT);
});
