const { loadTechniqueKBUS } = require("../../src/layer2/kb/loadTechniqueKBUS");
const { getTechniqueIdsForIntent } = require("../../src/layer2/dicts/intents");
const { matchTechniques } = require("../../src/layer2/kb/evalTechniqueTriggers");
const { selectBestTechniqueId } = require("../../src/layer2/kb/triggerMatchSelection");

function resolveCards(kb, ids) {
  return ids.map((id) => kb.byId.get(id)).filter(Boolean);
}

describe("Activity pick trigger selection stability", () => {
  test("preferenceMode default does not affect non-preference triggers", () => {
    const card = {
      id: "T_TEST_NO_PREF",
      triggers: {
        all: [{ key: "lookSpec.breakdown.base.finish", op: "eq", value: "matte" }],
      },
    };

    const ctxNoPref = { lookSpec: { breakdown: { base: { finish: "matte" } } } };
    const ctxStructure = { ...ctxNoPref, preferenceMode: "structure" };

    expect(matchTechniques(ctxNoPref, [card]).map((c) => c.id)).toEqual(["T_TEST_NO_PREF"]);
    expect(matchTechniques(ctxStructure, [card]).map((c) => c.id)).toEqual(["T_TEST_NO_PREF"]);
  });

  test("EYE_LINER_ACTIVITY_PICK selects deterministically for direction=up", () => {
    const kb = loadTechniqueKBUS();
    const doActionIds = getTechniqueIdsForIntent("EYE_LINER_ACTIVITY_PICK", "US");
    expect(Array.isArray(doActionIds)).toBe(true);
    expect(doActionIds.length).toBeGreaterThan(0);

    const cards = resolveCards(kb, doActionIds);
    const ctx = {
      preferenceMode: "structure",
      lookSpec: { breakdown: { eye: { linerDirection: { direction: "up" } } } },
    };

    const matched = matchTechniques(ctx, cards).map((c) => c.id);
    expect(matched.length).toBeGreaterThan(0);

    const { selectedId } = selectBestTechniqueId({ ctx, cards, fallbackId: doActionIds[0] });
    expect(selectedId).toBeTruthy();
    expect(matched.includes(selectedId)).toBe(true);

    const runs = 25;
    for (let i = 0; i < runs; i += 1) {
      const out = selectBestTechniqueId({ ctx, cards, fallbackId: doActionIds[0] });
      expect(out.selectedId).toBe(selectedId);
    }
  });

  test("EYE_LINER_ACTIVITY_PICK: missing preferenceMode defaults to structure (does not degrade to candidates[0])", () => {
    const kb = loadTechniqueKBUS();
    const doActionIds = getTechniqueIdsForIntent("EYE_LINER_ACTIVITY_PICK", "US");
    expect(Array.isArray(doActionIds)).toBe(true);
    expect(doActionIds.length).toBeGreaterThan(0);

    const cards = resolveCards(kb, doActionIds);
    const ctx = {
      lookSpec: { breakdown: { eye: { linerDirection: { direction: "up" } } } },
    };

    const { selectedId } = selectBestTechniqueId({ ctx, cards, fallbackId: doActionIds[0] });
    expect(selectedId).toBe("US_eye_liner_winged_western_01-en");
  });

  test("BASE_BUILD_COVERAGE_SPOT_ACTIVITY_PICK selects deterministically for finish=matte", () => {
    const kb = loadTechniqueKBUS();
    const doActionIds = getTechniqueIdsForIntent("BASE_BUILD_COVERAGE_SPOT_ACTIVITY_PICK", "US");
    expect(Array.isArray(doActionIds)).toBe(true);
    expect(doActionIds.length).toBeGreaterThan(0);

    const cards = resolveCards(kb, doActionIds);
    const ctx = {
      preferenceMode: "structure",
      lookSpec: { breakdown: { base: { finish: "matte", coverage: "full" } } },
    };

    const matched = matchTechniques(ctx, cards).map((c) => c.id);
    expect(matched.length).toBeGreaterThan(0);

    const { selectedId } = selectBestTechniqueId({ ctx, cards, fallbackId: doActionIds[0] });
    expect(selectedId).toBeTruthy();
    expect(matched.includes(selectedId)).toBe(true);

    const runs = 25;
    for (let i = 0; i < runs; i += 1) {
      const out = selectBestTechniqueId({ ctx, cards, fallbackId: doActionIds[0] });
      expect(out.selectedId).toBe(selectedId);
    }
  });
});
