const { recoBlocks } = require('../src/auroraBff/recoBlocksDag');

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function makeAnchor(overrides = {}) {
  return {
    brand_id: 'anchor_brand',
    category_taxonomy: ['serum'],
    price: 100,
    ...overrides,
  };
}

function makeCandidate(overrides = {}) {
  return {
    product_id: 'cand_1',
    brand_id: 'other_brand',
    category_match: 0.9,
    similarity_score: 0.82,
    price: 90,
    source: { type: 'catalog_search' },
    ...overrides,
  };
}

describe('aurora reco blocks dag', () => {
  test('catalog_ann timeout + on_page present: competitors remain on_page-free, related can fallback from on_page', async () => {
    const out = await recoBlocks(
      makeAnchor(),
      {
        mode: 'main_path',
        timeouts_ms: {
          catalog_ann: 25,
          ingredient_index: 25,
          skin_fit_light: 25,
          kb_backfill: 25,
          dupe_pipeline: 25,
          on_page_related: 80,
        },
        sources: {
          catalog_ann: async () =>
            delay(120, {
              candidates: [makeCandidate({ product_id: 'timeout_candidate' })],
            }),
          ingredient_index: async () => ({ candidates: [] }),
          skin_fit_light: async () => ({ candidates: [] }),
          kb_backfill: async () => ({ candidates: [], competitors: [], dupes: [] }),
          dupe_pipeline: async () => ({ candidates: [] }),
          on_page_related: async () => ({
            candidates: [
              makeCandidate({
                product_id: 'on_page_1',
                source: { type: 'on_page_related' },
                similarity_score: 0.94,
                price: 75,
              }),
            ],
          }),
        },
      },
      180,
    );

    const competitors = Array.isArray(out?.competitors?.candidates) ? out.competitors.candidates : [];
    const related = Array.isArray(out?.related_products?.candidates) ? out.related_products.candidates : [];
    expect(
      competitors.some((x) => String(x?.source?.type || '').toLowerCase() === 'on_page_related'),
    ).toBe(false);
    expect(
      related.some((x) => String(x?.source?.type || '').toLowerCase() === 'on_page_related'),
    ).toBe(true);
    const firstRelated = related[0] || {};
    expect(firstRelated.why_candidate).toBeTruthy();
    expect(typeof firstRelated.why_candidate.summary).toBe('string');
    expect(Array.isArray(firstRelated.why_candidate.reasons_user_visible)).toBe(true);
    expect(firstRelated.score_breakdown && typeof firstRelated.score_breakdown).toBe('object');
    expect(typeof firstRelated.score_breakdown.category_use_case_match).toBe('number');
    expect(typeof firstRelated.score_breakdown.score_total).toBe('number');
    expect(Array.isArray(out?.diagnostics?.timed_out_blocks)).toBe(true);
    expect(out.diagnostics.timed_out_blocks).toContain('catalog_ann');
  });

  test('all competitor recall fail: competitors may be empty, provenance has fallback trace, confidence lowers to low', async () => {
    const out = await recoBlocks(
      makeAnchor(),
      {
        mode: 'main_path',
        timeouts_ms: {
          catalog_ann: 40,
          ingredient_index: 30,
          skin_fit_light: 30,
          kb_backfill: 30,
          dupe_pipeline: 30,
          on_page_related: 30,
        },
        sources: {
          catalog_ann: async () => {
            throw new Error('catalog down');
          },
          ingredient_index: async () => ({ candidates: [] }),
          skin_fit_light: async () => ({ candidates: [] }),
          kb_backfill: async () => ({ candidates: [], competitors: [], dupes: [] }),
          dupe_pipeline: async () => ({ candidates: [] }),
          on_page_related: async () => ({ candidates: [] }),
        },
      },
      160,
    );

    expect(Array.isArray(out?.competitors?.candidates)).toBe(true);
    expect(out.competitors.candidates.length).toBe(0);
    expect(Array.isArray(out?.provenance_patch?.fallbacks_used)).toBe(true);
    expect(out.provenance_patch.fallbacks_used).toEqual(
      expect.arrayContaining(['kb_or_cache_competitors', 'fast_ann_competitors']),
    );
    expect(out?.confidence_patch?.competitors?.level).toBe('low');
    expect(Number(out?.confidence_patch?.competitors?.score || 0)).toBeLessThanOrEqual(0.2);
    expect(Array.isArray(out?.confidence_patch?.competitors?.reasons)).toBe(true);
    expect(out.confidence_patch.competitors.reasons).toEqual(
      expect.arrayContaining(['all_competitor_recall_failed']),
    );
  });

  test('dupes empty but kb_backfill_dupes available: dupes can be filled from kb fallback', async () => {
    const out = await recoBlocks(
      makeAnchor(),
      {
        mode: 'main_path',
        sources: {
          catalog_ann: async () => ({ candidates: [] }),
          ingredient_index: async () => ({ candidates: [] }),
          skin_fit_light: async () => ({ candidates: [] }),
          kb_backfill: async () => ({
            candidates: [],
            competitors: [],
            dupes: [
              makeCandidate({
                product_id: 'kb_dupe_1',
                brand_id: 'other_brand_2',
                category_match: 0.92,
                similarity_score: 0.91,
                price: 80,
                source: { type: 'kb_backfill' },
              }),
            ],
          }),
          dupe_pipeline: async () => ({ candidates: [] }),
          on_page_related: async () => ({ candidates: [] }),
        },
      },
      220,
    );

    const dupes = Array.isArray(out?.dupes?.candidates) ? out.dupes.candidates : [];
    expect(dupes.map((x) => x.product_id)).toContain('kb_dupe_1');
    const firstDupe = dupes[0] || {};
    expect(firstDupe.why_candidate).toBeTruthy();
    expect(typeof firstDupe.why_candidate.summary).toBe('string');
    expect(Array.isArray(firstDupe.evidence_refs)).toBe(true);
    expect(firstDupe.score_breakdown && typeof firstDupe.score_breakdown).toBe('object');
    expect(typeof firstDupe.score_breakdown.ingredient_functional_similarity).toBe('number');
    expect(Array.isArray(out?.provenance_patch?.fallbacks_used)).toBe(true);
    expect(out.provenance_patch.fallbacks_used).toContain('kb_backfill_dupes');
  });

  test('budget exhausted records timed_out_blocks and per-block stats', async () => {
    const out = await recoBlocks(
      makeAnchor(),
      {
        mode: 'main_path',
        timeouts_ms: {
          catalog_ann: 300,
          ingredient_index: 300,
          skin_fit_light: 300,
          kb_backfill: 300,
          dupe_pipeline: 300,
          on_page_related: 300,
        },
        sources: {
          catalog_ann: async () => delay(180, { candidates: [makeCandidate({ product_id: 'late_1' })] }),
          ingredient_index: async () => delay(180, { candidates: [] }),
          skin_fit_light: async () => delay(180, { candidates: [] }),
          kb_backfill: async () => delay(180, { candidates: [], competitors: [], dupes: [] }),
          dupe_pipeline: async () => delay(180, { candidates: [] }),
          on_page_related: async () => delay(180, { candidates: [] }),
        },
      },
      70,
    );

    expect(Array.isArray(out?.diagnostics?.timed_out_blocks)).toBe(true);
    expect(out.diagnostics.timed_out_blocks.length).toBeGreaterThan(0);
    expect(out.diagnostics.timed_out_blocks).toContain('catalog_ann');
    expect(out?.diagnostics?.blocks?.catalog_ann).toBeTruthy();
    expect(typeof out.diagnostics.blocks.catalog_ann.duration_ms).toBe('number');
  });

  test('dogfood exploration/interleave still preserve hard redlines in competitors', async () => {
    const out = await recoBlocks(
      makeAnchor({ brand_id: 'anchor_brand' }),
      {
        mode: 'main_path',
        dogfood_config: {
          dogfood_mode: true,
          exploration: { enabled: true, rate_per_block: 0.5, max_explore_items: 2 },
          interleave: { enabled: true, rankerA: 'ranker_v1', rankerB: 'ranker_v2' },
          ui: { lock_top_n_on_first_paint: 3, show_employee_feedback_controls: true, allow_block_internal_rerank_on_async: true },
          retrieval: { pool_size: { competitors: 50, dupes: 20, related_products: 20 } },
        },
        sources: {
          catalog_ann: async () => ({
            candidates: [
              makeCandidate({ product_id: 'cross_brand_ok', brand_id: 'other_1', source: { type: 'catalog_search' } }),
              makeCandidate({ product_id: 'same_brand_bad', brand_id: 'anchor_brand', source: { type: 'catalog_search' } }),
              makeCandidate({ product_id: 'on_page_bad', brand_id: 'other_2', source: { type: 'on_page_related' } }),
              makeCandidate({ product_id: 'legacy_alt_bad', brand_id: 'other_3', source: { type: 'aurora_alternatives' } }),
            ],
          }),
          ingredient_index: async () => ({ candidates: [] }),
          skin_fit_light: async () => ({ candidates: [] }),
          kb_backfill: async () => ({ candidates: [], competitors: [], dupes: [] }),
          dupe_pipeline: async () => ({ candidates: [] }),
          on_page_related: async () => ({ candidates: [] }),
        },
      },
      260,
    );

    const competitors = Array.isArray(out?.competitors?.candidates) ? out.competitors.candidates : [];
    expect(competitors.some((x) => String(x?.brand_id || '').toLowerCase() === 'anchor_brand')).toBe(false);
    expect(competitors.some((x) => String(x?.source?.type || '').toLowerCase() === 'on_page_related')).toBe(false);
    expect(competitors.some((x) => String(x?.source?.type || '').toLowerCase() === 'aurora_alternatives')).toBe(false);
    expect(out?.diagnostics?.interleave_enabled).toBe(true);
    expect(out?.diagnostics?.exploration_enabled).toBe(true);
    expect(out?.provenance_patch?.dogfood_mode).toBe(true);
    expect(out?.tracking?.by_block?.competitors).toBeTruthy();
  });
});
