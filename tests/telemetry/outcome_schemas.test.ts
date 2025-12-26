import fs from "fs";
import path from "path";

import { OutcomeEventV0Schema } from "../../src/telemetry/schemas/outcomeEventV0";
import { OutcomeSampleV0Schema } from "../../src/telemetry/schemas/outcomeSampleV0";

describe("telemetry schemas", () => {
  test("OutcomeEventV0 parses a minimal event", () => {
    const parsed = OutcomeEventV0Schema.parse({
      schemaVersion: "v0",
      market: "US",
      jobId: "00000000-0000-0000-0000-000000000001",
      eventType: "rating",
      payload: { rating: 5 },
      createdAt: "2025-12-26T00:00:00.000Z",
    });
    expect(parsed.market).toBe("US");
  });

  test("OutcomeSampleV0 parses analyzer fixture lines", () => {
    const fixturePath = path.join(__dirname, "..", "fixtures", "kb", "us", "outcome_samples.jsonl");
    const raw = fs.readFileSync(fixturePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const obj = JSON.parse(line);
      const parsed = OutcomeSampleV0Schema.parse(obj);
      expect(parsed.market).toBe("US");
    }
  });
});

