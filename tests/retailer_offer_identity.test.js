'use strict';
/* Fix Plan D — behaviour tests for the shared cross-seller identity normalizer +
 * resolver. Lesson (ADR-009): SQL-shape tests miss 3-valued logic — we test the
 * BEHAVIOUR: collapse across size/packaging, distinctness across shade/product,
 * contamination guard, and the exact/fuzzy/self-mint resolver decision. */

const m = require('../src/services/retailerOfferIdentity');

describe('brandCore', () => {
  test.each([
    ['Benefit Cosmetics', 'benefit'],
    ['Benefit', 'benefit'],
    ['Estée Lauder', 'estee lauder'],
    ['Estee Lauder', 'estee lauder'],
    ["L'Oreal Paris", 'loreal'],
    ['e.l.f. Cosmetics', 'e l f'],
    ['COSRX', 'cosrx'],
  ])('brandCore(%p) -> %p', (input, expected) => {
    expect(m.brandCore(input)).toBe(expected);
  });
});

describe('titleCore strips size/packaging, keeps shade', () => {
  test('size variants collapse to one core', () => {
    expect(m.titleCore('COSRX Advanced Snail 96 Mucin Power Essence 100ml', 'COSRX')).toBe(
      m.titleCore('Advanced Snail 96 Mucin Power Essence 3.38 oz', 'COSRX'),
    );
  });
  test('mini / travel size collapse', () => {
    expect(m.titleCore('Benefit Cosmetics Hoola Matte Bronzer Mini', 'Benefit Cosmetics')).toBe(
      m.titleCore('Hoola Matte Bronzer travel size', 'Benefit'),
    );
  });
  test('brand suffix word (Cosmetics) removed from the title core', () => {
    expect(m.titleCore('Benefit Cosmetics Hoola Matte Bronzer', 'Benefit Cosmetics')).toBe('hoola matte bronzer');
  });
  test('shade tokens are PRESERVED (must not silently merge shades)', () => {
    expect(m.titleCore('NARS Blush Orgasm', 'NARS')).not.toBe(m.titleCore('NARS Blush Deep Throat', 'NARS'));
  });
});

/* #1916: this module used to also export contentKeyFallback(), a THIRD formula for a
 * key it does not own — it never minted a single prod key and could never collide with
 * one that had. The cross-seller collapse those tests described is real, but it lives
 * in identityMatchKey + resolve-first, which is what is asserted here instead. The
 * content_key minter is src/services/contentKey.js (tests/content_key_authority.test.js). */
describe('identityMatchKey is URL-free, deterministic, and collapses variants', () => {
  test('ml vs oz -> same match key', () => {
    expect(m.identityMatchKey('COSRX', 'COSRX Advanced Snail 96 Mucin Power Essence 100ml')).toBe(
      m.identityMatchKey('COSRX', 'Advanced Snail 96 Mucin Power Essence 3.38 oz'),
    );
  });
  test('accent + brand-suffix variance -> same match key', () => {
    expect(m.identityMatchKey('Estée Lauder', 'Estée Lauder Advanced Night Repair Serum 50ml')).toBe(
      m.identityMatchKey('Estee Lauder', 'Advanced Night Repair Serum 1.7 oz'),
    );
  });
  test('distinct products of same brand -> distinct match key', () => {
    expect(m.identityMatchKey('COSRX', 'COSRX Snail Mucin Essence')).not.toBe(
      m.identityMatchKey('COSRX', 'COSRX Advanced Snail Peptide Eye Cream'),
    );
  });
  test('is a readable brandCore|titleCore pair, NOT a ck_ hash', () => {
    expect(m.identityMatchKey('COSRX', 'COSRX Snail Mucin Essence')).toBe('cosrx|snail mucin essence');
    expect(m.identityMatchKey('COSRX', 'x')).not.toMatch(/^ck_/);
  });
});

describe('isRetailerHost (contamination guard)', () => {
  test.each([
    ['ulta.com', true],
    ['www.ulta.com', true],
    ['sephora.com', true],
    ['global.oliveyoung.com', true],
    ['cosrx.com', false],
    ['theordinary.com', false],
    ['', false],
  ])('isRetailerHost(%p) -> %p', (h, expected) => {
    expect(m.isRetailerHost(h)).toBe(expected);
  });
  test('hostOf strips protocol/www/path', () => {
    expect(m.hostOf('https://www.ulta.com/p/x?y=1')).toBe('ulta.com');
  });
});

describe('resolveAgainstIndex — exact / fuzzy / self-mint', () => {
  // Build an index the way buildCatalogIdentityIndex would, but hand-rolled.
  function makeIndex(products) {
    const exact = new Map();
    const byBrand = new Map();
    for (const p of products) {
      const key = m.identityMatchKey(p.brand, p.title);
      const entry = { content_key: p.content_key, product_group_id: p.product_group_id || null, product_key: p.product_key, brand: p.brand, title: p.title };
      if (!exact.has(key)) exact.set(key, { ...entry, count: 1 });
      const bc = m.brandCore(p.brand);
      if (!byBrand.has(bc)) byBrand.set(bc, []);
      byBrand.get(bc).push({ ...entry, tokens: m.coreTokens(m.titleCore(p.title, p.brand)) });
    }
    return { exact, byBrand, candidateCount: products.length };
  }
  const index = makeIndex([
    { product_key: 'pk_cosrx_essence', content_key: 'ck_dtc_essence', product_group_id: 'pg1', brand: 'COSRX', title: 'COSRX Advanced Snail 96 Mucin Power Essence 100ml' },
    { product_key: 'pk_cosrx_eye', content_key: 'ck_dtc_eye', product_group_id: 'pg2', brand: 'COSRX', title: 'COSRX Advanced Snail Peptide Eye Cream 25ml' },
  ]);

  test('exact size-variant retailer offer REUSES the D2C content_key', () => {
    const r = m.resolveAgainstIndex(index, 'COSRX', 'Advanced Snail 96 Mucin Power Essence 3.38 oz');
    expect(r.decision).toBe('reuse_exact');
    expect(r.match.content_key).toBe('ck_dtc_essence');
    expect(r.score).toBe(1);
  });

  test('near-but-not-exact retailer offer goes to REVIEW, never auto-merge', () => {
    const r = m.resolveAgainstIndex(index, 'COSRX', 'Advanced Snail 96 Mucin Power Cream', { fuzzyThreshold: 0.6 });
    expect(r.decision).toBe('review_fuzzy');
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });

  test('unrelated title self-mints (no false merge)', () => {
    const r = m.resolveAgainstIndex(index, 'COSRX', 'Salicylic Acid Daily Gentle Cleanser');
    expect(r.decision).toBe('self_mint');
  });

  test('brand with no candidates self-mints', () => {
    const r = m.resolveAgainstIndex(index, 'Some Unknown Brand', 'Whatever Product');
    expect(r.decision).toBe('self_mint');
  });
});

describe('buildCatalogIdentityIndex (injected query)', () => {
  test('excludes retailer-host candidates and honours excludeProductKeys', async () => {
    const rows = [
      { product_key: 'pk_dtc', content_key: 'ck_dtc', brand: 'COSRX', title: 'COSRX Snail Essence 100ml', canonical_url: 'https://cosrx.com/p/1', product_group_id: 'pg_dtc' },
      { product_key: 'pk_contaminated', content_key: 'ck_bad', brand: 'COSRX', title: 'COSRX Snail Essence 100ml', canonical_url: 'https://www.ulta.com/p/2', product_group_id: 'pg_bad' },
      { product_key: 'pk_excluded', content_key: 'ck_x', brand: 'COSRX', title: 'COSRX Toner', canonical_url: 'https://cosrx.com/p/3', product_group_id: 'pg_x' },
    ];
    const queryFn = async () => ({ rows });
    const index = await m.buildCatalogIdentityIndex(queryFn, ['COSRX'], { excludeProductKeys: ['pk_excluded'] });
    // contaminated (ulta host) + excluded dropped -> only pk_dtc remains
    expect(index.candidateCount).toBe(1);
    const r = m.resolveAgainstIndex(index, 'COSRX', 'Snail Essence 3.38 oz');
    expect(r.decision).toBe('reuse_exact');
    expect(r.match.content_key).toBe('ck_dtc');
  });
});

/* Pack-count guard. titleCore strips "10 sheets" the same way it strips "100ml", which
 * is right for matching — but a count is a PACK SIZE, not a cosmetic variant. Measured
 * on prod 2026-08-08: of the 51 folds reconcile-retailer-offers-into-d2c.cjs applied on
 * 2026-07-12, exactly one put two different products on one content_key this way, and
 * therefore on one index_pipeline_state row (a PRIMARY KEY). Replaying this guard over
 * all 51 blocks that one and allows the other 50. */
describe('packCounts / packCountMismatch', () => {
  test('reads counts in the spellings real listings use', () => {
    expect(m.packCounts('Sheet Mask - 1 ct')).toEqual([1]);
    expect(m.packCounts('Sheet Mask 10 Sheets')).toEqual([10]);
    expect(m.packCounts('Cotton Pads 60 pads')).toEqual([60]);
    expect(m.packCounts('Ampoule 30 capsules')).toEqual([30]);
    expect(m.packCounts('Serum 3-pack')).toEqual([3]);
    expect(m.packCounts('Masks pack of 5')).toEqual([5]);
  });

  test('a title with no count states none — silence, not zero', () => {
    expect(m.packCounts('Advanced Snail Mucin Power Essence')).toEqual([]);
    expect(m.packCounts('Snail Essence 100ml')).toEqual([]); // volume is not a count
    expect(m.packCounts('')).toEqual([]);
  });

  test('BLOCKS when both sides state a count and they disagree', () => {
    // The exact prod case, un-folded 2026-08-08.
    expect(m.packCountMismatch(
      'Advanced Snail Mucin Power Sheet Mask - 1 ct',
      'Advanced Snail Mucin Power Sheet Mask 10 Sheets',
    )).toBe(true);
  });

  test('ALLOWS when only one side states a count — silence is not disagreement', () => {
    // 13 of the 51 measured folds were this shape: the retailer states the pack, the
    // brand's own site does not. Those folds are correct and must keep working.
    expect(m.packCountMismatch('Sheet Mask 10 Sheets', 'Sheet Mask')).toBe(false);
    expect(m.packCountMismatch('Sheet Mask', 'Sheet Mask 10 Sheets')).toBe(false);
  });

  test('counts are compared as a SET, not in title order', () => {
    // A kit can state two counts, and two listings can state them in either order.
    // Without sorting, an order flip reads as a mismatch and blocks a correct fold.
    expect(m.packCounts('Recovery Kit 10 sheets 2 pads')).toEqual([2, 10]);
    expect(m.packCounts('Recovery Kit 2 pads 10 sheets')).toEqual([2, 10]);
    expect(m.packCountMismatch('Recovery Kit 10 sheets 2 pads', 'Recovery Kit 2 pads 10 sheets')).toBe(false);
    // ...but a genuinely different multiset still blocks.
    expect(m.packCountMismatch('Recovery Kit 10 sheets 2 pads', 'Recovery Kit 10 sheets 5 pads')).toBe(true);
  });

  test('ALLOWS when both agree, and when neither is a count at all', () => {
    expect(m.packCountMismatch('Mask 10 Sheets', 'Mask - 10 ct')).toBe(false);
    expect(m.packCountMismatch('Essence 100ml', 'Essence 3.38 oz')).toBe(false); // volume
  });
});

describe('resolveAgainstIndex refuses to auto-merge a pack-count conflict', () => {
  function indexOf(products) {
    const exact = new Map();
    const byBrand = new Map();
    for (const p of products) {
      exact.set(m.identityMatchKey(p.brand, p.title), { ...p, count: 1 });
      const bc = m.brandCore(p.brand);
      if (!byBrand.has(bc)) byBrand.set(bc, []);
      byBrand.get(bc).push({ ...p, tokens: m.coreTokens(m.titleCore(p.title, p.brand)) });
    }
    return { exact, byBrand, candidateCount: products.length };
  }
  const index = indexOf([{
    product_key: 'pk_d2c_10pack',
    content_key: 'ck_d2c_10pack',
    brand: 'COSRX',
    title: 'Advanced Snail Mucin Power Sheet Mask 10 Sheets',
  }]);

  test('the 1-ct offer is surfaced for review, NOT folded onto the 10-pack', () => {
    const r = m.resolveAgainstIndex(index, 'COSRX', 'Advanced Snail Mucin Power Sheet Mask - 1 ct');
    expect(r.decision).toBe('review_fuzzy');
    expect(r.blocked_by).toBe('pack_count_mismatch');
    expect(r.pack_counts).toEqual({ incoming: [1], candidate: [10] });
  });

  test('review, not self_mint — the titles otherwise match, so a human should see it', () => {
    // self_mint would silently create a second identity with no record of the near-miss.
    const r = m.resolveAgainstIndex(index, 'COSRX', 'Advanced Snail Mucin Power Sheet Mask - 1 ct');
    expect(r.decision).not.toBe('self_mint');
    expect(r.match.content_key).toBe('ck_d2c_10pack');
  });

  test('the same offer WITHOUT a stated count still folds — the guard is not a blanket', () => {
    const r = m.resolveAgainstIndex(index, 'COSRX', 'Advanced Snail Mucin Power Sheet Mask');
    expect(r.decision).toBe('reuse_exact');
    expect(r.match.content_key).toBe('ck_d2c_10pack');
  });

  test('a matching count still folds', () => {
    const r = m.resolveAgainstIndex(index, 'COSRX', 'Advanced Snail Mucin Power Sheet Mask - 10 ct');
    expect(r.decision).toBe('reuse_exact');
  });
});
