// Intentionally require the JS module to avoid TS declaration drift for scripts/_utils.
// This test only validates deterministic behavior of the pure functions.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractMacroIds, extractNeedsChange, extractSlotEmits, percentile, summarizeRuns } = require("../../scripts/_utils/geminiEvalReport");

describe("geminiEvalReport", () => {
  test("percentile: empty returns null", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  test("percentile: single element returns that element", () => {
    expect(percentile([123], 0.5)).toBe(123);
    expect(percentile([123], 0.95)).toBe(123);
  });

  test("percentile: deterministic p50/p95", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 6);
  });

  test("extractNeedsChange: missing fields => false", () => {
    expect(extractNeedsChange(null)).toEqual({
      "eye.linerDirection": false,
      "base.finish": false,
      "base.coverage": false,
      "lip.finish": false,
      "prep.intent": false,
      "contour.intent": false,
      "brow.intent": false,
      "blush.intent": false,
    });
  });

  test("extractNeedsChange: reads expected paths", () => {
    const similarityReport = {
      lookDiff: {
        eye: { linerDirection: { needsChange: true } },
        base: { finish: { needsChange: true }, coverage: { needsChange: false } },
        lip: { finish: { needsChange: true } },
        prep: { intent: { needsChange: false } },
        contour: { intent: { needsChange: true } },
        brow: { intent: { needsChange: false } },
        blush: { intent: { needsChange: true } },
      },
    };
    const out = extractNeedsChange(similarityReport);
    expect(out["eye.linerDirection"]).toBe(true);
    expect(out["base.finish"]).toBe(true);
    expect(out["base.coverage"]).toBe(false);
    expect(out["lip.finish"]).toBe(true);
    expect(out["contour.intent"]).toBe(true);
    expect(out["blush.intent"]).toBe(true);
  });

  test("extractSlotEmits: detects ruleIds", () => {
    const skeletons = [
      { ruleId: "EYE_LINER_ACTIVITY_SLOT" },
      { ruleId: "BASE_ACTIVITY_SLOT" },
      { ruleId: "NOT_A_SLOT" },
    ];
    const out = extractSlotEmits(skeletons);
    expect(out.EYE_LINER_ACTIVITY_SLOT).toBe(true);
    expect(out.BASE_ACTIVITY_SLOT).toBe(true);
    expect(out.LIP_ACTIVITY_SLOT).toBe(false);
  });

  test("extractMacroIds: stable de-dupe and filters US_*", () => {
    const result = {
      techniqueRefs: [{ id: "US_eye_liner_daily_upwing_01-en" }, { id: "US_eye_liner_daily_upwing_01-en" }, { id: "T_EYE_X" }],
    };
    expect(extractMacroIds(result)).toEqual(["US_eye_liner_daily_upwing_01-en"]);
  });

  test("summarizeRuns: outputs rates and counts without throwing", () => {
    const runs = [
      {
        ok: true,
        totalMs: 100,
        gemini: { reference: { okCount: 1, failCount: 0, lastErrorCode: null, latencyMs: 50 }, selfie: { okCount: 1, failCount: 0, lastErrorCode: null, latencyMs: 60 }, lookDiffSource: "gemini" },
        similarityReport: { lookDiff: { eye: { linerDirection: { needsChange: true } } } },
        skeletons: [{ ruleId: "EYE_LINER_ACTIVITY_SLOT" }],
        result: { techniqueRefs: [{ id: "US_eye_liner_daily_upwing_01-en" }] },
      },
      {
        ok: false,
        totalMs: 300,
        gemini: { reference: { okCount: 0, failCount: 1, lastErrorCode: "REQUEST_FAILED", latencyMs: 200 }, selfie: { okCount: 0, failCount: 0, lastErrorCode: null, latencyMs: null }, lookDiffSource: null },
        similarityReport: null,
        skeletons: [],
        result: { techniqueRefs: [] },
      },
    ];

    const summary = summarizeRuns(runs);
    expect(summary.n).toBe(2);
    expect(summary.okCount).toBe(1);
    expect(summary.okRate).toBe(0.5);
    expect(summary.totalMsP50).toBe(200);
    expect(summary.gemini.errorCodeCounts.REQUEST_FAILED).toBe(1);
    expect(summary.needsChangeRates["eye.linerDirection"]).toBe(0.5);
    expect(summary.slotEmitRates.EYE_LINER_ACTIVITY_SLOT).toBe(0.5);
    expect(summary.macroIdCounts.uniqueCount).toBe(1);
  });
});
