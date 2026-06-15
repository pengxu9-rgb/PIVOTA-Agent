'use strict';

// Phase 1 active-aware beauty rank (find_products_multi). Locks in the behaviour
// that surfaces a product by its actives even when they are absent from its title:
// e.g. the pilot "Tofu Collagen Dual-Firming Jelly Cream" for "soy firming cream".
// See docs/find_products_multi_actives_recall_design.md.

const SERVER_PATH = require.resolve('../src/server.js');

const PILOT = {
  source: 'canonical_chain',
  search_recall_source: 'canonical_chain',
  title: 'Tofu Collagen Dual-Firming Jelly Cream',
  brand: 'Aruen',
  merchant_name: 'Aruen',
  category: 'cream',
  product_type: 'cream',
  category_path: ['beauty', 'skincare', 'moisturize', 'cream'],
  description: 'firming jelly cream',
  // INCI surface forms differ from the friendly query word (soy -> glycine soja).
  raw_ingredient_text_clean:
    'water, glycine soja (soybean) seed extract, adenosine, niacinamide, sodium hyaluronate, hydrolyzed collagen',
  image_url: 'http://example.test/pilot.jpg',
  price: 30,
  in_stock: true,
};

const GENERIC = {
  source: 'canonical_chain',
  title: 'Centella Soothing Cream',
  brand: 'SomeBrand',
  merchant_name: 'SomeBrand',
  category: 'cream',
  product_type: 'cream',
  category_path: ['beauty', 'skincare', 'moisturize', 'cream'],
  description: 'soothing cream',
  raw_ingredient_text_clean: 'water, centella asiatica extract, glycerin',
  image_url: 'http://example.test/generic.jpg',
  price: 20,
  in_stock: true,
};

function loadServer(flagValue) {
  let mod;
  jest.isolateModules(() => {
    const prev = process.env.PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED;
    if (flagValue === undefined) {
      delete process.env.PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED;
    } else {
      process.env.PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED = flagValue;
    }
    try {
      mod = require(SERVER_PATH);
    } finally {
      if (prev == null) delete process.env.PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED;
      else process.env.PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED = prev;
    }
  });
  return mod._debug;
}

function scoreArgs(product, queryText) {
  return {
    product,
    queryText,
    intent: { families: [], normalized: queryText, brandBrowse: null, safety: [] },
    normalizedQuery: queryText,
    queryTokens: queryText.split(' '),
    searchQualityContract: null,
  };
}

describe('active-aware beauty rank — query concept extraction', () => {
  const { extractBeautyQueryActiveConcepts: extract } = loadServer(undefined);
  const keys = (q) => extract(q).map((c) => c.key);

  test('names the active and the benefit for "soy firming cream"', () => {
    expect(keys('soy firming cream').sort()).toEqual(['firming', 'soy']);
  });
  test('names the active and the benefit for "adenosine firming cream"', () => {
    expect(keys('adenosine firming cream').sort()).toEqual(['adenosine', 'firming']);
  });
  test('a benefit-only query yields just the benefit concept', () => {
    expect(keys('korean firming cream')).toEqual(['firming']);
  });
  test('a pure category/title query yields no concepts (no perturbation)', () => {
    expect(keys('jelly cream')).toEqual([]);
  });
});

describe('active-aware beauty rank — product actives matching', () => {
  const { countBeautyActiveConceptMatches: count } = loadServer(undefined);

  test('pilot matches soy (via INCI "glycine soja") + firming (via adenosine/collagen)', () => {
    const m = count('soy firming cream', PILOT);
    expect(m.count).toBe(2);
    expect(m.keys.sort()).toEqual(['firming', 'soy']);
  });
  test('pilot matches adenosine + firming', () => {
    expect(count('adenosine firming cream', PILOT).keys.sort()).toEqual(['adenosine', 'firming']);
  });
  test('generic soothing cream matches none of the firming/active concepts', () => {
    expect(count('soy firming cream', GENERIC).count).toBe(0);
    expect(count('korean firming cream', GENERIC).count).toBe(0);
  });

  // Regression: surface forms are whole tokens, so the registry must list the real
  // Vitamin-C derivative roots — a bare `ascorb` fragment would not match the most
  // common INCI forms (ascorbyl / ascorbate / ascorbic acid).
  test('Vitamin-C derivatives match the vitamin_c + brightening concepts', () => {
    const vitC = {
      source: 'canonical_chain',
      title: 'Brightening Serum',
      category: 'serum',
      product_type: 'serum',
      raw_ingredient_text_clean: 'water, magnesium ascorbyl phosphate, niacinamide, glycerin',
      image_url: 'http://example.test/vitc.jpg',
      price: 25,
      in_stock: true,
    };
    expect(count('vitamin c serum', vitC).keys).toContain('vitamin_c');
    expect(count('brightening serum', vitC).keys).toContain('brightening');
  });
});

describe('active-aware beauty rank — scorer gating', () => {
  test('flag OFF (default): no active_match, pilot barely above generic', () => {
    const { scoreBeautyExternalSeedProduct: score } = loadServer(undefined);
    const rp = score(scoreArgs(PILOT, 'soy firming cream'));
    const rg = score(scoreArgs(GENERIC, 'soy firming cream'));
    expect(rp.active_match).toBeUndefined();
    expect(rg.active_match).toBeUndefined();
    expect(rp.relevant).toBe(true);
    expect(rp.score - rg.score).toBeLessThan(20); // the spread that buries the pilot
  });

  test('flag ON: pilot gets the active bonus and decisively outscores generic', () => {
    const { scoreBeautyExternalSeedProduct: score } = loadServer('true');
    const rp = score(scoreArgs(PILOT, 'soy firming cream'));
    const rg = score(scoreArgs(GENERIC, 'soy firming cream'));
    expect(rp.active_match).toEqual({ count: 2, keys: ['soy', 'firming'], bonus: 88 });
    expect(rg.active_match).toBeUndefined();
    expect(rp.score - rg.score).toBeGreaterThanOrEqual(80);
  });

  test('flag ON: a query that names no active leaves scoring unbonused', () => {
    const { scoreBeautyExternalSeedProduct: score } = loadServer('true');
    const r = score(scoreArgs(PILOT, 'jelly cream'));
    expect(r.active_match).toBeUndefined();
  });
});
