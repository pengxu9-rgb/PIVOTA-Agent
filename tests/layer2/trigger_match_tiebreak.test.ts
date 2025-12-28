import { renderSkeletonFromKB } from "../../src/layer2/personalization/renderSkeletonFromKB";

function buildCard(input: { id: string }) {
  return {
    schemaVersion: "v0",
    market: "US",
    id: input.id,
    area: "base",
    difficulty: "easy",
    triggers: { all: [{ key: "lookSpec.breakdown.base.finish", op: "exists" }] },
    actionTemplate: { title: "t", steps: ["s1"] },
    rationaleTemplate: ["r"],
  };
}

describe("trigger matching tie-break", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  test("when scores tie, prefers doActionIds (candidate) order over lexicographic id", () => {
    process.env.LAYER2_ENABLE_TRIGGER_MATCHING = "1";

    const cardB = buildCard({ id: "B_card" });
    const cardA = buildCard({ id: "A_card" });

    const kb: any = {
      byId: new Map([
        [cardB.id, cardB],
        [cardA.id, cardA],
        ["T_EYE_1", { ...buildCard({ id: "T_EYE_1" }), area: "eye" }],
        ["T_LIP_1", { ...buildCard({ id: "T_LIP_1" }), area: "lip" }],
      ]),
      list: [cardB, cardA],
    };

    const baseSkeleton: any = {
      schemaVersion: "v0",
      market: "US",
      impactArea: "base",
      ruleId: "TEST_BASE",
      severity: 0.1,
      confidence: "low",
      becauseFacts: ["x"],
      doActionSelection: "choose_one",
      doActionIds: [cardB.id, cardA.id],
      doActions: [],
      whyMechanism: ["x"],
      evidenceKeys: ["x"],
      tags: ["x"],
    };

    const eyeSkeleton: any = {
      schemaVersion: "v0",
      market: "US",
      impactArea: "eye",
      ruleId: "TEST_EYE",
      severity: 0.1,
      confidence: "low",
      becauseFacts: ["x"],
      doActionIds: ["T_EYE_1"],
      doActions: [],
      whyMechanism: ["x"],
      evidenceKeys: ["x"],
      tags: ["x"],
    };

    const lipSkeleton: any = {
      schemaVersion: "v0",
      market: "US",
      impactArea: "lip",
      ruleId: "TEST_LIP",
      severity: 0.1,
      confidence: "low",
      becauseFacts: ["x"],
      doActionIds: ["T_LIP_1"],
      doActions: [],
      whyMechanism: ["x"],
      evidenceKeys: ["x"],
      tags: ["x"],
    };

    const out = renderSkeletonFromKB([baseSkeleton, eyeSkeleton, lipSkeleton], kb, {
      market: "US",
      locale: "en-US",
      preferenceMode: "structure",
      lookSpec: { breakdown: { base: { finish: "matte" } } },
    } as any);

    expect(out.skeletons[0].techniqueRefs?.map((r) => r.id)).toEqual(["B_card"]);
  });
});

