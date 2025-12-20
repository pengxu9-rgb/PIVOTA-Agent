const {
  extractProductSignals,
  scoreByTagFacetOverlap,
  scorePairOverlap,
} = require('../src/services/productTagSignals');

describe('productTagSignals', () => {
  test('extracts tokens from tags + facets', () => {
    const p = {
      tags: ['Cat:Brush', 'Use:Foundation', 'Group-123'],
      recommendation_meta: { facets: { cat: 'brush', use: ['foundation'], material: ['synthetic'] } },
    };
    const sig = extractProductSignals(p);
    expect(sig.tagTokens.has('brush')).toBe(true);
    expect(sig.tagTokens.has('foundation')).toBe(true);
    expect(sig.facetTokens.has('synthetic')).toBe(true);
  });

  test('scores overlap against query terms', () => {
    const p = {
      tags: ['Cat:Brush', 'Use:Foundation'],
      recommendation_meta: { facets: { use: ['foundation'], area: ['face'] } },
    };
    const s = scoreByTagFacetOverlap(['foundation', 'brush', 'random'], p);
    expect(s.tagOverlap).toBeGreaterThanOrEqual(1);
    expect(s.facetOverlap).toBeGreaterThanOrEqual(1);
    expect(s.score).toBeGreaterThan(0);
  });

  test('scores pair overlap between base and candidate', () => {
    const base = {
      tags: ['Cat:Brush', 'Use:Foundation', 'Series:Logo'],
      recommendation_meta: { facets: { cat: 'brush', use: ['foundation'], series: ['logo'] } },
    };
    const cand = {
      tags: ['Cat:Brush', 'Use:Foundation', 'Series:Logo'],
      recommendation_meta: { facets: { cat: 'brush', use: ['foundation'], series: ['logo'] } },
    };
    const s = scorePairOverlap(base, cand);
    expect(s.facetOverlap).toBeGreaterThanOrEqual(1);
    expect(s.score).toBeGreaterThan(0);
  });
});

