import { selectBestTechniqueId } from "../../src/layer2/kb/triggerMatchSelection";

describe("triggerMatchSelection", () => {
  test("prefers stricter (all) triggers over (any) when both match", () => {
    const ctx = {
      lookSpec: { breakdown: { base: { finish: "matte", coverage: "full" } } },
      preferenceMode: "structure",
    };

    const cards: any[] = [
      {
        id: "T_BASE_THIN_LAYER",
        triggers: { any: [{ key: "lookSpec.breakdown.base.coverage", op: "in", value: ["full"] }] },
      },
      {
        id: "US_base_fix_caking_01-en",
        triggers: { all: [{ key: "lookSpec.breakdown.base.finish", op: "exists" }] },
      },
    ];

    const out = selectBestTechniqueId({
      ctx: ctx as any,
      cards: cards as any,
      fallbackId: "T_BASE_THIN_LAYER",
    });

    expect(out.selectedId).toBe("US_base_fix_caking_01-en");
  });

  test("falls back to first candidate when none match", () => {
    const ctx = {
      lookSpec: { breakdown: { base: { finish: "matte", coverage: "sheer" } } },
      preferenceMode: "structure",
    };

    const cards: any[] = [
      {
        id: "T_BASE_THIN_LAYER",
        triggers: { any: [{ key: "lookSpec.breakdown.base.coverage", op: "in", value: ["full"] }] },
      },
      {
        id: "US_base_fix_caking_01-en",
        triggers: { all: [{ key: "lookSpec.breakdown.base.finish", op: "eq", value: "gloss" }] },
      },
    ];

    const out = selectBestTechniqueId({
      ctx: ctx as any,
      cards: cards as any,
      fallbackId: "T_BASE_THIN_LAYER",
    });

    expect(out.selectedId).toBe("T_BASE_THIN_LAYER");
  });

  test("deterministically breaks ties by candidate order", () => {
    const ctx = {
      lookSpec: { breakdown: { base: { finish: "matte" } } },
      preferenceMode: "structure",
    };

    const cards: any[] = [
      { id: "B_card", triggers: { all: [{ key: "lookSpec.breakdown.base.finish", op: "exists" }] } },
      { id: "A_card", triggers: { all: [{ key: "lookSpec.breakdown.base.finish", op: "exists" }] } },
    ];

    const out = selectBestTechniqueId({
      ctx: ctx as any,
      cards: cards as any,
      fallbackId: "B_card",
    });

    expect(out.selectedId).toBe("B_card");
  });
});
