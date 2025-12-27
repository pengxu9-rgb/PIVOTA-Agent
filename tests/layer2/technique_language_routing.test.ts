import { matchTechniques } from "../../src/layer2/kb/evalTechniqueTriggers";
import { TechniqueCardV0Schema } from "../../src/layer2/schemas/techniqueCardV0";
import { resolveTechniqueCardForLanguage } from "../../src/layer2/kb/resolveTechniqueCardForLanguage";

function makeCard(partial: any) {
  return TechniqueCardV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    id: "T_TEST",
    area: "eye",
    difficulty: "easy",
    triggers: {},
    actionTemplate: { title: "Test", steps: ["Step one.", "Step two."] },
    rationaleTemplate: ["Why."],
    ...partial,
  });
}

describe("Technique KB language routing via triggers.preferenceMode", () => {
  test("evaluator supports preferenceMode eq/in/exists", () => {
    const zhOnly = makeCard({
      id: "T_TEST_ZH",
      triggers: { all: [{ key: "preferenceMode", op: "eq", value: "zh" }] },
    });
    const inBoth = makeCard({
      id: "T_TEST_BOTH",
      triggers: { all: [{ key: "preferenceMode", op: "in", value: ["zh", "en"] }] },
    });
    const existsAny = makeCard({
      id: "T_TEST_EXISTS",
      triggers: { all: [{ key: "preferenceMode", op: "exists" }] },
    });

    const baseCtx = { lookSpec: { breakdown: {} }, userFaceProfile: null, refFaceProfile: null, similarityReport: null };

    expect(matchTechniques({ ...baseCtx, preferenceMode: "zh" }, [zhOnly]).map((c) => c.id)).toEqual(["T_TEST_ZH"]);
    expect(matchTechniques({ ...baseCtx, preferenceMode: "en" }, [zhOnly]).map((c) => c.id)).toEqual([]);

    expect(matchTechniques({ ...baseCtx, preferenceMode: "zh" }, [inBoth]).map((c) => c.id)).toEqual(["T_TEST_BOTH"]);
    expect(matchTechniques({ ...baseCtx, preferenceMode: "en" }, [inBoth]).map((c) => c.id)).toEqual(["T_TEST_BOTH"]);

    expect(matchTechniques({ ...baseCtx, preferenceMode: "zh" }, [existsAny]).map((c) => c.id)).toEqual(["T_TEST_EXISTS"]);
    expect(matchTechniques({ ...baseCtx, preferenceMode: "en" }, [existsAny]).map((c) => c.id)).toEqual(["T_TEST_EXISTS"]);
  });

  test("resolveTechniqueCardForLanguage picks -zh for zh locale and -en for en locale", () => {
    const zh = makeCard({
      id: "T_TEST_ACTION-zh",
      triggers: { all: [{ key: "preferenceMode", op: "eq", value: "zh" }] },
      actionTemplate: { title: "中文", steps: ["步骤一。", "步骤二。"] },
    });
    const en = makeCard({
      id: "T_TEST_ACTION-en",
      triggers: { all: [{ key: "preferenceMode", op: "eq", value: "en" }] },
      actionTemplate: { title: "English", steps: ["Step one.", "Step two."] },
    });
    const kb = { byId: new Map([[zh.id, zh], [en.id, en]]), list: [zh, en] } as any;

    expect(resolveTechniqueCardForLanguage({ id: "T_TEST_ACTION", kb, locale: "zh-CN" }).resolvedId).toBe("T_TEST_ACTION-zh");
    expect(resolveTechniqueCardForLanguage({ id: "T_TEST_ACTION", kb, locale: "en-US" }).resolvedId).toBe("T_TEST_ACTION-en");
  });

  test("fallback: zh user falls back to -en when -zh card missing", () => {
    const en = makeCard({
      id: "T_TEST_FALLBACK-en",
      triggers: { all: [{ key: "preferenceMode", op: "eq", value: "en" }] },
      actionTemplate: { title: "English", steps: ["Step one.", "Step two."] },
    });
    const kb = { byId: new Map([[en.id, en]]), list: [en] } as any;

    const out = resolveTechniqueCardForLanguage({ id: "T_TEST_FALLBACK", kb, locale: "zh" });
    expect(out.resolvedId).toBe("T_TEST_FALLBACK-en");
    expect(out.usedFallbackLanguage).toBe(true);
  });
});

