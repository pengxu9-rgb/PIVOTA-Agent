import type { OutcomeSampleV0 } from "../../telemetry/schemas/outcomeSampleV0";

// Keep the runtime implementation in JS (Node entrypoints use CommonJS).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { analyzeKBHealthUS: analyze } = require("./analyzeKBHealth.js");

export function analyzeKBHealthUS(samples: OutcomeSampleV0[]) {
  return analyze(samples);
}

