'use strict';

// Phase 2 WS2 — ingredient-recall-direct lane reorder + near-dup collapse.
//
// The ingredient-direct lane (query_source=agent_products_ingredient_recall_direct;
// e.g. "niacinamide serum for dark spots", "vitamin c serum") recalls + filters
// but never relevance-ranks or dedupes, so on the 2026-07-08 prod baseline a
// generic "The Serum" sat at #1, literal-title matches were buried, and 7 test
// copies "(Copy_T1)".."(Copy_T7)" occupied ranks 4-10. This locks the fix:
// reuse the mainline token-relevance ordering + near-dup collapse, gated by the
// same flags, preserving the full set (reorder/demote, never drop).

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

// Mirrors the observed prod recall order for "niacinamide serum for dark spots":
// generic first, then 7 test copies of the Jumiso product, then the literal
// title matches that were buried, plus an off-topic blusher.
function baselineProducts() {
  const jumiso = (suffix, id) => ({
    id,
    title: `20% NIACINAMIDE High Potency Dark Spot Serum${suffix}`,
    brand: 'Jumiso USA',
    // recalled by ingredient evidence — niacinamide present in INCI
    ingredients_inci: ['Niacinamide', 'Water', 'Glycerin'],
  });
  return [
    { id: 'the_serum', title: 'The Serum', brand: 'Aetās' }, // no niacinamide, generic token only
    jumiso(' (Copy_T1)', 'j1'),
    jumiso(' (Copy_T2)', 'j2'),
    jumiso(' (Copy_T3)', 'j3'),
    jumiso(' (Copy_T4)', 'j4'),
    jumiso(' (Copy_T5)', 'j5'),
    jumiso(' (Copy_T6)', 'j6'),
    jumiso(' (Copy_T7)', 'j7'),
    jumiso('', 'j0'),
    { id: 'blusher', title: 'Moist Ampoule Blusher 20ml', brand: 'House of HUR' },
    {
      id: 'roundlab',
      title: 'Vita Niacinamide Dark Spot Serum',
      brand: 'Round Lab',
    }, // literal-title match, no INCI supplied
    {
      id: 'fab',
      title: 'Facial Radiance Niacinamide Dark Spot Serum',
      brand: 'First Aid Beauty',
    },
  ];
}

const QUERY = 'niacinamide serum for dark spots';

describe('reorderBeautyIngredientDirectProducts — flags off', () => {
  const { reorderBeautyIngredientDirectProducts: reorder } = loadServer({});

  test('returns the input unchanged when both flags are off', () => {
    const input = baselineProducts();
    const out = reorder(input, { queryText: QUERY });
    expect(out.products).toBe(input); // same reference, no work
    expect(out.token_relevance_applied).toBe(false);
    expect(out.near_dup_collapsed_count).toBe(0);
  });
});

describe('reorderBeautyIngredientDirectProducts — near-dup collapse only', () => {
  const { reorderBeautyIngredientDirectProducts: reorder } = loadServer({
    PIVOT_BEAUTY_NEAR_DUP_COLLAPSE_ENABLED: 'true',
  });

  test('collapses the 7 Copy_T duplicates below distinct rows, preserving count', () => {
    const input = baselineProducts();
    const out = reorder(input, {
      queryText: QUERY,
      nearDupCollapseEnabled: true,
    });
    expect(out.near_dup_collapsed_count).toBe(7);
    expect(out.products).toHaveLength(input.length); // demote, never drop
    const titles = out.products.map((p) => p.title);
    // exactly one Jumiso variant remains among the leading distinct rows
    const firstJumisoIdx = titles.findIndex((t) => t.startsWith('20% NIACINAMIDE'));
    const distinctCount = input.length - 7;
    const jumisoInDistinct = titles
      .slice(0, distinctCount)
      .filter((t) => t.startsWith('20% NIACINAMIDE')).length;
    expect(jumisoInDistinct).toBe(1);
    // the 7 demoted copies sit in the tail
    expect(titles.slice(distinctCount).every((t) => t.startsWith('20% NIACINAMIDE'))).toBe(true);
    expect(firstJumisoIdx).toBeLessThan(distinctCount);
  });
});

describe('reorderBeautyIngredientDirectProducts — token relevance + collapse', () => {
  const { reorderBeautyIngredientDirectProducts: reorder } = loadServer({
    PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED: 'true',
    PIVOT_BEAUTY_NEAR_DUP_COLLAPSE_ENABLED: 'true',
  });

  function ranked() {
    return reorder(baselineProducts(), {
      queryText: QUERY,
      tokenRelevanceEnabled: true,
      nearDupCollapseEnabled: true,
    });
  }

  test('literal-title matches rank above the generic "The Serum"', () => {
    const ids = ranked().products.map((p) => p.id);
    expect(ids.indexOf('roundlab')).toBeLessThan(ids.indexOf('the_serum'));
    expect(ids.indexOf('fab')).toBeLessThan(ids.indexOf('the_serum'));
  });

  test('both literal-title serums land in the visible top 5', () => {
    const top5 = ranked().products.slice(0, 5).map((p) => p.id);
    expect(top5).toContain('roundlab');
    expect(top5).toContain('fab');
  });

  test('the off-topic blusher (zero token/active match) is demoted below every matched row', () => {
    const ids = ranked().products.map((p) => p.id);
    const blusherIdx = ids.indexOf('blusher');
    for (const matched of ['roundlab', 'fab', 'j0']) {
      expect(blusherIdx).toBeGreaterThan(ids.indexOf(matched));
    }
  });

  test('Copy_T duplicates still collapse to one representative', () => {
    const out = ranked();
    expect(out.near_dup_collapsed_count).toBe(7);
    expect(out.token_relevance_applied).toBe(true);
    const visibleJumiso = out.products
      .slice(0, out.products.length - 7)
      .filter((p) => p.title.startsWith('20% NIACINAMIDE'));
    expect(visibleJumiso).toHaveLength(1);
    // the surfaced representative is the clean original, not a "(Copy_Tn)" copy
    expect(visibleJumiso[0].title).toBe('20% NIACINAMIDE High Potency Dark Spot Serum');
    expect(visibleJumiso[0].id).toBe('j0');
  });
});
