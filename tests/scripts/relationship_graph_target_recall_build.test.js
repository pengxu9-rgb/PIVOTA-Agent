jest.mock('../../src/db', () => ({ query: jest.fn(), closePool: jest.fn(), withClient: jest.fn() }));
jest.mock('../../src/auroraBff/productRelationshipGraphSources', () => ({
  ...jest.requireActual('../../src/auroraBff/productRelationshipGraphSources'),
  loadProductRelationshipGraphSourceInputs: jest.fn(),
  buildCandidatesByAnchorFromSources: jest.fn(),
  enrichProductRelationshipGraphProducts: jest.fn(),
}));
jest.mock('../../src/auroraBff/productRelationshipGraphTargetRecall', () => ({
  ...jest.requireActual('../../src/auroraBff/productRelationshipGraphTargetRecall'),
  loadProductRelationshipGraphTargetRecall: jest.fn(),
}));
const sources = require('../../src/auroraBff/productRelationshipGraphSources');
const recall = require('../../src/auroraBff/productRelationshipGraphTargetRecall');
const { buildInputsFromDb } = require('../../scripts/build-product-relationship-graph');
const a = { product_ref: 'product:anchor', product_key: 'a', name: 'Hydrating serum', brand: 'House', category: 'Serum' };
const base = { product_ref: 'product:base', product_key: 'b', name: 'Hydrating serum', brand: 'Other', category: 'Serum' };
const target = { product_ref: 'product:older', product_key: 'old', name: 'Hydrating serum', brand: 'Older', category: 'Serum' };
beforeEach(() => {
  jest.clearAllMocks();
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products: [a, base], intelRows: [] });
  sources.buildCandidatesByAnchorFromSources.mockImplementation((options) =>
    options.productsByAnchor || { [a.product_ref]: [base] });
  sources.enrichProductRelationshipGraphProducts.mockImplementation(async ({ products }) => ({
    products: products.map((product) => ({ ...product, ingredient_text: 'Verified selected-listing ingredients',
      price: 18, price_currency: 'CAD', product_intel: { source: 'exact-target' } })),
    ingredientRows: [], intelRows: [], diagnostics: { exact_target_count: products.length },
  }));
  recall.loadProductRelationshipGraphTargetRecall.mockResolvedValue({ products: [target],
    candidatesByAnchor: { [a.product_ref]: [target] }, diagnostics: { caps: { maxCandidates: 5000 } } });
});

test.each([false, true])('only final selected anchors and candidates are hydrated before rescore (expand %s)', async (expandTargetRecall) => {
  const payload = await buildInputsFromDb({ limit: 1, affectedRefs: ['anchor'], includeNeedNodes: false, expandTargetRecall });
  expect(recall.loadProductRelationshipGraphTargetRecall).toHaveBeenCalledTimes(Number(expandTargetRecall));
  const requested = sources.enrichProductRelationshipGraphProducts.mock.calls[0][0].products.map((product) => product.product_ref);
  expect(requested).toEqual(expandTargetRecall ? [a.product_ref, target.product_ref, base.product_ref] : [a.product_ref, base.product_ref]);
  const rescore = sources.buildCandidatesByAnchorFromSources.mock.calls[1][0];
  expect(rescore.products).toEqual([]);
  expect(rescore.intelRows).toEqual([]);
  expect(rescore.anchors[0]).toMatchObject({ product_ref: a.product_ref, ingredient_text: 'Verified selected-listing ingredients', price_currency: 'CAD' });
  expect(rescore.productsByAnchor[a.product_ref].every((product) => product.product_intel && product.price_currency === 'CAD')).toBe(true);
  expect(payload.anchors[0].product_key).toBe('a');
  expect(payload.sourceDiagnostics.targeted_evidence).toMatchObject({ selection_complete: true, omitted_product_count: 0 });
});

test('hydration cap preserves every selected anchor first and explicitly reports incomplete evidence selection', async () => {
  const candidates = Array.from({ length: 5010 }, (_, index) => ({ ...base, product_ref: `product:target_${index}`, product_key: `target_${index}` }));
  sources.buildCandidatesByAnchorFromSources.mockImplementation((options) => options.productsByAnchor || { [a.product_ref]: candidates });
  const payload = await buildInputsFromDb({ limit: 1, affectedRefs: ['anchor'], includeNeedNodes: false });
  const request = sources.enrichProductRelationshipGraphProducts.mock.calls[0][0];
  expect(request.products).toHaveLength(5000);
  expect(request.products[0]).toBe(a);
  expect(payload.sourceDiagnostics.targeted_evidence).toMatchObject({ requested_product_count: 5011,
    hydration_product_count: 5000, selection_complete: false, omitted_product_count: 11 });
});

test('first-pass pair scores cannot compound during evidence rescore', async () => {
  sources.buildCandidatesByAnchorFromSources.mockImplementation((options) => options.productsByAnchor || {
    [a.product_ref]: [{ ...base, similarity_score: 0.94, score_total: 0.94, score_breakdown: { score_total: 0.94 },
      vector_score: 0.72, curated_pair_evidence: { verified: true }, ingredient_confidence: 0.91 }],
  });
  await buildInputsFromDb({ limit: 1, affectedRefs: ['anchor'], includeNeedNodes: false });
  const targetFacts = sources.enrichProductRelationshipGraphProducts.mock.calls[0][0].products[1];
  expect(targetFacts).not.toHaveProperty('similarity_score');
  expect(targetFacts).not.toHaveProperty('score_total');
  expect(targetFacts).not.toHaveProperty('score_breakdown');
  expect(targetFacts).toMatchObject({ vector_score: 0.72, ingredient_confidence: 0.91, curated_pair_evidence: { verified: true } });
});

test('canonical group aliases hydrate both exact listings independently', async () => {
  const first = { ...a, product_ref: 'product:pg_shared', product_key: 'exact_first', ingredient_text: 'First formula' };
  const second = { ...a, product_ref: 'product:pg_shared', product_key: 'exact_second', ingredient_text: 'Second formula' };
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products: [first, second], intelRows: [] });
  sources.buildCandidatesByAnchorFromSources.mockReturnValue({});
  sources.enrichProductRelationshipGraphProducts.mockImplementation(async ({ products }) => ({
    products: products.map((product) => ({ ...product, ingredient_text: `${product.ingredient_text} verified` })),
    ingredientRows: [], intelRows: [], diagnostics: {},
  }));
  const payload = await buildInputsFromDb({ limit: 2, includeNeedNodes: false });
  expect(sources.enrichProductRelationshipGraphProducts.mock.calls[0][0].products.map((product) => product.product_key))
    .toEqual(['exact_first', 'exact_second']);
  expect(payload.anchors.map((product) => product.ingredient_text)).toEqual(['First formula verified', 'Second formula verified']);
});

test.each([
  ['different stores', { merchant_id: 'store_a', platform: 'shopify' }, { merchant_id: 'store_b', platform: 'shopify' }],
  ['different platforms', { merchant_id: 'store_a', platform: 'shopify' }, { merchant_id: 'store_a', platform: 'wix' }],
  ['unscoped IDs', {}, {}],
])('shared raw product IDs preserve distinct listing identities and evidence (%s)', async (_name, firstScope, secondScope) => {
  const first = { product_ref: 'product:store_a_123', source_product_id: '123', product_id: '123',
    ingredient_text: 'First formula', ...firstScope };
  const second = { product_ref: 'product:store_b_123', source_product_id: '123', product_id: '123',
    ingredient_text: 'Second formula', ...secondScope };
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products: [first, second], intelRows: [] });
  sources.buildCandidatesByAnchorFromSources.mockReturnValue({});
  sources.enrichProductRelationshipGraphProducts.mockImplementation(async ({ products }) => ({
    products: products.map((product) => ({ ...product, ingredient_text: `${product.ingredient_text} verified` })),
    ingredientRows: [], intelRows: [], diagnostics: {},
  }));
  const payload = await buildInputsFromDb({ limit: 2, includeNeedNodes: false });
  expect(sources.enrichProductRelationshipGraphProducts.mock.calls[0][0].products).toEqual([first, second]);
  expect(payload.anchors.map((product) => product.product_ref)).toEqual([first.product_ref, second.product_ref]);
  expect(payload.anchors.map((product) => product.ingredient_text)).toEqual(['First formula verified', 'Second formula verified']);
  expect(payload.anchors.map((product) => product.merchant_id)).toEqual([first.merchant_id, second.merchant_id]);
});

test('one exact listing hydrates once while retaining each original graph alias', async () => {
  const first = { ...a, product_ref: 'product:listing_alias', product_key: 'same_exact_key' };
  const second = { ...a, product_ref: 'product:pg_canonical', product_key: 'same_exact_key' };
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products: [first, second], intelRows: [] });
  sources.buildCandidatesByAnchorFromSources.mockReturnValue({});
  const payload = await buildInputsFromDb({ limit: 2, includeNeedNodes: false });
  expect(sources.enrichProductRelationshipGraphProducts.mock.calls[0][0].products).toEqual([first]);
  expect(payload.anchors.map((product) => product.product_ref)).toEqual([first.product_ref, second.product_ref]);
  expect(payload.anchors.every((product) => product.ingredient_text === 'Verified selected-listing ingredients')).toBe(true);
});

test('an exact listing omitted by the cap cannot borrow a canonical alias formula', async () => {
  const selected = { ...a, product_ref: 'product:pg_shared', product_key: 'exact_selected', ingredient_text: 'Selected formula' };
  const omitted = { ...base, product_ref: 'product:pg_shared', product_key: 'exact_omitted', ingredient_text: 'Different formula' };
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products: [selected, base], intelRows: [] });
  sources.buildCandidatesByAnchorFromSources.mockImplementation((options) => options.productsByAnchor || {
    [selected.product_ref]: [...Array.from({ length: 4999 }, (_, index) =>
      ({ ...base, product_ref: `product:${index}`, product_key: `exact_${index}` })), omitted],
  });
  const payload = await buildInputsFromDb({ limit: 1, includeNeedNodes: false });
  const secondPass = sources.buildCandidatesByAnchorFromSources.mock.calls[1][0];
  const actual = secondPass.productsByAnchor[selected.product_ref].find((product) => product.product_key === 'exact_omitted');
  expect(actual.ingredient_text).toBe('Different formula');
  expect(actual).not.toHaveProperty('product_intel');
  expect(payload.sourceDiagnostics.targeted_evidence).toMatchObject({ selection_complete: false, omitted_product_count: 1 });
});

test('selected need targets receive exact hydrated facts without expanding the affected need lane', async () => {
  const needTarget = { ...base, name: 'Sensitive skin barrier support ceramide repair moisturizer',
    category: 'Moisturizer', description: 'Sensitive skin barrier support ceramide repair moisturizer' };
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products: [a, needTarget], intelRows: [] });
  sources.buildCandidatesByAnchorFromSources.mockReturnValue({});
  const payload = await buildInputsFromDb({ limit: 1, includeNeedNodes: true });
  expect(sources.enrichProductRelationshipGraphProducts.mock.calls[0][0].products.some((product) => product.product_key === needTarget.product_key)).toBe(true);
  const needs = Object.values(payload.needCandidatesById).flat().filter((product) => product.product_key === needTarget.product_key);
  expect(needs.length).toBeGreaterThan(0);
  expect(needs.every((product) => product.ingredient_text === 'Verified selected-listing ingredients')).toBe(true);
});

test('explicit empty scope does no catalog recall or evidence load', async () => {
  const payload = await buildInputsFromDb({ limit: 200, affectedRefs: [], affectedScopeProvided: true, expandTargetRecall: true });
  expect(payload.anchors).toEqual([]);
  expect(sources.loadProductRelationshipGraphSourceInputs).not.toHaveBeenCalled();
  expect(sources.enrichProductRelationshipGraphProducts).not.toHaveBeenCalled();
  expect(recall.loadProductRelationshipGraphTargetRecall).not.toHaveBeenCalled();
});
