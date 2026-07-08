'use strict';

// Phase 2 WS2 — op-level (layer 3) near-dup collapse over the fully merged body.
//
// The ADR-007 citable supplement is appended AFTER the lane's own rank/collapse,
// and its items carry distinct content_keys, so near-identical titles (e.g.
// "(Copy_Tn)" test copies) survive the exact-key dedupe and re-pollute the page.
// refineBeautyFindProductsMultiResponseBody() runs a final collapse (+ reorder
// for the scorer-less ingredient-direct lane) so no near-duplicate survives in
// any find_products_multi beauty response.

const SERVER_PATH = require.resolve('../src/server.js');

function loadServer(flags = {}) {
  const FLAG_KEYS = [
    'PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED',
    'PIVOT_BEAUTY_NEAR_DUP_COLLAPSE_ENABLED',
  ];
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

const JUMISO = '20% NIACINAMIDE High Potency Dark Spot Serum';

// A response body shaped like the ingredient-direct lane's output AFTER the
// citable supplement has appended distinct-content_key copies of the same
// product (ranks mirror the 2026-07-08 prod baseline).
function ingredientDirectBody() {
  const jumiso = (suffix, id) => ({
    id,
    product_id: id,
    content_key: `ck_${id}`,
    title: `${JUMISO}${suffix}`,
    brand: 'Jumiso USA',
    ingredients_inci: ['Niacinamide', 'Water'],
  });
  return {
    status: 'success',
    products: [
      jumiso('', 'j0'),
      { id: 'the_serum', product_id: 'the_serum', content_key: 'ck_the_serum', title: 'The Serum', brand: 'Aetās' },
      { id: 'roundlab', product_id: 'roundlab', content_key: 'ck_roundlab', title: 'Vita Niacinamide Dark Spot Serum', brand: 'Round Lab' },
      // citable-supplement copies — distinct content_keys, so exact-key dedupe
      // kept them; near-dup collapse must catch them.
      jumiso(' (Copy_T1)', 'j1'),
      jumiso(' (Copy_T2)', 'j2'),
      jumiso(' (Copy_T3)', 'j3'),
      jumiso(' (Copy_T4)', 'j4'),
    ],
    metadata: { query_source: 'agent_products_ingredient_recall_direct' },
  };
}

function titles(body) {
  return body.products.map((p) => p.title);
}

describe('refineBeautyFindProductsMultiResponseBody — flags off', () => {
  const { refineBeautyFindProductsMultiResponseBody: refine } = loadServer({});

  test('returns the body untouched when both flags are off', () => {
    const body = ingredientDirectBody();
    const before = titles(body);
    const out = refine(body, 'niacinamide serum for dark spots');
    expect(titles(out)).toEqual(before);
    expect(out.metadata.op_level_near_dup_collapsed_count).toBeUndefined();
  });
});

describe('refineBeautyFindProductsMultiResponseBody — ingredient-direct lane', () => {
  const { refineBeautyFindProductsMultiResponseBody: refine } = loadServer({
    PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED: 'true',
    PIVOT_BEAUTY_NEAR_DUP_COLLAPSE_ENABLED: 'true',
  });

  test('collapses citable-supplement Copy_T copies and promotes literal matches', () => {
    const body = refine(ingredientDirectBody(), 'niacinamide serum for dark spots');
    const ids = body.products.map((p) => p.id);
    // exactly one Jumiso variant remains in the visible head (4 copies collapse to 1)
    const distinctCount = body.products.length - 4;
    const jumisoVisible = body.products
      .slice(0, distinctCount)
      .filter((p) => p.title.startsWith('20% NIACINAMIDE'));
    expect(jumisoVisible).toHaveLength(1);
    expect(jumisoVisible[0].id).toBe('j0'); // clean original, not a Copy_T
    // the 4 copies are demoted to the tail
    expect(body.products.slice(distinctCount).every((p) => /Copy_T/.test(p.title))).toBe(true);
    // literal-title match ranks above the generic "The Serum"
    expect(ids.indexOf('roundlab')).toBeLessThan(ids.indexOf('the_serum'));
    expect(body.metadata.op_level_near_dup_collapsed_count).toBe(4);
    expect(body.metadata.op_level_token_relevance_applied).toBe(true);
  });
});

describe('refineBeautyFindProductsMultiResponseBody — mainline lane is collapse-only', () => {
  const { refineBeautyFindProductsMultiResponseBody: refine } = loadServer({
    PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED: 'true',
    PIVOT_BEAUTY_NEAR_DUP_COLLAPSE_ENABLED: 'true',
  });

  test('collapses near-dups but does NOT re-sort the mainline scorer order', () => {
    // Mainline order is deliberate (brand/category/active weights); only the
    // trailing near-dup should move, everything else keeps position.
    const body = {
      status: 'success',
      products: [
        { id: 'a', product_id: 'a', content_key: 'ck_a', title: 'Alpha Cream', brand: 'X' },
        { id: 'b', product_id: 'b', content_key: 'ck_b', title: 'Beta Serum', brand: 'Y' },
        { id: 'c', product_id: 'c', content_key: 'ck_c', title: 'Gamma Toner', brand: 'Z' },
        { id: 'a_dup', product_id: 'a_dup', content_key: 'ck_a_dup', title: 'Alpha Cream (Copy_T1)', brand: 'X' },
      ],
      metadata: { query_source: 'agent_products_beauty_external_seed_mainline' },
    };
    const out = refine(body, 'cream');
    expect(out.products.map((p) => p.id)).toEqual(['a', 'b', 'c', 'a_dup']); // order preserved, dup at tail
    expect(out.metadata.op_level_near_dup_collapsed_count).toBe(1);
    expect(out.metadata.op_level_token_relevance_applied).toBeUndefined(); // NOT reordered
  });

  test('ignores non-beauty responses entirely', () => {
    const body = {
      status: 'success',
      products: [
        { id: 'x', content_key: 'ck_x', title: 'Plain Tee', brand: 'A' },
        { id: 'y', content_key: 'ck_y', title: 'Plain Tee', brand: 'A' },
      ],
      metadata: { query_source: 'agent_products_search' },
    };
    const out = refine(body, 'tee');
    expect(out.products.map((p) => p.id)).toEqual(['x', 'y']); // untouched
    expect(out.metadata.op_level_near_dup_collapsed_count).toBeUndefined();
  });
});
