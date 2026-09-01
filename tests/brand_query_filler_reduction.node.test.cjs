'use strict';

// Unit cover for reduceBrandOnlyQuery, the vocabulary half of the agent-UI brand-recall fix.
// The delivery half — that policy.js actually sends the reduced query upstream — is pinned in
// tests/find_products_multi_context.test.js through buildFindProductsMultiContext.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reduceBrandOnlyQuery,
  hoistDetectedBrandProducts,
  productMatchesDetectedBrand,
  BRAND_QUERY_FILLER_TOKENS,
} = require('../src/findProductsMulti/brandLexicon');

test('the live repro: a brand wrapped in filler is a bare brand query in disguise', () => {
  assert.deepEqual(reduceBrandOnlyQuery('show me Murad products', ['murad']), {
    bare: false,
    fillerOnly: true,
    query: 'Murad',
  });
  assert.deepEqual(reduceBrandOnlyQuery('Murad products', ['murad']), {
    bare: false,
    fillerOnly: true,
    query: 'Murad',
  });
});

test('the bare verdict is unchanged — that path already worked and must stay byte-identical', () => {
  assert.deepEqual(reduceBrandOnlyQuery('Murad', ['murad']), {
    bare: true,
    fillerOnly: false,
    query: 'Murad',
  });
  // Punctuation and case are normalized for the VERDICT but never for the returned query.
  assert.deepEqual(reduceBrandOnlyQuery('MURAD!', ['murad']), {
    bare: true,
    fillerOnly: false,
    query: 'MURAD!',
  });
});

test('a real token is never filler, however small', () => {
  // This is the boundary the whole fix rests on: reducing a query that names a category would
  // silently delete a constraint the user typed.
  for (const query of [
    'Murad cleanser',
    'show me Murad cleanser',
    'Murad serum for dry skin',
    'cheap Murad',
    'best Murad',
    'new Murad',
    'Murad sale',
  ]) {
    const result = reduceBrandOnlyQuery(query, ['murad']);
    assert.equal(result.fillerOnly, false, `${query} must not reduce`);
    assert.equal(result.bare, false);
  }
});

test('the query is the brand AS TYPED — never the normalized catalog span', () => {
  // The detected entity is a lowercased dictionary span. Echoing it back would put words in the
  // user's mouth and would break multi-word brands whose display casing matters.
  assert.equal(reduceBrandOnlyQuery('show me CeraVe products', ['cerave']).query, 'CeraVe');
  assert.equal(
    reduceBrandOnlyQuery('show me The Ordinary products', ['the ordinary']).query,
    'The Ordinary',
  );
});

test('token order is the order the user typed, across multiple brands', () => {
  assert.deepEqual(reduceBrandOnlyQuery('show me Dior and Chanel products', ['dior', 'chanel']), {
    bare: false,
    fillerOnly: true,
    query: 'Dior Chanel',
  });
});

test('no brand token present means no opinion at all', () => {
  assert.equal(reduceBrandOnlyQuery('show me products', ['murad']), null);
  assert.equal(reduceBrandOnlyQuery('show me Murad products', []), null);
  assert.equal(reduceBrandOnlyQuery('', ['murad']), null);
  assert.equal(reduceBrandOnlyQuery(null, ['murad']), null);
});

test('non-ASCII remainder tokens count as real evidence', () => {
  // The guard this function replaced carried a review finding: "uniqlo 连衣裙" must keep its
  // expansion. An English filler list is blind to user-typed CJK, so those tokens must never be
  // mistaken for filler.
  const result = reduceBrandOnlyQuery('uniqlo 连衣裙', ['uniqlo']);
  assert.equal(result.fillerOnly, false);
  assert.equal(result.bare, false);
});

test('the filler list holds no token that could steer retrieval', () => {
  // A wrong entry here silently deletes a constraint, so the list is asserted, not just trusted.
  // Ranking, recency, price and every category noun must be absent.
  for (const forbidden of [
    'new', 'best', 'top', 'cheap', 'sale', 'discount', 'gift', 'mini', 'travel', 'set',
    'cleanser', 'serum', 'toner', 'moisturizer', 'sunscreen', 'blush', 'lipstick', 'mask',
    'shampoo', 'cream', 'oil', 'men', 'women', 'kids',
  ]) {
    assert.equal(
      BRAND_QUERY_FILLER_TOKENS.has(forbidden),
      false,
      `"${forbidden}" steers retrieval and must never be treated as filler`,
    );
  }
});

test('every filler token is normalized the same way the matcher normalizes query tokens', () => {
  // An entry with punctuation or an uppercase letter could never match, so it would be a silent
  // no-op sitting in the list looking like coverage.
  for (const token of BRAND_QUERY_FILLER_TOKENS) {
    assert.equal(
      token,
      token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''),
      `filler token "${token}" can never match a normalized query token`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Result-side brand scoping. Carrying the brand into the query is not the same as making it a
// constraint on the answer; this is the pass that does the second thing.

const row = (id, brand, extra = {}) => ({ id, title: `${brand || 'unbranded'} thing`, brand, ...extra });

test('the named brand is lifted to the front, and every product is returned', () => {
  const products = [row('a', 'Pixi Beauty'), row('b', 'CeraVe'), row('c', 'The Ordinary'), row('d', 'CeraVe')];
  const result = hoistDetectedBrandProducts(products, ['cerave']);
  assert.deepEqual(result.products.map((p) => p.id), ['b', 'd', 'a', 'c']);
  assert.equal(result.products.length, products.length, 'hoist, never truncate');
  assert.deepEqual({ matched: result.matched, applied: result.applied }, { matched: 2, applied: true });
});

test('a brand absent from the page produces NO opinion — the safety property', () => {
  // A false-positive detection may cost ranking position. It must never empty or reshuffle a page.
  const products = [row('a', 'Pixi Beauty'), row('b', 'The Ordinary')];
  const result = hoistDetectedBrandProducts(products, ['cerave']);
  assert.deepEqual(result.products, products);
  assert.deepEqual({ matched: result.matched, applied: result.applied }, { matched: 0, applied: false });
});

test('an all-on-brand page reports no work rather than phantom work', () => {
  const products = [row('a', 'CeraVe'), row('b', 'CeraVe')];
  const result = hoistDetectedBrandProducts(products, ['cerave']);
  assert.deepEqual(result.products, products);
  assert.equal(result.applied, false);
});

test('vendor answers when brand is empty; neither means never hoisted', () => {
  const products = [
    row('a', 'Pixi Beauty'),
    { id: 'b', title: 'CeraVe Foaming Cleanser', vendor: 'CeraVe' },
    { id: 'c', title: 'CeraVe dupe foaming cleanser' },
  ];
  const result = hoistDetectedBrandProducts(products, ['cerave']);
  // 'c' names the brand in its TITLE only — that is where "dupe" gets written, so it stays put.
  assert.deepEqual(result.products.map((p) => p.id), ['b', 'a', 'c']);
  assert.equal(result.matched, 1);
});

test('brand matching is the canonical matcher, not a substring test', () => {
  assert.equal(productMatchesDetectedBrand({ brand: 'CeraVe' }, ['cerave']), true);
  assert.equal(productMatchesDetectedBrand({ brand: 'Tom Ford Beauty' }, ['tom ford']), true);
  assert.equal(productMatchesDetectedBrand({ brand: 'Tomford' }, ['tom ford']), true);
  // A brand that merely CONTAINS the alias inside a longer token is a different company.
  assert.equal(productMatchesDetectedBrand({ brand: 'Naris Cosmetics' }, ['nars']), false);
  assert.equal(productMatchesDetectedBrand({ brand: '' }, ['cerave']), false);
  assert.equal(productMatchesDetectedBrand(null, ['cerave']), false);
});

test('no brands, or nothing to reorder, is a no-op', () => {
  const products = [row('a', 'CeraVe'), row('b', 'Pixi Beauty')];
  assert.equal(hoistDetectedBrandProducts(products, []).applied, false);
  assert.equal(hoistDetectedBrandProducts(products, ['']).applied, false);
  assert.equal(hoistDetectedBrandProducts([row('a', 'Pixi Beauty')], ['cerave']).applied, false);
  assert.deepEqual(hoistDetectedBrandProducts(null, ['cerave']).products, []);
});
