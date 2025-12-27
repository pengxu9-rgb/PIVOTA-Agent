const { buildAdjustmentCandidates } = require('../../src/lookReplicator/buildAdjustmentCandidates');

function makeRng(seq) {
  let i = 0;
  return () => {
    const v = seq[i] ?? 0.5;
    i += 1;
    return v;
  };
}

describe('buildAdjustmentCandidates', () => {
  test('disabled returns undefined fields', () => {
    const out = buildAdjustmentCandidates({ enabled: false, layer2Adjustments: [] });
    expect(out.adjustmentCandidates).toBeUndefined();
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
      layer2Adjustments,
    });

    expect(out.adjustmentCandidates).toHaveLength(7);
    expect(out.adjustmentCandidates.slice(0, 3).every((c) => c.isDefault)).toBe(true);
    expect(out.adjustmentCandidates.slice(3).every((c) => !c.isDefault)).toBe(true);
    expect(out.adjustmentCandidates.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('exploration shuffles only the More candidates', () => {
    const layer2Adjustments = [
      { impactArea: 'base', title: 'A', because: 'b', why: 'w', confidence: 'high', techniqueRefs: [] },
      { impactArea: 'eye', title: 'B', because: 'b', why: 'w', confidence: 'high', techniqueRefs: [] },
      { impactArea: 'lip', title: 'C', because: 'b', why: 'w', confidence: 'high', techniqueRefs: [] },
    ];

    // First rng call triggers exploration (< 0.5). Next calls affect shuffling.
    const out = buildAdjustmentCandidates({
      enabled: true,
      explorationRate: 0.5,
      rng: makeRng([0.1, 0.9, 0.8, 0.7, 0.6]),
      layer2Adjustments,
    });

    const top3 = out.adjustmentCandidates.slice(0, 3).map((c) => c.id);
    expect(top3).toEqual(['default:base', 'default:eye', 'default:lip']);

    const moreIds = out.adjustmentCandidates.slice(3).map((c) => c.id);
    expect(new Set(moreIds)).toEqual(new Set(['more:prep', 'more:brow', 'more:blush', 'more:contour']));
  });
});

