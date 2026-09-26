const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';

const app = require('../src/server');
const { buildSearchQualityContract, isStrictShaveQuery } = require('../src/findProductsMulti/queryUnderstanding');

const { scoreBeautyExternalSeedProduct, inferBeautyMainlineIntent, getSearchQualityContractHardConstraintResult } =
  app._debug;

// Measured 2026-09-26 on gateway-00396-xuj (MCP search_catalog, market US): "shaving cream"
// routes to beauty/skincare/moisturize/ (there is no men's-grooming leaf) and served 1 shave
// cream and 19 face creams. Only 3 shave products are servable in the whole catalog. A shave
// query now keeps only rows whose title/name/URL names shaving.

const FLAG = 'BEAUTY_RANKER_CATALOG_LEAF_SIGNAL_ENABLED';

// Both rows copied from the live search_catalog response for "shaving cream"; descriptions trimmed.
function shaveCreamRow() {
  return {
    id: 'sig_4601574cbdad30084f69f9fea78d1d7f',
    product_id: 'sig_4601574cbdad30084f69f9fea78d1d7f',
    merchant_id: 'merch_obs_69c4c9677181397c',
    platform: 'external_seed',
    title: 'Smooth Shave Cream',
    description: 'The First Aid Beauty Smooth Shaving Cream is a fragrance-free, skin-loving shaving cream.',
    price: 36,
    currency: 'USD',
    availability: 'in_stock',
    in_stock: true,
    product_type: 'cream',
    category: null,
    category_path: ['beauty', 'skincare', 'moisturize', 'cream'],
    catalog_category_path: 'beauty/skincare/moisturize/cream',
    source: 'canonical_chain',
    brand: 'First Aid Beauty',
    vendor: 'First Aid Beauty',
    destination_url: 'https://www.firstaidbeauty.com/products/smooth-shave-cream',
  };
}

function faceCreamRow(overrides = {}) {
  return {
    id: 'sig_f58ba8d0d2b3976a512b21026985b76f',
    product_id: 'sig_f58ba8d0d2b3976a512b21026985b76f',
    merchant_id: 'merch_obs_22a84ab657ced8ee',
    platform: 'external_seed',
    title: 'Radian-C Cream',
    description: 'A gentle daily Korean moisturizer, enriched with vitamins C and E to visibly brighten your skin.',
    price: 35,
    currency: 'USD',
    availability: 'in_stock',
    in_stock: true,
    product_type: 'cream',
    category: 'cream',
    category_path: ['beauty', 'skincare', 'moisturize', 'cream'],
    catalog_category_path: 'beauty/skincare/moisturize/cream',
    source: 'canonical_chain',
    brand: 'LANEIGE US',
    vendor: 'LANEIGE US',
    destination_url: 'https://us.laneige.com/products/radian-c-cream',
    ...overrides,
  };
}

function gate(query, product) {
  const prev = process.env[FLAG];
  process.env[FLAG] = '1'; // prod value
  try {
    const contract = buildSearchQualityContract({ rawQuery: query, source: 'shopping-agent-ui', market: 'US' });
    return {
      contract,
      hard: getSearchQualityContractHardConstraintResult(product, contract, query),
      ranked: scoreBeautyExternalSeedProduct({
        product,
        queryText: query,
        intent: inferBeautyMainlineIntent(query),
        normalizedQuery: query,
        queryTokens: query.split(' '),
        searchQualityContract: contract,
      }),
    };
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

for (const query of ['shaving cream', 'shave cream', 'shave gel', 'aftershave balm', 'after-shave lotion', 'pre-shave oil']) {
  test(`"${query}" is a strict shave query`, () => {
    assert.equal(isStrictShaveQuery(query), true);
  });
}

for (const query of ['face cream', 'shaved ice', 'electric shaver', 'shampoo', 'curl cream']) {
  test(`"${query}" is not a strict shave query`, () => {
    assert.equal(isStrictShaveQuery(query), false);
  });
}

test('shaving cream: the contract carries strict_shave and still browses its resolved path', () => {
  const { contract } = gate('shaving cream', shaveCreamRow());
  assert.equal(contract.hard_constraints.strict_shave, true);
  assert.ok(contract.hard_constraints.exclusions.includes('product_not_named_for_shaving'));
  assert.equal(contract.hard_constraints.category_path_prefix, 'beauty/skincare/moisturize/');
});

test('shaving cream: the real shave cream passes both the contract and the ranker', () => {
  const { hard, ranked } = gate('shaving cream', shaveCreamRow());
  assert.equal(hard.eligible, true, JSON.stringify(hard));
  assert.equal(ranked.relevant, true, JSON.stringify(ranked));
});

test('shaving cream: a face cream is rejected by both the contract and the ranker', () => {
  const { hard, ranked } = gate('shaving cream', faceCreamRow());
  assert.equal(hard.eligible, false);
  assert.ok(hard.reasons.includes('strict_shave_mismatch'), JSON.stringify(hard.reasons));
  assert.equal(ranked.relevant, false);
});

test('shaving cream: a description that mentions shaving does not make a face cream a shave product', () => {
  const row = faceCreamRow({ description: 'A soothing moisturizer, ideal after shaving.' });
  const { hard, ranked } = gate('shaving cream', row);
  assert.equal(hard.eligible, false);
  assert.equal(ranked.relevant, false);
});

test('control: "face cream" has no strict_shave and still keeps the face cream', () => {
  const { contract, hard, ranked } = gate('face cream', faceCreamRow());
  assert.equal(contract.hard_constraints.strict_shave, false);
  assert.equal(hard.eligible, true, JSON.stringify(hard));
  assert.equal(ranked.relevant, true, JSON.stringify(ranked));
});

test('shaving cream without an enforced contract: the ranker alone still drops the face cream', () => {
  // The mainline passes the contract only when enforcement is on (searchQualityEnforced);
  // otherwise it passes null, and the ranker's own strict-shave check is the only gate.
  const prev = process.env[FLAG];
  process.env[FLAG] = '1';
  try {
    const score = (product) => scoreBeautyExternalSeedProduct({
      product,
      queryText: 'shaving cream',
      intent: inferBeautyMainlineIntent('shaving cream'),
      normalizedQuery: 'shaving cream',
      queryTokens: ['shaving', 'cream'],
      searchQualityContract: null,
    });
    assert.equal(score(faceCreamRow()).relevant, false);
    assert.equal(score(shaveCreamRow()).relevant, true);
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
});
