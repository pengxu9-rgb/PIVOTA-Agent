import fs from "fs";
import path from "path";
import { z } from "zod";

import { runAdjustmentRulesUS } from "../../src/layer2/personalization/rules/runAdjustmentRulesUS";
import {
  rephraseAdjustments,
  renderAdjustmentFromSkeleton,
  validateNoNewFactsOrIdentity,
} from "../../src/layer2/personalization/rephraseAdjustments";
import { AdjustmentSkeletonV0Schema } from "../../src/layer2/schemas/adjustmentSkeletonV0";
import { LlmProvider } from "../../src/llm/provider";
import { loadTechniqueKBUS } from "../../src/layer2/kb/loadTechniqueKBUS";
import { renderSkeletonFromKB } from "../../src/layer2/personalization/renderSkeletonFromKB";

function loadFixture(name: string) {
  const p = path.join(__dirname, "..", "fixtures", "layer2", name);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

describe("Layer2 US adjustment rules-first", () => {
  test("runAdjustmentRulesUS returns base/eye/lip skeletons with evidenceKeys and ruleId", () => {
    const fixture = loadFixture("us_adjustments_rules_input.json");
    delete process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT;
    const skeletons = runAdjustmentRulesUS({
      userFaceProfile: fixture.userFaceProfile,
      refFaceProfile: fixture.refFaceProfile,
      similarityReport: fixture.similarityReport,
      lookSpec: fixture.lookSpec,
      preferenceMode: "structure",
    });

    expect(skeletons.length).toBeGreaterThanOrEqual(3);
    expect(new Set(skeletons.map((s) => s.impactArea))).toEqual(new Set(["base", "eye", "lip"]));
    for (const s of skeletons) {
      const parsed = AdjustmentSkeletonV0Schema.parse(s);
      expect(parsed.ruleId).toBeTruthy();
      expect(parsed.evidenceKeys.length).toBeGreaterThan(0);
      expect(parsed.doActionIds?.length).toBeGreaterThan(0);
    }

    expect(skeletons).toMatchSnapshot();
  });

  test("rephraseAdjustments accepts valid LLM output and passes validator", async () => {
    const fixture = loadFixture("us_adjustments_rules_input.json");
    const rawSkeletons = runAdjustmentRulesUS({
      userFaceProfile: fixture.userFaceProfile,
      refFaceProfile: fixture.refFaceProfile,
      similarityReport: fixture.similarityReport,
      lookSpec: fixture.lookSpec,
      preferenceMode: "structure",
    });

    const kb = loadTechniqueKBUS();
    const rendered = renderSkeletonFromKB(rawSkeletons, kb, {
      userFaceProfile: fixture.userFaceProfile,
      refFaceProfile: fixture.refFaceProfile,
      similarityReport: fixture.similarityReport,
      lookSpec: fixture.lookSpec,
      preferenceMode: "structure",
    });
    const skeletons = rendered.skeletons;

    const allowedEvidenceByArea = Object.fromEntries(skeletons.map((s) => [s.impactArea, s.evidenceKeys])) as Record<
      string,
      string[]
    >;

    const firstSentence = (text: string): string => {
      const s = String(text || "").trim();
      if (!s) return s;
      const idx = s.search(/[.!?;\n]/);
      if (idx === -1) return s;
      return s.slice(0, idx + 1).trim();
    };

    const provider: LlmProvider = {
      analyzeImageToJson: async () => {
        throw new Error("not used");
      },
      analyzeTextToJson: async <TSchema extends z.ZodTypeAny>({ schema }: { schema: TSchema }) =>
        schema.parse({
          adjustments: skeletons.map((s) => ({
            impactArea: s.impactArea,
            ruleId: s.ruleId,
            title: "Safe paraphrase",
            because: s.becauseFacts.join(" "),
            do: s.doActions.map((step) => firstSentence(step)).join(" "),
            why: s.whyMechanism.join(" "),
            confidence: s.confidence,
            evidence: [allowedEvidenceByArea[s.impactArea]?.[0] ?? s.evidenceKeys[0]],
          })),
        }) as z.infer<TSchema>,
    };

    const out = await rephraseAdjustments({ market: "US", locale: "en", skeletons, provider });
    expect(out.usedFallback).toBe(false);
    expect(out.adjustments).toHaveLength(3);
    expect(validateNoNewFactsOrIdentity(skeletons, out.adjustments).ok).toBe(true);
  });

  test("rephraseAdjustments falls back when LLM adds identity language", async () => {
    const fixture = loadFixture("us_adjustments_rules_input.json");
    const rawSkeletons = runAdjustmentRulesUS({
      userFaceProfile: fixture.userFaceProfile,
      refFaceProfile: fixture.refFaceProfile,
      similarityReport: fixture.similarityReport,
      lookSpec: fixture.lookSpec,
      preferenceMode: "structure",
    });

    const kb = loadTechniqueKBUS();
    const rendered = renderSkeletonFromKB(rawSkeletons, kb, {
      userFaceProfile: fixture.userFaceProfile,
      refFaceProfile: fixture.refFaceProfile,
      similarityReport: fixture.similarityReport,
      lookSpec: fixture.lookSpec,
      preferenceMode: "structure",
    });
    const skeletons = rendered.skeletons;

    const provider: LlmProvider = {
      analyzeImageToJson: async () => {
        throw new Error("not used");
      },
      analyzeTextToJson: async <TSchema extends z.ZodTypeAny>({ schema }: { schema: TSchema }) =>
        schema.parse({
          adjustments: skeletons.map((s) => ({
            impactArea: s.impactArea,
            ruleId: s.ruleId,
            title: "Bad output",
            because: "You look like a celebrity.",
            do: s.doActions.join(" "),
            why: s.whyMechanism.join(" "),
            confidence: s.confidence,
            evidence: [s.evidenceKeys[0]],
          })),
        }) as z.infer<TSchema>,
    };

    const out = await rephraseAdjustments({ market: "US", locale: "en", skeletons, provider });
    expect(out.usedFallback).toBe(true);
    expect(out.adjustments).toEqual(skeletons.map(renderAdjustmentFromSkeleton));
  });
});
