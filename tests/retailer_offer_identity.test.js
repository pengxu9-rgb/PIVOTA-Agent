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
