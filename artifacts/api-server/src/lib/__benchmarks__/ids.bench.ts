import { scanValue, deepScan } from "../ids";

const largeObject = {
  user: {
    id: 123,
    name: "John Doe",
    email: "john@example.com",
    bio: "I am a software engineer and I like to write code. Sometimes I write SQL: SELECT * FROM users;",
    preferences: {
      theme: "dark",
      notifications: {
        email: true,
        sms: false
      }
    }
  },
  data: Array.from({ length: 100 }, (_, i) => ({
    id: i,
    value: `some value ${i}`,
    nested: {
      more: "data",
      even: "more"
    }
  }))
};

const iterations = 500;

function benchmark() {
  console.log("Starting benchmark...");

  // Warmup
  for (let i = 0; i < 50; i++) {
    deepScan(largeObject);
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    deepScan(largeObject);
  }
  const end = performance.now();

  console.log(`deepScan took ${((end - start) / iterations).toFixed(4)}ms per call on average.`);

  const startScan = performance.now();
  const sqlValue = "SELECT * FROM users WHERE id = 1 OR 1=1";
  for (let i = 0; i < iterations * 10; i++) {
    scanValue(sqlValue);
  }
  const endScan = performance.now();
  console.log(`scanValue (match) took ${((endScan - startScan) / (iterations * 10)).toFixed(4)}ms per call on average.`);

  const startNoMatch = performance.now();
  const normalValue = "This is a normal string with no threats in it.";
  for (let i = 0; i < iterations * 10; i++) {
    scanValue(normalValue);
  }
  const endNoMatch = performance.now();
  console.log(`scanValue (no match) took ${((endNoMatch - startNoMatch) / (iterations * 10)).toFixed(4)}ms per call on average.`);
}

benchmark();
