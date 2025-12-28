import { LookSpecV0Schema, normalizeLinerDirection } from "../../src/layer2/schemas/lookSpecV0";
import { normalizeLookSpecToV1 } from "../../src/layer2/schemas/lookSpecV1";

function baseLookSpecV0(overrides: any) {
  return LookSpecV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    locale: "en-US",
    layer2EngineVersion: "l2-us-0.1.0",
    layer3EngineVersion: "l3-us-0.1.0",
    orchestratorVersion: "orchestrator-us-0.1.0",
    lookTitle: "t",
    styleTags: [],
    breakdown: {
      base: { intent: "i", finish: "unknown", coverage: "unknown", keyNotes: [], evidence: [] },
      eye: { intent: "i", finish: "unknown", coverage: "unknown", keyNotes: [], evidence: [], ...overrides },
      lip: { intent: "i", finish: "unknown", coverage: "unknown", keyNotes: [], evidence: [] },
    },
    warnings: [],
  });
}

describe("normalizeLinerDirection", () => {
  test("maps synonyms and normalizes case", () => {
    expect(normalizeLinerDirection("UP")).toBe("up");
    expect(normalizeLinerDirection("upward")).toBe("up");
    expect(normalizeLinerDirection("Downward")).toBe("down");
    expect(normalizeLinerDirection("horizontal")).toBe("straight");
    expect(normalizeLinerDirection("flat")).toBe("straight");
    expect(normalizeLinerDirection("")).toBe("unknown");
    expect(normalizeLinerDirection(null)).toBe("unknown");
    expect(normalizeLinerDirection("斜め")).toBe("unknown");
  });

  test("does not drop linerDirection in V0->V1 normalize", () => {
    const v0 = baseLookSpecV0({ linerDirection: { direction: "UP" } });
    expect(v0.breakdown.eye.linerDirection.direction).toBe("up");

    const v1 = normalizeLookSpecToV1(v0);
    expect(v1.breakdown.eye.linerDirection.direction).toBe("up");
  });
});

