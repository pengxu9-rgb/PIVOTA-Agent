import type { OutcomeSampleV0 } from "../../telemetry/schemas/outcomeSampleV0";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { replayOutcomeSampleUS: replay } = require("./replay.js");

export function replayOutcomeSampleUS(sample: OutcomeSampleV0) {
  return replay(sample);
}

