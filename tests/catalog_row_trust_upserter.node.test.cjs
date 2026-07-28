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
    merchant_id: 'merch_first_party_seller_1',
    platform: 'shopify',
    source_system: 'shopify',
    source_ref: 'gid://shopify/Product/1',
    source_product_id: '1',
    source_domain: 'chydan.myshopify.com',
    sync_status: 'live',
    suppression_reason: null,
    last_seen_in_sync_at: daysAgo(1),
    // c1.v0.5 renderability input. The real product join ALWAYS selects this
    // column, so the fixture must too — a fixture that omitted it would
    // silently exercise the tri-state "absent" path and mask the gate.
    pdp_seed_route_ok: true,
    serving_eligible: true,
    // ADR-008 SLICE 1: present on the row so the 'stays unreachable' test
    // below can prove the JOIN, not the fixture, is what drops it.
    index_eligible: false,
    pipeline_stage: 'serving',
    blocker_code: null,
    content_quality_score: 0.8,
    quality_scored_at: daysAgo(1),
    last_extracted_at: daysAgo(1),
    pil_source_listing_ref: 'merch_first_party_seller_1:1',
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
    eps_seed_kind: null,
    ms_merchant_id: 'merch_first_party_seller_1',
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
    ['merch_first_party_seller_1:1'],
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

// ADR-009: the external_product_seeds join must key on source_system, not the
// legacy merchant_id='external_seed' bucket — external seeds now mirror under
// per-brand observed sellers (merch_obs_…), and a merchant_id conjunct excluded
// them → eps NULL → source lifecycle 'unknown' → a disabled merch_obs_ seed
// never propagated its inactive block. Keep in sync with the Python twin.
test('external_product_seeds join gates on source_system, not legacy merchant_id (ADR-009)', async () => {
  const pool = new FakePool({ joined: [makeJoinedRow()] });
  await upsertCatalogRowTrust(pool, 'pk_internal_1', NOW);
  const select = pool.queries.find(
    (q) => q.sql.includes('external_seed_one eps') && q.sql.includes('catalog_products cp'),
  );
  assert.ok(select, 'no product-join SELECT emitted');
  // The join correlates by source_system + external_product_id …
  assert.match(select.sql, /external_seed_one eps\s+(?:--[^\n]*\n\s*)*ON cp\.source_system = 'external_product_seeds_mirror_v1'/);
  // … and no longer restricts the join to the legacy external_seed merchant.
  assert.doesNotMatch(select.sql, /eps\s+(?:--[^\n]*\n\s*)*ON cp\.merchant_id = 'external_seed'/);
});

// ---------------------------------------------------------------------------
// c1.v0.5 renderability input threading.
// Ports pivota-backend tests/test_catalog_row_trust_upserter.py:358-440.
//
// Until these existed, three mutations survived the ENTIRE Node suite:
//   (a) pdpRouteResolvableFromRow({...row, pdp_seed_route_ok: undefined})
//   (b) `seed_kind: null` instead of `row.eps_seed_kind`
//   (c) replacing seedRouteResolvesSql('cp') with TRUE in the product joins
// Each is pinned below.
// ---------------------------------------------------------------------------

/** The Path-C minted canonical cohort — THE 1,375 that serve hard 500s. */
function mintedRow(overrides = {}) {
  return makeJoinedRow({
    merchant_id: 'external_seed',
    platform: 'external_seed',
    source_system: 'catalog_enrichment_agent_v1',
    source_product_id: 'tower-28-beauty-sunnydays-tinted-spf-30',
    pdp_seed_route_ok: false,
    eps_id: 1,
    eps_status: 'active',
    ms_merchant_id: null,
    ms_platform: null,
    ms_domain: null,
    ms_status: null,
    ms_last_sync: null,
    ...overrides,
  });
}

/** Runs the real upserter against a FakePool with the gate env forced. */
async function decisionFor(row, { renderableGate, indexEligibleRead } = {}) {
  const prevGate = process.env.CATALOG_TRUST_RENDERABLE_GATE;
  const prevIdx = process.env.INDEX_ELIGIBLE_READ;
  const set = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  set('CATALOG_TRUST_RENDERABLE_GATE', renderableGate);
  set('INDEX_ELIGIBLE_READ', indexEligibleRead);
  try {
    const pool = new FakePool({ joined: [row] });
    const ok = await upsertCatalogRowTrust(pool, row.product_key, NOW);
    assert.equal(ok, true);
    const upsert = pool.queries.find((q) => q.sql.includes('ON CONFLICT'));
    assert.ok(upsert, 'no upsert emitted');
    return {
      decision: upsert.params[17],
      reasons: upsert.params[18],
      policyVersion: upsert.params[20],
      sql: pool.queries.find((q) => q.sql.includes('AS pdp_seed_route_ok'))?.sql,
    };
  } finally {
    set('CATALOG_TRUST_RENDERABLE_GATE', prevGate);
    set('INDEX_ELIGIBLE_READ', prevIdx);
  }
}

test('seed-route column reaches the policy as a LANE-AWARE answer, not raw', async () => {
  // The SQL column is the RAW seed EXISTS; the LANE test happens in JS. Prove
  // the two halves are wired together rather than the raw EXISTS being passed
  // straight through, by feeding a row whose lane and whose raw answer
  // DISAGREE: a merchant-synced shopify row with pdp_seed_route_ok = TRUE.
  // Raw passthrough would call it renderable; the lane test correctly does not,
  // because a merchant-synced row must never borrow a stranger seed's answer
  // (4,492 merchant rows collide with some seed's external_product_id).
  const res = await decisionFor(makeJoinedRow({ pdp_seed_route_ok: true }), {
    renderableGate: '1',
  });
  assert.equal(res.decision, 'blocked');
  assert.ok(res.reasons.includes('PDP_ROUTE_UNRESOLVABLE'));

  // …and a genuinely seed-routed row with the same raw TRUE stays public, so
  // the assertion above is about the LANE and not just "always blocked".
  const seedRouted = await decisionFor(
    makeJoinedRow({
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'ext_a181155ef65de19f961ec40a',
      pdp_seed_route_ok: true,
      eps_id: 1,
      eps_status: 'active',
      ms_merchant_id: null,
      ms_platform: null,
      ms_domain: null,
      ms_status: null,
      ms_last_sync: null,
    }),
    { renderableGate: '1' },
  );
  assert.equal(seedRouted.decision, 'public');
});

test('Path-C minted row with no seed route is BLOCKED when the gate is on', async () => {
  // THE 1,375. A catalog_enrichment_agent_v1 row's seed attaches by
  // attached_product_key, so nothing answers on its source_product_id and the
  // PDP hard-500s. MUTATION PIN (a): dropping row.pdp_seed_route_ok makes the
  // policy input null, the gate never fires, and this returns 'public'.
  const res = await decisionFor(mintedRow(), { renderableGate: '1' });
  assert.equal(res.decision, 'blocked');
  assert.ok(res.reasons.includes('PDP_ROUTE_UNRESOLVABLE'));
});

test('Path-C minted row stays PUBLIC with the gate off (what prod does today)', async () => {
  const res = await decisionFor(mintedRow(), { renderableGate: undefined });
  assert.equal(res.decision, 'public');
  assert.ok(!res.reasons.includes('PDP_ROUTE_UNRESOLVABLE'));
  assert.equal(res.policyVersion, 'c1.v0.5');
});

test('a producer that never learned the column keeps c1.v0.4 output exactly', async () => {
  // Tri-state contract: absence NEVER blocks.
  const legacy = mintedRow();
  delete legacy.pdp_seed_route_ok;
  const res = await decisionFor(legacy, { renderableGate: '1' });
  assert.equal(res.decision, 'public');
  assert.ok(!res.reasons.includes('PDP_ROUTE_UNRESOLVABLE'));
});

test('eps_seed_kind reaches the policy so a cross-sourced observed seller is gated', async () => {
  // MUTATION PIN (b): `seed_kind: null` instead of `row.eps_seed_kind` makes
  // the cross row public via the observed-seller identity-coverage exemption —
  // exactly the live disagreement with the Python twin that c1.v0.5 closes. An
  // observed seller crawled off a MARKETPLACE (VODANA→Amazon) is not
  // authoritative for its own content.
  const base = {
    merchant_id: 'merch_obs_vodana',
    platform: 'external_seed',
    source_system: 'external_product_seeds_mirror_v1',
    eps_id: 7,
    eps_status: 'active',
    identity_status: null,
    live_read_enabled: null,
    ms_merchant_id: null,
    ms_platform: null,
    ms_domain: null,
    ms_status: null,
    ms_last_sync: null,
  };
  const selfRes = await decisionFor(makeJoinedRow({ ...base, eps_seed_kind: 'self' }));
  const crossRes = await decisionFor(makeJoinedRow({ ...base, eps_seed_kind: 'cross' }));

  assert.equal(selfRes.decision, 'public');
  assert.notEqual(
    crossRes.decision,
    'public',
    'a seed_kind=cross observed seller must not serve as brand-official',
  );
});

// ---------------------------------------------------------------------------
// ADR-008 SLICE 1: the index_eligible arm must be REACHABLE from the upserter.
// ---------------------------------------------------------------------------

test('the index_eligible arm stays UNREACHABLE from the upserter, on purpose', async () => {
  // Not an oversight — a deliberate safety property, pinned so nobody "fixes"
  // it in one repo. INDEX_ELIGIBLE_READ is set ASYMMETRICALLY in prod: =1 on
  // the pivota-backend `web` service, UNSET here (verified 2026-07-25). Both
  // repos write the same catalog_row_trust table and the UPSERT rewrites a row
  // whenever serving_decision differs, so the ONLY thing keeping the ~100 prod
  // rows with index_eligible=true AND serving_eligible<>true from flapping
  // public<->blocked forever is that NEITHER join selects the column — which
  // makes both writers compute serving_eligible-only regardless of the flag.
  //
  // Closing the gap is a THREE-part founder change: select the column in both
  // joins AND set the env on both Railway services, in one operation.
  const citable = makeJoinedRow({ serving_eligible: false, index_eligible: true });

  for (const flag of [undefined, '1']) {
    const res = await decisionFor(citable, { indexEligibleRead: flag });
    assert.equal(
      res.decision,
      'blocked',
      `flag=${flag}: the arm must stay unreachable until BOTH repos wire it up`,
    );
    assert.ok(res.reasons.includes('INDEX_NOT_SERVING_ELIGIBLE'));
    assert.ok(
      !res.sql.includes('ips.index_eligible'),
      'the product join must NOT select ips.index_eligible — see catalogTrustPolicy.js',
    );
  }
});

// ---------------------------------------------------------------------------
// SQL pins — the half of the threading a row-level unit test cannot see.
// ---------------------------------------------------------------------------

test('both product joins compile the c1.v0.5 seed-route EXISTS, not TRUE', () => {
  // MUTATION PIN (c): replacing seedRouteResolvesSql('cp') with TRUE in either
  // join makes every row look renderable and silently defeats the gate in prod
  // while every row-level unit test still passes.
  const { PRODUCT_JOIN_SQL } = require('../src/services/catalogRowTrustUpserter');
  const { PRODUCT_DRIVER_SQL } = require('../scripts/backfill-catalog-row-trust.cjs');
  const { seedRouteResolvesSql } = require('../src/services/pdpRenderability');

  const fragment = seedRouteResolvesSql('cp');
  assert.ok(fragment.includes('external_product_seeds _seed_route'));
  assert.ok(fragment.includes('cp.source_product_id'));

  for (const [name, sql] of [
    ['PRODUCT_JOIN_SQL', PRODUCT_JOIN_SQL],
    ['PRODUCT_DRIVER_SQL', PRODUCT_DRIVER_SQL],
  ]) {
    assert.ok(
      sql.includes(fragment),
      `${name} must embed seedRouteResolvesSql('cp') verbatim`,
    );
    assert.ok(
      sql.includes('AS pdp_seed_route_ok'),
      `${name} must alias the seed-route EXISTS as pdp_seed_route_ok`,
    );
    assert.ok(sql.includes('eps_seed_kind'), `${name} must select the coalesced seed_kind`);
    assert.ok(
      !sql.includes('ips.index_eligible'),
      `${name} must NOT select ips.index_eligible — see catalogTrustPolicy.js`,
    );
  }
});

test('the three trust suites are actually wired into `npm run test:node`', () => {
  // These files are `.cjs`, which jest.config.js testMatch
  // ('**/tests/**/*.test.(js|ts)') does NOT match. They therefore run ONLY if
  // listed explicitly in the test:node script. All three sat in the repo
  // collecting zero executions, which is how the c1.v0.5 mutations above
  // survived. Assert the wiring so a future suite cannot go dead silently.
  const pkg = require('../package.json');
  const script = String(pkg.scripts['test:node'] || '');
  for (const f of [
    'tests/catalog_trust_policy.node.test.cjs',
    'tests/pdp_renderability.node.test.cjs',
    'tests/catalog_row_trust_upserter.node.test.cjs',
  ]) {
    assert.ok(script.includes(f), `${f} is not listed in the test:node script — it never runs`);
  }
});
