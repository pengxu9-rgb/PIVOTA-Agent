// ADR-009 R1 — the mirror mints the seller of record instead of refilling the
// legacy `external_seed` bucket, and its own joins/prunes stop keying on a
// merchant literal (founder rule: derive from the row, never fix a literal
// with another literal).

const fs = require('fs');
const path = require('path');

jest.mock('../../src/db', () => ({
  closePool: jest.fn(),
  getPool: jest.fn(),
  query: jest.fn(),
  queryWithStatementTimeout: jest.fn(),
  withClient: jest.fn(),
}));

const { query } = require('../../src/db');
const {
  _internals: { annotateMirrorMerchants, buildMirror },
} = require('../../scripts/sync-external-seeds-to-catalog.cjs');

const SCRIPT_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../scripts/sync-external-seeds-to-catalog.cjs'),
  'utf8',
);

function seedRow(overrides = {}) {
  return {
    id: 'seed_1',
    external_product_id: 'ext_abc123',
    domain: 'fentybeauty.com',
    title: 'Test Product',
    image_url: 'https://img.example/x.jpg',
    canonical_url: 'https://fentybeauty.com/p/x',
    seed_data: { brand: 'Fenty Beauty' },
    status: 'active',
    ...overrides,
  };
}

describe('annotateMirrorMerchants precedence', () => {
  beforeEach(() => query.mockReset());

  test('an existing catalog row wins over seller_ref — the upsert never moves merchant_id, so children must follow the row', async () => {
    const rows = [seedRow({ existing_merchant_id: 'merch_obs_aaaa000011112222', seller_ref: 'merch_obs_ffff000011112222' })];
    const counts = await annotateMirrorMerchants(rows);
    expect(rows[0].mirror_merchant_id).toBe('merch_obs_aaaa000011112222');
    expect(counts).toMatchObject({ existing: 1, minted_from_seller_ref: 0 });
    // No candidates to verify — no catalog_merchants round-trip.
    expect(query).not.toHaveBeenCalled();
  });

  test('a NEW product mints from seller_ref only when the merchant exists in catalog_merchants', async () => {
    query.mockResolvedValueOnce({ rows: [{ merchant_id: 'merch_obs_ffff000011112222' }] });
    const rows = [seedRow({ existing_merchant_id: null, seller_ref: 'merch_obs_ffff000011112222' })];
    const counts = await annotateMirrorMerchants(rows);
    expect(rows[0].mirror_merchant_id).toBe('merch_obs_ffff000011112222');
    expect(counts).toMatchObject({ minted_from_seller_ref: 1 });
  });

  test('a seller_ref whose merchant is missing falls back to the legacy bucket LOUDLY — never a dark unservable row', async () => {
    // Serving predicate branch 2 requires a catalog_merchants row; minting a
    // merchant that does not exist would silently drop the product from serving.
    query.mockResolvedValueOnce({ rows: [] });
    const rows = [seedRow({ existing_merchant_id: null, seller_ref: 'merch_obs_deadbeefdeadbeef' })];
    const counts = await annotateMirrorMerchants(rows);
    expect(rows[0].mirror_merchant_id).toBe('external_seed');
    expect(counts).toMatchObject({ seller_ref_merchant_missing: 1 });
  });

  test('a seed with no seller_ref lands in the legacy bucket and is counted', async () => {
    const rows = [seedRow({ existing_merchant_id: null, seller_ref: null })];
    const counts = await annotateMirrorMerchants(rows);
    expect(rows[0].mirror_merchant_id).toBe('external_seed');
    expect(counts).toMatchObject({ seller_ref_missing: 1 });
  });

  test('a non-merchant-shaped seller_ref is never minted', async () => {
    const rows = [seedRow({ existing_merchant_id: null, seller_ref: 'ulta.com' })];
    await annotateMirrorMerchants(rows);
    expect(rows[0].mirror_merchant_id).toBe('external_seed');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('buildMirror carries the resolved merchant onto every child row', () => {
  test('product, sku and offer all ride under mirror_merchant_id', () => {
    const mirror = buildMirror(seedRow({
      mirror_merchant_id: 'merch_obs_aaaa000011112222',
      seed_data: {
        brand: 'Fenty Beauty',
        variants: [{ source_variant_id: 'v1', price_amount: 10, price_currency: 'USD', availability: 'in_stock' }],
      },
    }));
    expect(mirror.product.merchant_id).toBe('merch_obs_aaaa000011112222');
    for (const skuMirror of mirror.skus) {
      expect(skuMirror.sku.merchant_id).toBe('merch_obs_aaaa000011112222');
      expect(skuMirror.offer.merchant_id).toBe('merch_obs_aaaa000011112222');
    }
    // The storage key stays in the historical format regardless of merchant
    // (ADR-009 D4.2 — keys are opaque plumbing; a 2026-08-01 key "repair" took
    // 364 public PDPs to 500).
    expect(mirror.productKey).toBe('prod::external_seed::external_seed::ext_abc123');
  });

  test('an unannotated row still lands in the legacy bucket, not undefined', () => {
    const mirror = buildMirror(seedRow());
    expect(mirror.product.merchant_id).toBe('external_seed');
  });
});

describe('terminality of the migration (source-level guards)', () => {
  // The ADR-009 re-key is terminal ONLY because no OWNERSHIP upsert writes
  // merchant_id back — a re-keyed catalog row must keep its observed seller
  // through every later sync. This omission was incidental and undefended;
  // this test makes it a contract. index_pipeline_state is deliberately NOT in
  // this list: it is a projection keyed on content_key, and restamping it from
  // the resolved merchant is what heals its historically-wrong sentinel stamps.
  test('no catalog-ownership ON CONFLICT list assigns merchant_id', () => {
    const upserts = SCRIPT_SOURCE.match(
      /INSERT INTO (catalog_products|catalog_skus|catalog_offers|product_group_members)[\s\S]*?(?=`)/g,
    ) || [];
    expect(upserts.length).toBeGreaterThanOrEqual(4);
    for (const stmt of upserts) {
      const setList = stmt.split(/DO UPDATE SET/)[1] || '';
      expect(setList).not.toMatch(/^\s*merchant_id\s*=/m);
    }
  });

  test('index_pipeline_state DOES restamp merchant_id from the resolved value (the healing path)', () => {
    const ips = SCRIPT_SOURCE.match(/INSERT INTO index_pipeline_state[\s\S]*?(?=`)/g) || [];
    expect(ips.length).toBeGreaterThanOrEqual(1);
    expect(ips[0]).toMatch(/merchant_id = EXCLUDED\.merchant_id/);
  });

  // The stale prunes and the dry-run preview must not key on a merchant
  // literal: with one, pruning goes dead for every re-keyed product (dead
  // prices keep serving while stale_offer_deletes reports 0) — and the preview
  // agrees with the broken reality.
  test('stale prunes and preview are scoped by product_key, never a merchant literal', () => {
    const deletes = SCRIPT_SOURCE.match(/DELETE FROM catalog_(offers|skus)[\s\S]*?`/g) || [];
    expect(deletes.length).toBeGreaterThanOrEqual(2);
    for (const stmt of deletes) {
      expect(stmt).toContain('product_key = $1');
      expect(stmt).not.toMatch(/merchant_id\s*=/);
    }
  });

  test('the seed identity join keys on source identity, not a merchant literal or key template', () => {
    // Re-keyed rows carry BOTH a different merchant_id AND a rewritten
    // product_key, so only (source_system, source_product_id) survives
    // migration — measured 1:1 across all 10,339 mirror rows on prod.
    expect(SCRIPT_SOURCE).toContain('ON cp.source_product_id = e.external_product_id');
    expect(SCRIPT_SOURCE).not.toContain('ON cp.merchant_id = $3');
    expect(SCRIPT_SOURCE).not.toContain("ON cp.product_key = ('prod::external_seed");
  });

  test('buildMirror reuses an existing product_key instead of reconstructing the template', () => {
    const { _internals } = require('../../scripts/sync-external-seeds-to-catalog.cjs');
    const mirror = _internals.buildMirror({
      id: 'seed_2',
      external_product_id: 'ext_rekeyed1',
      domain: 'fentybeauty.com',
      title: 'X', image_url: 'https://img.example/x.jpg',
      canonical_url: 'https://fentybeauty.com/p/x',
      seed_data: { brand: 'Fenty Beauty' },
      status: 'active',
      existing_product_key: 'prod::merch_obs_7d65d696184c1023::external_seed::ext_rekeyed1',
      existing_merchant_id: 'merch_obs_7d65d696184c1023',
      mirror_merchant_id: 'merch_obs_7d65d696184c1023',
    });
    // Reconstructing the template here would miss ON CONFLICT (product_key)
    // and insert a duplicate catalog_products row on the product's next sync.
    expect(mirror.productKey).toBe('prod::merch_obs_7d65d696184c1023::external_seed::ext_rekeyed1');
    expect(mirror.product.product_key).toBe('prod::merch_obs_7d65d696184c1023::external_seed::ext_rekeyed1');
  });
});
