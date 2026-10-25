import {
  summarizeWebForm,
  getComprehensiveTortForm,
  getAllComprehensiveTortForms,
} from "../comprehensive-tort-forms";

const sampleForm = getComprehensiveTortForm("roundup")?.web_form_config;

const ITERATIONS_SUMMARIZE = 200_000;
const ITERATIONS_GET = 200_000;
const ITERATIONS_GET_ALL = 5_000;

console.log("Running comprehensive-tort-forms benchmark...\n");

// 1. Benchmark summarizeWebForm
const startSummarize = performance.now();
for (let i = 0; i < ITERATIONS_SUMMARIZE; i++) {
  summarizeWebForm(sampleForm);
}
const elapsedSummarize = performance.now() - startSummarize;
console.log(
  `summarizeWebForm (${ITERATIONS_SUMMARIZE.toLocaleString()} calls): ${elapsedSummarize.toFixed(2)}ms (${(
    (elapsedSummarize / ITERATIONS_SUMMARIZE) *
    1000
  ).toFixed(4)}µs/op)`
);

// 2. Benchmark getComprehensiveTortForm
const startGet = performance.now();
for (let i = 0; i < ITERATIONS_GET; i++) {
  getComprehensiveTortForm("roundup");
  getComprehensiveTortForm("camp-lejeune");
  getComprehensiveTortForm("non-existent");
}
const elapsedGet = performance.now() - startGet;
const totalGetCalls = ITERATIONS_GET * 3;
console.log(
  `getComprehensiveTortForm (${totalGetCalls.toLocaleString()} calls): ${elapsedGet.toFixed(2)}ms (${(
    (elapsedGet / totalGetCalls) *
    1000
  ).toFixed(4)}µs/op)`
);

// 3. Benchmark getAllComprehensiveTortForms
const startGetAll = performance.now();
for (let i = 0; i < ITERATIONS_GET_ALL; i++) {
  getAllComprehensiveTortForms();
}
const elapsedGetAll = performance.now() - startGetAll;
console.log(
  `getAllComprehensiveTortForms (${ITERATIONS_GET_ALL.toLocaleString()} calls): ${elapsedGetAll.toFixed(2)}ms (${(
    (elapsedGetAll / ITERATIONS_GET_ALL) *
    1000
  ).toFixed(4)}µs/op)`
);
