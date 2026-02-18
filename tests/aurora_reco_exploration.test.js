const { selectExplorationCandidates, computeUncertainty } = require('../src/auroraBff/recoExploration');

function cand(id, score, extra = {}) {
  return {
    product_id: id,
    score_breakdown: { score_total: score },
    ...extra,
  };
}

describe('aurora reco exploration', () => {
  test('selects exploration candidates from gated pool and appends at tail', () => {
    const ranked = [cand('r1', 0.95), cand('r2', 0.9)];
    const gatedPool = [
      ...ranked,
      cand('e1', 0.49),
      cand('e2', 0.52, { new_item: true }),
      cand('e3', 0.1),
    ];
    const out = selectExplorationCandidates({
      block: 'competitors',
      ranked,
      gatedPool,
      ratePerBlock: 0.3,
      maxExploreItems: 2,
    });
    expect(out.list.length).toBeGreaterThanOrEqual(2);
    expect(out.insertedCount).toBeLessThanOrEqual(2);
    if (out.insertedCount > 0) {
      const tail = out.list.slice(-out.insertedCount).map((x) => x.product_id);
      expect(tail.length).toBe(out.insertedCount);
      expect(tail.every((id) => id.startsWith('e'))).toBe(true);
    }
  });

  test('returns original list when exploration disabled', () => {
    const ranked = [cand('r1', 0.8)];
    const out = selectExplorationCandidates({
      block: 'dupes',
      ranked,
      gatedPool: [cand('e1', 0.5)],
      ratePerBlock: 0,
      maxExploreItems: 2,
    });
    expect(out.list).toHaveLength(1);
    expect(out.insertedCount).toBe(0);
  });

  test('uncertainty boosts new items', () => {
    const base = computeUncertainty(cand('x', 0.7));
    const boosted = computeUncertainty(cand('x2', 0.7, { new_item: true }));
    expect(boosted).toBeGreaterThan(base);
  });
});
