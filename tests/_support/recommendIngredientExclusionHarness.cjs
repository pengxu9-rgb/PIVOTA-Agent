'use strict';

// One fixed recommend_products run per `avoid` request shape, with every dependency stubbed and recorded.
// tests/fixtures/recommend_ingredient_exclusion_answers.json holds what this harness recorded against
// 4885ec01d (before reviewed ingredient exclusions existed) and against 6c55a6aad (the exclusion live and
// ungated). The flag test replays it here: off must equal the first, on must equal the second. Keep this file
// byte-stable; a change to it needs both recordings redone from those two commits.

const item = (id, currency, amount, sku = {}) => ({
  step: 'serum', score: 70, name: `Placeholder Serum ${id}`,
  sku: { product_id: id, name: `Placeholder Serum ${id}`, merchant_id: 'merchant-1', ...sku },
  merchant_id: 'merchant-1', reasons: ['hydrates', 'Within your budget'],
  price: { amount, currency }, url: `https://shop.example/p/${id}`,
});

const ITEMS = [
  item('sig_usd', 'USD', 20),
  item('sig_gbp', 'GBP', 18),
  item('sig_variant', 'USD', 15, { variant_id: 'variant-2' }),
  item('sig_present', 'USD', 22),
];

const LIVE = {
  sig_usd: { price: 21, currency: 'USD' },
  sig_gbp: { price: 18, currency: 'GBP' },
  sig_variant: null,
  sig_present: { price: 22, currency: 'USD' },
};

const CLEAN = 'Water, Glycerin, Panthenol, Butylene Glycol, Phenoxyethanol';
const FORMULAS = {
  sig_usd: CLEAN,
  sig_gbp: CLEAN,
  sig_variant: CLEAN,
  sig_present: `Water, Parfum, Snail Secretion Filtrate, ${CLEAN}`,
};

const SCENARIOS = Object.freeze([
  ['avoid_list', { avoid: ['fragrance'] }],
  ['avoid_two_supported', { avoid: ['fragrance', 'snail mucin'] }],
  ['avoid_with_unsupported', { avoid: ['fragrance', 'alcohol'] }],
  ['avoid_string', { avoid: 'fragrance, snail mucin' }],
  ['avoid_empty_string', { avoid: '' }],
  ['avoid_with_price', { avoid: ['snail mucin'], price_max: 25, currency: 'USD' }],
  ['avoid_with_texture', { avoid: ['fragrance'], texture: 'gel', skin_type: 'sensitive' }],
]);

const clone = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));

async function runScenario(makeRecommendProducts, constraints, { loaderThrows = false } = {}) {
  let n = 0;
  const record = { askArgs: [], generateArgs: [], verifyCalls: [], loaderCalls: [] };
  const recommend = makeRecommendProducts({
    generate: async (args) => {
      const seen = clone(args);
      // The lane's request id is random per call; it is not part of the answer.
      if (seen && seen.ctx) for (const key of ['request_id', 'trace_id']) if (key in seen.ctx) seen.ctx[key] = '<random>';
      record.generateArgs.push(seen);
      return { norm: { payload: { recommendations: clone(ITEMS), confidence: 0.7, missing_info: [], warnings: [],
        grounding_status: 'grounded', recommendation_meta: { confidence_basis: 'model_self_report' } } } };
    },
    buildAsk: (args) => {
      record.askArgs.push(clone(args));
      return `ASK ${JSON.stringify(args.constraints)}`;
    },
    newId: () => String(++n).padStart(24, '0'),
    now: () => 1000,
    isEnabled: () => true,
    verifyPrice: async (args) => {
      record.verifyCalls.push(clone(args));
      return clone(LIVE[args.product_id]);
    },
    loadIngredientFormulas: async (refs, market) => {
      record.loaderCalls.push(clone({ refs, market }));
      if (loaderThrows) throw new Error('evidence unavailable');
      return refs.map((ref) => ({ ingredientText: FORMULAS[ref.product_id], sourceUrl: `https://brand.example/formula/${ref.product_id}`, market }));
    },
  });
  record.out = clone(await recommend({ need: 'a hydrating serum for dry skin', constraints, limit: 4 }));
  return record;
}

async function recordAll(makeRecommendProducts) {
  const out = {};
  for (const [name, constraints] of SCENARIOS) out[name] = await runScenario(makeRecommendProducts, constraints);
  return out;
}

module.exports = { SCENARIOS, runScenario, recordAll };
