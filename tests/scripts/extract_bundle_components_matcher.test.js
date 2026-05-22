const {
  scoreCandidateMatch,
  pickBestMatch,
  extractSizeTokens,
} = require('../../scripts/extract-bundle-components-llm.cjs');

function mockCandidate(title, opts = {}) {
  return {
    external_product_id: opts.id || `ext_${title.replace(/\W+/g, '').toLowerCase().slice(0, 12)}`,
    title,
    canonical_url: opts.canonical_url || 'https://theordinary.com/x',
    destination_url: opts.destination_url || 'https://theordinary.com/x',
    brand: opts.brand || null,
  };
}

describe('extract-bundle-components-llm matcher hardening (codex audit findings)', () => {
  describe('extractSizeTokens', () => {
    test('captures ml/oz/g tokens regardless of spacing', () => {
      expect(Array.from(extractSizeTokens('Glycolic Acid 30ml'))).toEqual(['30ml']);
      expect(Array.from(extractSizeTokens('Cosmic 1.0 oz'))).toEqual(['1oz']);
      expect(Array.from(extractSizeTokens('Trio 50 ml + 30ml'))).toEqual(['50ml', '30ml']);
      expect(Array.from(extractSizeTokens('No size here'))).toEqual([]);
    });
  });

  describe('scoreCandidateMatch — variant noise guard (finding #1)', () => {
    test('penalizes "sample" in matched title when extracted has no "sample"', () => {
      const cleanFull = scoreCandidateMatch(
        mockCandidate('Cosmic Kylie Jenner Eau de Parfum'),
        { extractedTitle: 'Cosmic Kylie Jenner Eau de Parfum', parentTitle: 'Cosmic Gift Set', parentHost: '' },
      );
      const sampleSwap = scoreCandidateMatch(
        mockCandidate('Cosmic Kylie Jenner Eau de Parfum Deluxe Sample'),
        { extractedTitle: 'Cosmic Kylie Jenner Eau de Parfum', parentTitle: 'Cosmic Gift Set', parentHost: '' },
      );
      expect(cleanFull._score).toBeGreaterThan(sampleSwap._score);
      expect(sampleSwap._hard_noise_hit).toBe(true);
      expect(cleanFull._hard_noise_hit).toBe(false);
    });

    test('does NOT penalize when extracted title also says "mini"', () => {
      const matched = scoreCandidateMatch(
        mockCandidate('Glycolic Acid Mini Toner'),
        { extractedTitle: 'Glycolic Acid Mini Toner', parentTitle: 'The Mini Icons Set', parentHost: '' },
      );
      expect(matched._hard_noise_hit).toBe(false);
    });
  });

  describe('scoreCandidateMatch — bundle-child guard (finding #2)', () => {
    test('disqualifies a matched title containing "Mystery Box" when extracted is a single product', () => {
      const candidates = [
        mockCandidate('Hydra Vizor Invisible Defense Moisturizer SPF 30', { id: 'ext_single' }),
        mockCandidate('Arcane Mystery Box: Hydra Vizor Edition', { id: 'ext_bundle' }),
      ];
      const scored = candidates.map((c) =>
        ({ ...c, ...scoreCandidateMatch(c, {
          extractedTitle: 'Hydra Vizor Invisible Defense Moisturizer',
          parentTitle: 'Fenty Skin Starter Set',
          parentHost: '',
        }) }),
      );
      scored.sort((a, b) => b._score - a._score);
      const best = pickBestMatch(scored);
      expect(best.external_product_id).toBe('ext_single');
      const bundleEntry = scored.find((s) => s.external_product_id === 'ext_bundle');
      expect(bundleEntry._bundle_child_hit).toBe(true);
    });

    test('keeps the bundle-token candidate when extracted title also has "set"', () => {
      const result = scoreCandidateMatch(
        mockCandidate('Rare Mini Eau de Parfum Set'),
        { extractedTitle: 'Rare Mini Eau de Parfum Set', parentTitle: 'Rare Holiday Bundle', parentHost: '' },
      );
      expect(result._bundle_child_hit).toBe(false);
    });
  });

  describe('scoreCandidateMatch — size preference (finding #3)', () => {
    test('size_bonus is positive when extracted and candidate share the size', () => {
      const matched30 = scoreCandidateMatch(
        mockCandidate('Cosmic Eau de Parfum 30ml'),
        { extractedTitle: 'Cosmic Eau de Parfum 30ml', sizeLabel: '30ml', parentTitle: 'Cosmic Set', parentHost: '' },
      );
      expect(matched30._size_bonus).toBeGreaterThan(0);
    });

    test('size_bonus is negative when candidate names a different size', () => {
      const mismatch = scoreCandidateMatch(
        mockCandidate('Cosmic Eau de Parfum 100ml'),
        { extractedTitle: 'Cosmic Eau de Parfum 30ml', sizeLabel: '30ml', parentTitle: 'Cosmic Set', parentHost: '' },
      );
      expect(mismatch._size_bonus).toBeLessThan(0);
    });

    test('size_bonus is zero when extracted has no size', () => {
      const noSize = scoreCandidateMatch(
        mockCandidate('Glycolic Acid Toner 30ml'),
        { extractedTitle: 'Glycolic Acid Toner', parentTitle: 'The Mini Icons Set', parentHost: '' },
      );
      expect(noSize._size_bonus).toBe(0);
    });
  });

  describe('scoreCandidateMatch — parent-context bonus (finding #4)', () => {
    test('boosts candidates whose title shares distinguishing words with the parent bundle title', () => {
      const contextful = scoreCandidateMatch(
        mockCandidate('Awaken Confidence Fragrance Mist'),
        { extractedTitle: 'Awaken Confidence', parentTitle: 'Awaken Confidence Fragrance Bundle', parentHost: '' },
      );
      const distractor = scoreCandidateMatch(
        mockCandidate('Awaken Confidence Tote Bag'),
        { extractedTitle: 'Awaken Confidence', parentTitle: 'Awaken Confidence Fragrance Bundle', parentHost: '' },
      );
      expect(contextful._context_bonus).toBeGreaterThan(distractor._context_bonus);
    });
  });

  describe('pickBestMatch — dedup against parent + siblings', () => {
    test('skips a candidate already in excludeIds (parent-bundle self-loop guard)', () => {
      const matches = [
        { ...mockCandidate('Same Bundle Self-Loop', { id: 'ext_parent' }),
          _score: 0.95, _title_overlap: 0.95 },
        { ...mockCandidate('A Different Real Product', { id: 'ext_sibling' }),
          _score: 0.7, _title_overlap: 0.65 },
      ];
      const best = pickBestMatch(matches, { excludeIds: new Set(['ext_parent']) });
      expect(best.external_product_id).toBe('ext_sibling');
    });

    test('returns null when all candidates fall below the 0.5 score threshold', () => {
      const matches = [
        { ...mockCandidate('Weak match'), _score: 0.3, _title_overlap: 0.3 },
      ];
      expect(pickBestMatch(matches)).toBeNull();
    });

    test('returns null when all viable candidates are already used', () => {
      const matches = [
        { ...mockCandidate('Strong but used', { id: 'ext_used' }),
          _score: 0.95, _title_overlap: 0.95 },
      ];
      expect(pickBestMatch(matches, { excludeIds: new Set(['ext_used']) })).toBeNull();
    });
  });
});
