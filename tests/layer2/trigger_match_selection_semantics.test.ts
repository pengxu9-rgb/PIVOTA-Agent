import { renderSkeletonFromKB } from "../../src/layer2/personalization/renderSkeletonFromKB";

function buildCard(input: {
  id: string;
  area: "prep" | "base" | "contour" | "brow" | "eye" | "blush" | "lip";
  triggers?: any;
}) {
  return {
    schemaVersion: "v0",
    market: "US",
    id: input.id,
    area: input.area,
    difficulty: "easy",
    triggers: input.triggers ?? {},
    actionTemplate: { title: "t", steps: ["s1"] },
    rationaleTemplate: ["r"],
  };
}

function buildKb(cards: any[]) {
  return {
    byId: new Map(cards.map((c) => [c.id, c])),
    list: cards,
  };
}

describe("renderSkeletonFromKB doActionIds semantics", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  test("default/sequence does NOT collapse multi-step doActionIds (even when trigger matching is ON)", () => {
    const baseIds = ["T_SEQ_1", "T_SEQ_2", "T_SEQ_3"];
    const cards = [
      ...baseIds.map((id) => buildCard({ id, area: "base" })),
      buildCard({ id: "T_EYE_1", area: "eye" }),
      buildCard({ id: "T_LIP_1", area: "lip" }),
    ];
    const kb = buildKb(cards);

    const baseSkeleton: any = {
      schemaVersion: "v0",
      market: "US",
      impactArea: "base",
      ruleId: "TEST_BASE",
      severity: 0.1,
      confidence: "low",
      becauseFacts: ["x"],
      doActionIds: baseIds,
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

    process.env.LAYER2_ENABLE_TRIGGER_MATCHING = "0";
    const outOff = renderSkeletonFromKB([baseSkeleton, eyeSkeleton, lipSkeleton], kb as any, {
      market: "US",
      locale: "en-US",
      preferenceMode: "structure",
      lookSpec: { breakdown: { base: { finish: "matte" } } },
    } as any);
    expect(outOff.skeletons[0].techniqueRefs?.map((r) => r.id)).toEqual(baseIds);

    process.env.LAYER2_ENABLE_TRIGGER_MATCHING = "1";
    const outOn = renderSkeletonFromKB([baseSkeleton, eyeSkeleton, lipSkeleton], kb as any, {
      market: "US",
      locale: "en-US",
      preferenceMode: "structure",
      lookSpec: { breakdown: { base: { finish: "matte" } } },
    } as any);
    expect(outOn.skeletons[0].techniqueRefs?.map((r) => r.id)).toEqual(baseIds);
  });

  test("choose_one renders exactly one technique; trigger matching ON can change which one", () => {
    const cardA = buildCard({
      id: "T_CHOOSE_A",
      area: "base",
      triggers: { all: [{ key: "lookSpec.breakdown.base.finish", op: "eq", value: "gloss" }] },
    });
    const cardB = buildCard({
      id: "T_CHOOSE_B",
      area: "base",
      triggers: { all: [{ key: "lookSpec.breakdown.base.finish", op: "exists" }] },
    });
    const cards = [cardA, cardB, buildCard({ id: "T_EYE_1", area: "eye" }), buildCard({ id: "T_LIP_1", area: "lip" })];
    const kb = buildKb(cards);

    const baseSkeleton: any = {
      schemaVersion: "v0",
      market: "US",
      impactArea: "base",
      ruleId: "TEST_BASE",
      severity: 0.1,
      confidence: "low",
      becauseFacts: ["x"],
      doActionSelection: "choose_one",
      doActionIds: [cardA.id, cardB.id],
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

    const ctx: any = {
      market: "US",
      locale: "en-US",
      preferenceMode: "structure",
      lookSpec: { breakdown: { base: { finish: "matte" } } },
    };

    process.env.LAYER2_ENABLE_TRIGGER_MATCHING = "0";
    const outOff = renderSkeletonFromKB([baseSkeleton, eyeSkeleton, lipSkeleton], kb as any, ctx);
    expect(outOff.skeletons[0].techniqueRefs?.map((r) => r.id)).toEqual([cardA.id]);

    process.env.LAYER2_ENABLE_TRIGGER_MATCHING = "1";
    const outOn = renderSkeletonFromKB([baseSkeleton, eyeSkeleton, lipSkeleton], kb as any, ctx);
    expect(outOn.skeletons[0].techniqueRefs?.map((r) => r.id)).toEqual([cardB.id]);
  });
});

