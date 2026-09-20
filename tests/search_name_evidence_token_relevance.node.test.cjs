'use strict';

// The token-relevance ranking arm is a MODULE-LOAD constant
// (PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED), and in production it is set from a secret, so its
// value here is not knowable from the repo -- both settings have to hold. This file is the ON
// half; tests/search_name_evidence.node.test.cjs covers the default OFF.
//
// With the arm on, a row's token tier decides the sort before its score does: a row that carries
// no query token sorts below every row that carries one. An admitted row whose name needs the
// identity fold ("SÍLVER SERUM GLOSS") must therefore be read folded HERE too, or it is admitted,
// waived, and then sorted underneath the category rows it was admitted past.

process.env.NODE_ENV = 'test';
process.env.PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED = 'true';

const assert = require('node:assert/strict');
const test = require('node:test');

const ne = require('../src/services/searchNameEvidence');
const app = require('../src/server');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');

const { scoreBeautyExternalSeedProduct, inferBeautyMainlineIntent } = app._debug;

const q = 'Silver Serum Gloss';
const BASE = {
  product_id: 'p', brand: 'Other', product_type: 'makeup', category: 'makeup',
  category_path: ['beauty', 'makeup'], catalog_category_path: 'beauty/makeup', price: 28.8,
  currency: 'SGD', image_url: 'https://cdn.example.com/j.jpg', source: 'canonical_chain',
  search_recall_source: 'canonical_chain', [ne.NAME_EVIDENCE_ADMITTED]: true,
};

function score(product) {
  process.env[ne.FLAG] = 'on';
  try {
    return scoreBeautyExternalSeedProduct({
      product, queryText: q, intent: inferBeautyMainlineIntent(q), normalizedQuery: q.toLowerCase(),
      queryTokens: q.toLowerCase().split(' '),
      searchQualityContract: buildSearchQualityContract({ rawQuery: q, market: 'SG' }),
    });
  } finally { delete process.env[ne.FLAG]; }
}

test('token relevance ON: an admitted row scores and tiers the same in any spelling the SQL fold admits', () => {
  const plain = score({ ...BASE, title: 'LIP-PRESSION Silver Serum Gloss' });
  assert.equal(plain.token_tier, 1, 'premise: the arm is on and the plain spelling is tier 1');
  assert.ok(plain.token_relevance.count > 0, 'premise: the plain spelling matches tokens');
  for (const title of ['SÍLVER SERUM GLOSS Sheer', 'S·I·L·V·E·R Serum Gloss']) {
    const folded = score({ ...BASE, product_id: title, title });
    assert.equal(folded.token_tier, 1, title);
    assert.equal(folded.token_relevance.count, plain.token_relevance.count, title);
    assert.equal(folded.score, plain.score, title);
  }
});
