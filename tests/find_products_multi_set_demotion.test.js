/**
 * Multi-product bundles must not outrank single products for a category query.
 *
 * Prod 2026-08-04: 14/120 served rows across 12 category queries were bundles,
 * clustered in makeup (bronzer 4/10, blush 4/10). The category signal cannot
 * catch them — "The Mini Discovery Set" is stored as category=Bronzer,
 * product_type=Bronzer — so the demotion keys on the title.
 */

'use strict';

const gate = require('../src/services/beautyRelevanceGate');

describe('multi-product set vocabulary', () => {
  test('recognizes real bundle titles observed in prod', () => {
    for (const title of [
      'The Mini Discovery Set',
      'Shade and Illuminate Contour Duo',
      'Choose Your Glow Trio',
      'Glow Besties Bundle',
      'The Most-Loved Collection',
      'pH Duo Set',
      'Mascara is a Moment Set',
    ]) {
      expect(gate.titleLooksLikeMultiProductSet(title)).toBe(true);
    }
  });

  test('does NOT flag single products whose names merely sound rich', () => {
    for (const title of [
      'Pixi Glow Tonic',
      'Niacinamide 10% + Zinc 1% Serum',
      'Sunset Blush',
      'Ultra Repair Retinol Serum with 0.3% Retinol Complex + Peptides',
      'Soleil Neige Crème Blush',
    ]) {
      expect(gate.titleLooksLikeMultiProductSet(title)).toBe(false);
    }
  });

  test('query intent: a shopper asking for a set is not fighting the demotion', () => {
    expect(gate.queryWantsMultiProductSet('skincare gift set')).toBe(true);
    expect(gate.queryWantsMultiProductSet('starter kit')).toBe(true);
    expect(gate.queryWantsMultiProductSet('bronzer')).toBe(false);
    expect(gate.queryWantsMultiProductSet('')).toBe(false);
  });
});

describe('refineBeautyFindProductsMultiResponseBody set demotion', () => {
  const products = () => [
    { title: 'The Mini Discovery Set' },
    { title: 'Sunset Bronzer' },
    { title: 'Shade and Illuminate Contour Duo' },
    { title: 'Matte Bronzing Powder' },
  ];
  const body = (list, querySource = 'beauty_discovery_mainline') => ({
    products: list,
    metadata: { query_source: querySource },
  });
  let prevEnv;

  beforeEach(() => { jest.resetModules(); prevEnv = { ...process.env }; });
  afterEach(() => { process.env = prevEnv; jest.resetModules(); });

  function load(enabled) {
    if (enabled) process.env.PIVOT_BEAUTY_SET_DEMOTION_ENABLED = 'true';
    else delete process.env.PIVOT_BEAUTY_SET_DEMOTION_ENABLED;
    delete process.env.PIVOT_BEAUTY_NEAR_DUP_COLLAPSE_ENABLED;
    delete process.env.PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED;
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
    return require('../src/server');
  }

  test('flag off: order byte-identical', () => {
    const app = load(false);
    const fn = app._debug.refineBeautyFindProductsMultiResponseBody;
    const out = fn(body(products()), 'bronzer');
    expect(out.products.map((p) => p.title)).toEqual(products().map((p) => p.title));
  });

  test('flag on: bundles sink below singles, nothing dropped', () => {
    const app = load(true);
    const fn = app._debug.refineBeautyFindProductsMultiResponseBody;
    const out = fn(body(products()), 'bronzer');
    const titles = out.products.map((p) => p.title);
    expect(titles).toHaveLength(4); // never drops
    expect(titles.slice(0, 2)).toEqual(['Sunset Bronzer', 'Matte Bronzing Powder']);
    expect(out.metadata.op_level_set_demoted_count).toBe(2);
  });

  test('flag on but the query asks for a set: no demotion', () => {
    const app = load(true);
    const fn = app._debug.refineBeautyFindProductsMultiResponseBody;
    const out = fn(body(products()), 'bronzer gift set');
    expect(out.products.map((p) => p.title)).toEqual(products().map((p) => p.title));
    expect(out.metadata.op_level_set_demoted_count).toBeUndefined();
  });
});
