const test = require('node:test');
const assert = require('node:assert/strict');

const { runRecoHybridResolveCandidates, __internal } = require('../src/auroraBff/usecases/recoHybridResolveCandidates');

function makeRequest(overrides = {}) {
  return {
    context: {
      locale: 'en-US',
      profile: {},
      ...(overrides.context || {}),
    },
    params: {
      target_step: 'mask',
      ...(overrides.params || {}),
    },
  };
}

function makeCandidateOutput(products) {
  return {
    answer_en: 'Here are product seeds to start from.',
    answer_zh: null,
    products,
  };
}

test('hybrid resolver keeps only exact internal row when exact resolve succeeds', async () => {
  const result = await runRecoHybridResolveCandidates({
    request: makeRequest(),
    candidateOutput: makeCandidateOutput([
      {
        brand: 'Winona',
        name: 'Hydrating Repair Mask',
        product_type: 'mask',
        why: { en: 'Supports barrier comfort.', zh: null },
        suitability_score: 0.88,
        price_tier: 'mid',
        search_aliases: ['winona hydrating repair mask'],
      },
    ]),
    deps: {
      async resolveProduct() {
        return {
          ok: true,
          transient: false,
          product: {
            product_id: 'prod_mask_1',
            merchant_id: 'merchant_mask_1',
            canonical_product_ref: { product_id: 'prod_mask_1', merchant_id: 'merchant_mask_1' },
            brand: 'Winona',
            name: 'Hydrating Repair Mask',
            category: 'mask',
          },
        };
      },
      async searchProducts() {
        throw new Error('should not search when exact resolve hits');
      },
    },
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].match_state, 'exact');
  assert.equal(result.rows[0].product_id, 'prod_mask_1');
  assert.equal(result.recommendation_meta.exact_match_count, 1);
  assert.equal(result.recommendation_meta.unresolved_seed_count, 0);
});

test('hybrid resolver preserves internal group targets from exact offers-style resolve results', async () => {
  const result = await runRecoHybridResolveCandidates({
    request: makeRequest(),
    candidateOutput: makeCandidateOutput([
      {
        brand: 'Laneige',
        name: 'Water Sleeping Mask',
        product_type: 'mask',
        why: { en: 'Good for overnight hydration.', zh: null },
        suitability_score: 0.86,
        search_aliases: ['laneige water sleeping mask'],
      },
    ]),
    deps: {
      async resolveProduct() {
        return {
          ok: true,
          transient: false,
          product: {
            product_group_id: 'pg_mask_1',
            canonical_product_ref: { product_id: 'prod_mask_group_1', merchant_id: 'merchant_mask_group_1' },
            brand: 'Laneige',
            name: 'Water Sleeping Mask',
            category: 'mask',
          },
        };
      },
      async searchProducts() {
        throw new Error('should not search when exact resolve hits');
      },
    },
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].match_state, 'exact');
  assert.equal(result.rows[0].subject_product_group_id, 'pg_mask_1');
  assert.equal(result.rows[0].pdp_open?.path, 'group');
});

test('hybrid resolver keeps fuzzy internal row plus raw llm seed when exact resolve misses', async () => {
  const result = await runRecoHybridResolveCandidates({
    request: makeRequest(),
    candidateOutput: makeCandidateOutput([
      {
        brand: 'Avene',
        name: 'Soothing Radiance Mask',
        product_type: 'mask',
        why: { en: 'Calms visible irritation.', zh: null },
        suitability_score: 0.82,
        price_tier: 'mid',
        search_aliases: ['avene soothing radiance mask'],
      },
    ]),
    deps: {
      async resolveProduct() {
        return { ok: false, transient: false, product: null };
      },
      async searchProducts() {
        return {
          ok: true,
          transient: false,
          products: [
            {
              product_id: 'prod_mask_2',
              merchant_id: 'merchant_mask_2',
              canonical_product_ref: { product_id: 'prod_mask_2', merchant_id: 'merchant_mask_2' },
              brand: 'Avène',
              name: 'Soothing Radiance Mask',
              category: 'mask',
            },
          ],
        };
      },
    },
  });

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].match_state, 'fuzzy');
  assert.equal(result.rows[1].match_state, 'llm_seed');
  assert.equal(result.rows[1].pdp_open?.path, 'external');
  assert.equal(result.recommendation_meta.fuzzy_match_count, 1);
  assert.equal(result.recommendation_meta.unresolved_seed_count, 0);
});

test('hybrid resolver keeps external raw seed when exact and fuzzy both miss', async () => {
  const result = await runRecoHybridResolveCandidates({
    request: makeRequest(),
    candidateOutput: makeCandidateOutput([
      {
        brand: 'Unknown',
        name: 'Impossible Recovery Mask',
        product_type: 'mask',
        why: { en: 'A backup seed.', zh: null },
        suitability_score: 0.61,
        price_tier: 'mid',
        search_aliases: ['impossible recovery mask'],
      },
    ]),
    deps: {
      async resolveProduct() {
        return { ok: false, transient: false, product: null };
      },
      async searchProducts() {
        return { ok: true, transient: false, products: [] };
      },
    },
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].match_state, 'llm_seed');
  assert.equal(result.rows[0].pdp_open?.path, 'external');
  assert.equal(result.recommendation_meta.unresolved_seed_count, 1);
});

test('hybrid resolver does not turn transient resolver/search errors into generic catalog rows', async () => {
  const result = await runRecoHybridResolveCandidates({
    request: makeRequest(),
    candidateOutput: makeCandidateOutput([
      {
        brand: 'La Roche-Posay',
        name: 'Cicaplast B5 Mask',
        product_type: 'mask',
        why: { en: 'Good for barrier support.', zh: null },
        suitability_score: 0.85,
        price_tier: 'mid',
        search_aliases: ['cicaplast b5 mask'],
      },
    ]),
    deps: {
      async resolveProduct() {
        return { ok: false, transient: true, product: null };
      },
      async searchProducts() {
        throw new Error('should not search after transient resolve failure');
      },
    },
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].match_state, 'llm_seed');
  assert.equal(result.rows[0].product_id, undefined);
});

test('hybrid resolver fuzzy scoring rejects non-skincare items like makeup brushes', () => {
  const score = __internal.scoreFuzzyCandidate({
    seed: __internal.normalizeSeed(
      {
        brand: 'Winona',
        name: 'Hydrating Repair Mask',
        product_type: 'mask',
        why: { en: 'Supports hydration.', zh: null },
        suitability_score: 0.8,
        search_aliases: ['winona hydrating repair mask'],
      },
      0,
    ),
    product: __internal.normalizeProduct({
      product_id: 'brush_1',
      merchant_id: 'merchant_1',
      brand: 'Random',
      name: 'Small Eyeshadow Brush',
      category: 'Makeup Brush',
    }),
    targetStep: 'mask',
    targetIngredient: '',
  });

  assert.equal(score, 0);
});

test('hybrid resolver can keep internal similar products when names differ but concern and step align', async () => {
  const result = await runRecoHybridResolveCandidates({
    request: makeRequest({
      params: {
        target_step: 'mask',
        _extracted_concerns: ['hydration', 'barrier repair'],
      },
    }),
    candidateOutput: makeCandidateOutput([
      {
        brand: 'Summer Fridays',
        name: 'Jet Lag Mask',
        product_type: 'mask',
        why: { en: 'Hydrates and helps support the skin barrier.', zh: null },
        suitability_score: 0.84,
        search_aliases: ['summer fridays jet lag mask'],
      },
    ]),
    deps: {
      async resolveProduct() {
        return { ok: false, transient: false, product: null };
      },
      async searchProducts() {
        return {
          ok: true,
          transient: false,
          products: [
            {
              product_id: 'prod_mask_barrier_1',
              merchant_id: 'merchant_mask_barrier_1',
              canonical_product_ref: { product_id: 'prod_mask_barrier_1', merchant_id: 'merchant_mask_barrier_1' },
              brand: 'Pivota',
              name: 'Overnight Barrier Repair Mask',
              category: 'mask',
              tags: ['hydration', 'barrier repair'],
            },
          ],
        };
      },
    },
  });

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].match_state, 'fuzzy');
  assert.equal(result.rows[0].product_id, 'prod_mask_barrier_1');
  assert.equal(result.recommendation_meta.fuzzy_match_count, 1);
});

test('normalizeProduct accepts legacy catalog rows with nested refs and group ids', () => {
  const normalized = __internal.normalizeProduct({
    title: 'Overnight Recovery Mask',
    brand_name: 'Legacy Brand',
    merchant: { merchant_id: 'merchant_legacy_1' },
    subject: { product_group_id: 'group_legacy_1', category: 'mask' },
    product_ref: { product_id: 'prod_legacy_1', merchant_id: 'merchant_legacy_1' },
    pdp_open: {
      path: 'ref',
      product_ref: { product_id: 'prod_legacy_1', merchant_id: 'merchant_legacy_1' },
    },
    topic_keywords: ['hydration'],
    ingredient_tokens: ['ceramide'],
  });

  assert.equal(normalized.product_id, 'prod_legacy_1');
  assert.equal(normalized.product_group_id, 'group_legacy_1');
  assert.equal(normalized.category, 'mask');
  assert.equal(normalized.canonical_product_ref?.product_id, 'prod_legacy_1');
  assert.equal(normalized.pdp_open?.path, 'ref');
  assert.deepEqual(normalized.ingredients, ['ceramide']);
});

test('hybrid resolver caps six seeds to at most twelve displayed rows', async () => {
  const products = Array.from({ length: 6 }, (_, index) => ({
    brand: `Brand${index}`,
    name: `Mask ${index}`,
    product_type: 'mask',
    why: { en: `Mask ${index} fits the request.`, zh: null },
    suitability_score: 0.8,
    price_tier: 'mid',
    search_aliases: [`brand${index} mask ${index}`],
  }));

  const result = await runRecoHybridResolveCandidates({
    request: makeRequest(),
    candidateOutput: makeCandidateOutput(products),
    deps: {
      async resolveProduct() {
        return { ok: false, transient: false, product: null };
      },
      async searchProducts({ query }) {
        const token = String(query || '').replace(/\s+/g, '_').toLowerCase();
        return {
          ok: true,
          transient: false,
          products: [
            {
              product_id: `prod_${token}`,
              merchant_id: `merchant_${token}`,
              canonical_product_ref: { product_id: `prod_${token}`, merchant_id: `merchant_${token}` },
              brand: `Brand ${token}`,
              name: String(query || ''),
              category: 'mask',
            },
          ],
        };
      },
    },
  });

  assert.equal(result.rows.length, 12);
});
