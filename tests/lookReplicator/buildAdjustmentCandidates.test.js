const { buildAdjustmentCandidates } = require('../../src/lookReplicator/buildAdjustmentCandidates');
const crypto = require('crypto');

function makeRng(seq) {
  let i = 0;
  return () => {
    const v = seq[i] ?? 0.5;
    i += 1;
    return v;
  };
}

describe('buildAdjustmentCandidates', () => {
  function makeIdGen(prefix = 'id') {
    let i = 0;
    return () => {
      i += 1;
      return `${prefix}_${i}`;
    };
  }

  test('disabled returns undefined fields', () => {
    const out = buildAdjustmentCandidates({ enabled: false, layer2Adjustments: [] });
    expect(out.adjustmentCandidates).toBeUndefined();
    expect(out.experiment).toBeUndefined();
    expect(out.experiments).toBeUndefined();
  });

  test('returns top3 defaults + up to 4 more', () => {
    const layer2Adjustments = [
      { impactArea: 'base', title: 'A', because: 'b', why: 'w', confidence: 'high', techniqueRefs: [] },
      { impactArea: 'eye', title: 'B', because: 'b', why: 'w', confidence: 'medium', techniqueRefs: [] },
      { impactArea: 'lip', title: 'C', because: 'b', why: 'w', confidence: 'low', techniqueRefs: [] },
    ];
    const out = buildAdjustmentCandidates({
      enabled: true,
      explorationRate: 0,
      rng: makeRng([0.9]),
      idGen: makeIdGen('uuid'),
      layer2Adjustments,
    });

    expect(typeof out.exposureId).toBe('string');
    expect(out.exposureId).toBe('uuid_1');
    expect(out.adjustmentCandidates.map((c) => c.impressionId)).toEqual([
      'uuid_2',
      'uuid_3',
      'uuid_4',
      'uuid_5',
      'uuid_6',
      'uuid_7',
      'uuid_8',
    ]);

    expect(out.adjustmentCandidates).toHaveLength(7);
    expect(out.adjustmentCandidates.slice(0, 3).every((c) => c.isDefault)).toBe(true);
    expect(out.adjustmentCandidates.slice(3).every((c) => !c.isDefault)).toBe(true);
    expect(out.adjustmentCandidates.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const expectedSeed = crypto.createHash('sha256').update(`lr_more_v1:${out.exposureId}`).digest('hex').slice(0, 16);
    expect(out.experiment).toEqual({
      variantId: 'lr_more_v1',
      explorationEnabled: true,
      explorationRate: 0,
      explorationBucket: 0,
      seed: expectedSeed,
    });
    expect(out.experiments).toEqual({ variant: 'control_more_v1', explorationRate: 0 });
  });

  test('exploration shuffles only the More candidates', () => {
    const layer2Adjustments = [
      { impactArea: 'base', title: 'A', because: 'b', why: 'w', confidence: 'high', techniqueRefs: [] },
      { impactArea: 'eye', title: 'B', because: 'b', why: 'w', confidence: 'high', techniqueRefs: [] },
      { impactArea: 'lip', title: 'C', because: 'b', why: 'w', confidence: 'high', techniqueRefs: [] },
    ];

    // First rng call triggers exploration (< explorationRate).
    const out = buildAdjustmentCandidates({
      enabled: true,
      explorationRate: 0.5,
      rng: makeRng([0.1]),
      idGen: makeIdGen('uuid'),
      layer2Adjustments,
    });

    const top3 = out.adjustmentCandidates.slice(0, 3).map((c) => c.id);
    expect(top3).toEqual(['default:base', 'default:eye', 'default:lip']);

    const moreIds = out.adjustmentCandidates.slice(3).map((c) => c.id);
    expect(new Set(moreIds)).toEqual(new Set(['more:prep', 'more:brow', 'more:blush', 'more:contour']));

    const impressionIds = out.adjustmentCandidates.map((c) => c.impressionId);
    expect(new Set(impressionIds).size).toBe(impressionIds.length);

    // Deterministic shuffle is seeded from exposureId, not RNG.
    const out2 = buildAdjustmentCandidates({
      enabled: true,
      explorationRate: 0.5,
      rng: makeRng([0.1]),
      idGen: makeIdGen('uuid'),
      layer2Adjustments,
    });
    expect(out.adjustmentCandidates.slice(3).map((c) => c.id)).toEqual(out2.adjustmentCandidates.slice(3).map((c) => c.id));
    expect(out.experiment.variantId).toBe('lr_more_v1');
    expect(out.experiment.explorationBucket).toBe(1);
    expect(out.experiments.variant).toBe('explore_more_v1');
  });
});
