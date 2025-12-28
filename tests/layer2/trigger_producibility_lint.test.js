const { z } = require("zod");

const { buildTriggerProducibilityReport } = require("../../src/layer2/kb/triggerProducibility");

describe("KB trigger producibility lint", () => {
  test("categorizes producible vs unproducible keys and groups cards", () => {
    const kbCards = [
      {
        id: "card_ok",
        triggers: { all: [{ key: "lookSpec.breakdown.eye.intent", op: "exists" }] },
      },
      {
        id: "card_bad",
        triggers: { any: [{ key: "lookSpec.breakdown.eye.linerDirection.direction", op: "eq", value: "up" }] },
      },
    ];

    const lookSpecSchema = z
      .object({
        breakdown: z.object({ eye: z.object({ intent: z.string() }).strict() }).strict(),
      })
      .strict();

    const report = buildTriggerProducibilityReport({
      market: "US",
      kbCards,
      isTriggerKeyAllowed: () => true,
      allowUnproducibleKeys: [],
      rootSchemas: {
        lookSpec: [lookSpecSchema],
      },
    });

    expect(report.summary.kbCardCount).toBe(2);
    expect(report.summary.cardsWithTriggers).toBe(2);
    expect(report.summary.uniqueTriggerKeys).toBe(2);
    expect(report.summary.unproducibleKeysCount).toBe(1);
    expect(report.summary.cardsAffectedCount).toBe(1);

    const bad = report.unproducibleKeys.find((x) => x.key === "lookSpec.breakdown.eye.linerDirection.direction");
    expect(bad).toBeTruthy();
    expect(bad.cards).toEqual(["card_bad"]);
  });
});

