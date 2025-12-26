import fs from "fs";
import path from "path";

import { loadTechniqueKBUS } from "../../src/layer2/kb/loadTechniqueKBUS";
import { matchTechniques } from "../../src/layer2/kb/evalTechniqueTriggers";
import { runAdjustmentRulesUS } from "../../src/layer2/personalization/rules/runAdjustmentRulesUS";
import { renderSkeletonFromKB } from "../../src/layer2/personalization/renderSkeletonFromKB";

function loadFixture(name: string) {
  const p = path.join(__dirname, "..", "fixtures", "layer2", name);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

describe("Technique KB (US)", () => {
  test("loads and validates technique cards", () => {
    const kb = loadTechniqueKBUS();
    expect(kb.list.length).toBeGreaterThanOrEqual(20);
    expect(kb.byId.size).toEqual(kb.list.length);
    expect(kb.byId.get("T_BASE_THIN_LAYER")?.area).toBe("base");
  });

  test("trigger evaluator matches cards deterministically", () => {
    const kb = loadTechniqueKBUS();
    const ctx = {
      userFaceProfile: { geometry: { eyeOpennessRatio: 0.3 } },
      refFaceProfile: null,
      similarityReport: null,
      lookSpec: { breakdown: { lip: { finish: "glossy" } } },
      preferenceMode: "structure" as const,
    };
    const matched = matchTechniques(ctx, kb.list);
    expect(matched.some((c) => c.id === "T_EYE_TIGHTLINE_UPPER_LASHLINE")).toBe(true);
    expect(matched.some((c) => c.id === "T_LIP_GLOSS_CENTER")).toBe(true);
  });

  test("renderSkeletonFromKB expands doActionIds into doActions", () => {
    const kb = loadTechniqueKBUS();
    const skeletons = [
      {
        schemaVersion: "v0",
        market: "US",
        impactArea: "base",
        ruleId: "BASE_FALLBACK_THIN_LAYER",
        severity: 0.2,
        confidence: "low",
        becauseFacts: ["Because."],
        doActionIds: ["T_BASE_THIN_LAYER"],
        doActions: [],
        whyMechanism: ["Why."],
        evidenceKeys: ["lookSpec.breakdown.base.finish"],
      },
      {
        schemaVersion: "v0",
        market: "US",
        impactArea: "eye",
        ruleId: "EYE_FALLBACK_SAFE_CONTROL",
        severity: 0.2,
        confidence: "low",
        becauseFacts: ["Because."],
        doActionIds: ["T_EYE_WING_SHORTEN"],
        doActions: [],
        whyMechanism: ["Why."],
        evidenceKeys: ["lookSpec.breakdown.eye.intent"],
      },
      {
        schemaVersion: "v0",
        market: "US",
        impactArea: "lip",
        ruleId: "LIP_FALLBACK_FINISH_FOCUS",
        severity: 0.2,
        confidence: "low",
        becauseFacts: ["Because."],
        doActionIds: ["T_LIP_MATCH_FINISH"],
        doActions: [],
        whyMechanism: ["Why."],
        evidenceKeys: ["lookSpec.breakdown.lip.finish"],
      },
    ] as const;

    const out = renderSkeletonFromKB(skeletons as any, kb, {
      userFaceProfile: null,
      refFaceProfile: null,
      similarityReport: null,
      lookSpec: { breakdown: { base: {}, eye: {}, lip: {} } },
      preferenceMode: "structure",
    });
    expect(out.skeletons[0].doActions.length).toBeGreaterThan(0);
    expect(out.skeletons[0].techniqueRefs?.[0].id).toBe("T_BASE_THIN_LAYER");
  });

  test("missing technique id triggers fallback + warning", () => {
    const kb = loadTechniqueKBUS();
    const skeletons = [
      {
        schemaVersion: "v0",
        market: "US",
        impactArea: "base",
        ruleId: "BASE_FALLBACK_THIN_LAYER",
        severity: 0.2,
        confidence: "low",
        becauseFacts: ["Because."],
        doActionIds: ["T_DOES_NOT_EXIST"],
        doActions: [],
        whyMechanism: ["Why."],
        evidenceKeys: ["lookSpec.breakdown.base.finish"],
      },
      {
        schemaVersion: "v0",
        market: "US",
        impactArea: "eye",
        ruleId: "EYE_FALLBACK_SAFE_CONTROL",
        severity: 0.2,
        confidence: "low",
        becauseFacts: ["Because."],
        doActionIds: ["T_DOES_NOT_EXIST"],
        doActions: [],
        whyMechanism: ["Why."],
        evidenceKeys: ["lookSpec.breakdown.eye.intent"],
      },
      {
        schemaVersion: "v0",
        market: "US",
        impactArea: "lip",
        ruleId: "LIP_FALLBACK_FINISH_FOCUS",
        severity: 0.2,
        confidence: "low",
        becauseFacts: ["Because."],
        doActionIds: ["T_DOES_NOT_EXIST"],
        doActions: [],
        whyMechanism: ["Why."],
        evidenceKeys: ["lookSpec.breakdown.lip.finish"],
      },
    ] as const;

    const out = renderSkeletonFromKB(skeletons as any, kb, {
      userFaceProfile: null,
      refFaceProfile: null,
      similarityReport: null,
      lookSpec: { breakdown: { base: {}, eye: {}, lip: {} } },
      preferenceMode: "structure",
    });

    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.skeletons[0].doActions.length).toBeGreaterThan(0);
  });

  test("end-to-end rules -> render includes techniqueRefs", () => {
    const fixture = loadFixture("us_adjustments_rules_input.json");
    const kb = loadTechniqueKBUS();
    const skeletons = runAdjustmentRulesUS({
      userFaceProfile: fixture.userFaceProfile,
      refFaceProfile: fixture.refFaceProfile,
      similarityReport: fixture.similarityReport,
      lookSpec: fixture.lookSpec,
      preferenceMode: "structure",
    });
    const rendered = renderSkeletonFromKB(skeletons, kb, {
      userFaceProfile: fixture.userFaceProfile,
      refFaceProfile: fixture.refFaceProfile,
      similarityReport: fixture.similarityReport,
      lookSpec: fixture.lookSpec,
      preferenceMode: "structure",
    });
    expect(rendered.skeletons).toHaveLength(3);
    for (const s of rendered.skeletons) {
      expect(s.doActions.length).toBeGreaterThan(0);
      expect(s.techniqueRefs?.length).toBeGreaterThan(0);
    }
  });
});

