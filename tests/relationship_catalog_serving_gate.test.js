const {
  CATALOG_GATE_FAILURES_SQL,
  catalogGateKeys,
  filterProductsByCatalogServingGate,
  isNonProductListing,
  nonProductListingReason,
  relationshipServingCatalogGateMode,
} = require('../src/auroraBff/relationshipCatalogServingGate');
const { __internal: { inferRelationship, isOutOfScopeBeautyProduct } } = require('../src/auroraBff/productRelationshipGraphBuilder');
const { normalizeExternalProductSeedRow, loadProductRelationshipGraphSourceInputs } = require('../src/auroraBff/productRelationshipGraphSources');
const { readApprovedRelationshipEdgesForAnchorUncollapsed } = require('../src/auroraBff/productRelationshipGraph');
const { runReview, selectReviewCandidates } = require('../scripts/review-relationship-candidate-labels');

// The corpora of pivota-backend#2664 tests/test_nightly_index_health_job.py, verbatim: the first
// block was live in the prod catalog on 2026-10-21; the second is real products carrying the
// same words.
const NOT_A_PRODUCT_TITLES = [
  'Heart To Tarte Donation', 'Donate To The Clara Lionel Foundation', 'Add-on Donation', 'Round Up Donation',
  'GIFT VOUCHER', 'Shipping Protection by Route', 'SavedBy Package Protection', 'Green Package Protection',
  'Delivery Guarantee', 'Gift Certificate', '$50 E-Voucher', 'Route Insurance', 'Order Protection',
  'Shipping Insurance', 'Tip', 'Add a Tip', 'Tips', 'Gratuity', 'Booking Deposit', 'Pre-Order Deposit',
  'Deposit', 'Deposit for Custom Order',
  // The old rule's gift-card arm, kept.
  'Gift Card', 'Pixi E-Gift Card 25',
];
const REAL_PRODUCTS_NEAR_NON_PRODUCT_WORDS = [
  "Pro Filt'r Soft Matte Longwear Foundation", 'Liquid Foundation Brush', 'Q-Tip Precision Tips Swabs',
  'Fingertip Blending Sponge', 'Lip Tip Liquid Lipstick', 'Tip Top Nail Polish', 'Colour Deposit Mask',
  'Color Depositing Conditioner', 'Lipstick (10% of Proceeds Donated to Charity)', 'Charity Pot Body Lotion',
  'Holiday Gift Set', 'Route 66 Eau de Parfum', 'Buy One, Donate One Lip Balm', 'Deposit Only Hair Color',
  // Samples and sets are merchandise to the graph (the IPS gate rules on them, not this rule).
  'Flaura + Santelle Eau De Parfum Sample Vials',
];

describe('non-product listing rule (twin of pivota-backend _is_non_core_product, #2664)', () => {
  test.each(NOT_A_PRODUCT_TITLES)('%s is not a product', (title) => {
    expect(isNonProductListing({ name: title })).toBe(true);
    expect(isNonProductListing({ title })).toBe(true);
  });
  test.each(REAL_PRODUCTS_NEAR_NON_PRODUCT_WORDS)('%s is a product', (title) => {
    expect(isNonProductListing({ name: title, url: 'https://example.com/products/listing' })).toBe(false);
  });
  test('the URL counts, the description does not', () => {
    expect(isNonProductListing({ name: 'Make it count', url: 'https://shop.example/products/gift-card' })).toBe(true);
    expect(isNonProductListing({ name: 'Make it count', url: 'https://shop.example/products/shippingprotection' })).toBe(true);
    expect(isNonProductListing({ name: 'Barrier Serum', description: 'A donation goes to charity with every order.' })).toBe(false);
  });
  test('title-start words count only at the start of ONE title', () => {
    expect(isNonProductListing({ name: 'Glow Serum', title: 'Tip' })).toBe(true);
    expect(isNonProductListing({ name: 'Glow Serum Tip' })).toBe(false);
    expect(isNonProductListing({ snapshot: { title: 'Donate to the foundation' } })).toBe(true);
  });
  test('product type is an exact match: Gift Card is not a product, Gift Set is', () => {
    expect(nonProductListingReason({ name: 'Fifty', product_type: 'Gift_Card' })).toBe('non_product_type');
    expect(nonProductListingReason({ name: 'Fifty', category: 'donation' })).toBe('non_product_type');
    expect(isNonProductListing({ name: 'Fifty', product_type: 'Gift Set' })).toBe(false);
    expect(isNonProductListing({ name: 'Fifty', product_type: 'Gifts' })).toBe(false);
  });
});

describe('builder: a non-product listing never becomes an edge', () => {
  const serum = (name, brand) => ({ product_ref: `product:${brand}`, name, brand, category: 'serum',
    category_taxonomy: ['skincare', 'serum'], description: 'Hydrating facial serum supports the skin barrier.', price: 30 });
  test('the donation is rejected with its own reason, merch keeps the merch reason', () => {
    const anchor = serum('Daily Barrier Face Serum', 'aster');
    const clara = { ...serum('Donate To The Clara Lionel Foundation', 'fenty'), category: 'serum' };
    const donation = inferRelationship(anchor, clara, { similarity_score: 0.9 });
    expect(donation.relation_type).toBe('rejected');
    expect(donation.scopeCompatibility.reason).toBe('non_product_listing');
    const hoodie = inferRelationship(anchor, { ...serum('Logo Hoodie', 'merchco'), category: 'apparel' }, {});
    expect(hoodie.scopeCompatibility.reason).toBe('non_beauty_merch_scope');
    expect(isOutOfScopeBeautyProduct(clara)).toBe(true);
  });
});

describe('catalog gate keys', () => {
  test('a normalized seed names its seed id, never its own ref twice', () => {
    const product = normalizeExternalProductSeedRow({ id: 'eps_1', external_product_id: 'ext_1', title: 'Serum',
      seed_data: { snapshot: { title: 'Serum' } } });
    expect(catalogGateKeys(product).sort()).toEqual(['ext_1']);
  });
  test('a stored snapshot under a re-keyed ref contributes its listing ids', () => {
    expect(catalogGateKeys({ product_id: 'ext_1', pivota_signature_id: 'sig_1', product_key: 'cp_1', source_product_id: '' },
      'product:pg_family').sort()).toEqual(['cp_1', 'ext_1', 'pg_family', 'sig_1']);
  });
});

describe('generation: the gate decides, and a gate error is never read as "nothing failed"', () => {
  test('filterProductsByCatalogServingGate drops title failures without asking the catalog about them', async () => {
    const queryFn = jest.fn(async (_sql, [subjects]) => ({ rows: JSON.parse(subjects)
      .filter((s) => s.keys.includes('ext_stale')).map((s) => ({ subject_id: s.subject_id, reason: 'catalog_not_live' })) }));
    const live = { product_ref: 'product:ext_live', name: 'Serum' };
    const stale = { product_ref: 'product:ext_stale', name: 'Serum' };
    const tip = { product_ref: 'product:ext_tip', name: 'Add a Tip' };
    const gate = await filterProductsByCatalogServingGate([live, stale, tip], { queryFn });
    expect(gate.kept).toEqual([live]);
    expect(gate.counts).toEqual({ catalog_not_live: 1, non_product_listing: 1 });
    expect(JSON.parse(queryFn.mock.calls[0][1][0]).map((s) => s.keys)).toEqual([['ext_live'], ['ext_stale']]);
  });
  test('the source loader propagates a gate query error', async () => {
    const queryFn = jest.fn(async (sql) => {
      if (sql === CATALOG_GATE_FAILURES_SQL) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      if (/FROM external_product_seeds\b/.test(sql)) {
        return { rows: [{ id: 'eps_1', external_product_id: 'ext_1', title: 'Serum', market: 'US', seed_data: { snapshot: { title: 'Serum' } } }] };
      }
      return { rows: [] };
    });
    await expect(loadProductRelationshipGraphSourceInputs({ queryFn, market: 'US', limit: 5 })).rejects.toThrow(/statement timeout/);
  });
});

describe('serving read: RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE', () => {
  const saved = process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE;
    else process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE = saved;
  });
  const NOW = Date.now();
  const edgeRow = (id, candidate, name = 'Barrier Serum') => ({ id, anchor_type: 'product', anchor_ref: 'product:a',
    anchor_snapshot: { name: 'Daily Barrier Face Serum', brand: 'Aster' }, candidate_product_ref: `product:${candidate}`,
    candidate_snapshot: { name, brand: `Brand ${id}`, product_id: candidate }, relation_type: 'competitive_alternative',
    market: 'US', vertical: 'beauty', score_total: 0.8, review_status: 'approved', label_state: 'ai_approved',
    evidence_grade: 'B', source_refs: [{ type: 'products_cache', authoritative: true }],
    last_verified_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 86400000).toISOString(),
    created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() });
  const rows = [edgeRow('e1', 'ext_live'), edgeRow('e2', 'ext_stale'), edgeRow('e3', 'ext_donation', 'Round Up Donation')];
  const queryFnFor = (gate) => jest.fn(async (sql, params) => {
    if (sql === CATALOG_GATE_FAILURES_SQL) return gate(params);
    if (/FROM product_relationship_edges/.test(sql)) return { rows };
    return { rows: [] };
  });
  const staleFails = ([subjects]) => ({ rows: JSON.parse(subjects).filter((s) => s.keys.includes('ext_stale'))
    .map((s) => ({ subject_id: s.subject_id, reason: 'catalog_not_live' })) });
  const read = (queryFn) => readApprovedRelationshipEdgesForAnchorUncollapsed({ anchorRefs: ['product:a'], market: 'US', queryFn });

  test('unknown values mean off', () => {
    expect(relationshipServingCatalogGateMode({})).toBe('off');
    expect(relationshipServingCatalogGateMode({ RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE: 'on' })).toBe('off');
    expect(relationshipServingCatalogGateMode({ RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE: ' Enforce ' })).toBe('enforce');
  });
  test('off (default): no gate query, every edge served', async () => {
    const queryFn = queryFnFor(staleFails);
    const result = await read(queryFn);
    expect(queryFn.mock.calls.some(([sql]) => sql === CATALOG_GATE_FAILURES_SQL)).toBe(false);
    expect(result.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2', 'e3']);
  });
  test('shadow: counts the catalog failure and the donation, drops nothing', async () => {
    process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE = 'shadow';
    const result = await read(queryFnFor(staleFails));
    expect(result.edges).toHaveLength(3);
    expect(result.diagnostics).toMatchObject({ catalog_gate_failed_count: 2, catalog_gate_dropped_count: 0 });
  });
  test('enforce: drops them', async () => {
    process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE = 'enforce';
    const result = await read(queryFnFor(staleFails));
    expect(result.edges.map((e) => e.id)).toEqual(['e1']);
    expect(result.diagnostics).toMatchObject({ catalog_gate_failed_count: 2, catalog_gate_dropped_count: 2 });
  });
  test('a gate error: shadow serves unchanged, enforce fails the read', async () => {
    const broken = () => { throw new Error('gate down'); };
    process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE = 'shadow';
    const shadow = await read(queryFnFor(broken));
    expect(shadow.edges).toHaveLength(3);
    expect(shadow.diagnostics.catalog_gate_status).toBe('error');
    process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE = 'enforce';
    await expect(read(queryFnFor(broken))).rejects.toThrow('gate down');
  });
});

describe('review selection skips non-product labels and refills the batch', () => {
  const label = (id, name) => ({ id, anchor_ref: 'product:a', anchor_snapshot: { name: 'Daily Barrier Face Serum' },
    candidate_product_ref: `product:${id}`, candidate_snapshot: { name }, relation_type: 'competitive_alternative',
    label_state: 'generated', score_total: 0.8 });
  test('a donation is skipped without a write and the next page fills its slot', async () => {
    const all = [label('c1', 'Heart To Tarte Donation'), label('c2', 'Barrier Serum'), label('c3', 'Hydra Serum')];
    const queryFn = jest.fn(async (sql, params) => {
      if (/FROM relationship_candidate_labels/.test(sql)) {
        const limit = params[2];
        const offset = /OFFSET/.test(sql) ? params[params.length - 1] : 0;
        return { rows: all.slice(offset, offset + limit) };
      }
      if (/UPDATE|INSERT/.test(sql)) throw new Error('no writes expected');
      return { rows: [] };
    });
    const selection = await selectReviewCandidates({ limit: 2, queryFn, fetchOptions: { cutoff: '2026-01-01', minScore: 0 },
      supplementsFn: async () => new Map() });
    expect(selection.rows.map((r) => r.id)).toEqual(['c2', 'c3']);
    expect(selection.nonProductSkippedIds).toEqual(['c1']);
  });
});

describe('consensus review skips a non-product label before either reviewer sees it', () => {
  const savedApply = process.env.RELGRAPH_AI_REVIEW_APPLY;
  beforeEach(() => { jest.spyOn(process.stdout, 'write').mockImplementation(() => true); process.env.RELGRAPH_AI_REVIEW_APPLY = '1'; });
  afterEach(() => {
    jest.restoreAllMocks();
    if (savedApply === undefined) delete process.env.RELGRAPH_AI_REVIEW_APPLY; else process.env.RELGRAPH_AI_REVIEW_APPLY = savedApply;
  });
  test('no provider call, no write, counted', async () => {
    const row = { id: 'donation_label', anchor_type: 'product', anchor_ref: 'product:a', candidate_product_ref: 'product:b',
      anchor_snapshot: { product_id: 'a', title: 'Barrier Peptide Face Cream' },
      candidate_snapshot: { product_id: 'b', title: 'Round Up Donation' }, relation_type: 'competitive_alternative',
      market: 'US', vertical: 'beauty', score_total: 0.9, label_state: 'generated', source_refs: [] };
    const providers = [['openai', 'gpt-fixture'], ['gemini', 'gemini-2.5-flash']].map(([provider, model]) => ({
      __meta: { provider, model }, analyzeTextToJson: jest.fn() }));
    const queryFn = jest.fn(async (sql) => {
      if (/UPDATE relationship_candidate_labels/.test(sql)) throw new Error('no writes expected');
      return { rows: /FROM relationship_candidate_labels/.test(sql) ? [row] : [] };
    });
    const result = await runReview({ cutoff: '2026-01-01', minScore: 0, limit: 10, reviewMode: 'consensus',
      consensusProviders: providers, queryFn, apply: true });
    expect(providers[0].analyzeTextToJson).not.toHaveBeenCalled();
    expect(result.summary.non_product_listing_skipped_count).toBe(1);
  });
});
