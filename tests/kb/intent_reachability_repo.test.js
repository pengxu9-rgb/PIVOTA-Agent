const { loadTechniqueKB } = require("../../src/layer2/kb/loadTechniqueKB");
const { loadIntentsV0 } = require("../../src/layer2/dicts/intents");
const { computeIntentTechniqueMappingReport } = require("../../src/layer2/kb/checkIntentTechniqueMapping");

describe("KB intent reachability (repo)", () => {
  test("intents_v0.json references only existing technique ids (US/JP)", () => {
    process.env.ENABLE_STARTER_KB = "0";

    const intents = loadIntentsV0();

    for (const market of ["US", "JP"]) {
      const kb = loadTechniqueKB(market);
      const report = computeIntentTechniqueMappingReport({
        market,
        intentsDict: intents,
        techniqueIds: new Set(kb.list.map((c) => c.id)),
      });
      expect(report.missingNonPlaceholderRefs).toBe(0);
    }
  });
});

