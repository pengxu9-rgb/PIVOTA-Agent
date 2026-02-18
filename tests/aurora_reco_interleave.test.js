const { teamDraftInterleave, buildCandidateKey } = require('../src/auroraBff/recoInterleave');

function cand(id, name) {
  return {
    product_id: id,
    name: name || id,
  };
}

describe('aurora reco interleave', () => {
  test('team-draft interleave dedupes and annotates attribution', () => {
    const rankedA = [cand('a1'), cand('shared'), cand('a2')];
    const rankedB = [cand('b1'), cand('shared'), cand('b2')];
    const out = teamDraftInterleave({
      rankedA,
      rankedB,
      limit: 6,
      seed: 'seed-1',
    });
    const ids = out.interleaved.map((row) => row.product_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['shared', 'a1', 'b1']));
    const sharedKey = buildCandidateKey(cand('shared'), 0);
    expect(out.attribution[sharedKey]).toBe('both');
  });

  test('handles uneven lists and limit', () => {
    const out = teamDraftInterleave({
      rankedA: [cand('a1'), cand('a2'), cand('a3')],
      rankedB: [cand('b1')],
      limit: 2,
      seed: 'seed-2',
    });
    expect(out.interleaved.length).toBe(2);
    expect(out.interleaved.map((x) => x.product_id)).toEqual(expect.arrayContaining(['a1', 'b1']));
  });
});
