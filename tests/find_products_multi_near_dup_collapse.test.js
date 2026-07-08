'use strict';

// Phase 2 WS2 near-duplicate collapse. Locks in: test-copy artifacts like
// "(Copy_T1)".."(Copy_T7)" (2026-07-08 prod baseline: 8 of the top 11 slots for
// "niacinamide serum for dark spots") collapse to one visible representative,
// while genuine variant suffixes ("(Refill)", "(50ml)", "(SPF 50)") survive.

const SERVER_PATH = require.resolve('../src/server.js');

function loadServer(flags = {}) {
  const FLAG_KEYS = ['PIVOT_BEAUTY_NEAR_DUP_COLLAPSE_ENABLED'];
  let mod;
  jest.isolateModules(() => {
    const prev = {};
    for (const key of FLAG_KEYS) {
      prev[key] = process.env[key];
      if (flags[key] === undefined) delete process.env[key];
      else process.env[key] = flags[key];
    }
    try {
      mod = require(SERVER_PATH);
    } finally {
      for (const key of FLAG_KEYS) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  });
  return mod._debug;
}

describe('stripBeautyTitleAnnotationSuffix', () => {
  const { stripBeautyTitleAnnotationSuffix: strip } = loadServer({});
  const BASE = '20% NIACINAMIDE High Potency Dark Spot Serum';

  test('strips Copy_T1..Copy_T7 style annotations', () => {
    for (let i = 1; i <= 7; i += 1) {
      expect(strip(`${BASE} (Copy_T${i})`)).toBe(BASE);
    }
  });

  test('strips assorted test annotations', () => {
    expect(strip(`${BASE} [TEST]`)).toBe(BASE);
    expect(strip(`${BASE} (sample 2)`)).toBe(BASE);
    expect(strip(`${BASE} - copy 3`)).toBe(BASE);
    expect(strip(`${BASE} (qa)`)).toBe(BASE);
    expect(strip(`${BASE} (do not buy)`)).toBe(BASE);
    expect(strip(`${BASE} (v2)`)).toBe(BASE); // short code
  });

  test('strips stacked annotations across passes', () => {
    expect(strip(`${BASE} (Copy_T1) [TEST]`)).toBe(BASE);
  });

  test('KEEPS genuine variant descriptors', () => {
    expect(strip(`${BASE} (Refill)`)).toBe(`${BASE} (Refill)`);
    expect(strip(`${BASE} (50ml)`)).toBe(`${BASE} (50ml)`);
    expect(strip(`${BASE} (SPF 50)`)).toBe(`${BASE} (SPF 50)`);
    expect(strip('Cushion Foundation (Shade 21)')).toBe('Cushion Foundation (Shade 21)');
    expect(strip(`${BASE} (Unscented)`)).toBe(`${BASE} (Unscented)`);
    expect(strip(`${BASE} (Travel)`)).toBe(`${BASE} (Travel)`);
  });

  test('leaves plain titles untouched', () => {
    expect(strip(BASE)).toBe(BASE);
    expect(strip('')).toBe('');
  });
});

describe('collapseNearDuplicateScoredBeautyProducts', () => {
  const { collapseNearDuplicateScoredBeautyProducts: collapse } = loadServer({});
  const row = (title, score, extra = {}) => ({
    product: { title, brand: 'Jumiso USA', pivota_signature_id: `sig_${title.replace(/\W+/g, '_')}`, ...extra },
    relevant: true,
    score,
  });

  test('keeps the best-scored representative in place, demotes the copies below distinct rows', () => {
    const original = row('20% NIACINAMIDE High Potency Dark Spot Serum', 300);
    const copies = Array.from({ length: 7 }, (_, i) =>
      row(`20% NIACINAMIDE High Potency Dark Spot Serum (Copy_T${i + 1})`, 300 - i),
    );
    const distinctA = row('Vita Niacinamide Dark Spot Serum', 280, { brand: 'Round Lab' });
    const distinctB = row('Licorice First Essence', 120, { brand: 'Hyaah' });
    // Pre-sorted best-first, copies interleaved like the prod baseline.
    const input = [original, ...copies, distinctA, distinctB];

    const result = collapse(input);
    expect(result.collapsed_count).toBe(7);
    const titles = result.rows.map((r) => r.product.title);
    // Representative + all distinct rows come before any demoted copy.
    expect(titles[0]).toBe('20% NIACINAMIDE High Potency Dark Spot Serum');
    expect(titles.slice(0, 3)).toEqual([
      '20% NIACINAMIDE High Potency Dark Spot Serum',
      'Vita Niacinamide Dark Spot Serum',
      'Licorice First Essence',
    ]);
    const demoted = result.rows.slice(3);
    expect(demoted).toHaveLength(7);
    for (const d of demoted) {
      expect(d.near_dup_demoted).toBe(true);
      expect(d.near_dup_of).toBe(original.product.pivota_signature_id);
    }
    // Total preserved: demoted, not dropped.
    expect(result.rows).toHaveLength(input.length);
  });

  test('different brands with the same title stay distinct', () => {
    const a = row('Dark Spot Serum', 200, { brand: 'BrandA' });
    const b = row('Dark Spot Serum', 190, { brand: 'BrandB' });
    const result = collapse([a, b]);
    expect(result.collapsed_count).toBe(0);
  });

  test('distinct products sharing vocabulary are not collapsed', () => {
    const a = row('Vita Niacinamide Dark Spot Serum', 200, { brand: 'Round Lab' });
    const b = row('Vita Niacinamide Dark Spot Cream', 190, { brand: 'Round Lab' });
    const result = collapse([a, b]);
    expect(result.collapsed_count).toBe(0);
    expect(result.rows).toHaveLength(2);
  });

  test('size/refill variant pairs collapse to one visible entry (shared-canonicalizer semantics)', () => {
    // canonicalizeBeautyProductTitleForDedupe already normalizes size/refill
    // descriptors away — that is the existing display-dedupe contract, and the
    // collapse inherits it: one visible representative, the variant demoted (not
    // dropped).
    const a = row('Niacinamide Serum (50ml)', 200);
    const b = row('Niacinamide Serum (Refill)', 190);
    const result = collapse([a, b]);
    expect(result.rows).toHaveLength(2);
    expect(result.collapsed_count).toBe(1);
    expect(result.rows[1].near_dup_demoted).toBe(true);
  });

  test('rows without titles pass through untouched', () => {
    const a = { product: { brand: 'X' }, relevant: true, score: 10 };
    const result = collapse([a]);
    expect(result.rows).toEqual([a]);
    expect(result.collapsed_count).toBe(0);
  });
});
