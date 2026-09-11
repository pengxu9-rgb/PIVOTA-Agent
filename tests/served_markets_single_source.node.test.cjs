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
  parseMarketList, servedMarkets, marketsForRequest, primaryMarket, DEFAULT_MARKET, marketBind,
  laneMarkets,
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
  // NOT in this baseline: canonicalCatalogSearch.js. Its two `AND market = $1` hits were PROSE
  // (:776, :929). Its real market gates are a different shape this needle cannot see —
  // `${marketBind}` at :958/:967 and `$${params.length}` at :1299, all scalar — and they are
  // tracked below in CANONICAL_SCALAR_GATES instead of being silently counted as zero.
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
// The canonical arm binds its market through interpolated placeholders, so it needs its own
// count. Still scalar, still a single market — a known gap, recorded rather than invisible.
const CANONICAL_SCALAR_GATES = 3;

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

// ⚠️ COMMENTS ARE NOT CODE, and counting them made this census wrong in BOTH directions.
// `canonicalCatalogSearch.js` was baselined at 2 — those were two PROSE lines (:776, :929)
// quoting the old shape, while the file's real market binds are `${marketBind}` (:958, :967)
// and `$${params.length}` (:1299), which this needle cannot see at all. A census that counts
// documentation and misses SQL is worse than no census: it reports progress for a comment edit.
function census(needle) {
  const found = {};
  for (const abs of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (rel === HELPER) continue; // the helper documents the old shape in prose
    let n = 0;
    for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      n += line.split(needle).length - 1;
    }
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

test('the door builds its market predicate from the helper, never inline', () => {
  const server = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  const scalars = server.split('AND market = $1').length - 1;
  assert.strictEqual(scalars, 0,
    `src/server.js still has ${scalars} hardcoded \`AND market = $1\` bind(s). A hardcoded ` +
    'scalar cannot express "US and SG", which is the defect this module exists to remove.');
  const built = (server.match(/AND \$\{\w+\.sql\}/g) || []).length;
  assert.ok(built >= 6,
    `expected the door's six seed lanes to take their predicate from marketBind(), found ${built}`);
});

test('marketBind keeps the single-market plan identical, and widens only when asked', () => {
  // `market` is the LEADING column of the partial indexes these ORDER BY ... LIMIT n lanes use.
  // A ScalarArrayOpExpr does not reliably carry the index's sort order, and these lanes already
  // return 57014 timeouts — so one market must emit exactly the SQL that shipped before.
  const one = marketBind(['US'], '$1');
  assert.strictEqual(one.sql, 'market = $1');
  assert.strictEqual(one.value, 'US', 'a single market must bind a SCALAR, not a 1-element array');
  const two = marketBind(['US', 'SG'], '$1');
  assert.strictEqual(two.sql, 'market = ANY($1::text[])');
  assert.deepStrictEqual(two.value, ['US', 'SG']);
  // The pair must never disagree — that mismatch is the bug this change already made once.
  for (const markets of [['US'], ['US', 'SG'], ['SG', 'HK', 'US']]) {
    const b = marketBind(markets, '$1');
    assert.strictEqual(b.sql.includes('ANY('), Array.isArray(b.value),
      `predicate and param disagree for ${markets}: ${b.sql} <- ${JSON.stringify(b.value)}`);
  }
});

test('the main beauty lane actually widens — the default must not pin it to one market', () => {
  // `runScopeQuery(tool)` defaulted queryMarket to `safeMarket`, which is TRUTHY, so every
  // no-arg call took marketsForRequest(safeMarket) = [safeMarket] and the deployment's served
  // list was never bound. The change was a no-op on its own main lane; review caught it.
  const server = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  for (const fn of ['runScopeQuery', 'runTextRecallQuery']) {
    const m = new RegExp(`const ${fn} = async \\(tool, queryMarket = (\\w+)`).exec(server);
    assert.ok(m, `${fn} not found`);
    assert.strictEqual(m[1], 'null',
      `${fn} defaults queryMarket to \`${m[1]}\`, which is truthy — the served list can never ` +
      'be reached and multi-market is silently a no-op on this lane.');
  }
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

// --- THE TEST THAT WOULD HAVE CAUGHT THE COLLAPSE ------------------------------------------
//
// Everything above reasons about the helper or greps source text. Twice now a defect lived in
// neither: the served list was resolved correctly and then collapsed with `[0]` several
// thousand lines before it reached SQL, so every constant, default and regex stayed right while
// the door bound one market. Review found it by RUNNING the chain. So does this.

test('laneMarkets keeps the list the caller resolved, and never re-derives it from one name', () => {
  const env = { CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: 'US,SG' };
  // The caller resolved ['US','SG'] and hands it down. It must survive.
  assert.deepStrictEqual(laneMarkets(['US', 'SG'], 'US', env), ['US', 'SG']);
  assert.deepStrictEqual(marketBind(laneMarkets(['US', 'SG'], 'US', env), '$1').value, ['US', 'SG']);
  // No list handed down => derive from the deployment.
  assert.deepStrictEqual(laneMarkets(undefined, undefined, env), ['US', 'SG']);
  // THE COLLAPSE, stated as a counterfactual so this test cannot pass for the wrong reason:
  // deriving from a single NAME can only ever yield one element, which is why `inherited` wins.
  assert.deepStrictEqual(marketsForRequest('US', env), ['US']);
  // An explicitly requested market still narrows to exactly that market.
  assert.deepStrictEqual(laneMarkets(undefined, 'SG', env), ['SG']);
});

test('every lane takes its markets from laneMarkets, not by re-deriving from the scalar', () => {
  // `laneMarkets` is the seam the test above drives. A lane that stops calling it is a lane that
  // has gone back to deciding for itself — which is how the list was collapsed twice.
  const src = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  const uses = (src.match(/laneMarkets\(/g) || []).length;
  assert.ok(uses >= 2,
    `expected the door and the apparel lane to resolve through laneMarkets(); found ${uses}`);
  assert.ok(!/const safeMarkets = marketsForRequest\(market\)/.test(src),
    'the door re-derives its list from the single `market` name — that collapses it to one ' +
    'element however the deployment is configured.');
  assert.ok(!/const markets = \[market\]/.test(src),
    'a lane rebuilds `markets` from the already-collapsed scalar.');
  assert.ok(/const markets = marketsForRequest\(search\.market \|\| metadata\.market\)/.test(src),
    'the beauty mainline no longer resolves a LIST before handing it down.');
});

test('an empty market list is refused, not silently bound', () => {
  assert.throws(() => marketBind([], '$1'), /empty market list/);
});

test('no serving lane collapses the list with [0] before binding', () => {
  // A grep, deliberately: the runtime test above covers the mainline, but the apparel lane and
  // the brand fastpath have no request override and are hard to drive without a DB. What they
  // must never do is take the head of the served list and hand THAT to marketBind.
  const src = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  const collapses = [...src.matchAll(/marketBind\(\s*\w*[Mm]arketsForRequest\([^)]*\)\[0\]/g)]
    .map((m) => src.slice(0, m.index).split('\n').length);
  assert.deepStrictEqual(collapses, [],
    `these lines bind the HEAD of the served list instead of the list: ${collapses.join(', ')}`);
  assert.ok(!/const markets = servedMarkets\(\)\[0\]/.test(src));
});

test('the canonical arm\'s market gates stay counted, even though the needle cannot see them', () => {
  // Comments stripped FIRST. :1268 is prose describing the gate, and counting it is the exact
  // bug this test exists to correct — committed once in the census and again, here, in the test
  // written to fix the census. A count that includes documentation measures nothing.
  const src = fs.readFileSync(path.join(ROOT, 'src/services/canonicalCatalogSearch.js'), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  // ONE pattern. Two overlapping ones double-counted every gate, because `= $` also matches
  // the first character of `= ${marketBind}`.
  const gates = (src.match(/(?:recall_market|eps\.market) = \$/g) || []).length;
  assert.ok(gates <= CANONICAL_SCALAR_GATES,
    `canonicalCatalogSearch.js grew to ${gates} scalar market gates (baseline ` +
    `${CANONICAL_SCALAR_GATES}). This arm still binds ONE market; widening it is the next PR.`);
  assert.ok(gates > 0,
    'the canonical arm has no market gate at all any more — if that is intended, drop ' +
    'CANONICAL_SCALAR_GATES to 0 deliberately rather than letting this test pass on absence.');
});
