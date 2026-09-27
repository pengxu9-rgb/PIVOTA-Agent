'use strict';

// pdp_route_id_exists: the settled signal agent.pivota.cc needs before it may 404 a product id. The only
// dangerous answer is a false `exists: false` (a cached 404 that de-indexes a live product), so these pin
// that the probe NEVER says "absent" unless its statement completed and every lookup answered false.
// Run: node --test tests/pdp_route_id_existence.node.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { OperationEnum } = require('../src/schema');
const {
  probePdpRouteIdExistence,
  PDP_ROUTE_ID_EXISTENCE_CONTRACT,
  __internal: { ROUTE_ID_LOOKUPS, ROUTE_ID_EXISTENCE_SQL },
} = require('../src/services/pdpRouteIdExistence');

const NAMES = ROUTE_ID_LOOKUPS.map(([name]) => name);

function rowWith(trueNames = []) {
  return Object.fromEntries(NAMES.map((n) => [n, trueNames.includes(n)]));
}

function queryReturning(row) {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: row === undefined ? [] : [row] };
  };
  return { calls, queryFn };
}

test('the operation is part of the invoke vocabulary', () => {
  assert.ok(OperationEnum.options.includes('pdp_route_id_exists'));
});

test('absent only when the statement completed and every lookup answered false', async () => {
  const { calls, queryFn } = queryReturning(rowWith([]));
  const out = await probePdpRouteIdExistence('foo', { queryFn });
  assert.deepEqual(out, { contract: PDP_ROUTE_ID_EXISTENCE_CONTRACT, product_id: 'foo', exists: false, matched: [] });
  assert.equal(calls.length, 1);
});

test('any single lookup matching is enough, and the answer names it', async () => {
  for (const name of NAMES) {
    const out = await probePdpRouteIdExistence('sig_x', { queryFn: queryReturning(rowWith([name])).queryFn });
    assert.equal(out.exists, true, name);
    assert.deepEqual(out.matched, [name]);
  }
});

test('a failing statement propagates — it is never read as "absent"', async () => {
  const boom = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  await assert.rejects(probePdpRouteIdExistence('sig_x', { queryFn: async () => { throw boom; } }), /statement timeout/);
  const missing = Object.assign(new Error('relation "pdp_identity_listing" does not exist'), { code: '42P01' });
  await assert.rejects(probePdpRouteIdExistence('sig_x', { queryFn: async () => { throw missing; } }), /does not exist/);
});

test('no row, or a column that is not a boolean, is not an answer', async () => {
  await assert.rejects(probePdpRouteIdExistence('sig_x', { queryFn: queryReturning(undefined).queryFn }), { code: 'EXISTENCE_QUERY_EMPTY' });
  const partial = rowWith([]);
  delete partial[NAMES[NAMES.length - 1]];
  await assert.rejects(probePdpRouteIdExistence('sig_x', { queryFn: queryReturning(partial).queryFn }), { code: 'EXISTENCE_QUERY_MALFORMED' });
  const nullCol = { ...rowWith([]), [NAMES[0]]: null };
  await assert.rejects(probePdpRouteIdExistence('sig_x', { queryFn: queryReturning(nullCol).queryFn }), { code: 'EXISTENCE_QUERY_MALFORMED' });
});

test('no database configured is a failure, not an absence', async () => {
  await assert.rejects(probePdpRouteIdExistence('sig_x', {}), { code: 'NO_DATABASE' });
});

test('synthesized pg: ids are stored nowhere, so they answer null without a query', async () => {
  for (const id of ['pg:pid:123', 'pg:shopify:456', 'PG:merchant:x']) {
    const { calls, queryFn } = queryReturning(rowWith([]));
    const out = await probePdpRouteIdExistence(id, { queryFn });
    assert.equal(out.exists, null, id);
    assert.equal(out.reason, 'synthesized_id_family');
    assert.equal(calls.length, 0);
  }
  // pg_ (stored in product_group_members) is NOT synthesized: it is asked, and a miss is an answer.
  const pgUnderscore = queryReturning(rowWith([]));
  const stored = await probePdpRouteIdExistence('pg_2d55', { queryFn: pgUnderscore.queryFn });
  assert.equal(stored.exists, false);
  assert.equal(pgUnderscore.calls.length, 1);
});

test('invalid input is refused, not probed', async () => {
  for (const bad of ['', '   ', null, undefined, 42, 'x'.repeat(513)]) {
    await assert.rejects(probePdpRouteIdExistence(bad, { queryFn: async () => ({ rows: [rowWith([])] }) }), { code: 'INVALID_ROUTE_ID' });
  }
});

test('parameters: the lowercased id, and both spellings for the exact-match lookups', async () => {
  const { calls, queryFn } = queryReturning(rowWith([]));
  await probePdpRouteIdExistence('  Rejuran:AbC  ', { queryFn });
  assert.deepEqual(calls[0].params, ['rejuran:abc', ['Rejuran:AbC', 'rejuran:abc']]);
  const lower = queryReturning(rowWith([]));
  await probePdpRouteIdExistence('sig_abc', { queryFn: lower.queryFn });
  assert.deepEqual(lower.calls[0].params, ['sig_abc', ['sig_abc']]);
});

test('the statement covers every store a route id can live in', () => {
  // Each table get_pdp_v2 (or an id minter) keys a route id on — dropping one turns its ids into 404s.
  for (const table of [
    'catalog_products',
    'product_group_members',
    'external_product_seeds',
    'pdp_identity_listing',
    'content_canonical_election',
    'products_cache',
  ]) {
    assert.ok(ROUTE_ID_EXISTENCE_SQL.includes(`FROM ${table}`), table);
  }
  for (const column of ['pivota_signature_id', 'product_key', 'source_product_id', 'content_key', 'product_group_id',
    'platform_product_id', 'external_product_id', 'attached_product_key', 'sellable_item_group_id', 'canonical_sig_id']) {
    assert.ok(ROUTE_ID_EXISTENCE_SQL.includes(column), column);
  }
});
