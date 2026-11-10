'use strict';

// THE DEFAULTS DIFFERENTIAL (FIX_PLAN 1.17): with every new flag at its default -- LIST_ROW_PRICE_AS_OF,
// PRICE_STALENESS_DEMOTE and UCP_LIVE_SEARCH_READ_TOP_K unset -- every answer is BYTE-IDENTICAL to origin/main
// before this change, through the real doors (/mcp, /ucp/mcp, /public/mcp, REST, invoke) and the list surfaces it
// touches (the search overlay's exits, the transport projection, recommend_products, get_alternatives), under
// UCP_LIVE_SEARCH_READ unset, shadow (prod today) and enforce. The fixture (tests/fixtures/price_tiers_doors_main.
// json) is the sha256 of each answer, captured by running tests/_support/priceTiersDoorsChild.cjs against an
// origin/main tree. (The 60 -> 15 min cache expiry changes only stored Firestore docs, never an answer:
// tests/price_cache_golden.node.test.cjs keeps write mode byte-identical to off.)
//
// It then shows the harness can see a change: each flag on moves exactly the answers it should, and
// PRICE_STALENESS_DEMOTE=shadow and a TOP_K under shadow move none.
//
// Each combination runs in its own process. Nothing leaves the process (see the child's header).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAIN = require('./fixtures/price_tiers_doors_main.json');
const CHILD = path.join(__dirname, '_support', 'priceTiersDoorsChild.cjs');
const NEW_FLAGS = ['LIST_ROW_PRICE_AS_OF', 'PRICE_STALENESS_DEMOTE', 'UCP_LIVE_SEARCH_READ_TOP_K', 'UCP_LIVE_SEARCH_READ_BUDGET_MS'];
const ALL_FLAGS = [...NEW_FLAGS, 'DOOR_CACHE_PRICE_FRESHNESS_CAP', 'RELGRAPH_CANDIDATE_PRICE_CHECKED_AT',
  'UCP_LIVE_SEARCH_READ', 'PRICE_CACHE_STORE', 'PRICE_CACHE_MODE', 'PRICE_HOST_BUDGET', 'PRICE_VERIFICATION_LOG',
  'COMMERCE_READ_CACHE_ENABLED', 'PUBLIC_READ_CACHE_ENABLED'];

const COMBOS = {
  base: {},
  search_shadow: { UCP_LIVE_SEARCH_READ: 'shadow' },
  search_enforce: { UCP_LIVE_SEARCH_READ: 'enforce' },
  shadow_with_k: { UCP_LIVE_SEARCH_READ: 'shadow', UCP_LIVE_SEARCH_READ_TOP_K: '3' },
  asof_on: { LIST_ROW_PRICE_AS_OF: 'on' },
  staleness_shadow: { PRICE_STALENESS_DEMOTE: 'shadow' },
  staleness_on: { PRICE_STALENESS_DEMOTE: 'on' },
  enforce_k1: { UCP_LIVE_SEARCH_READ: 'enforce', UCP_LIVE_SEARCH_READ_TOP_K: '1' },
  // Prod's door caches (both read caches ON) and search read shadow; then the same with the door cap explicitly
  // off and the graph-build flag set (it changes no serving path).
  prod_like: { COMMERCE_READ_CACHE_ENABLED: '1', PUBLIC_READ_CACHE_ENABLED: '1', UCP_LIVE_SEARCH_READ: 'shadow' },
  prod_like_cap_off: {
    COMMERCE_READ_CACHE_ENABLED: '1', PUBLIC_READ_CACHE_ENABLED: '1', UCP_LIVE_SEARCH_READ: 'shadow',
    DOOR_CACHE_PRICE_FRESHNESS_CAP: 'off', RELGRAPH_CANDIDATE_PRICE_CHECKED_AT: 'on',
  },
  // The cap alone changes cache clocks, never an answer (the side channel is a header and a symbol).
  prod_like_cap_on: { COMMERCE_READ_CACHE_ENABLED: '1', PUBLIC_READ_CACHE_ENABLED: '1', UCP_LIVE_SEARCH_READ: 'shadow', DOOR_CACHE_PRICE_FRESHNESS_CAP: 'on' },
};

function runCombo(env, port) {
  const childEnv = { ...process.env };
  for (const k of ALL_FLAGS) delete childEnv[k];
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, String(port)], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err.slice(-2000)}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()).cases);
      } catch (e) {
        reject(new Error(`unreadable child output: ${e.message}; ${out.slice(-500)}`));
      }
    });
  });
}

const R = {};
test.before(async () => {
  // Two at a time: each child serves real loopback calls with a 6 s self-invoke timeout, and eight servers
  // starting at once on a loaded runner time those out (socket hang up).
  const entries = Object.entries(COMBOS);
  for (let i = 0; i < entries.length; i += 2) {
    const batch = entries.slice(i, i + 2);
    const results = await Promise.all(batch.map(([, env], j) => runCombo(env, 4301 + i + j)));
    batch.forEach(([name], j) => { R[name] = results[j]; });
  }
}, { timeout: 600000 });

const shas = (cases) => Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, { status: v.status, sha256: v.sha256 }]));
const changed = (a, b) => Object.keys(a).filter((k) => a[k].sha256 !== (b[k] || {}).sha256).sort();

test('DEFAULTS: every answer byte-identical to origin/main, search read unset / shadow / enforce', () => {
  for (const combo of ['base', 'search_shadow', 'search_enforce', 'prod_like']) {
    assert.deepEqual(shas(R[combo]), MAIN.combos[combo], `${combo}: byte-identical to origin/main`);
    for (const c of Object.values(R[combo])) assert.equal(c.status, 200);
  }
  assert.deepEqual(shas(R.prod_like_cap_off), MAIN.combos.prod_like, 'the door cap off and the graph-build flag: identical');
  assert.deepEqual(shas(R.prod_like_cap_on), MAIN.combos.prod_like, 'the door cap on alone: every answer identical');
  assert.ok(Object.keys(MAIN.combos.base).length >= 20, 'the fixture covers the doors and the list surfaces');
});

test('TOP_K is ignored unless the UCP search read ENFORCES (shadow + K = main shadow)', () => {
  assert.deepEqual(shas(R.shadow_with_k), MAIN.combos.search_shadow);
});

test('PRICE_STALENESS_DEMOTE=shadow serves exactly what off serves', () => {
  assert.deepEqual(shas(R.staleness_shadow), MAIN.combos.base);
});

test('the harness sees each flag: as-of / staleness change the list answers; the UCP and public doors are untouched', () => {
  const LIST = ['final_search', 'final_search_capped', 'final_projected', 'recommend_handler', 'recommend_handler_capped',
    'alternatives_handler', 'alternatives_handler_ratio', 'mcp_recommend', 'rest_search', 'invoke_overlaid_elsewhere'];
  // The overlay and the projection no longer tier anything: a search is tiered once, at the final exit.
  for (const k of ['overlay_search', 'overlay_search_capped', 'overlay_search_cheapest', 'overlay_search_page2', 'transport_projection']) {
    assert.equal(changed(MAIN.combos.base, R.asof_on).includes(k), false, `${k} is not the final exit`);
  }
  const asof = changed(MAIN.combos.base, R.asof_on);
  for (const k of LIST) assert.ok(asof.includes(k), `as-of moves ${k}`);
  for (const k of ['ucp_search', 'public_search', 'ucp_tools_list', 'mcp_tools_list', 'public_tools_list', 'mcp_get_offers']) {
    assert.equal(asof.includes(k), false, `${k} is not a list row this PR stamps (UCP shaper / public projection / offers / tools)`);
  }
  const stale = changed(MAIN.combos.base, R.staleness_on);
  for (const k of LIST) assert.ok(stale.includes(k), `staleness moves ${k}`);
  // Every stamped search row says when and from where.
  const rows = JSON.parse(R.asof_on.final_search.body).products;
  assert.deepEqual(rows.map((p) => p.price_source), ['live', 'stored', 'stored', 'live']);
  for (const p of rows) assert.ok('price_as_of' in p);
});

test('top-K enforce: only the first K cards are read live; the rest keep their stored price; the page keeps every card', () => {
  const k1 = JSON.parse(R.enforce_k1.overlay_search.body);
  const all = JSON.parse(R.search_enforce.overlay_search.body);
  assert.equal(k1.products.length, all.products.length);
  assert.deepEqual(all.products.map((p) => p.price_source), ['merchant_live', 'catalog_offer', undefined, 'merchant_live'], 'K=0: both readable cards read');
  assert.deepEqual(k1.products.map((p) => p.price_source), ['merchant_live', 'catalog_offer', undefined, undefined], 'K=1: the 4th card is not read');
  assert.equal(k1.products[3].price, 23, 'its stored price stands');
  assert.deepEqual(k1.metadata.live_merchant_price.top_k, { k: 1, budget_ms: 600, live_verified_count: 1, cache_fallback_count: 0 });
});
