'use strict';

/**
 * "Which markets do we serve" must be asked in ONE place, and the answer must be a LIST.
 *
 * Making Singapore servable needed two env vars that did not know about each other, and the
 * second could not express the answer: PIVOTA_SERVING_PRICING_REGIONS (backend) is a comma
 * list and flips serving_eligible; CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET (here) was a single
 * value bound to a scalar `AND market = $1`, so 'SG' swapped US off and 'US,SG' matched zero
 * rows. A row could be serving_eligible and still invisible, with no configuration able to fix
 * it. An audit of the route found THIRTY market/region/currency gates across two repos and
 * EIGHT independent implementations of "what market is this", over three columns — one of the
 * eight list-valued.
 *
 * src/services/servedMarkets.js is the one place now. This file stops the other seven growing
 * back, and records the ones not yet converted as a baseline that may only SHRINK.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HELPER = 'src/services/servedMarkets.js';
const {
  parseMarketList, servedMarkets, marketsForRequest, primaryMarket, DEFAULT_MARKET,
} = require(path.join(ROOT, HELPER));

// Files that still spell the question themselves. ONLY EVER REMOVE FROM THESE.
// Counts, not just names: a file may hold several, and fixing one of three is progress.
const SCALAR_BIND_BASELINE = {
  'src/auroraBff/productRecV1.js': 2,
  'src/auroraBff/travelLocalProductAuthority.js': 1,
  'src/findProductsExternalSeedBrandFastpath.js': 2,
  'src/findProductsExternalSeedDirectRetrieval.js': 1,
  'src/modules/decisioning/shopping_agent/strictFindProductsMulti.js': 1,
  'src/services/RecommendationEngine.js': 5,
  'src/services/canonicalCatalogSearch.js': 2,
  'src/services/categories.js': 2,
  // ⚠️ FOUND ONLY BY THIS TEST'S OWN CENSUS, NOT BY GREP. discoveryFeed.js is 447KB and
  // contains ONE NUL byte, so `grep` classifies it as binary and skips it SILENTLY — printing
  // nothing, not even a 0. Every grep-based audit of this repo has been missing a serving file
  // with five market binds in it. The census below reads utf8 and cannot be fooled that way;
  // if you audit this by hand, use `grep -a`.
  'src/services/discoveryFeed.js': 5,
  'src/services/ingredientSkuEvidence.js': 2,
  'src/services/productGroundingResolver.js': 1,
};
const RAW_ENV_BASELINE = {
  'src/findProductsExternalSeedDirectPlanning.js': 1,
  'src/services/RecommendationEngine.js': 1,
  'src/services/categories.js': 2,
  'src/services/discoveryFeed.js': 2,  // see the NUL-byte note above
  'src/services/ingredientSkuEvidence.js': 1,
  'src/services/productGroundingResolver.js': 1,
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(js|cjs|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

function census(needle) {
  const found = {};
  for (const abs of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (rel === HELPER) continue; // the helper documents the old shape in prose
    const n = fs.readFileSync(abs, 'utf8').split(needle).length - 1;
    if (n > 0) found[rel] = n;
  }
  return found;
}

// --- the helper behaves ---------------------------------------------------------------

test('an unset env yields exactly the old single-market behaviour', () => {
  assert.deepStrictEqual(servedMarkets({}), ['US']);
  assert.deepStrictEqual(primaryMarket({}), 'US');
  assert.strictEqual(DEFAULT_MARKET, 'US');
});

test('a comma list is a list — the thing the old scalar could not express', () => {
  assert.deepStrictEqual(servedMarkets({ CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: 'US,SG' }), ['US', 'SG']);
  assert.deepStrictEqual(servedMarkets({ CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: ' sg , us ' }), ['SG', 'US']);
});

test('junk degrades to the default instead of binding a value that matches nothing', () => {
  // The old code would bind the literal 'US,SG' or 'en-US' and silently return zero rows.
  for (const junk of ['', '   ', 'en-US', 'United States', ',,,', null, undefined]) {
    const got = servedMarkets({ CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: junk });
    assert.ok(got.length >= 1, `${JSON.stringify(junk)} produced an EMPTY market list`);
    assert.ok(got.every((m) => /^[A-Z]{2}$/.test(m)), `${JSON.stringify(junk)} -> ${got}`);
  }
  assert.deepStrictEqual(servedMarkets({ CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: 'en-US' }), ['US']);
});

test('a request that names a market gets THAT market, not the deployment list', () => {
  const env = { CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: 'US,SG' };
  // A shopper asking for SG must not be served US pricing alongside it.
  assert.deepStrictEqual(marketsForRequest('SG', env), ['SG']);
  assert.deepStrictEqual(marketsForRequest('', env), ['US', 'SG']);
  assert.deepStrictEqual(marketsForRequest(null, env), ['US', 'SG']);
});

test('parseMarketList dedupes and preserves order', () => {
  assert.deepStrictEqual(parseMarketList('US,SG,US'), ['US', 'SG']);
});

// --- the door uses it -----------------------------------------------------------------

test('the door binds market as a LIST, not a scalar', () => {
  const server = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  const scalars = server.split('AND market = $1').length - 1;
  assert.strictEqual(scalars, 0,
    `src/server.js still has ${scalars} scalar \`AND market = $1\` bind(s). A scalar cannot ` +
    'express "US and SG", which is the defect this module exists to remove.');
  const lists = server.split('AND market = ANY($1::text[])').length - 1;
  assert.ok(lists >= 6, `expected the door's six seed lanes to bind a list, found ${lists}`);
});

test('the door does not read the market env directly any more', () => {
  for (const f of ['src/server.js', 'src/auroraBff/routes.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!src.includes('process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET'),
      `${f} reads CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET directly; go through servedMarkets.js ` +
      'so there is one answer and it can be a list.');
  }
});

// --- and the rest may only shrink -------------------------------------------------------

test('no NEW file spells the market question itself', () => {
  const scalar = census('AND market = $1');
  const added = Object.keys(scalar).filter((f) => !(f in SCALAR_BIND_BASELINE));
  assert.deepStrictEqual(added, [],
    `these files gained a scalar market bind: ${added.join(', ')}. Use servedMarkets.js and ` +
    'bind `market = ANY($n::text[])`, or this becomes the ninth implementation.');
  for (const [f, n] of Object.entries(scalar)) {
    assert.ok(n <= SCALAR_BIND_BASELINE[f],
      `${f} went from ${SCALAR_BIND_BASELINE[f]} scalar market binds to ${n}`);
  }
  const env = census('process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET');
  const addedEnv = Object.keys(env).filter((f) => !(f in RAW_ENV_BASELINE));
  assert.deepStrictEqual(addedEnv, [],
    `these files gained a raw market-env read: ${addedEnv.join(', ')}`);
  for (const [f, n] of Object.entries(env)) {
    assert.ok(n <= RAW_ENV_BASELINE[f], `${f} went from ${RAW_ENV_BASELINE[f]} raw env reads to ${n}`);
  }
});

test('fixing a baselined file updates this baseline', () => {
  const scalar = census('AND market = $1');
  const fixed = Object.entries(SCALAR_BIND_BASELINE)
    .filter(([f, n]) => (scalar[f] || 0) < n)
    .map(([f, n]) => `${f} (${n} -> ${scalar[f] || 0})`);
  assert.deepStrictEqual(fixed, [],
    `progress — lower these in SCALAR_BIND_BASELINE: ${fixed.join(', ')}. When the map is ` +
    'empty, there is one source of truth and this test can go.');
});

// --- the mistake this change actually made, caught by CI and not by the tests above -----

test('no params array hands a SCALAR market to an ANY(...) bind', () => {
  /* I converted six `AND market = $1` binds to `ANY($1::text[])` and updated ONE of the four
   * params arrays. The other three kept passing a scalar — `safeQueryMarket`, a bare `market`,
   * and a hardcoded `'US'`. node-postgres does not reject that: the query runs and matches
   * NOTHING, which surfaced as a single KR-bridge integration test failing with "failed"
   * rather than as anything naming market or SQL.
   *
   * The nine tests above all passed while it was broken, because every one of them reasons
   * about the helper or greps the SQL text — none looks at what is BOUND to it. */
  const files = ['src/server.js', 'src/auroraBff/routes.js'];
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (!src.includes('market = ANY($1::text[])')) continue;
    // An identifier assigned from the helper HOLDS a list — flagging it would be a false
    // positive, and the first cut of this test produced two. Resolve before accusing.
    const listIds = new Set();
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:servedMarkets|marketsForRequest)\s*\(/g)) {
      listIds.add(m[1]);
    }
    // `[,\]]` not just `,` — a ONE-element params array (`const sqlParams = [market];`) has no
    // trailing comma, and the first cut of this regex missed exactly that site.
    for (const m of src.matchAll(/\[\s*(safeQueryMarket|safeMarket|market|'US'|"US")\s*[,\]]/g)) {
      const id = m[1];
      if (listIds.has(id)) continue;
      offenders.push(`${f}:${src.slice(0, m.index).split('\n').length} binds ${id}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'these params arrays pass a scalar market as $1 while the SQL binds ANY($1::text[]). ' +
    'The query will run and match zero rows:\n  ' + offenders.join('\n  '));
});
