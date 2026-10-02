const test = require('node:test');
const assert = require('node:assert/strict');
const { pageFreshness, offerFreshness, normalizeOptions, buildRefreshManifest, refreshPlanSql,
  aggregateAudit } = require('../src/services/relationshipGraphFreshness');
const { catalogCoverageSql } = require('../src/auroraBff/relationshipGraphCoverage');
const { run, parseArgs } = require('../scripts/audit-relgraph-freshness');
const now = new Date('2026-10-02T00:00:00Z');

test('stale positive and negative page checks mean unknown; only current false means not renderable', () => {
  for (const state of [true, false]) {
    assert.equal(pageFreshness({ pdp_will_render: state, pdp_will_render_computed_at: '2026-09-01' }, now), 'unknown_stale');
  }
  assert.equal(pageFreshness({ pdp_will_render: false, pdp_will_render_computed_at: '2026-10-01' }, now), 'fresh_not_renderable');
  assert.equal(pageFreshness({ pdp_will_render: true, pdp_will_render_computed_at: '2026-10-01' }, now), 'fresh_renderable');
  assert.equal(pageFreshness({ pdp_will_render: true, pdp_will_render_computed_at: '2030-01-01' }, now), 'unknown_stale');
});

test('offer evidence pairs amount/currency/market and needs price and origin clocks', () => {
  const row = { market: 'US', currency: 'USD', price: 22, price_checked_at: '2026-10-01',
    last_crawled_at: '2026-10-01', availability: 'in_stock' };
  const opts = { market: 'US', currency: 'USD', now };
  assert.equal(offerFreshness(row, opts), 'fresh_available');
  for (const field of ['price_checked_at', 'last_crawled_at']) {
    assert.equal(offerFreshness({ ...row, [field]: '2026-09-01' }, opts), 'unknown_stale');
  }
  assert.equal(offerFreshness({ ...row, currency: 'SGD' }, opts), 'currency_mismatch');
  assert.equal(offerFreshness({ ...row, market: 'JP' }, opts), 'market_mismatch');
  assert.equal(offerFreshness({ ...row, currency: null }, opts), 'currency_mismatch');
  assert.equal(offerFreshness({ ...row, price: 0 }, opts), 'unknown_price');
  assert.equal(offerFreshness({ ...row, availability: 'out_of_stock' }, opts), 'fresh_unavailable');
  assert.equal(offerFreshness({ ...row, availability: 'out_of_stock', last_crawled_at: null }, opts), 'unknown_stale');
  assert.equal(row.currency, 'USD'); assert.equal(row.price, 22);
});

test('offline planner alone can bypass the old page stamp; default coverage keeps the exact gate', () => {
  assert.match(catalogCoverageSql('cp', { suppressedIdsSql: '$4' }), /cp.pdp_will_render IS TRUE/);
  const sql = refreshPlanSql();
  assert.match(sql, /Offline freshness worklist/);
  assert.match(sql, /relationship_graph_anchor_attempts/);
  assert.match(sql, /interval '7 days'/);
  assert.match(sql, /seed.external_product_id = cp.source_product_id/);
  assert.match(sql, /seed.attached_product_key = cp.product_key/);
  assert.match(sql, /LIMIT \$3/);
});

test('strict bounded input rejects accidental apply and manifests never include row content', () => {
  for (const limit of [0, 201, Infinity, 'nan', 1.5]) assert.throws(() => normalizeOptions({ limit }));
  assert.throws(() => normalizeOptions({ market: 'ZZ' }));
  assert.throws(() => parseArgs(['--apply']));
  const manifest = buildRefreshManifest([{ product_key: 'P1', title: 'secret', price: 42, source_refs: ['secret'] }], {}, now);
  assert.deepEqual(Object.keys(manifest).sort(), ['currency', 'generated_at', 'market', 'max_products', 'product_keys', 'schema']);
  assert.equal(JSON.stringify(manifest).includes('secret'), false);
  assert.equal(JSON.stringify(aggregateAudit({ active_products: '7', url: 'https://private.example', title: 'secret' })).includes('secret'), false);
});

test('default audit reads only aggregates, never scans labels, writes files, or runs refresh', async () => {
  const sqls = [];
  const client = { async query(sql) { sqls.push(sql); return { rows: [{ active_products: '3', title: 'secret' }] }; } };
  const result = await run({ client, options: {}, scanFn: () => { throw Error('unexpected scan'); },
    writeManifest: () => { throw Error('unexpected write'); } });
  assert.equal(result.active_products, 3); assert.equal(result.dry_run, true);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(sqls[0], 'BEGIN TRANSACTION READ ONLY');
  assert.equal(sqls.at(-1), 'COMMIT');
  assert.equal(sqls.some((sql) => /UPDATE|INSERT|DELETE|https?:\/\//.test(sql)), false);
});

test('explicit manifest writes private keys once after successful read, never adds keys to stdout summary', async () => {
  const sqls = []; const writes = [];
  const client = { async query(sql) { sqls.push(sql); return { rows: sql.includes('SELECT product_key FROM candidates')
    ? [{ product_key: 'P1', url: 'secret' }] : [] }; } };
  const result = await run({ client, options: { manifestOut: '/private/tmp/worklist.json' },
    scanFn: async () => ({ suppressedIds: ['hidden1'] }), writeManifest: (file, manifest) => writes.push(manifest) });
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].product_keys, ['P1']);
  assert.equal(result.refresh_products, 1); assert.equal(JSON.stringify(result).includes('P1'), false);
  assert.equal(sqls.at(-1), 'COMMIT');
});

test('failed reads roll back, do not retry an aborted transaction, and write no worklist', async () => {
  const sqls = []; let writes = 0;
  const client = { async query(sql) { sqls.push(sql); if (sql.includes('WITH cohort')) throw Error('secret URL'); return {}; } };
  await assert.rejects(run({ client, options: { manifestOut: '/tmp/worklist' }, writeManifest: () => { writes += 1; } }));
  assert.equal(sqls.filter((sql) => sql.includes('WITH cohort')).length, 1);
  assert.equal(sqls.at(-1), 'ROLLBACK'); assert.equal(writes, 0);
});
