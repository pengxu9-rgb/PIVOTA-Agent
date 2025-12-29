const { loadIntentsV0 } = require("../../src/layer2/dicts/intents");

describe("KB intent pool size guardrails", () => {
  test("EYE_LINER_ACTIVITY_PICK (US) candidate pool size is stable", () => {
    const dict = loadIntentsV0();
    const intent = (dict.intents || []).find((i) => i.id === "EYE_LINER_ACTIVITY_PICK");
    if (!intent) throw new Error("Missing intent: EYE_LINER_ACTIVITY_PICK");

    const ids = intent?.markets?.US?.techniqueIds;
    if (!Array.isArray(ids)) throw new Error("Invalid intents_v0.json: EYE_LINER_ACTIVITY_PICK.US.techniqueIds is not an array");

    const expected = 5;
    if (ids.length !== expected) {
      throw new Error(
        `EYE_LINER_ACTIVITY_PICK pool size changed (got=${ids.length}, expected=${expected}). Expanding/contracting pools requires updating this test and documenting why in the PR.`,
      );
    }
  });
});
