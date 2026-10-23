import { performance } from "perf_hooks";
import crypto from "crypto";
import { TORT_REGISTRY, TortDefinition } from "../tort-engine.js";
import { buildTortAgentPrompt } from "../voice/tort-agent-prompt.js";

const torts = Object.values(TORT_REGISTRY);

// Warmup
for (let i = 0; i < 1_000; i++) {
  for (const tort of torts) {
    buildTortAgentPrompt(tort);
  }
}

const ITERATIONS = 100_000;

const start = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  for (const tort of torts) {
    buildTortAgentPrompt(tort);
  }
}
const elapsed = performance.now() - start;
const totalCalls = ITERATIONS * torts.length;

console.log(`Execution time for ${totalCalls} calls: ${elapsed.toFixed(2)} ms`);
console.log(`Latency per call: ${((elapsed / totalCalls) * 1000).toFixed(4)} us (${(elapsed / totalCalls).toFixed(6)} ms)`);
console.log(`Throughput: ${(totalCalls / (elapsed / 1000)).toFixed(0)} ops/sec`);
