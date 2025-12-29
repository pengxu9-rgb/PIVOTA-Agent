const { loadTechniqueKB } = require("../../src/layer2/kb/loadTechniqueKB");
const { renderSkeletonFromKB } = require("../../src/layer2/personalization/renderSkeletonFromKB");

function hasCjk(text) {
  return /[\u4E00-\u9FFF]/.test(String(text || ""));
}

describe("renderSkeletonFromKB zh localization", () => {
  test("overrides becauseFacts/whyMechanism from zh technique rationale", () => {
    const kb = loadTechniqueKB("US");

    const base = {
      schemaVersion: "v0",
      market: "US",
      impactArea: "base",
      ruleId: "test_base_rule",
      severity: 0.5,
      confidence: "high",
      becauseFacts: ["english fact"],
      whyMechanism: ["english why"],
      evidenceKeys: ["lookSpec.breakdown.base.finish"],
      doActionIds: ["US_base_fix_caking_01-zh"],
    };

    const eye = {
      schemaVersion: "v0",
      market: "US",
      impactArea: "eye",
      ruleId: "test_eye_rule",
      severity: 0.5,
      confidence: "high",
      becauseFacts: ["english fact"],
      whyMechanism: ["english why"],
      evidenceKeys: ["lookSpec.breakdown.eye.intent"],
      doActionIds: ["US_eye_shadow_smoky_01-zh"],
    };

    const lip = {
      schemaVersion: "v0",
      market: "US",
      impactArea: "lip",
      ruleId: "test_lip_rule",
      severity: 0.5,
      confidence: "high",
      becauseFacts: ["english fact"],
      whyMechanism: ["english why"],
      evidenceKeys: ["lookSpec.breakdown.lip.finish"],
      doActionIds: ["US_lip_3d_center_gloss_01-zh"],
    };

    const out = renderSkeletonFromKB([base, eye, lip], kb, { market: "US", locale: "zh" });
    expect(out.skeletons).toHaveLength(3);

    for (const s of out.skeletons) {
      expect(s.becauseFacts).not.toContain("english fact");
      expect(s.whyMechanism).not.toContain("english why");
      expect(hasCjk(s.becauseFacts.join(" "))).toBe(true);
      expect(hasCjk(s.whyMechanism.join(" "))).toBe(true);
    }
  });
});

