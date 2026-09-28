const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';

const app = require('../src/server');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');

const { scoreBeautyExternalSeedProduct, inferBeautyMainlineIntent } = app._debug;

// Family-less beauty queries ("self tanner", a brand name) require every row to carry a
// text "beauty product" signal. The text classifier has no tanning vocabulary, so on prod
// (2026-09-25) 14 of the 17 Bondi Sands tanning rows scored -30 and were dropped; the 3
// served survived only because "no added fragrance" bucketed them as fragrance.
// BEAUTY_RANKER_CATALOG_LEAF_SIGNAL_ENABLED lets the row's own beauty LEAF path count.

const FLAG = 'BEAUTY_RANKER_CATALOG_LEAF_SIGNAL_ENABLED';

function withFlag(value, fn) {
  const prev = process.env[FLAG];
  if (value === null) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

// Shape of a prod canonical_chain tanning row (title/description verbatim in spirit:
// no skincare, makeup or fragrance word anywhere in the text).
function tanningRow(overrides = {}) {
  return {
    id: 'ext:bondi-sands-express-self-tanning-foam::test',
    product_id: 'ext:bondi-sands-express-self-tanning-foam::test',
    title: 'Express Self Tanning Foam',
    brand: 'Bondi Sands',
    vendor: 'Bondi Sands',
    description: 'Get a deep, natural-looking tan in just one hour. Lightweight foam, streak-free finish.',
    product_type: 'tanning',
    category: 'tanning',
    category_path: ['beauty', 'body', 'tanning'],
    catalog_category_path: 'beauty/body/tanning',
    source: 'canonical_chain',
    price: 22,
    currency: 'USD',
    image_url: 'https://cdn.example.test/foam.png',
    ...overrides,
  };
}

function score(query, product) {
  const contract = buildSearchQualityContract({ rawQuery: query, source: 'shopping-agent-ui' });
  const intent = inferBeautyMainlineIntent(query);
  return scoreBeautyExternalSeedProduct({
    product,
    queryText: query,
    intent,
    normalizedQuery: query,
    queryTokens: query.split(' '),
    searchQualityContract: contract,
  });
}

test('premise: "self tanner" is family-less and the row carries no text beauty signal', () => {
  const intent = inferBeautyMainlineIntent('self tanner');
  assert.deepEqual(intent.families || [], []);
});

test('flag OFF: the tanning leaf row is dropped at -30 (today\'s behaviour, pinned)', () => {
  const out = withFlag(null, () => score('self tanner', tanningRow()));
  assert.equal(out.relevant, false);
  assert.equal(out.score, -30);
});

test('flag ON: the same row is kept on its own beauty leaf path', () => {
  const out = withFlag('true', () => score('self tanner', tanningRow()));
  assert.equal(out.relevant, true, JSON.stringify(out.rejection_reasons || out.score));
});

test('flag ON: a bare `beauty` path is not a leaf and still needs text evidence', () => {
  // Contract-free on purpose: under the "self tanner" contract the category gate would
  // reject this row first, and the test would pass without touching the leaf rule.
  const row = tanningRow({ category_path: ['beauty'], catalog_category_path: 'beauty' });
  assert.equal(withFlag('true', () => leafGateScore(row)), -30);
});

test('flag ON: a two-segment ancestor (beauty/body) is not a leaf either', () => {
  // Contract-free (see leafGateScore): the assertion is about the leaf rule, not the category gate.
  const row = tanningRow({ category_path: ['beauty', 'body'], catalog_category_path: 'beauty/body' });
  assert.equal(withFlag('true', () => leafGateScore(row)), -30);
});

test('flag ON: a non-beauty leaf path grants nothing', () => {
  const row = tanningRow({ category_path: ['home', 'kitchen', 'mugs'], catalog_category_path: 'home/kitchen/mugs' });
  assert.equal(withFlag('true', () => leafGateScore(row)), -30);
});

test('flag ON: a family query still applies the family gate (a tanning row is not a serum)', () => {
  // Contract-free so the rejection is the FAMILY gate (-40), not the category gate.
  const intent = inferBeautyMainlineIntent('vitamin c serum');
  assert.ok((intent.families || []).length > 0, 'premise: the query has a family');
  const out = withFlag('true', () =>
    scoreBeautyExternalSeedProduct({
      product: tanningRow(),
      queryText: 'vitamin c serum',
      intent,
      normalizedQuery: 'vitamin c serum',
      queryTokens: ['vitamin', 'c', 'serum'],
      searchQualityContract: null,
    }),
  );
  assert.equal(out.relevant, false);
  assert.equal(out.score, -40);
});

test('CONTROL: a row WITH a text signal is kept with the flag off', () => {
  const out = withFlag(null, () =>
    score('self tanner', tanningRow({ description: 'Self tanning face serum, non-comedogenic, fragrance free.' })),
  );
  assert.equal(out.relevant, true);
});

// The leaf rule in isolation, through the scorer: a family-less, category-less query
// ("bondi sands" with the catalog-brand flag off is ambiguous, so use the scorer with no
// contract) exercises only the -30 gate.
function scoreFamilyless(product) {
  const intent = inferBeautyMainlineIntent('bondi sands');
  return scoreBeautyExternalSeedProduct({
    product,
    queryText: 'bondi sands',
    intent,
    normalizedQuery: 'bondi sands',
    queryTokens: ['bondi', 'sands'],
    searchQualityContract: null,
  });
}
function beautyLeaf(product) {
  return scoreFamilyless(product).relevant === true;
}
// The -30 score is the product-signal gate's own; any other rejection has another score.
function leafGateScore(product) {
  const out = scoreFamilyless(product);
  return out.relevant === true ? 'kept' : out.score;
}

test('flag ON: through the contract-free path, a beauty leaf row is kept (sanity for the helper tests)', () => {
  assert.equal(withFlag('true', () => beautyLeaf(tanningRow())), true);
  assert.equal(withFlag(null, () => beautyLeaf(tanningRow())), false);
});
