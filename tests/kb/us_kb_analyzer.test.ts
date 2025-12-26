import fs from "fs";
import path from "path";

import { OutcomeSampleV0Schema } from "../../src/telemetry/schemas/outcomeSampleV0";
import { analyzeKBHealthUS } from "../../src/kb/us/analyzeKBHealth";
import { replayOutcomeSampleUS } from "../../src/kb/us/replay";

function loadFixture() {
  const fixturePath = path.join(__dirname, "..", "fixtures", "kb", "us", "outcome_samples.jsonl");
  const raw = fs.readFileSync(fixturePath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => OutcomeSampleV0Schema.parse(JSON.parse(l)));
}

describe("KB analyzer (US)", () => {
  test("aggregates technique and rule metrics", () => {
    const samples = loadFixture();
    const summary = analyzeKBHealthUS(samples);
    expect(summary.market).toBe("US");
    expect(summary.totals.samples).toBe(samples.length);
    expect(summary.technique_metrics.length).toBeGreaterThan(0);
    expect(summary.rule_metrics.length).toBeGreaterThan(0);
    expect(summary.gap_candidates.length).toBeGreaterThan(0);
  });

  test("replay harness runs when replayContext is present", () => {
    const samples = loadFixture();
    const res = replayOutcomeSampleUS(samples[0]);
    expect(res.ok).toBe(true);
  });
});

