const {
  normalizeProductCandidateSnapshot, normalizeProductIntelKbRow, normalizeIngredientKbRow,
  enrichProductsWithEvidence, enrichProductRelationshipGraphProducts, buildCandidatesByAnchorFromSources,
  dedupeNormalizedProducts, __internal,
} = require('../src/auroraBff/productRelationshipGraphSources');
const { buildProductRelationshipGraphDryRun } = require('../src/auroraBff/productRelationshipGraphBuilder');
const { buildEvidence, buildReviewPrompt } = require('../scripts/review-relationship-candidate-labels');

const NOW = '2026-10-01T00:00:00.000Z';
const FORMULA = 'Water, Glycerin, Squalane, Ceramide NP, Panthenol, Phenoxyethanol';
function product(key, overrides = {}) {
  return { product_ref: `product:sig_${key}`, product_id: `source_${key}`,
    pivota_signature_id: `sig_${key}`, source_product_id: `source_${key}`, product_key: `cp_${key}`,
    brand: key === 'a' ? 'Top Lab' : 'Value Lab', name: 'Daily Barrier Serum',
    category: 'serum', category_taxonomy: ['skincare', 'serum'], market: 'US',
    price: key === 'a' ? 50 : 20, price_currency: 'USD', observed_at: NOW,
    source_refs: [{ type: 'catalog_products', authoritative: true }], ...overrides };
}
function ingredient(key, overrides = {}) {
  return { table: 'public.beauty_sku_ingredients', sku_key: `sku_${key}`, product_key: `cp_${key}`,
    raw_inci: FORMULA, updated_at: NOW, ...overrides };
}
function intel(key, overrides = {}) {
  return { kb_key: `product:source_${key}`, last_success_at: NOW, analysis: { product_intel_v1: {
    canonical_product_ref: { product_id: `source_${key}`, pivota_signature_id: `sig_${key}` },
    evidence_profile: 'seller_only', confidence: { tier: 'limited' },
    provenance: { source_signals: ['official_pdp_description'], field_sources: { what_it_is: 'seller' } },
    freshness: { generated_at: NOW, source_version: 'reviewed_fixture' },
    product_intel_core: {
      what_it_is: { headline: 'Daily serum', body: 'Hydrating facial serum with a lightweight gel texture.' },
      routine_fit: { step: 'serum', am_pm: ['am'], pairing_notes: ['Apply before moisturizer.'] },
      why_it_stands_out: [{ headline: 'Gel format', body: 'A light gel format.' }],
      watchouts: [{ label: 'Patch test if sensitive.' }],
    }, ...overrides,
  } } };
}

describe('canonical relationship evidence enrichment', () => {
  test('normalization preserves complete INCI, amount/currency, source confidence and original metadata', () => {
    const input = product('a', { ingredient_text: `${FORMULA}, ${'Long Ingredient Name, '.repeat(50)}`,
      price_observed_at: '2026-09-15T00:00:00.000Z',
      _relgraph_uncovered_live: true, label_state: 'human_approved',
      source_refs: [{ type: 'product_intel_kb', authoritative: false, evidence_profile: 'seller_only', confidence: 'limited' }],
      _source_type: 'product_intel_kb' });
    const once = normalizeProductCandidateSnapshot(input);
    const twice = normalizeProductCandidateSnapshot(once);
    expect(twice.ingredient_text).toBe(input.ingredient_text.trim());
    expect(twice.price).toBe(50);
    expect(twice.price_currency).toBe('USD');
    expect(twice.observed_at).toBe(NOW);
    expect(twice.price_observed_at).toBe('2026-09-15T00:00:00.000Z');
    expect(twice.source_refs).toEqual(once.source_refs);
    expect(twice.source_refs.some((ref) => ref.authoritative)).toBe(false);
    const [enriched] = enrichProductsWithEvidence([input]);
    expect(enriched).toMatchObject({ _relgraph_uncovered_live: true, label_state: 'human_approved' });
  });

  test('product-key ingredients join signature anchors on both sides without changing listing or offer', () => {
    const rows = [ingredient('a'), ingredient('b')];
    const products = enrichProductsWithEvidence([product('a'), product('b')], { ingredientRows: rows });
    expect(products.map((row) => row.ingredient_text)).toEqual([FORMULA, FORMULA]);
    expect(products[0]).toMatchObject({ product_ref: 'product:sig_a', product_id: 'source_a',
      product_key: 'cp_a', pivota_signature_id: 'sig_a', price: 50, price_currency: 'USD' });
    expect(products[0].ingredient_evidence[0]).toMatchObject({ table: 'public.beauty_sku_ingredients', sku_key: 'sku_a', ingredient_text: FORMULA });
    expect(normalizeIngredientKbRow(ingredient('a', { pivota_signature_id: 'sig_a' })).product_ref).toBe('product:sig_a');
  });

  test.each([
    { review_status: 'rejected' }, { audit_status: 'blocked' }, { parse_status: 'failed' },
    { ingest_allowed: false }, { ingest_allowed: 'false' }, { review_status: 'needs_review' },
  ])('rejected ingredient evidence is not admitted even with trusted source membership: %j', (status) => {
    expect(normalizeIngredientKbRow(ingredient('a', status))).toBeNull();
    const [row] = enrichProductsWithEvidence([product('a')], { ingredientRows: [ingredient('a', status)] });
    expect(row.ingredient_text).toBeUndefined();
    expect(row.source_refs.some((ref) => ref.type === 'ingredient_kb')).toBe(false);
  });

  test('parse OK cannot override explicit ingest denial in the PCI store', () => {
    expect(normalizeIngredientKbRow({ sku_key: 'source_a', table: 'pci_kb.sku_ingredients',
      parse_status: 'OK', ingest_allowed: false, inci_list: FORMULA })).toBeNull();
  });

  test('stores reusing a raw product id cannot acquire sparse or differently scoped ingredient evidence', () => {
    const stores = ['store_a', 'store_b'].map((merchant_id) => product(merchant_id, {
      merchant_id, platform: 'shopify', product_id: '123', source_product_id: '123',
      product_ref: `product:sig_${merchant_id}`, brand: 'Same Brand', name: 'Daily Barrier Serum',
    }));
    const sparse = { table: 'public.beauty_sku_ingredients', sku_key: '123', raw_inci: FORMULA };
    expect(enrichProductsWithEvidence(stores, { ingredientRows: [sparse] }).every((row) => !row.ingredient_text)).toBe(true);
    const scoped = { ...sparse, merchant_id: 'store_a', platform: 'shopify' };
    const enriched = enrichProductsWithEvidence(stores, { ingredientRows: [scoped] });
    expect(enriched[0].ingredient_text).toBe(FORMULA);
    expect(enriched[1].ingredient_text).toBeUndefined();
    const platformMismatch = { ...scoped, platform: 'amazon' };
    expect(enrichProductsWithEvidence(stores, { ingredientRows: [platformMismatch] }).every((row) => !row.ingredient_text)).toBe(true);
  });

  test.each([
    { product_key: 'cp_other', product_name: 'Daily Barrier Serum', brand: 'Top Lab' },
    { pivota_signature_id: 'sig_other' }, { market: 'JP' }, { merchant_id: 'different' },
    { variant_title: 'Shade: 200' }, { brand: 'Wrong Lab' },
  ])('identical names and conflicting identities cannot bind formula evidence: %j', (mismatch) => {
    const anchor = product('a', { merchant_id: 'merchant_a', variant_title: 'Shade: 100' });
    const [row] = enrichProductsWithEvidence([anchor], { ingredientRows: [ingredient('a', mismatch)] });
    expect(row.ingredient_text).toBeUndefined();
  });

  test('same family/name cannot transfer formula evidence to a different listing during dedupe', () => {
    const enriched = enrichProductsWithEvidence([
      product('a', { name: 'Soft Matte Concealer - #100', category: 'concealer', variant_title: 'Shade: 100' }),
      product('shade', { brand: 'Top Lab', name: 'Soft Matte Concealer - #200', category: 'concealer', variant_title: 'Shade: 200', similarity_score: 0.99 }),
    ], { ingredientRows: [ingredient('a')] });
    const [representative] = dedupeNormalizedProducts(enriched);
    expect(representative.product_key).toBe('cp_shade');
    expect(representative.ingredient_text).toBeFalsy();
    expect(representative.ingredient_evidence).toBeUndefined();
    expect(representative.source_refs.some((ref) => ref.type === 'ingredient_kb')).toBe(false);
  });

  test('canonical identity owner cannot inherit a different family sibling’s formula', () => {
    const external = product('external', { pivota_signature_id: '', product_ref: 'product:ext_1',
      product_id: 'ext_1', product_key: '', ingredient_text: FORMULA, similarity_score: 0.99 });
    const catalog = product('catalog', { brand: external.brand, name: external.name, similarity_score: 0.5 });
    const [merged] = dedupeNormalizedProducts([external, catalog]);
    expect(merged.pivota_signature_id).toBe('sig_catalog');
    expect(merged.ingredient_text).toBeFalsy();
  });

  test('conflicting trusted formulas remain attributed and cannot silently form a combined INCI list', () => {
    const [row] = enrichProductsWithEvidence([product('a')], { ingredientRows: [ingredient('a'),
      ingredient('a', { sku_key: 'sku_second', raw_inci: 'Water, Mineral Oil, Fragrance' })] });
    expect(row.ingredient_text).toBeUndefined();
    expect(row.ingredient_evidence_conflict).toBe(true);
    expect(row.ingredient_evidence).toHaveLength(2);
    expect(normalizeProductCandidateSnapshot(row).ingredient_text).toBeUndefined();
    const evidence = buildEvidence({ anchor_ref: row.product_ref, candidate_product_ref: 'product:sig_b',
      anchor_snapshot: row, candidate_snapshot: product('b') }, new Map());
    expect(evidence.anchor.ingredient_evidence_conflict).toBe(true);
    expect(evidence.anchor.ingredient_evidence).toHaveLength(2);
  });

  test('deduplicating identical canonical keys preserves contradictory formula inputs and abstains', () => {
    const [row] = dedupeNormalizedProducts([
      product('a', { ingredient_text: FORMULA }),
      product('a', { ingredient_text: 'Alcohol, Menthol, Fragrance' }),
    ]);
    expect(row.ingredient_text).toBeUndefined();
    expect(row.ingredient_evidence_conflict).toBe(true);
    expect(row.ingredient_evidence.map((evidence) => evidence.ingredient_text)).toEqual(expect.arrayContaining([
      FORMULA, 'Alcohol, Menthol, Fragrance',
    ]));
    expect(normalizeProductCandidateSnapshot(row).ingredient_text).toBeUndefined();
  });

  test('Insights standard sections, provenance, freshness and seller confidence survive repeated normalization', () => {
    const row = normalizeProductIntelKbRow(intel('a'));
    expect(row.evidence_grade).toBe('C');
    expect(row.source_refs).toContainEqual(expect.objectContaining({ type: 'product_intel_kb',
      authoritative: false, evidence_profile: 'seller_only', confidence: 'limited' }));
    expect(row.intel_text).toContain('Apply before moisturizer.');
    expect(row.intel_text).toContain('Patch test if sensitive.');
    expect(row.intel_text).toContain('A light gel format.');
    const [enriched] = enrichProductsWithEvidence([product('a')], { intelRows: [row] });
    const again = normalizeProductCandidateSnapshot(enriched);
    expect(again.product_intel.provenance.field_sources).toEqual({ what_it_is: 'seller' });
    expect(again.product_intel.freshness.generated_at).toBe(NOW);
    const evidence = buildEvidence({ anchor_snapshot: again, candidate_snapshot: product('b') }, new Map());
    expect(evidence.anchor).toMatchObject({ evidence_profile: 'seller_only', confidence_tier: 'limited',
      source_signals: ['official_pdp_description'], freshness: { generated_at: NOW } });
  });

  test('reviewed official entity evidence has its own grade; rejected Insights cannot fall back into a plain source row', () => {
    const row = normalizeProductIntelKbRow(intel('a', { evidence_profile: 'official_pdp_reviewed_line', quality_state: 'reviewed' }));
    expect(row.evidence_grade).toBe('B');
    expect(row.source_refs[0].authoritative).toBe(true);
    const [productRow] = enrichProductsWithEvidence([product('a')], { intelRows: [intel('a', { quality_state: 'rejected' })] });
    expect(productRow.product_intel).toBeUndefined();
    const [rejected] = enrichProductsWithEvidence([product('a')], { intelRows: [intel('a', { provenance: { review_decision: 'reject_external' } })] });
    expect(rejected.product_intel).toBeUndefined();
  });

  test('review keeps sponsored external highlights distinct from verified review badges', () => {
    const [row] = enrichProductsWithEvidence([product('a')], { intelRows: [intel('a', {
      market_signal_badges: [{ badge_type: 'review_signal', badge_label: 'Verified review signal', source_type: 'verified_reviews', evidence_strength: 'strong' }],
      external_highlight_signals: [{ source_type: 'creator_social_consensus', claim_type: 'texture_finish', claim_text: 'Light texture', sponsorship_status: 'sponsored', independence_count: 1, evidence_strength: 'weak' }],
    })] });
    const evidence = buildEvidence({ anchor_snapshot: row, candidate_snapshot: product('b') }, new Map());
    expect(evidence.anchor.market_signal_badges[0]).toMatchObject({ type: 'review_signal', claim_text: 'Verified review signal', source_type: 'verified_reviews' });
    expect(evidence.anchor.external_highlight_signals[0]).toMatchObject({ sponsorship_status: 'sponsored', evidence_strength: 'weak', independence_count: 1 });
    expect(evidence.anchor.source_refs).toContainEqual(expect.objectContaining({ type: 'product_intel_kb', authoritative: false }));
  });

  test('review preserves unknown sponsorship and independence, and marks partial ingredient summaries', () => {
    const [row] = enrichProductsWithEvidence([product('a', { ingredient_text: FORMULA.repeat(15) })], { intelRows: [intel('a', {
      external_highlight_signals: [{ source_type: 'creator_social_consensus', claim_text: 'Texture mention', independence_count: null },
        { source_type: 'verified_reviews', claim_text: 'Explicit metadata', sponsored: false, independence_count: 0 }],
    })] });
    const evidence = buildEvidence({ anchor_snapshot: row, candidate_snapshot: product('b') }, new Map());
    expect(evidence.anchor.external_highlight_signals[0]).toMatchObject({ sponsored: null, independence_count: null });
    expect(evidence.anchor.external_highlight_signals[1]).toMatchObject({ sponsored: false, independence_count: 0 });
    expect(evidence.anchor.ingredient_text_truncated).toBe(true);
  });

  test('ingredient/intel source membership contributes no similarity or social-proof boost', () => {
    const anchor = product('a');
    const candidate = product('b');
    const base = __internal.scoreCandidateForAnchor(anchor, candidate);
    const sourced = __internal.scoreCandidateForAnchor(anchor, { ...candidate,
      source_refs: [{ type: 'ingredient_kb', authoritative: true }, { type: 'product_intel_kb', authoritative: false }] }, { intelMatch: true });
    expect(sourced.score_total).toBe(base.score_total);
    expect(sourced.ingredient_functional_similarity).toBe(base.ingredient_functional_similarity);
    expect(sourced.social_reference_strength).toBe(0);
  });

  test('both frozen review sides receive exact INCI and typed Insights evidence', () => {
    const products = enrichProductsWithEvidence([product('a'), product('b')], {
      ingredientRows: [ingredient('a'), ingredient('b')], intelRows: [intel('a'), intel('b')],
    });
    const candidatesByAnchor = buildCandidatesByAnchorFromSources({ anchors: [products[0]], products: [products[1]],
      includeTransitiveRecall: false });
    const out = buildProductRelationshipGraphDryRun({ anchors: [products[0]], candidatesByAnchor,
      now: new Date(NOW), reviewStatus: 'pending' });
    expect(out.edges).toHaveLength(1);
    const edge = out.edges[0];
    expect(edge.source_refs).toContainEqual(expect.objectContaining({ type: 'product_intel_kb', authoritative: false, evidence_profile: 'seller_only' }));
    const evidence = buildEvidence(edge, new Map());
    for (const side of [evidence.anchor, evidence.candidate]) {
      expect(side.ingredient_text).toBe(FORMULA);
      expect(side.ingredient_evidence[0].source_refs).toContainEqual(expect.objectContaining({ evidence_kind: 'ingredient_list' }));
      expect(side.evidence_profile).toBe('seller_only');
      expect(side.price_currency).toBe('USD');
    }
    expect(buildReviewPrompt(evidence)).toContain('Ingredient overlap never establishes clinical');
  });

  test('per-anchor recall products never become another anchor’s candidate pool', () => {
    const a = product('a'); const b = product('b');
    const candidates = buildCandidatesByAnchorFromSources({ anchors: [a, b],
      productsByAnchor: { [a.product_ref]: [product('target_a', { brand: 'Third Lab' })],
        [b.product_ref]: [product('target_b', { brand: 'Fourth Lab' })] }, includeTransitiveRecall: false });
    expect(candidates[a.product_ref].map((row) => row.product_ref)).toEqual(['product:sig_target_a']);
    expect(candidates[b.product_ref].map((row) => row.product_ref)).toEqual(['product:sig_target_b']);
  });

  test('truncated per-listing evidence loads report incompleteness and withhold formula comparison', async () => {
    const queryFn = jest.fn(async (sql, params) => {
      if (sql.includes('to_regclass')) return { rows: [{ table_name: params[0] === 'public.beauty_sku_ingredients' ? params[0] : null }] };
      if (sql.includes('FROM public.beauty_sku_ingredients')) return { rows: Array.from({ length: 5 }, (_, i) => ({
        ...ingredient('a', { sku_key: `sku_${i}` }), _evidence_target_key: 'product_key:cp_a',
      })) };
      return { rows: [] };
    });
    const hydrated = await enrichProductRelationshipGraphProducts({ queryFn, products: [product('a')], limit: 1 });
    expect(hydrated.products[0].ingredient_text).toBeUndefined();
    expect(hydrated.products[0].ingredient_evidence_incomplete).toBe(true);
    expect(hydrated.diagnostics).toMatchObject({ targeted_products_complete: true, ingredient_loads_incomplete: 1,
      evidence_records_per_product_per_source_limit: 4 });
    const sourceCall = queryFn.mock.calls.find(([sql]) => sql.includes('FROM public.beauty_sku_ingredients'));
    expect(sourceCall[0]).toContain('CROSS JOIN LATERAL');
    expect(sourceCall[1][0]).toBe(5);
  });

  test('multiple aliases of one exact listing form one targeted request instead of inflating its cap', async () => {
    const queryFn = jest.fn(async (sql, params) => {
      if (sql.includes('to_regclass')) return { rows: [{ table_name: params[0] === 'public.beauty_sku_ingredients' ? params[0] : null }] };
      if (sql.includes('FROM public.beauty_sku_ingredients')) return { rows: [{ ...ingredient('a'), _evidence_target_key: 'product_key:cp_a' }] };
      return { rows: [] };
    });
    const hydrated = await enrichProductRelationshipGraphProducts({ queryFn,
      products: [product('a'), product('a', { product_ref: 'product:pg_shared' })] });
    const sourceCall = queryFn.mock.calls.find(([sql]) => sql.includes('FROM public.beauty_sku_ingredients'));
    const targets = JSON.parse(sourceCall[1][1]);
    expect(targets).toHaveLength(1);
    expect(targets[0].refs).toEqual(expect.arrayContaining(['product:sig_a', 'product:pg_shared']));
    expect(hydrated.products.map((row) => row.ingredient_text)).toEqual([FORMULA, FORMULA]);
    expect(hydrated.diagnostics.ingredient_loads_incomplete).toBe(0);
  });
});
