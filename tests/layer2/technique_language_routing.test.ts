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

describe("Technique KB language routing", () => {
  test("evaluator supports preferenceMode eq/in/exists (non-language values)", () => {
    const zhOnly = makeCard({
      id: "T_TEST_STRUCTURE",
      triggers: { all: [{ key: "preferenceMode", op: "eq", value: "structure" }] },
    });
    const inBoth = makeCard({
      id: "T_TEST_BOTH",
      triggers: { all: [{ key: "preferenceMode", op: "in", value: ["structure", "ease"] }] },
    });
    const existsAny = makeCard({
      id: "T_TEST_EXISTS",
      triggers: { all: [{ key: "preferenceMode", op: "exists" }] },
    });

    const baseCtx = { lookSpec: { breakdown: {} }, userFaceProfile: null, refFaceProfile: null, similarityReport: null };

    expect(matchTechniques({ ...baseCtx, preferenceMode: "structure" }, [zhOnly]).map((c) => c.id)).toEqual(["T_TEST_STRUCTURE"]);
    expect(matchTechniques({ ...baseCtx, preferenceMode: "ease" }, [zhOnly]).map((c) => c.id)).toEqual([]);

    expect(matchTechniques({ ...baseCtx, preferenceMode: "structure" }, [inBoth]).map((c) => c.id)).toEqual(["T_TEST_BOTH"]);
    expect(matchTechniques({ ...baseCtx, preferenceMode: "ease" }, [inBoth]).map((c) => c.id)).toEqual(["T_TEST_BOTH"]);

    expect(matchTechniques({ ...baseCtx, preferenceMode: "structure" }, [existsAny]).map((c) => c.id)).toEqual(["T_TEST_EXISTS"]);
    expect(matchTechniques({ ...baseCtx, preferenceMode: "ease" }, [existsAny]).map((c) => c.id)).toEqual(["T_TEST_EXISTS"]);
  });

  test("resolveTechniqueCardForLanguage picks language by locale for base id", () => {
    const zh = makeCard({
      id: "T_TEST_ACTION-zh",
      triggers: {},
      actionTemplate: { title: "中文", steps: ["步骤一。", "步骤二。"] },
    });
    const en = makeCard({
      id: "T_TEST_ACTION-en",
      triggers: {},
      actionTemplate: { title: "English", steps: ["Step one.", "Step two."] },
    });
    const kb = { byId: new Map([[zh.id, zh], [en.id, en]]), list: [zh, en] } as any;

    expect(resolveTechniqueCardForLanguage({ id: "T_TEST_ACTION", kb, locale: "zh-CN" }).resolvedId).toBe("T_TEST_ACTION-zh");
    expect(resolveTechniqueCardForLanguage({ id: "T_TEST_ACTION", kb, locale: "en-US" }).resolvedId).toBe("T_TEST_ACTION-en");
  });

  test("swap: zh locale resolves -zh even when input id ends with -en", () => {
    const zh = makeCard({ id: "T_TEST_SWAP-zh", triggers: {} });
    const en = makeCard({ id: "T_TEST_SWAP-en", triggers: {} });
    const kb = { byId: new Map([[zh.id, zh], [en.id, en]]), list: [zh, en] } as any;

    const out = resolveTechniqueCardForLanguage({ id: "T_TEST_SWAP-en", kb, locale: "zh-CN" });
    expect(out.resolvedId).toBe("T_TEST_SWAP-zh");
    expect(out.usedFallbackLanguage).toBe(false);
  });

  test("swap: en locale resolves -en even when input id ends with -zh", () => {
    const zh = makeCard({ id: "T_TEST_SWAP2-zh", triggers: {} });
    const en = makeCard({ id: "T_TEST_SWAP2-en", triggers: {} });
    const kb = { byId: new Map([[zh.id, zh], [en.id, en]]), list: [zh, en] } as any;

    const out = resolveTechniqueCardForLanguage({ id: "T_TEST_SWAP2-zh", kb, locale: "en-US" });
    expect(out.resolvedId).toBe("T_TEST_SWAP2-en");
    expect(out.usedFallbackLanguage).toBe(false);
  });

  test("fallback: zh locale falls back to -en when -zh missing", () => {
    const en = makeCard({
      id: "T_TEST_FALLBACK-en",
      triggers: {},
      actionTemplate: { title: "English", steps: ["Step one.", "Step two."] },
    });
    const kb = { byId: new Map([[en.id, en]]), list: [en] } as any;

    const out = resolveTechniqueCardForLanguage({ id: "T_TEST_FALLBACK", kb, locale: "zh" });
    expect(out.resolvedId).toBe("T_TEST_FALLBACK-en");
    expect(out.usedFallbackLanguage).toBe(true);
  });
});
