'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  upsertCatalogRowTrust,
  upsertCatalogRowTrustMany,
  upsertCatalogRowTrustForSourceListingRefs,
} = require('../src/services/catalogRowTrustUpserter');

const NOW = new Date('2026-05-26T12:00:00Z');
function daysAgo(n) {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Fake pool that returns canned data without hitting Postgres.
// ---------------------------------------------------------------------------

function makeJoinedRow(overrides = {}) {
  return {
    product_key: 'pk_internal_1',
    content_key: 'ck_internal_1',
    merchant_id: 'merch_efbc46b4619cfbdf',
    platform: 'shopify',
    source_system: 'shopify',
    source_ref: 'gid://shopify/Product/1',
    source_product_id: '1',
    source_domain: 'chydan.myshopify.com',
    sync_status: 'live',
    suppression_reason: null,
    last_seen_in_sync_at: daysAgo(1),
    serving_eligible: true,
    pipeline_stage: 'serving',
    blocker_code: null,
    content_quality_score: 0.8,
    quality_scored_at: daysAgo(1),
    last_extracted_at: daysAgo(1),
    pil_source_listing_ref: 'merch_efbc46b4619cfbdf:1',
    identity_status: 'approved',
    identity_confidence: 0.95,
    live_read_enabled: true,
    review_required: false,
    sellable_item_group_id: 'sig_abc',
    product_line_id: 'pl_x',
    review_family_id: null,
    eps_id: null,
    eps_status: null,
    eps_domain: null,
    eps_attached_product_key: null,
    eps_last_seen_at: null,
    ms_merchant_id: 'merch_efbc46b4619cfbdf',
    ms_platform: 'shopify',
    ms_domain: 'chydan.myshopify.com',
    ms_status: 'active',
    ms_last_sync: daysAgo(1),
    override_id: null,
    override_action_type: null,
    override_active: null,
    ...overrides,
  };
}

class FakePool {
  constructor({ joined = [], quarantines = [], resolvedKeys = [] } = {}) {
    this._joined = joined;
    this._quarantines = quarantines;
    this._resolvedKeys = resolvedKeys;
    this.queries = [];
  }

  async query(sql, params) {
    this.queries.push({ sql, params });
    if (sql.includes('catalog_source_quarantine')) {
      return { rows: this._quarantines };
    }
    if (sql.includes('SELECT DISTINCT cp.product_key') && sql.includes('pdp_identity_listing')) {
      return { rows: this._resolvedKeys.map((k) => ({ product_key: k })) };
    }
    if (sql.includes('catalog_products cp') && params?.length === 1) {
      // SELECT by single product_key
      const key = params[0];
      const row = this._joined.find((r) => r.product_key === key);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('catalog_products cp') && Array.isArray(params?.[0])) {
      // SELECT by product_key = ANY(...)
      const keys = new Set(params[0]);
      return { rows: this._joined.filter((r) => keys.has(r.product_key)) };
    }
    if (sql.includes('ON CONFLICT (subject_type, subject_key)')) {
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

// ---------------------------------------------------------------------------

test('upsertCatalogRowTrust returns true and emits upsert for a healthy row', async () => {
  const pool = new FakePool({ joined: [makeJoinedRow()] });
  const ok = await upsertCatalogRowTrust(pool, 'pk_internal_1', NOW);
  assert.equal(ok, true);
  const upsert = pool.queries.find((q) => q.sql.includes('ON CONFLICT'));
  assert.ok(upsert, 'no upsert emitted');
  const params = upsert.params;
  assert.equal(params[0], 'product');           // subject_type
  assert.equal(params[1], 'pk_internal_1');     // subject_key
  assert.equal(params[17], 'public');            // serving_decision
});

test('upsertCatalogRowTrust returns false for missing product_key arg', async () => {
  const pool = new FakePool();
  const ok = await upsertCatalogRowTrust(pool, '', NOW);
  assert.equal(ok, false);
  assert.equal(pool.queries.length, 0);
});

test('upsertCatalogRowTrust returns false when product not found', async () => {
  const pool = new FakePool({ joined: [makeJoinedRow()] });
  const ok = await upsertCatalogRowTrust(pool, 'pk_does_not_exist', NOW);
  assert.equal(ok, false);
  assert.ok(!pool.queries.find((q) => q.sql.includes('ON CONFLICT')));
});

test('upsertCatalogRowTrust swallows db errors without throwing', async () => {
  class BoomPool {
    async query() { throw new Error('db down'); }
  }
  const ok = await upsertCatalogRowTrust(new BoomPool(), 'pk_x', NOW);
  assert.equal(ok, false);
});

test('tombstoned row produces blocked serving_decision', async () => {
  const pool = new FakePool({
    joined: [makeJoinedRow({ suppression_reason: 'stale_after_sync' })],
  });
  await upsertCatalogRowTrust(pool, 'pk_internal_1', NOW);
  const upsert = pool.queries.find((q) => q.sql.includes('ON CONFLICT'));
  assert.ok(upsert);
  assert.equal(upsert.params[17], 'blocked');
  assert.ok(upsert.params[18].includes('ROW_TOMBSTONED'));
});

test('upsertCatalogRowTrustMany writes all supplied keys', async () => {
  const rows = [
    makeJoinedRow({ product_key: 'pk_a' }),
    makeJoinedRow({ product_key: 'pk_b' }),
    makeJoinedRow({ product_key: 'pk_c' }),
  ];
  const pool = new FakePool({ joined: rows });
  const wrote = await upsertCatalogRowTrustMany(pool, ['pk_a', 'pk_b', 'pk_c'], NOW);
  assert.equal(wrote, 3);
  const upserts = pool.queries.filter((q) => q.sql.includes('ON CONFLICT'));
  assert.equal(upserts.length, 3);
});

test('upsertCatalogRowTrustMany with empty list returns 0 and no queries', async () => {
  const pool = new FakePool();
  const wrote = await upsertCatalogRowTrustMany(pool, [], NOW);
  assert.equal(wrote, 0);
  assert.equal(pool.queries.length, 0);
});

test('upsertCatalogRowTrustForSourceListingRefs resolves refs and writes trust', async () => {
  const pool = new FakePool({
    joined: [makeJoinedRow({ product_key: 'pk_internal_1' })],
    resolvedKeys: ['pk_internal_1'],
  });
  const wrote = await upsertCatalogRowTrustForSourceListingRefs(
    pool,
    ['merch_efbc46b4619cfbdf:1'],
    NOW,
  );
  assert.equal(wrote, 1);
  const upsert = pool.queries.find((q) => q.sql.includes('ON CONFLICT'));
  assert.ok(upsert);
  assert.equal(upsert.params[1], 'pk_internal_1');
});

test('upsertCatalogRowTrustForSourceListingRefs with empty refs returns 0', async () => {
  const pool = new FakePool();
  const wrote = await upsertCatalogRowTrustForSourceListingRefs(pool, [], NOW);
  assert.equal(wrote, 0);
  assert.equal(pool.queries.length, 0);
});
