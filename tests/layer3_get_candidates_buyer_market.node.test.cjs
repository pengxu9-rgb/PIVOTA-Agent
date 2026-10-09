'use strict';

// The look-kit recall carries the kit's market as the buyer market of the inner find_products_multi
// invoke — ISO-2 or nothing — so the purchasability gate downstream keys on the buyer's market and
// a plan with no usable market stays SILENT rather than defaulting.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getCandidates } = require('../src/layer3/retrieval/getCandidates');

// One breakdown entry per catalog category: `buildQueryForCategory` reads `breakdown[category]`,
// and a category it cannot query is skipped before the fetcher runs.
const lookSpec = {
  breakdown: Object.fromEntries(['prep', 'base', 'contour', 'brow', 'eye', 'blush', 'lip'].map((c) => [c, { keyNotes: [] }])),
};

async function recallWith(market) {
  const calls = [];
  await getCandidates({
    lookSpec,
    market,
    limitPerCategory: 3,
    fetcher: async (args) => {
      calls.push(args);
      return [];
    },
  });
  return calls;
}

test('the kit market reaches the recall fetcher as the buyer market, upper-cased', async () => {
  const calls = await recallWith('jp');
  assert.ok(calls.length >= 1, 'the recall ran');
  assert.ok(calls.every((c) => c.market === 'JP'), JSON.stringify(calls));
});

test('no usable market sends none: the recall is silent, never defaulted', async () => {
  for (const bad of [undefined, '', 'usa', 'en-US', 7]) {
    const calls = await recallWith(bad);
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((c) => c.market === null), `${String(bad)}: ${JSON.stringify(calls)}`);
  }
});
