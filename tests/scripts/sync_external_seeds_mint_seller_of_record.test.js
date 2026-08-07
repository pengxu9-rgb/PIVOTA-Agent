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

  test('a NEW product mints from seller_ref when the merchant is admitted and the slot is free', async () => {
    query.mockResolvedValueOnce({ rows: [{ merchant_id: 'merch_obs_ffff000011112222' }] }); // admitted
    query.mockResolvedValueOnce({ rows: [] }); // slot unoccupied
    const rows = [seedRow({ existing_merchant_id: null, seller_ref: 'merch_obs_ffff000011112222' })];
    const counts = await annotateMirrorMerchants(rows);
    expect(rows[0].mirror_merchant_id).toBe('merch_obs_ffff000011112222');
    expect(counts).toMatchObject({ minted_from_seller_ref: 1 });
    // The admission query must filter on status, not bare existence — a
    // suspended merchant would produce rows dark on every serving surface.
    expect(query.mock.calls[0][0]).toMatch(/status/);
  });

  test('a seller_ref whose merchant is missing or not admitted BLOCKS the row — skipped and retried, never a dark row and never the bucket', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // not admitted
    const rows = [seedRow({ existing_merchant_id: null, seller_ref: 'merch_obs_deadbeefdeadbeef' })];
    const counts = await annotateMirrorMerchants(rows);
    expect(rows[0].mirror_merchant_id).toBeUndefined();
    expect(rows[0].mirror_mint_blocked_reason).toBe('seller_ref_merchant_missing_or_not_admitted');
    expect(counts).toMatchObject({ seller_ref_merchant_missing_or_not_admitted: 1 });
  });

  test('an occupied (merchant, platform, source_product_id) slot is never inserted into — that unique index spans ALL source_systems', async () => {
    query.mockResolvedValueOnce({ rows: [{ merchant_id: 'merch_obs_ffff000011112222' }] }); // admitted
    query.mockResolvedValueOnce({ rows: [{ merchant_id: 'merch_obs_ffff000011112222', source_product_id: 'ext_abc123' }] }); // occupied
    const rows = [seedRow({ existing_merchant_id: null, seller_ref: 'merch_obs_ffff000011112222' })];
    const counts = await annotateMirrorMerchants(rows);
    expect(rows[0].mirror_merchant_id).toBeUndefined();
    expect(rows[0].mirror_mint_blocked_reason).toBe('seller_ref_slot_occupied');
    expect(counts).toMatchObject({ seller_ref_slot_occupied: 1 });
  });

  test('a FIRST-PARTY merchant id in seller_ref BLOCKS the row — the mirror never routes onto a real merchant', async () => {
    // Real merchants carry merchant_stores rows; the serving predicate then
    // demands an active store on platform 'external_seed', which cannot exist —
    // the row would be unservable where the sentinel bucket serves today.
    const rows = [seedRow({ existing_merchant_id: null, seller_ref: 'merch_shopify_0584b37f7a8be00a5223' })];
    const counts = await annotateMirrorMerchants(rows);
    expect(rows[0].mirror_merchant_id).toBeUndefined();
    expect(rows[0].mirror_mint_blocked_reason).toBe('seller_ref_not_observed');
    expect(counts).toMatchObject({ seller_ref_not_observed: 1 });
    expect(query).not.toHaveBeenCalled();
  });

  test('a seed with no seller_ref BLOCKS the row and is counted', async () => {
    const rows = [seedRow({ existing_merchant_id: null, seller_ref: null })];
    const counts = await annotateMirrorMerchants(rows);
    expect(rows[0].mirror_merchant_id).toBeUndefined();
    expect(rows[0].mirror_mint_blocked_reason).toBe('seller_ref_missing');
    expect(counts).toMatchObject({ seller_ref_missing: 1 });
  });

  test('a non-merchant-shaped seller_ref BLOCKS the row, counted in its own bucket', async () => {
    const rows = [seedRow({ existing_merchant_id: null, seller_ref: 'ulta.com' })];
    const counts = await annotateMirrorMerchants(rows);
    expect(rows[0].mirror_merchant_id).toBeUndefined();
    expect(rows[0].mirror_mint_blocked_reason).toBe('seller_ref_not_observed');
    expect(counts).toMatchObject({ seller_ref_not_observed: 1, seller_ref_missing: 0 });
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

  test('an unannotated row THROWS — no silent default merchant (founder no-fallback rule)', () => {
    expect(() => buildMirror(seedRow())).toThrow(/annotateMirrorMerchants/);
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

  test('index_pipeline_state restamp is HEAL-ONLY: sentinel stamps heal, real merchants never thrash', () => {
    // content_key deliberately converges a D2C row and its retailer row, so an
    // unconditional merchant_id = EXCLUDED restamp would flip the shared IPS
    // row between two real sellers on alternating syncs.
    const ips = SCRIPT_SOURCE.match(/INSERT INTO index_pipeline_state[\s\S]*?(?=`)/g) || [];
    expect(ips.length).toBeGreaterThanOrEqual(1);
    expect(ips[0]).toMatch(/WHEN index_pipeline_state\.merchant_id = 'external_seed'\s*\n?\s*THEN EXCLUDED\.merchant_id/);
    expect(ips[0]).toMatch(/ELSE index_pipeline_state\.merchant_id/);
  });

  test('the dry-run preview joins carry no merchant literal (it must agree with the real prunes)', () => {
    const preview = SCRIPT_SOURCE.match(/current_skus AS \([\s\S]*?current_offers AS \([\s\S]*?\),/g) || [];
    expect(preview.length).toBeGreaterThanOrEqual(1);
    expect(preview[0]).not.toMatch(/merchant_id/);
  });

  test('a leftover sentinel group-membership row is retired when the product resolves to a real seller', () => {
    const cleanup = SCRIPT_SOURCE.match(/DELETE FROM product_group_members[\s\S]*?`/g) || [];
    expect(cleanup.length).toBe(1);
    expect(cleanup[0]).toContain('platform_product_id = $3');
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

describe('ulta retailer sibling — same doctrine, retailer lane', () => {
  const ULTA_SOURCE = fs.readFileSync(
    path.join(__dirname, '../../scripts/sync-ulta-external-seeds-to-catalog.cjs'),
    'utf8',
  );
  const {
    _internals: { annotateUltaMirrorMerchants, buildMirror: buildUltaMirror },
  } = require('../../scripts/sync-ulta-external-seeds-to-catalog.cjs');

  test('an existing catalog row keeps its own merchant and key', () => {
    const row = {
      external_product_id: 'ulta:abc',
      existing_merchant_id: 'merch_obs_aaaa000011112222',
      existing_product_key: 'prod::merch_obs_aaaa000011112222::external_seed::ulta:abc',
      seed_data: {}, status: 'active',
      canonical_url: 'https://ulta.com/p/x', title: 'X',
    };
    annotateUltaMirrorMerchants([row]);
    const mirror = buildUltaMirror(row);
    expect(mirror.product.merchant_id).toBe('merch_obs_aaaa000011112222');
    expect(mirror.productKey).toBe('prod::merch_obs_aaaa000011112222::external_seed::ulta:abc');
    // The '::canonical' sku generation derives from the REAL key, not a template.
    expect(mirror.skuKey).toBe('prod::merch_obs_aaaa000011112222::external_seed::ulta:abc::canonical');
  });

  // Ulta seeds carry per-BRAND seller_refs today — fragmenting one retailer
  // into hundreds of merchants, the mirror image of the ADR-009 bug. Until the
  // retailer seller model (W2) decides the identity, a NEW self-mint is
  // BLOCKED and retried — never landed in the legacy bucket, never minted
  // under a wrong per-brand identity.
  test('a NEW ulta product is BLOCKED pending W2 — even with a seller_ref present', () => {
    const row = {
      external_product_id: 'ulta:new1',
      existing_merchant_id: null,
      seller_ref: 'merch_obs_039b8cd5c84730bc',
      seed_data: {}, status: 'active',
    };
    const counts = annotateUltaMirrorMerchants([row]);
    expect(row.mirror_merchant_id).toBeUndefined();
    expect(row.mirror_mint_blocked_reason).toBe('retailer_seller_model_pending_w2');
    expect(counts).toMatchObject({ blocked_pending_w2: 1 });
    expect(() => buildUltaMirror(row)).toThrow(/annotateUltaMirrorMerchants/);
  });

  test('joins by source identity, never a merchant literal or key template', () => {
    expect(ULTA_SOURCE).toContain('ON cp.source_product_id = e.external_product_id');
    expect(ULTA_SOURCE).not.toMatch(/ON cp\.merchant_id = \$\d/);
  });

  test('no catalog-ownership ON CONFLICT list assigns merchant_id (terminality holds here too)', () => {
    const upserts = ULTA_SOURCE.match(
      /INSERT INTO (catalog_products|catalog_skus|catalog_offers|product_group_members)[\s\S]*?(?=`)/g,
    ) || [];
    expect(upserts.length).toBeGreaterThanOrEqual(4);
    for (const stmt of upserts) {
      const setList = stmt.split(/DO UPDATE SET/)[1] || '';
      expect(setList).not.toMatch(/^\s*merchant_id\s*=/m);
    }
  });
});
