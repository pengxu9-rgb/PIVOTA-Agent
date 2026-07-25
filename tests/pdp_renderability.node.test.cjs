const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pdpRouteResolvable,
  pdpRouteResolvableFromRow,
  seedRouteResolvesSql,
} = require('../src/services/pdpRenderability');

// Row matrix mirrored case-for-case from pivota-backend
// tests/test_pdp_renderability.py. Both suites encode the SAME measured prod
// cohorts (29 live PDP fetches, 2026-07-25), so a change to one twin that is
// not mirrored in the other shows up as a failure here.
//
// [label, row, expected]
const MATRIX = [
  [
    // 2,541 rows: the sitemap as it already stands.
    'mirror row with an active seed',
    {
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'ext_a181155ef65de19f961ec40a',
      pdp_seed_route_ok: true,
    },
    true,
  ],
  [
    // 424 rows: observed-seller mirror. merchant_id is merch_obs_… and the id
    // carries no ext_ prefix, so ONLY the source_system/platform arms catch it.
    // Measured 200 + product JSON-LD (6/6) despite live_read_enabled=false.
    'observed-seller mirror row with an active seed',
    {
      merchant_id: 'merch_obs_8887b6c53f029191',
      platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'goongbe_us_7400860516410',
      pdp_seed_route_ok: true,
    },
    true,
  ],
  [
    // The 127 sitemap URLs that served 500 after agent-ui#269.
    'mirror row whose only seed is inactive',
    {
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'ext_dead',
      pdp_seed_route_ok: false,
    },
    false,
  ],
  [
    // THE 1,375. Path-C minted canonicals: the seed attaches by
    // attached_product_key and carries external_product_id='brand:hash', while
    // source_product_id is a name slug — the keys never meet, so nothing
    // answers the gateway's lookup and the PDP hard-500s (11/11 measured).
    'Path-C minted canonical whose seed does not answer on its id',
    {
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_system: 'catalog_enrichment_agent_v1',
      source_product_id: 'tower-28-beauty-sunnydays-tinted-spf-30',
      pdp_seed_route_ok: false,
    },
    false,
  ],
  [
    // Audit-minted: no merchant sync and no seed. Measured 500 (1/1).
    'url_audit row',
    {
      merchant_id: 'merch_a2b08ee928dd9da5',
      platform: 'url_audit',
      source_system: null,
      source_product_id: 'us.hoverair.com~2a3fdfbf7046',
      pdp_seed_route_ok: false,
    },
    false,
  ],
  [
    'merchant-synced shopify row with no seed at all',
    {
      merchant_id: 'merch_a',
      platform: 'shopify',
      source_system: 'shopify_products_sync',
      source_product_id: 'shopify_12345',
      pdp_seed_route_ok: false,
    },
    true,
  ],
  [
    // 4,492 merchant-owned rows share a source_product_id with some seed's
    // external_product_id; the gateway's precheck is lane-gated, so an
    // unrelated seed going inactive must not drop them.
    'merchant-synced row colliding with an unrelated inactive seed',
    {
      merchant_id: 'merch_a',
      platform: 'shopify',
      source_system: 'shopify_products_sync',
      source_product_id: 'shopify_collides',
      pdp_seed_route_ok: false,
    },
    true,
  ],
  [
    // isExternalSeedProductId() keys off the id prefix, not the merchant.
    'ext_-prefixed id under a normal merchant, seed inactive',
    {
      merchant_id: 'merch_a',
      platform: 'shopify',
      source_system: 'shopify_products_sync',
      source_product_id: 'ext_orphaned',
      pdp_seed_route_ok: false,
    },
    false,
  ],
  [
    'brand_authored stub with neither a seed nor a sync adapter',
    {
      merchant_id: 'merch_brand',
      platform: 'brand_authored',
      source_system: null,
      source_product_id: 'brand_stub_1',
      pdp_seed_route_ok: false,
    },
    false,
  ],
];

for (const [label, row, expected] of MATRIX) {
  test(`renderability: ${label}`, () => {
    assert.equal(
      pdpRouteResolvable({
        merchantId: row.merchant_id,
        platform: row.platform,
        sourceSystem: row.source_system,
        sourceProductId: row.source_product_id,
        seedRouteOk: row.pdp_seed_route_ok,
      }),
      expected,
    );
    assert.equal(pdpRouteResolvableFromRow(row), expected);
  });
}

test('a row without the seed-route column stays tri-state null', () => {
  // A producer not yet taught to select pdp_seed_route_ok must not be read as
  // "not renderable" — that would mass-demote the catalog the moment the gate
  // is flipped on.
  assert.equal(
    pdpRouteResolvableFromRow({
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'ext_x',
    }),
    null,
  );
  assert.equal(pdpRouteResolvableFromRow(null), null);
});

test('the seed EXISTS fragment is correlated to the outer row', () => {
  // If catalog_products ever leaks into that subquery's FROM the predicate
  // becomes a cartesian product and every row reads renderable as long as ONE
  // acceptable seed exists anywhere.
  const sql = seedRouteResolvesSql('cp');
  assert.match(sql, /^EXISTS \(SELECT 1 FROM external_product_seeds _seed_route /);
  assert.ok(sql.includes('_seed_route.external_product_id = cp.source_product_id'));
  assert.ok(!/FROM external_product_seeds _seed_route,/.test(sql));
  assert.ok(!sql.includes('catalog_products'));
  // A falsy status falls THROUGH the gateway precheck rather than 404ing.
  assert.ok(sql.includes("IN ('', 'active')"));
});

test('the alias is threaded, not hardcoded', () => {
  assert.ok(seedRouteResolvesSql('x').includes('x.source_product_id'));
});
