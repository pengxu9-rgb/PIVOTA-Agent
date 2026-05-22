const {
  scoreCandidateMatch,
  pickBestMatch,
  extractSizeTokens,
  extractVariantNumberTokens,
  tokenize,
} = require('../../scripts/extract-bundle-components-llm.cjs');

function mockCandidate(title, opts = {}) {
  return {
    external_product_id: opts.id || `ext_${title.replace(/\W+/g, '').toLowerCase().slice(0, 14)}`,
    title,
    canonical_url: opts.canonical_url || 'https://theordinary.com/x',
    destination_url: opts.destination_url || 'https://theordinary.com/x',
    brand: opts.brand || null,
  };
}

// Score a list of candidates against the same extracted-component context.
function scoreAll(candidates, ctx) {
  return candidates
    .map((c) => ({ ...c, ...scoreCandidateMatch(c, ctx) }))
    .sort((a, b) => b._score - a._score);
}

describe('extract-bundle-components-llm matcher hardening — end-to-end pickBestMatch outcomes', () => {
  describe('tokenization preserves numeric variant tokens (codex round-2 finding)', () => {
    test('extractVariantNumberTokens picks up "2.0" and "v3.0"', () => {
      expect(Array.from(extractVariantNumberTokens('Cosmic Eau de Parfum 2.0'))).toEqual(['2.0']);
      expect(Array.from(extractVariantNumberTokens('Skincare V3.0'))).toEqual(['v3.0']);
      expect(Array.from(extractVariantNumberTokens('Plain Title'))).toEqual([]);
    });

    test('tokenize() exposes "2.0" so EDP vs EDP 2.0 differ', () => {
      const a = new Set(tokenize('Cosmic Eau de Parfum'));
      const b = new Set(tokenize('Cosmic Eau de Parfum 2.0'));
      expect(a.has('2.0')).toBe(false);
      expect(b.has('2.0')).toBe(true);
    });
  });

  describe('codex example: Essential Tonic Trio → Glow Tonic', () => {
    // Round-1 codex failure: matcher picked "Glow Tonic Cleansing Cloths"
    // over "Glow Tonic Travel Size" when the LLM only extracted "Glow Tonic".
    const candidates = [
      mockCandidate('Glow Tonic Cleansing Cloths', { id: 'ext_cloths' }),
      mockCandidate('Glow Tonic Travel Size 100ml', { id: 'ext_travel' }),
      mockCandidate('Glow Tonic 250ml', { id: 'ext_full' }),
    ];

    test('cloth/cloths variant is hard-disqualified (not just lower-scored)', () => {
      const scored = scoreAll(candidates, {
        extractedTitle: 'Glow Tonic',
        parentTitle: 'Pixi Essential Tonic Trio',
        sizeLabel: '100ml',
        parentHost: '',
      });
      const cloth = scored.find((s) => s.external_product_id === 'ext_cloths');
      expect(cloth._hard_noise_hit).toBe(true);
      expect(cloth._score).toBeLessThan(0.5);
    });

    test('travel-size wins when size_label matches and travel is context-supported', () => {
      const scored = scoreAll(candidates, {
        extractedTitle: 'Glow Tonic',
        parentTitle: 'Pixi Essential Tonic Trio',
        sizeLabel: '100ml',
        parentHost: '',
      });
      const best = pickBestMatch(scored);
      expect(best.external_product_id).toBe('ext_travel');
    });
  });

  describe('codex example: Hydra Vizor → Arcane Mystery Box', () => {
    const candidates = [
      mockCandidate('Hydra Vizor Invisible Defense Moisturizer', { id: 'ext_single' }),
      mockCandidate('Arcane Mystery Box: Hydra Vizor Edition', { id: 'ext_mystery' }),
    ];
    test('Mystery Box disqualified; single SKU wins', () => {
      const scored = scoreAll(candidates, {
        extractedTitle: 'Hydra Vizor Invisible Defense Moisturizer',
        parentTitle: 'Fenty Skin Starter Set',
        parentHost: '',
      });
      const mystery = scored.find((s) => s.external_product_id === 'ext_mystery');
      expect(mystery._bundle_child_hit).toBe(true);
      expect(mystery._score).toBeLessThan(0.5);
      const best = pickBestMatch(scored);
      expect(best.external_product_id).toBe('ext_single');
    });
  });

  describe('codex example: Kylie 30ml EDP → 2.0 deluxe sample', () => {
    const candidates = [
      mockCandidate('Cosmic Kylie Jenner Eau de Parfum 30ml', { id: 'ext_30ml' }),
      mockCandidate('Cosmic Kylie Jenner 2.0 Deluxe Sample', { id: 'ext_sample' }),
      mockCandidate('Cosmic Kylie Jenner Eau de Parfum 100ml', { id: 'ext_100ml' }),
    ];
    test('sample is hard-noise hit and falls below the score threshold', () => {
      const scored = scoreAll(candidates, {
        extractedTitle: 'Cosmic Kylie Jenner Eau de Parfum',
        parentTitle: 'Cosmic Kylie Jenner Gift Set',
        sizeLabel: '30ml',
        parentHost: '',
      });
      const sample = scored.find((s) => s.external_product_id === 'ext_sample');
      expect(sample._hard_noise_hit).toBe(true);
      expect(sample._score).toBeLessThan(0.5);
    });

    test('compound ineligibility: hard-noise + size-mismatch knocks a candidate further', () => {
      // A candidate that's BOTH a sample AND a wrong-size variant.
      const candidate = mockCandidate('Cosmic Kylie Jenner Eau de Parfum 100ml Sample', { id: 'ext_compound' });
      const result = scoreCandidateMatch(candidate, {
        extractedTitle: 'Cosmic Kylie Jenner Eau de Parfum',
        parentTitle: 'Cosmic Kylie Jenner Gift Set',
        sizeLabel: '30ml',
        parentHost: '',
      });
      expect(result._hard_noise_hit).toBe(true);
      expect(result._size_mismatch_hit).toBe(true);
      expect(result._score).toBeLessThan(0);
    });

    test('30ml wins as best match', () => {
      const scored = scoreAll(candidates, {
        extractedTitle: 'Cosmic Kylie Jenner Eau de Parfum',
        parentTitle: 'Cosmic Kylie Jenner Gift Set',
        sizeLabel: '30ml',
        parentHost: '',
      });
      const best = pickBestMatch(scored);
      expect(best.external_product_id).toBe('ext_30ml');
    });

    test('"2.0" token is preserved so "EDP 2.0" no longer collides with "EDP"', () => {
      const cands = [
        mockCandidate('Cosmic Eau de Parfum', { id: 'ext_v1' }),
        mockCandidate('Cosmic Eau de Parfum 2.0', { id: 'ext_v2' }),
      ];
      const scored = scoreAll(cands, {
        extractedTitle: 'Cosmic Eau de Parfum',
        parentTitle: 'Cosmic Gift Set',
        parentHost: '',
      });
      const v1 = scored.find((s) => s.external_product_id === 'ext_v1');
      const v2 = scored.find((s) => s.external_product_id === 'ext_v2');
      expect(v1._title_overlap).toBeGreaterThan(v2._title_overlap);
    });
  });

  describe('codex example: "Cleanser" → Total Cleansr (generic-label guard)', () => {
    const candidates = [
      mockCandidate("Fenty Total Cleans'r Remove-It-All Cleanser", { id: 'ext_total' }),
      mockCandidate('Fenty Melt Awf Jelly Oil Cleanser', { id: 'ext_melt' }),
    ];

    test('plain "Cleanser" without context is ineligible (generic-label guard)', () => {
      const scored = scoreAll(candidates, {
        extractedTitle: 'Cleanser',
        parentTitle: 'Fenty Skin Set', // no distinguishing words beyond brand
        parentHost: '',
      });
      const total = scored.find((s) => s.external_product_id === 'ext_total');
      expect(total._generic_label_hit).toBe(true);
      const best = pickBestMatch(scored);
      expect(best).toBeNull();
    });

    test('parent_title context lifts the right cleanser when distinguishing words appear', () => {
      const scored = scoreAll(candidates, {
        extractedTitle: 'Cleanser',
        parentTitle: "Fenty Total Cleans'r Travel Set",
        parentHost: '',
      });
      const total = scored.find((s) => s.external_product_id === 'ext_total');
      expect(total._context_support_ratio).toBeGreaterThan(0);
      expect(total._generic_label_hit).toBe(false);
      const best = pickBestMatch(scored);
      expect(best?.external_product_id).toBe('ext_total');
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

    test('returns null when all viable candidates are already used', () => {
      const matches = [
        { ...mockCandidate('Strong but used', { id: 'ext_used' }),
          _score: 0.95, _title_overlap: 0.95 },
      ];
      expect(pickBestMatch(matches, { excludeIds: new Set(['ext_used']) })).toBeNull();
    });
  });

  describe('extractSizeTokens', () => {
    test('captures ml/oz/g tokens regardless of spacing', () => {
      expect(Array.from(extractSizeTokens('Glycolic Acid 30ml'))).toEqual(['30ml']);
      expect(Array.from(extractSizeTokens('Cosmic 1.0 oz'))).toEqual(['1oz']);
      expect(Array.from(extractSizeTokens('Trio 50 ml + 30ml'))).toEqual(['50ml', '30ml']);
      expect(Array.from(extractSizeTokens('No size here'))).toEqual([]);
    });
  });
});
