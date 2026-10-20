'use strict';

// CRAWL_FRESH: a drain-lane storefront crawl row (a retailer listing, or a
// brand-official / curated `ext:` canonical) whose listing price was read
// recently is exempt from the identity-COVERAGE gates while it stays fresh.
//
// NODE TWIN of pivota-backend tests/test_catalog_trust_policy_crawl_fresh.py and
// tests/test_catalog_row_trust_upserter_crawl_fresh.py. Same cases, same
// fixtures, same input matrix. The two services write ONE catalog_row_trust
// table, so a case that answers differently here than there is a row that flaps.
//
// The contract pinned here:
//   * only an explicit `crawl_fresh: true` on a drain-lane crawl row acts; false
//     and absent are today's decision, byte for byte;
//   * it removes IDENTITY_CONFIDENCE_NULL, IDENTITY_LIVE_READ_DISABLED and the
//     silent identity-'unknown' shadow, and records CRAWL_FRESH only where it
//     removed one of them;
//   * it never removes review, conflict, non-canonical or any blocked cause, and
//     never promotes a row whose PDP is known not to render;
//   * round 2: it applies only to an identity GAP ('approved', or 'unknown' with
//     no listing / a raw '' or 'unknown' status -- never 'rejected' and the
//     like) and never to a row that stays shadow anyway, so every applied case
//     ends public; a future-dated read is stale;
//   * round 3: the row's read date is the OLDEST valid read across EVERY live
//     drain offer in a served market (variants and ::canonical alike), valid =
//     not after the batch's bound now, market DECLARED by the writer, not an
//     employee edit; at least one such offer in stock; one clock per batch;
//   * first-party and observed-seller ('self') rows are untouched;
//   * the switch (CATALOG_TRUST_CRAWL_FRESH_ENABLED, default off) and N
//     (CATALOG_TRUST_CRAWL_FRESH_DAYS, default 7) live in the upserter, which
//     with the switch off sends no extra statement and never sets the input;
//   * the freshness statement is the backend's, byte for byte (one bind token
//     aside), pinned against a fixture rendered from the backend constant.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  POLICY_VERSION,
  REASON_CODES,
  CRAWL_FRESH_COVERAGE_GAP_STATUSES,
  CRAWL_FRESH_DEFAULT_DAYS,
  CRAWL_LISTING_KEY_PREFIX,
  CRAWL_SOURCE_SYSTEM,
  deriveTrust,
  isCrawlFresh,
  isCrawlListing,
} = require('../src/services/catalogTrustPolicy');
const { TEST_MERCHANT_IDS } = require('../src/services/testMerchantPolicy');
const upserter = require('../src/services/catalogRowTrustUpserter');

const NOW = new Date('2026-10-20T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const RETAILER_PK = 'ext:retailer:0123456789abcdef0123456789abcdef';
const OTHER_RETAILER_PK = 'ext:retailer:fedcba9876543210fedcba9876543210';
const BRAND_PK = 'ext:serum-slug::0123abcd';
const COVERAGE_CODES = [
  REASON_CODES.IDENTITY_CONFIDENCE_NULL,
  REASON_CODES.IDENTITY_LIVE_READ_DISABLED,
];

function ago(ms) {
  return new Date(NOW.getTime() - ms);
}

// Every env var this file touches, restored after each test so no case leaks a
// switch into the next (and the suite is order-independent).
const TOUCHED_ENV = [
  'CATALOG_TRUST_CRAWL_FRESH_ENABLED',
  'CATALOG_TRUST_CRAWL_FRESH_DAYS',
  'CATALOG_TRUST_RENDERABLE_GATE',
  'INDEX_ELIGIBLE_READ',
];
let savedEnv = {};
test.beforeEach(() => {
  savedEnv = {};
  for (const k of TOUCHED_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
test.afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ---------------------------------------------------------------------------
// Policy fixtures (the backend file's, field for field)
// ---------------------------------------------------------------------------

function retailerProduct(overrides = {}) {
  return {
    product_key: RETAILER_PK,
    content_key: 'ck_retailer_1',
    merchant_id: 'merch_obs_0123456789abcdef',
    platform: 'external_seed',
    source_system: 'catalog_enrichment_agent_v1',
    source_ref: 'https://shop.example.com/products/serum',
    source_product_id: 'serum-slug',
    source_domain: 'shop.example.com',
    sync_status: 'live',
    suppression_reason: null,
    last_seen_in_sync_at: ago(DAY_MS),
    // The drain's seeds are tagged 'cross': a retailer is not the brand.
    seed_kind: 'cross',
    ...overrides,
  };
}

function eligibleIps(overrides = {}) {
  return {
    serving_eligible: true,
    pipeline_stage: 'serving',
    blocker_code: null,
    content_quality_score: 0.8,
    quality_scored_at: ago(DAY_MS),
    last_extracted_at: ago(DAY_MS),
    ...overrides,
  };
}

function activeSeed(overrides = {}) {
  return {
    id: 77,
    status: 'active',
    domain: 'shop.example.com',
    attached_product_key: RETAILER_PK,
    last_seen_at: ago(DAY_MS),
    ...overrides,
  };
}

function identity(overrides = {}) {
  return {
    source_listing_ref: 'seed:77',
    identity_status: 'approved',
    identity_confidence: 0.9,
    live_read_enabled: true,
    review_required: false,
    sellable_item_group_id: 'sig_example',
    ...overrides,
  };
}

function inputs(overrides = {}) {
  return {
    subject_type: 'product',
    subject_key: RETAILER_PK,
    product: retailerProduct(),
    identity: null,
    ips: eligibleIps(),
    external_seed: activeSeed(),
    pdp_route_resolvable: true,
    row_has_priced_offer: true,
    row_is_elected_canonical: null,
    now: NOW,
    ...overrides,
  };
}

function derive(overrides = {}) {
  return deriveTrust(inputs(overrides));
}

function without(obj, ...keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

// ---------------------------------------------------------------------------
// The exemption itself
// ---------------------------------------------------------------------------

test('today a retailer listing with no identity is shadow (IDENTITY_CONFIDENCE_NULL)', () => {
  const out = derive();
  assert.equal(out.serving_decision, 'shadow');
  assert.ok(out.serving_reason_codes.includes(REASON_CODES.IDENTITY_CONFIDENCE_NULL));
  assert.ok(!out.serving_reason_codes.includes(REASON_CODES.CRAWL_FRESH));
});

test('a fresh listing with no identity goes public with the trace code', () => {
  const out = derive({ crawl_fresh: true });
  assert.equal(out.serving_decision, 'public');
  assert.deepEqual(out.serving_reason_codes, [
    REASON_CODES.CRAWL_FRESH,
    REASON_CODES.PUBLIC_PASSTHROUGH,
  ]);
  assert.equal(out.identity_status, 'unknown');
  assert.equal(out.policy_version, POLICY_VERSION);
});

test('a fresh listing with live_read disabled goes public', () => {
  const ident = identity({ live_read_enabled: false });
  assert.deepEqual(derive({ identity: ident }).serving_reason_codes, [
    REASON_CODES.IDENTITY_LIVE_READ_DISABLED,
  ]);
  const out = derive({ identity: ident, crawl_fresh: true });
  assert.equal(out.serving_decision, 'public');
  assert.deepEqual(out.serving_reason_codes, [
    REASON_CODES.CRAWL_FRESH,
    REASON_CODES.PUBLIC_PASSTHROUGH,
  ]);
});

test('a fresh listing approved with a null confidence goes public', () => {
  const ident = identity({ identity_confidence: null });
  assert.equal(derive({ identity: ident }).serving_decision, 'shadow');
  const out = derive({ identity: ident, crawl_fresh: true });
  assert.equal(out.serving_decision, 'public');
  assert.ok(out.serving_reason_codes.includes(REASON_CODES.CRAWL_FRESH));
  for (const c of COVERAGE_CODES) assert.ok(!out.serving_reason_codes.includes(c));
});

for (const rawStatus of ['unknown', ' UNKNOWN ', '', null]) {
  test(`a fresh listing with a gap status (${JSON.stringify(rawStatus)}) and a confidence goes public (the silent shadow)`, () => {
    const ident = identity({ identity_status: rawStatus, identity_confidence: 0.4 });
    const today = derive({ identity: ident });
    assert.equal(today.serving_decision, 'shadow');
    for (const c of COVERAGE_CODES) assert.ok(!today.serving_reason_codes.includes(c));
    const out = derive({ identity: ident, crawl_fresh: true });
    assert.equal(out.serving_decision, 'public');
    assert.deepEqual(out.serving_reason_codes, [
      REASON_CODES.CRAWL_FRESH,
      REASON_CODES.PUBLIC_PASSTHROUGH,
    ]);
  });
}

// Round 2: deriveIdentity folds every unrecognised status into 'unknown'; only
// the GAP statuses are a coverage question.
for (const rawStatus of ['rejected', 'pending', 'resolved', 'unverified']) {
  for (const confidence of [0.2, null]) {
    test(`a listing status that is a verdict (${rawStatus}, confidence ${confidence}) is never lifted`, () => {
      const ident = identity({ identity_status: rawStatus, identity_confidence: confidence });
      const today = derive({ identity: ident });
      assert.equal(today.serving_decision, 'shadow');
      assert.deepEqual(derive({ identity: ident, crawl_fresh: true }), today);
    });
  }
}

test('the gap statuses are pinned', () => {
  assert.deepEqual([...CRAWL_FRESH_COVERAGE_GAP_STATUSES].sort(), ['', 'unknown']);
});

test('a fresh listing public on its own identity gets no new code (no rewrite)', () => {
  const ident = identity();
  assert.deepEqual(derive({ identity: ident, crawl_fresh: true }), derive({ identity: ident }));
});

test('the trace code is in the vocabulary', () => {
  assert.equal(REASON_CODES.CRAWL_FRESH, 'CRAWL_FRESH');
  assert.ok(Object.values(REASON_CODES).includes('CRAWL_FRESH'));
});

test('POLICY_VERSION does not bump for CRAWL_FRESH', () => {
  assert.equal(POLICY_VERSION, 'c1.v0.9');
});

// ---------------------------------------------------------------------------
// Stale / absent: today's gates, byte for byte
// ---------------------------------------------------------------------------

for (const value of [false, null, undefined, 0, '']) {
  test(`stale or absent (${JSON.stringify(value) ?? 'undefined'}) is exactly today`, () => {
    for (const ident of [null, identity({ live_read_enabled: false }), identity({ identity_confidence: null })]) {
      assert.deepEqual(derive({ identity: ident, crawl_fresh: value }), derive({ identity: ident }));
    }
  });
}

test('an absent key and an explicit null are the same', () => {
  assert.deepEqual(deriveTrust(without(inputs(), 'crawl_fresh')), derive({ crawl_fresh: null }));
});

// ---------------------------------------------------------------------------
// Never exempted
// ---------------------------------------------------------------------------

test('review_required still shadows', () => {
  const ident = identity({ identity_status: 'review_required' });
  const out = derive({ identity: ident, crawl_fresh: true });
  assert.equal(out.serving_decision, 'shadow');
  assert.deepEqual(out.serving_reason_codes, [REASON_CODES.IDENTITY_REVIEW_REQUIRED_LIVE_READ]);
  assert.deepEqual(out, derive({ identity: ident }));
});

test('approved but flagged for review still shadows', () => {
  const ident = identity({ review_required: true, live_read_enabled: false });
  const out = derive({ identity: ident, crawl_fresh: true });
  assert.equal(out.serving_decision, 'shadow');
  assert.deepEqual(out, derive({ identity: ident }));
});

test('a force_review_required override still shadows', () => {
  const override = { id: 'ovr_1', action_type: 'force_review_required', active: true };
  const out = derive({ override, crawl_fresh: true });
  assert.equal(out.serving_decision, 'shadow');
  assert.ok(out.serving_reason_codes.includes(REASON_CODES.IDENTITY_REVIEW_REQUIRED_LIVE_READ));
});

test('identity conflict still blocks', () => {
  const ident = identity({ identity_status: 'conflict' });
  const out = derive({ identity: ident, crawl_fresh: true });
  assert.equal(out.serving_decision, 'blocked');
  assert.deepEqual(out.serving_reason_codes, [REASON_CODES.IDENTITY_CONFLICT]);
  assert.deepEqual(out, derive({ identity: ident }));
});

for (const ident of [null, identity({ live_read_enabled: false })]) {
  test(`a non-canonical duplicate still shadows and is not rewritten (identity ${ident ? 'live_read off' : 'none'})`, () => {
    // Round 2: a row that stays shadow as a duplicate gets no exemption at all,
    // so its reason codes are exactly today's and the flip writes nothing.
    const out = derive({ identity: ident, row_is_elected_canonical: false, crawl_fresh: true });
    assert.equal(out.serving_decision, 'shadow');
    assert.ok(out.serving_reason_codes.includes(REASON_CODES.NON_CANONICAL_DUPLICATE));
    assert.ok(!out.serving_reason_codes.includes(REASON_CODES.CRAWL_FRESH));
    assert.deepEqual(out, derive({ identity: ident, row_is_elected_canonical: false }));
  });
}

test('the elected canonical goes public', () => {
  assert.equal(derive({ row_is_elected_canonical: true, crawl_fresh: true }).serving_decision, 'public');
});

const BLOCKED_CAUSES = [
  [{ product: retailerProduct({ suppression_reason: 'retired' }) }, REASON_CODES.ROW_TOMBSTONED],
  [{ external_seed: activeSeed({ status: 'disabled' }) }, REASON_CODES.EXTERNAL_SEED_INACTIVE],
  [{ ips: null }, REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE],
  [{ ips: eligibleIps({ serving_eligible: false }) }, REASON_CODES.INDEX_NOT_SERVING_ELIGIBLE],
  [{ product: retailerProduct({ sync_status: 'paused' }) }, REASON_CODES.PUBLISH_STATE_NOT_PUBLIC],
  [{ row_has_priced_offer: false }, REASON_CODES.OFFER_PRICE_MISSING],
  [
    { active_quarantines: [{ state: 'active', match_type: 'domain', match_value: 'shop.example.com' }] },
    REASON_CODES.SOURCE_QUARANTINED,
  ],
];
for (const [overrides, reason] of BLOCKED_CAUSES) {
  test(`blocked cause ${reason} (${Object.keys(overrides).join(',')}) still blocks`, () => {
    const today = derive(overrides);
    const out = derive({ crawl_fresh: true, ...overrides });
    assert.equal(out.serving_decision, 'blocked');
    assert.ok(out.serving_reason_codes.includes(reason));
    assert.deepEqual(out, today);
  });
}

test('a test merchant still blocks', () => {
  const rig = [...TEST_MERCHANT_IDS].sort()[0];
  const product = retailerProduct({ merchant_id: rig });
  const out = derive({ product, crawl_fresh: true });
  assert.equal(out.serving_decision, 'blocked');
  assert.equal(out.serving_reason_codes.at(-1), REASON_CODES.TEST_MERCHANT_EXCLUDED);
  assert.deepEqual(out, derive({ product }));
});

test('the renderable gate still blocks', () => {
  process.env.CATALOG_TRUST_RENDERABLE_GATE = '1';
  const out = derive({ pdp_route_resolvable: false, crawl_fresh: true });
  assert.equal(out.serving_decision, 'blocked');
  assert.equal(out.serving_reason_codes.at(-1), REASON_CODES.PDP_ROUTE_UNRESOLVABLE);
});

test('a known-unrenderable PDP is never promoted, even with the renderable gate off', () => {
  const out = derive({ pdp_route_resolvable: false, crawl_fresh: true });
  assert.equal(out.serving_decision, 'shadow');
  assert.deepEqual(out, derive({ pdp_route_resolvable: false }));
});

test('an uncomputed renderability does not hold the exemption back', () => {
  assert.equal(derive({ pdp_route_resolvable: null, crawl_fresh: true }).serving_decision, 'public');
});

// ---------------------------------------------------------------------------
// Brand-official / curated drain rows: the same arm, the same code
// ---------------------------------------------------------------------------

function brandOfficialProduct(overrides = {}) {
  return retailerProduct({
    product_key: BRAND_PK,
    merchant_id: 'merch_brand_0123456789ab',
    source_domain: 'brand.example.com',
    seed_kind: 'cross',
    ...overrides,
  });
}

for (const seedKind of ['cross', 'self', null]) {
  for (const [ident, todayCode] of [
    [null, REASON_CODES.IDENTITY_CONFIDENCE_NULL],
    [identity({ live_read_enabled: false }), REASON_CODES.IDENTITY_LIVE_READ_DISABLED],
  ]) {
    test(`a fresh brand-official row (seed_kind=${seedKind}, ${todayCode}) goes public with the same code`, () => {
      const product = brandOfficialProduct({ seed_kind: seedKind });
      const today = derive({ product, identity: ident });
      assert.equal(today.serving_decision, 'shadow');
      assert.ok(today.serving_reason_codes.includes(todayCode));
      const out = derive({ product, identity: ident, crawl_fresh: true });
      assert.equal(out.serving_decision, 'public');
      assert.deepEqual(out.serving_reason_codes, [
        REASON_CODES.CRAWL_FRESH,
        REASON_CODES.PUBLIC_PASSTHROUGH,
      ]);
    });
  }
}

test('a stale brand-official row is today', () => {
  const product = brandOfficialProduct();
  assert.deepEqual(derive({ product, crawl_fresh: false }), derive({ product }));
});

// ---------------------------------------------------------------------------
// Other lanes untouched, whatever the input says
// ---------------------------------------------------------------------------

const OTHER_LANES = [
  // another writer's key space
  retailerProduct({ product_key: 'prod::external_seed::merch_x::ext_1' }),
  // retailer key, another writer
  retailerProduct({ source_system: 'external_product_seeds_mirror_v1' }),
  retailerProduct({ source_system: null }),
  // the prefix must be a PREFIX
  retailerProduct({ product_key: `x${RETAILER_PK}` }),
  retailerProduct({ product_key: RETAILER_PK.toUpperCase() }),
];
OTHER_LANES.forEach((product, i) => {
  test(`the input alone never exempts another lane (#${i})`, () => {
    for (const ident of [null, identity({ live_read_enabled: false })]) {
      assert.deepEqual(
        derive({ product, identity: ident, crawl_fresh: true }),
        derive({ product, identity: ident }),
      );
    }
  });
});

test('first-party rows are unchanged', () => {
  const product = retailerProduct({
    product_key: 'pk_first_party_1',
    merchant_id: 'merch_first_party_seller_1',
    platform: 'shopify',
    source_system: 'shopify',
    seed_kind: null,
  });
  for (const ident of [null, identity({ live_read_enabled: false })]) {
    assert.deepEqual(
      derive({ product, identity: ident, external_seed: null, crawl_fresh: true }),
      derive({ product, identity: ident, external_seed: null }),
    );
  }
  assert.ok(
    derive({ product, external_seed: null, crawl_fresh: true })
      .serving_reason_codes.includes(REASON_CODES.IDENTITY_NOT_APPLICABLE_FIRST_PARTY),
  );
});

for (const seedKind of ['self', null]) {
  test(`observed-seller rows (seed_kind=${seedKind}) are unchanged even on a retailer key`, () => {
    const product = retailerProduct({ seed_kind: seedKind });
    const out = derive({ product, crawl_fresh: true });
    assert.deepEqual(out, derive({ product }));
    assert.deepEqual(out.serving_reason_codes, [
      REASON_CODES.IDENTITY_NOT_APPLICABLE_FIRST_PARTY,
      REASON_CODES.PUBLIC_PASSTHROUGH,
    ]);
  });
}

test('a missing product is never exempt', () => {
  const out = deriveTrust({ subject_type: 'product', subject_key: RETAILER_PK, crawl_fresh: true, now: NOW });
  assert.equal(out.serving_decision, 'shadow');
});

// ---------------------------------------------------------------------------
// Byte-identical without the input: the backend's matrix, case for case
// (6 products x 8 identities x 3 elected x 3 route x 2 priced = 864 cases, the
// same itertools.product, in the same order, the backend test parametrizes)
// ---------------------------------------------------------------------------

const MATRIX_IDENTITIES = [
  null,
  identity(),
  identity({ live_read_enabled: false }),
  identity({ identity_confidence: null }),
  identity({ identity_status: 'review_required' }),
  identity({ identity_status: 'conflict' }),
  identity({ identity_status: 'pending', identity_confidence: 0.3 }),
  identity({ review_required: true }),
];
const MATRIX_PRODUCTS = [
  retailerProduct(),
  retailerProduct({ seed_kind: 'self' }),
  retailerProduct({ product_key: BRAND_PK, merchant_id: 'merch_brand_x' }),
  retailerProduct({
    product_key: 'pk_first_party_1', merchant_id: 'merch_fp', platform: 'shopify',
    source_system: 'shopify', seed_kind: null,
  }),
  retailerProduct({
    product_key: 'ext_4242', merchant_id: 'external_seed',
    source_system: 'external_product_seeds_mirror_v1', seed_kind: null,
  }),
  retailerProduct({ suppression_reason: 'retired' }),
];
const TRI = [null, true, false];

function* matrixCases() {
  for (const product of MATRIX_PRODUCTS) {
    for (const ident of MATRIX_IDENTITIES) {
      for (const elected of TRI) {
        for (const route of TRI) {
          for (const priced of [true, false]) {
            yield {
              product, identity: ident, row_is_elected_canonical: elected,
              pdp_route_resolvable: route, row_has_priced_offer: priced,
            };
          }
        }
      }
    }
  }
}

test('without a true input every decision is identical (864-case matrix)', () => {
  let cases = 0;
  let moved = 0;
  for (const base of matrixCases()) {
    cases += 1;
    const absent = deriveTrust(without(inputs(base), 'crawl_fresh'));
    assert.deepEqual(derive({ ...base, crawl_fresh: false }), absent);
    assert.deepEqual(derive({ ...base, crawl_fresh: null }), absent);
    const fresh = derive({ ...base, crawl_fresh: true });
    // With the input on, only the decision/reason codes may move, and only from
    // shadow to public (or a shadow gaining the trace code).
    assert.deepEqual(
      without(fresh, 'serving_decision', 'serving_reason_codes'),
      without(absent, 'serving_decision', 'serving_reason_codes'),
    );
    if (JSON.stringify(fresh) !== JSON.stringify(absent)) {
      moved += 1;
      assert.equal(absent.serving_decision, 'shadow');
      assert.ok(fresh.serving_reason_codes.includes(REASON_CODES.CRAWL_FRESH));
      // round 2: the exemption applies only when it makes the row public
      assert.equal(fresh.serving_decision, 'public');
    }
  }
  assert.equal(cases, 864);
  assert.ok(moved > 0, 'the matrix must exercise the exemption at least once');
});

// Cross-language pin: the backend's derive_trust over the SAME matrix, rendered
// to a fixture (decision + reason codes, input absent and input true). Any
// case where this twin answers differently is a row the two services would
// write differently -- a flap.
test('the matrix answers exactly as the backend twin does (rendered golden)', () => {
  const golden = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'crawl_fresh_trust_matrix.backend.json'), 'utf8'),
  );
  assert.equal(golden.cases.length, 864);
  let i = 0;
  for (const base of matrixCases()) {
    const [absentDecision, absentCodes, freshDecision, freshCodes] = golden.cases[i];
    const absent = deriveTrust(without(inputs(base), 'crawl_fresh'));
    const fresh = derive({ ...base, crawl_fresh: true });
    assert.deepEqual(
      [absent.serving_decision, absent.serving_reason_codes, fresh.serving_decision, fresh.serving_reason_codes],
      [absentDecision, absentCodes, freshDecision, freshCodes],
      `matrix case #${i} disagrees with the backend twin`,
    );
    i += 1;
  }
});

// ---------------------------------------------------------------------------
// The two predicates
// ---------------------------------------------------------------------------

test('listing predicate constants', () => {
  assert.equal(CRAWL_LISTING_KEY_PREFIX, 'ext:');
  assert.equal(CRAWL_SOURCE_SYSTEM, 'catalog_enrichment_agent_v1');
  assert.equal(CRAWL_FRESH_DEFAULT_DAYS, 7);
});

test('listing predicate', () => {
  assert.equal(isCrawlListing(retailerProduct()), true);
  assert.equal(isCrawlListing(null), false);
  assert.equal(isCrawlListing(undefined), false);
  assert.equal(isCrawlListing({}), false);
  assert.equal(isCrawlListing(retailerProduct({ source_system: ' catalog_enrichment_agent_v1' })), false);
  assert.equal(isCrawlListing(retailerProduct({ source_system: 'CATALOG_ENRICHMENT_AGENT_V1' })), false);
  assert.equal(isCrawlListing(retailerProduct({ product_key: 'ext:retailer' })), true);
  assert.equal(isCrawlListing(retailerProduct({ product_key: BRAND_PK })), true);
  assert.equal(isCrawlListing(retailerProduct({ product_key: 'ext' })), false);
  assert.equal(isCrawlListing(retailerProduct({ product_key: 'ext_4242' })), false);
  assert.equal(isCrawlListing(retailerProduct({ product_key: ' ext:retailer:x' })), false);
});

const SEC = 1000;
const HOUR = 60 * 60 * SEC;
for (const [ageMs, days, fresh] of [
  [0, 7, true],
  [7 * DAY_MS, 7, true], // inclusive bound
  [7 * DAY_MS + SEC, 7, false],
  [3 * DAY_MS + 23 * HOUR, 4, true],
  [4 * DAY_MS + SEC, 4, false],
  [12 * HOUR, 0.5, true],
  [12 * HOUR + SEC, 0.5, false],
  [-SEC, 7, false], // round 2: a stamp ahead of `now` is stale
  [-10 * DAY_MS, 7, false],
]) {
  test(`freshness window: age ${ageMs}ms, N=${days} -> ${fresh}`, () => {
    assert.equal(isCrawlFresh(ago(ageMs), { now: NOW, maxAgeDays: days }), fresh);
  });
}

test('freshness of nothing is false', () => {
  assert.equal(isCrawlFresh(null, { now: NOW, maxAgeDays: 7 }), false);
  assert.equal(isCrawlFresh(undefined, { now: NOW, maxAgeDays: 7 }), false);
  assert.equal(isCrawlFresh('not a date', { now: NOW, maxAgeDays: 7 }), false);
  assert.equal(isCrawlFresh('', { now: NOW, maxAgeDays: 7 }), false);
  assert.equal(isCrawlFresh(NOW, { now: null, maxAgeDays: 7 }), false);
  assert.equal(isCrawlFresh(new Date('nope'), { now: NOW, maxAgeDays: 7 }), false);
});

test('freshness reads ISO strings, and a zone-less timestamp as UTC (the twin reads naive as UTC)', () => {
  assert.equal(isCrawlFresh('2026-10-14T12:00:00Z', { now: NOW, maxAgeDays: 6 }), true);
  assert.equal(isCrawlFresh('2026-10-14T11:59:59Z', { now: NOW, maxAgeDays: 6 }), false);
  assert.equal(isCrawlFresh('2026-10-14T12:00:00+00:00', { now: NOW, maxAgeDays: 6 }), true);
  assert.equal(isCrawlFresh('2026-10-14T12:00:00', { now: NOW, maxAgeDays: 6 }), true);
  assert.equal(isCrawlFresh('2026-10-14 11:59:59', { now: NOW, maxAgeDays: 6 }), false);
  assert.equal(isCrawlFresh('2026-10-14T14:00:00+02:00', { now: NOW, maxAgeDays: 6 }), true);
  // An hours-only offset, as Python's fromisoformat reads it; a lowercase 'z',
  // which Python rejects.
  assert.equal(isCrawlFresh('2026-10-14T14:00:00+02', { now: NOW, maxAgeDays: 6 }), true);
  assert.equal(isCrawlFresh('2026-10-14T13:59:59+02', { now: NOW, maxAgeDays: 6 }), false);
  assert.equal(isCrawlFresh('2026-10-14T07:00:00.000-05', { now: NOW, maxAgeDays: 6 }), true);
  assert.equal(isCrawlFresh('2026-10-14T14:00:00+0200', { now: NOW, maxAgeDays: 6 }), true);
  assert.equal(isCrawlFresh('2026-10-19T12:00:00z', { now: NOW, maxAgeDays: 6 }), false);
  // A number is epoch MILLISECONDS, as in the twin.
  assert.equal(isCrawlFresh(NOW.getTime() - DAY_MS, { now: NOW, maxAgeDays: 1 }), true);
});

// ---------------------------------------------------------------------------
// The upserter half: the switch, N, and the input
// ---------------------------------------------------------------------------

function joinedRow(pk = RETAILER_PK, overrides = {}) {
  // A drain-written listing as the product join returns it: no identity
  // listing minted yet (the IDENTITY_CONFIDENCE_NULL case).
  return {
    product_key: pk,
    content_key: `ck_${pk.slice(-6)}`,
    merchant_id: 'merch_obs_0123456789abcdef',
    platform: 'external_seed',
    source_system: 'catalog_enrichment_agent_v1',
    source_ref: 'https://shop.example.com/products/serum',
    source_product_id: 'serum-slug',
    source_domain: 'shop.example.com',
    sync_status: 'live',
    suppression_reason: null,
    last_seen_in_sync_at: ago(DAY_MS),
    pdp_seed_route_ok: true,
    serving_eligible: true,
    pipeline_stage: 'serving',
    blocker_code: null,
    content_quality_score: 0.8,
    quality_scored_at: ago(DAY_MS),
    last_extracted_at: ago(DAY_MS),
    pil_source_listing_ref: null,
    identity_status: null,
    identity_confidence: null,
    live_read_enabled: null,
    review_required: null,
    sellable_item_group_id: null,
    product_line_id: null,
    review_family_id: null,
    row_has_priced_offer: true,
    row_is_elected_canonical: null,
    eps_id: 77,
    eps_status: 'active',
    eps_domain: 'shop.example.com',
    eps_attached_product_key: pk,
    eps_last_seen_at: NOW,
    eps_seed_kind: 'cross',
    ms_merchant_id: null,
    ms_platform: null,
    ms_domain: null,
    ms_status: null,
    ms_last_sync: null,
    override_id: null,
    override_action_type: null,
    override_active: null,
    ...overrides,
  };
}

function firstPartyRow() {
  return joinedRow('pk_internal_1', {
    content_key: 'ck_internal_1',
    merchant_id: 'merch_first_party_seller_1',
    platform: 'shopify',
    source_system: 'shopify',
    source_ref: 'gid://shopify/Product/1',
    source_product_id: '1',
    source_domain: 'store.example.com',
    pil_source_listing_ref: 'merch_first_party_seller_1:1',
    identity_status: 'approved',
    identity_confidence: 0.95,
    live_read_enabled: true,
    review_required: false,
    eps_id: null,
    eps_status: null,
    eps_domain: null,
    eps_attached_product_key: null,
    eps_last_seen_at: null,
    eps_seed_kind: null,
    ms_merchant_id: 'merch_first_party_seller_1',
    ms_platform: 'shopify',
    ms_domain: 'store.example.com',
    ms_status: 'active',
    ms_last_sync: ago(DAY_MS),
  });
}

// The product join, the quarantine list, the column probe and the freshness
// statement, each recognised by the exact text the real statement carries.
class CrawlFakePool {
  constructor({ joined = [], reads = {}, columnPresent = true, probeThrows = false } = {}) {
    this.joined = joined;
    this.reads = reads;
    this.columnPresent = columnPresent;
    this.probeThrows = probeThrows;
    this.queries = [];
  }

  async query(sql, params) {
    this.queries.push({ sql, params });
    if (sql === upserter.PRICE_CHECK_COLUMN_SQL) {
      if (this.probeThrows) throw new Error('no pg_attribute here');
      return { rows: [{ present: this.columnPresent }] };
    }
    if (sql === upserter.CRAWL_ROW_PRICE_READ_SQL) {
      assert.ok(params[1] instanceof Date && !Number.isNaN(params[1].getTime()), 'the batch clock must be bound as $2');
      assert.ok(this.columnPresent, 'the statement naming price_checked_at was sent to a DB without it');
      return {
        rows: params[0]
          .filter((k) => this.reads[k] != null)
          .map((k) => ({ product_key: k, row_price_read_at: this.reads[k] })),
      };
    }
    if (sql.includes('catalog_source_quarantine')) return { rows: [] };
    if (sql.includes('ON CONFLICT (subject_type, subject_key)')) return { rowCount: 1 };
    if (sql.includes('catalog_products cp') && Array.isArray(params?.[0])) {
      const keys = new Set(params[0]);
      const limit = Number(params[1]) || Infinity;
      return {
        rows: this.joined
          .filter((r) => keys.has(r.product_key))
          .sort((a, b) => (a.product_key < b.product_key ? -1 : 1))
          .slice(0, limit),
      };
    }
    if (sql.includes('catalog_products cp') && params?.length === 1) {
      const row = this.joined.find((r) => r.product_key === params[0]);
      return { rows: row ? [row] : [] };
    }
    return { rows: [], rowCount: 0 };
  }

  sent(sql) {
    return this.queries.filter((q) => q.sql === sql).map((q) => q.params);
  }

  keysSent() {
    return this.sent(upserter.CRAWL_ROW_PRICE_READ_SQL).map((params) => params[0]);
  }

  written() {
    const out = {};
    for (const q of this.queries) {
      if (q.sql.includes('ON CONFLICT (subject_type, subject_key)')) {
        out[q.params[1]] = { serving_decision: q.params[17], serving_reason_codes: q.params[18] };
      }
    }
    return out;
  }
}

function switchOn(days) {
  process.env.CATALOG_TRUST_CRAWL_FRESH_ENABLED = '1';
  if (days != null) process.env.CATALOG_TRUST_CRAWL_FRESH_DAYS = String(days);
}

async function writeOne(pool, pk = RETAILER_PK) {
  assert.equal(await upserter.upsertCatalogRowTrust(pool, pk, NOW), true);
  return pool.written()[pk];
}

test('env names match the backend', () => {
  assert.equal(upserter.CRAWL_FRESH_ENV, 'CATALOG_TRUST_CRAWL_FRESH_ENABLED');
  assert.equal(upserter.CRAWL_FRESH_DAYS_ENV, 'CATALOG_TRUST_CRAWL_FRESH_DAYS');
});

// ---- switch OFF: byte-identical to main ------------------------------------

test('off: no extra statement, and today\'s decision is written', async () => {
  const pool = new CrawlFakePool({ joined: [joinedRow()], reads: { [RETAILER_PK]: NOW } });
  const written = await writeOne(pool);
  assert.equal(written.serving_decision, 'shadow');
  assert.deepEqual(written.serving_reason_codes, [REASON_CODES.IDENTITY_CONFIDENCE_NULL]);
  assert.deepEqual(pool.sent(upserter.PRICE_CHECK_COLUMN_SQL), []);
  assert.deepEqual(pool.sent(upserter.CRAWL_ROW_PRICE_READ_SQL), []);
});

for (const value of ['', '0', 'false', 'off', 'no', 'enabled', '2']) {
  test(`only the truthy spellings switch it on (${JSON.stringify(value)} is off)`, () => {
    process.env.CATALOG_TRUST_CRAWL_FRESH_ENABLED = value;
    assert.equal(upserter.crawlFreshEnabled(), false);
  });
}

for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
  test(`truthy spelling ${JSON.stringify(value)} is on`, () => {
    process.env.CATALOG_TRUST_CRAWL_FRESH_ENABLED = value;
    assert.equal(upserter.crawlFreshEnabled(), true);
  });
}

test('off leaves the inputs object exactly as main built it', () => {
  const row = joinedRow();
  const built = upserter.rowToPolicyInputs(row, [], NOW);
  assert.ok(!('crawl_fresh' in built));
  assert.deepEqual(upserter.rowToPolicyInputs(row, [], NOW, { crawlFresh: null }), built);
  // A key the map does not carry (a non-drain row) leaves it unset too.
  assert.deepEqual(upserter.rowToPolicyInputs(row, [], NOW, { crawlFresh: { other: true } }), built);
  assert.equal(upserter.rowToPolicyInputs(row, [], NOW, { crawlFresh: { [RETAILER_PK]: true } }).crawl_fresh, true);
});

test('the backfill driver builds the same input the same way', () => {
  const backfill = require('../scripts/backfill-catalog-row-trust.cjs');
  const row = joinedRow();
  for (const crawlFresh of [null, {}, { other: true }, { [RETAILER_PK]: true }, { [RETAILER_PK]: false }]) {
    assert.deepEqual(
      backfill.rowToPolicyInputs(row, [], NOW, { crawlFresh }),
      upserter.rowToPolicyInputs(row, [], NOW, { crawlFresh }),
    );
  }
  assert.deepEqual(backfill.rowToPolicyInputs(row, [], NOW), upserter.rowToPolicyInputs(row, [], NOW));
});

// ---- switch ON -------------------------------------------------------------

test('on: a fresh listing is written public with the trace code', async () => {
  switchOn();
  const pool = new CrawlFakePool({ joined: [joinedRow()], reads: { [RETAILER_PK]: ago(2 * DAY_MS) } });
  const written = await writeOne(pool);
  assert.equal(written.serving_decision, 'public');
  assert.deepEqual(written.serving_reason_codes, [
    REASON_CODES.CRAWL_FRESH,
    REASON_CODES.PUBLIC_PASSTHROUGH,
  ]);
  assert.deepEqual(pool.keysSent(), [[RETAILER_PK]]);
  // ONE CLOCK: the statement is bound with the same now the age is judged by
  assert.equal(pool.sent(upserter.CRAWL_ROW_PRICE_READ_SQL)[0][1], NOW);
});

test('on: a stale listing is today\'s decision', async () => {
  const off = await writeOne(new CrawlFakePool({ joined: [joinedRow()] }));
  switchOn();
  const pool = new CrawlFakePool({ joined: [joinedRow()], reads: { [RETAILER_PK]: ago(8 * DAY_MS) } });
  assert.deepEqual(await writeOne(pool), off);
});

test('on: a listing with no qualifying read is today\'s decision', async () => {
  const off = await writeOne(new CrawlFakePool({ joined: [joinedRow()] }));
  switchOn();
  assert.deepEqual(await writeOne(new CrawlFakePool({ joined: [joinedRow()], reads: {} })), off);
});

test('on: without the price_checked_at column nothing names it and nothing moves', async () => {
  const off = await writeOne(new CrawlFakePool({ joined: [joinedRow()] }));
  switchOn();
  const pool = new CrawlFakePool({ joined: [joinedRow()], reads: { [RETAILER_PK]: NOW }, columnPresent: false });
  assert.deepEqual(await writeOne(pool), off);
  assert.deepEqual(pool.sent(upserter.CRAWL_ROW_PRICE_READ_SQL), []);
});

test('on: a failed column probe reads as absent', async () => {
  switchOn();
  const pool = new CrawlFakePool({ joined: [joinedRow()], reads: { [RETAILER_PK]: NOW }, probeThrows: true });
  const written = await writeOne(pool);
  assert.equal(written.serving_decision, 'shadow');
  assert.deepEqual(pool.sent(upserter.CRAWL_ROW_PRICE_READ_SQL), []);
});

test('on: a batch with no drain-lane row sends nothing extra', async () => {
  switchOn();
  const pool = new CrawlFakePool({ joined: [firstPartyRow()] });
  await writeOne(pool, 'pk_internal_1');
  assert.deepEqual(pool.sent(upserter.PRICE_CHECK_COLUMN_SQL), []);
  assert.deepEqual(pool.sent(upserter.CRAWL_ROW_PRICE_READ_SQL), []);
});

test('on: a fresh brand-official row is written public with the same code', async () => {
  switchOn();
  const row = joinedRow(BRAND_PK, {
    merchant_id: 'merch_brand_0123456789ab',
    identity_status: 'approved',
    identity_confidence: 0.9,
    live_read_enabled: false,
    review_required: false,
    pil_source_listing_ref: 'seed:9',
  });
  const pool = new CrawlFakePool({ joined: [row], reads: { [BRAND_PK]: ago(DAY_MS) } });
  const written = await writeOne(pool, BRAND_PK);
  assert.equal(written.serving_decision, 'public');
  assert.deepEqual(written.serving_reason_codes, [
    REASON_CODES.CRAWL_FRESH,
    REASON_CODES.PUBLIC_PASSTHROUGH,
  ]);
});

test('on: only drain-lane rows are looked up, and only they get the input', async () => {
  switchOn();
  const rows = [
    joinedRow(),
    joinedRow(OTHER_RETAILER_PK),
    firstPartyRow(),
    // the drain writer's brand-official / curated slug key: also a crawl row
    joinedRow(BRAND_PK, { merchant_id: 'merch_brand_0123456789ab' }),
    // an `ext:` key under another writer: not
    joinedRow('ext:mirror-slug::0123abcd', { source_system: 'external_product_seeds_mirror_v1' }),
  ];
  const pool = new CrawlFakePool({
    joined: rows,
    reads: { [RETAILER_PK]: NOW, [BRAND_PK]: NOW, 'ext:mirror-slug::0123abcd': NOW },
  });
  const fresh = await upserter.crawlFreshByKey(pool, rows, NOW);
  assert.deepEqual(fresh, { [RETAILER_PK]: true, [OTHER_RETAILER_PK]: false, [BRAND_PK]: true });
  assert.deepEqual(pool.keysSent(), [[RETAILER_PK, OTHER_RETAILER_PK, BRAND_PK].sort()]);
});

for (const [days, ageDays, decision] of [[3, 4, 'shadow'], [5, 4, 'public'], [4, 4, 'public']]) {
  test(`on: N comes from the env (N=${days}, age ${ageDays}d -> ${decision})`, async () => {
    switchOn(days);
    const pool = new CrawlFakePool({ joined: [joinedRow()], reads: { [RETAILER_PK]: ago(ageDays * DAY_MS) } });
    assert.equal((await writeOne(pool)).serving_decision, decision);
  });
}

for (const raw of ['', '  ', 'x', '0', '-1', 'nan', 'inf', '-inf', 'Infinity', '1e400', '0x10', '0b1', '1__0', '_1', '٣x']) {
  test(`an unusable N (${JSON.stringify(raw)}) falls back to seven`, () => {
    process.env.CATALOG_TRUST_CRAWL_FRESH_DAYS = raw;
    assert.equal(upserter.crawlFreshDays(), 7);
  });
}

test('N accepts fractions and the other decimal spellings the twin\'s float() accepts', () => {
  for (const [raw, want] of [
    [' 0.5 ', 0.5], ['3', 3], ['.5', 0.5], ['2.', 2], ['1e1', 10], ['+4', 4], ['1_0', 10],
    // Unicode decimal digits, as Python's float() reads them (values checked
    // against float() on the backend's interpreter)
    ['３', 3], ['٣.٥', 3.5], ['１_０', 10], ['𝟓', 5], ['٣e١', 30], ['\u00a07\u2003', 7],
  ]) {
    process.env.CATALOG_TRUST_CRAWL_FRESH_DAYS = raw;
    assert.equal(upserter.crawlFreshDays(), want, raw);
  }
  delete process.env.CATALOG_TRUST_CRAWL_FRESH_DAYS;
  assert.equal(upserter.crawlFreshDays(), 7);
});

// ---- every recompute path supplies it --------------------------------------

function pathsPool() {
  return new CrawlFakePool({
    joined: [joinedRow(), joinedRow(OTHER_RETAILER_PK)],
    reads: { [RETAILER_PK]: ago(6 * HOUR), [OTHER_RETAILER_PK]: ago(30 * DAY_MS) },
  });
}

test('bulk path (the external-seed sync and the one-off scripts)', async () => {
  switchOn();
  const pool = pathsPool();
  const wrote = await upserter.upsertCatalogRowTrustMany(pool, [RETAILER_PK, OTHER_RETAILER_PK], NOW);
  assert.equal(wrote, 2);
  assert.equal(pool.written()[RETAILER_PK].serving_decision, 'public');
  assert.equal(pool.written()[OTHER_RETAILER_PK].serving_decision, 'shadow');
  assert.deepEqual(pool.keysSent(), [[RETAILER_PK, OTHER_RETAILER_PK]]);
});

test('identity-event path (source listing refs -> bulk) supplies it too', async () => {
  switchOn();
  const pool = pathsPool();
  const origQuery = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (sql.includes('SELECT DISTINCT cp.product_key') && sql.includes('pdp_identity_listing')) {
      pool.queries.push({ sql, params });
      return { rows: [{ product_key: RETAILER_PK }, { product_key: OTHER_RETAILER_PK }] };
    }
    return origQuery(sql, params);
  };
  const wrote = await upserter.upsertCatalogRowTrustForSourceListingRefs(pool, ['seed:77'], NOW);
  assert.equal(wrote, 2);
  assert.equal(pool.written()[RETAILER_PK].serving_decision, 'public');
  assert.equal(pool.written()[OTHER_RETAILER_PK].serving_decision, 'shadow');
});

test('a failing freshness statement fails CLOSED per batch: today\'s gates are written, nothing throws', async () => {
  switchOn();
  const pool = pathsPool();
  const origQuery = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (sql === upserter.CRAWL_ROW_PRICE_READ_SQL) throw new Error('boom');
    return origQuery(sql, params);
  };
  assert.equal(await upserter.upsertCatalogRowTrust(pool, RETAILER_PK, NOW), true);
  assert.equal(await upserter.upsertCatalogRowTrustMany(pool, [RETAILER_PK, OTHER_RETAILER_PK], NOW), 2);
  // the fresh row would have gone public: with the read failed, it is today's shadow
  assert.equal(pool.written()[RETAILER_PK].serving_decision, 'shadow');
  assert.deepEqual(pool.written()[RETAILER_PK].serving_reason_codes, [REASON_CODES.IDENTITY_CONFIDENCE_NULL]);
});

test('the read-only serving predictor (repairRetailerOfficialDomain) supplies it too', async () => {
  const { predictServing, SERVING_SQL } = require('../scripts/repairRetailerOfficialDomain.cjs');
  const run = async () => {
    const pool = new CrawlFakePool({
      joined: [joinedRow(RETAILER_PK, { pil_source_listing_ref: 'seed:77' })],
      reads: { [RETAILER_PK]: ago(DAY_MS) },
    });
    const origQuery = pool.query.bind(pool);
    pool.query = async (sql, params) => {
      if (sql === SERVING_SQL) {
        pool.queries.push({ sql, params });
        return { rows: [{ product_key: RETAILER_PK, serving_decision: 'shadow' }] };
      }
      return origQuery(sql, params);
    };
    const plans = [{ kind: 'update', ref: 'seed:77', fields: {} }];
    const out = await predictServing({ client: pool, plans, now: NOW });
    const entry = (out.get('seed:77') || [])[0];
    assert.ok(entry, 'the predictor returned no entry for the planned listing');
    return [entry.before, entry.after];
  };
  assert.deepEqual(await run(), ['shadow', 'shadow']);
  switchOn();
  // both the as-is and the planned derivation carry the input
  assert.deepEqual(await run(), ['public', 'public']);
});

// ---------------------------------------------------------------------------
// The statements, pinned byte for byte against the backend's constants
// ---------------------------------------------------------------------------

const BACKEND_SQL = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'crawl_fresh_trust_backend_sql.json'), 'utf8'),
);

test('the freshness statement is the backend constant, with :product_keys / :now bound as $1 / $2 and nothing else changed', () => {
  const backend = BACKEND_SQL.CRAWL_ROW_PRICE_READ_SQL;
  assert.equal(backend.split(':product_keys').length - 1, 1, 'the backend binds the key list once');
  assert.equal(backend.split(':now').length - 1, 2, 'the backend binds :now in both valid-read arms');
  assert.deepEqual([...new Set(backend.match(/:[a-z_]+\b/g) || [])].sort(), [':now', ':product_keys']);
  assert.equal(
    upserter.CRAWL_ROW_PRICE_READ_SQL,
    backend.replace(':product_keys', '$1').split(':now').join('$2'),
  );
  assert.deepEqual([...new Set(upserter.CRAWL_ROW_PRICE_READ_SQL.match(/\$\d+/g) || [])].sort(), ['$1', '$2']);
});

test('the freshness statement, spelled out (so a fixture edit cannot move both sides at once)', () => {
  const valid =
    "CASE WHEN co.price_checked_at <= CAST($2 AS timestamptz) AND upper(btrim(coalesce(co.offer_payload->>'declared_market', ''))) = upper(btrim(coalesce(co.market, ''))) AND coalesce(co.offer_payload->>'price_read_source', '') <> 'employee_edit' THEN co.price_checked_at END";
  assert.equal(
    upserter.CRAWL_ROW_PRICE_READ_SQL,
    'SELECT k.product_key, r.row_price_read_at\n' +
      '  FROM unnest(CAST($1 AS text[])) AS k(product_key)\n' +
      ' CROSS JOIN LATERAL (\n' +
      '   SELECT CASE WHEN count(*) > 0\n' +
      `                AND bool_and((${valid}) IS NOT NULL)\n` +
      "                AND bool_or(lower(btrim(coalesce(co.availability, ''))) NOT IN ('out_of_stock', 'outofstock', 'sold_out', 'soldout', 'unavailable'))\n" +
      `               THEN min(${valid}) END AS row_price_read_at\n` +
      '     FROM catalog_offers co\n' +
      '    WHERE co.product_key = k.product_key\n' +
      "      AND co.source_system = 'catalog_enrichment_agent_v1'\n" +
      '      AND co.suppressed_at IS NULL\n' +
      '      AND coalesce(co.merchant_effective_price, co.list_price) > 0\n' +
      "      AND btrim(coalesce(co.offer_payload->>'destination_url', co.source_ref), E' \\t\\n\\r\\f\\v') ~ '^https?://\\S+$'\n" +
      "      AND coalesce(co.offer_payload->>'validated_at', '') NOT LIKE 'affiliate_feed:%'\n" +
      "      AND (upper(btrim(coalesce(co.market, ''))), upper(btrim(coalesce(co.currency, '')))) IN (('SG', 'SGD'), ('US', 'USD'))\n" +
      ' ) r\n' +
      ' WHERE r.row_price_read_at IS NOT NULL\n',
  );
});

test('the column probe is the backend constant, byte for byte', () => {
  assert.equal(upserter.PRICE_CHECK_COLUMN_SQL, BACKEND_SQL.PRICE_CHECK_COLUMN_SQL);
});

test('the stock fragment carries the pinned unavailable vocabulary; the market fragment the served pairs', () => {
  const { OFFER_UNAVAILABLE_AVAILABILITIES } = require('../src/services/offerAvailabilitySql');
  for (const value of OFFER_UNAVAILABLE_AVAILABILITIES) {
    assert.ok(upserter.CRAWL_OFFER_IN_STOCK_SQL.includes(`'${value}'`), value);
  }
  assert.ok(upserter.CRAWL_OFFER_SERVED_MARKET_SQL.endsWith(" IN (('SG', 'SGD'), ('US', 'USD'))"));
});

test('the read-source key is the backend writer\'s', () => {
  assert.equal(upserter.CRAWL_PRICE_READ_SOURCE_KEY, 'price_read_source');
});

test('the statement is built from the shared lateral body', () => {
  assert.ok(upserter.CRAWL_ROW_PRICE_READ_SQL.includes(upserter.crawlRowPriceReadLateralSql('k.product_key')));
  for (const c of upserter.crawlOfferClassConjuncts('k.product_key')) {
    assert.ok(upserter.CRAWL_ROW_PRICE_READ_SQL.includes(c), c);
  }
});

// ---------------------------------------------------------------------------
// Failure isolation: a CRAWL_FRESH read never aborts the caller's transaction
// ---------------------------------------------------------------------------

// A single pg connection, modelled closely enough to show transaction state: a
// failed statement inside BEGIN poisons every later statement ("current
// transaction is aborted") until ROLLBACK TO SAVEPOINT (or ROLLBACK). Outside
// BEGIN, SAVEPOINT is refused with 25P01, as Postgres does.
class TxnFakeClient extends CrawlFakePool {
  constructor({ inTransaction = true, failSql = null, ...rest } = {}) {
    super(rest);
    this.inTransaction = inTransaction;
    this.failSql = failSql;
    this.aborted = false;
    this.savepoints = [];
  }

  async query(sql, params) {
    if (this.aborted && !/^ROLLBACK/.test(sql)) {
      this.queries.push({ sql, params, rejected: true });
      throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
    }
    if (/^SAVEPOINT /.test(sql)) {
      this.queries.push({ sql, params });
      if (!this.inTransaction) {
        throw Object.assign(new Error('SAVEPOINT can only be used in transaction blocks'), { code: '25P01' });
      }
      this.savepoints.push(sql.slice('SAVEPOINT '.length));
      return { rows: [] };
    }
    if (/^ROLLBACK TO SAVEPOINT /.test(sql)) {
      this.queries.push({ sql, params });
      this.aborted = false;
      return { rows: [] };
    }
    if (/^RELEASE SAVEPOINT /.test(sql)) {
      this.queries.push({ sql, params });
      this.savepoints.pop();
      return { rows: [] };
    }
    if (this.failSql && sql === this.failSql) {
      this.queries.push({ sql, params });
      if (this.inTransaction) this.aborted = true;
      throw new Error('boom');
    }
    return super.query(sql, params);
  }
}

test('inside a caller transaction, a failed freshness read rolls back to its savepoint and the batch is still written', async () => {
  switchOn();
  const client = new TxnFakeClient({
    joined: [joinedRow(), joinedRow(OTHER_RETAILER_PK)],
    reads: { [RETAILER_PK]: NOW },
    failSql: upserter.CRAWL_ROW_PRICE_READ_SQL,
  });
  const wrote = await upserter.upsertCatalogRowTrustMany(client, [RETAILER_PK, OTHER_RETAILER_PK], NOW);
  assert.equal(wrote, 2);
  assert.equal(client.aborted, false, "the caller's transaction must still be usable");
  assert.ok(client.queries.some((q) => q.sql === 'ROLLBACK TO SAVEPOINT catalog_row_trust_crawl_fresh'));
  assert.ok(!client.queries.some((q) => q.rejected), 'no statement may run in an aborted transaction');
  assert.equal(client.written()[RETAILER_PK].serving_decision, 'shadow');
});

test('inside a caller transaction, a failed column probe is contained the same way', async () => {
  switchOn();
  const client = new TxnFakeClient({
    joined: [joinedRow()],
    reads: { [RETAILER_PK]: NOW },
    failSql: upserter.PRICE_CHECK_COLUMN_SQL,
  });
  assert.equal(await upserter.upsertCatalogRowTrust(client, RETAILER_PK, NOW), true);
  assert.equal(client.aborted, false);
  assert.equal(client.written()[RETAILER_PK].serving_decision, 'shadow');
  assert.deepEqual(client.sent(upserter.CRAWL_ROW_PRICE_READ_SQL), []);
});

test('inside a caller transaction, a successful read releases its savepoint and serves the input', async () => {
  switchOn();
  const client = new TxnFakeClient({ joined: [joinedRow()], reads: { [RETAILER_PK]: NOW } });
  assert.equal(await upserter.upsertCatalogRowTrust(client, RETAILER_PK, NOW), true);
  assert.deepEqual(client.savepoints, []);
  assert.equal(client.written()[RETAILER_PK].serving_decision, 'public');
});

test('a client outside any transaction (SAVEPOINT refused with 25P01) runs the read plainly', async () => {
  switchOn();
  const client = new TxnFakeClient({ inTransaction: false, joined: [joinedRow()], reads: { [RETAILER_PK]: NOW } });
  assert.equal(await upserter.upsertCatalogRowTrust(client, RETAILER_PK, NOW), true);
  assert.equal(client.written()[RETAILER_PK].serving_decision, 'public');
  assert.deepEqual(client.keysSent(), [[RETAILER_PK]]);
});

test('a pg Pool gets no savepoint: each of its queries is already its own statement', async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ max: 1 });
  const sent = [];
  pool.query = async (sql) => {
    sent.push(sql);
    return { rows: [{ present: true }] };
  };
  try {
    await upserter.isolatedQuery(pool, upserter.PRICE_CHECK_COLUMN_SQL);
    assert.deepEqual(sent, [upserter.PRICE_CHECK_COLUMN_SQL]);
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// The backfill driver: the input reaches deriveTrust, and `now` is per batch
// ---------------------------------------------------------------------------

function backfillPool({ rows, reads }) {
  const backfill = require('../scripts/backfill-catalog-row-trust.cjs');
  const pool = new CrawlFakePool({ joined: rows, reads });
  const origQuery = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (sql === backfill.PRODUCT_DRIVER_SQL) {
      pool.queries.push({ sql, params });
      const [cursor, size] = params;
      const page = rows
        .filter((r) => cursor == null || r.product_key > cursor)
        .sort((a, b) => (a.product_key < b.product_key ? -1 : 1))
        .slice(0, size);
      return { rows: page };
    }
    return origQuery(sql, params);
  };
  return pool;
}

test('backfill driver: the crawl_fresh input reaches deriveTrust and the write', async () => {
  const { runBackfill } = require('../scripts/backfill-catalog-row-trust.cjs');
  switchOn();
  const pool = backfillPool({ rows: [joinedRow()], reads: { [RETAILER_PK]: ago(DAY_MS) } });
  const tally = await runBackfill({ pool, clock: () => NOW });
  assert.equal(tally.public, 1);
  assert.equal(tally.by_reason.CRAWL_FRESH, 1);
  assert.equal(pool.written()[RETAILER_PK].serving_decision, 'public');
});

test('backfill driver: switched off it is today\'s decision and sends no extra statement', async () => {
  const { runBackfill } = require('../scripts/backfill-catalog-row-trust.cjs');
  const pool = backfillPool({ rows: [joinedRow()], reads: { [RETAILER_PK]: ago(DAY_MS) } });
  const tally = await runBackfill({ pool, clock: () => NOW });
  assert.equal(tally.shadow, 1);
  assert.deepEqual(pool.sent(upserter.CRAWL_ROW_PRICE_READ_SQL), []);
});

test('backfill driver: `now` is read per batch, so a late batch is judged by a current clock', async () => {
  const { runBackfill } = require('../scripts/backfill-catalog-row-trust.cjs');
  switchOn(7);
  // Both rows were read at the same instant. Batch 1 runs 1 day later (fresh),
  // batch 2 runs 8 days later (stale). A run-start clock would call both fresh.
  const readAt = ago(0);
  const clocks = [new Date(NOW.getTime() + DAY_MS), new Date(NOW.getTime() + 8 * DAY_MS)];
  let calls = 0;
  const pool = backfillPool({
    rows: [joinedRow(), joinedRow(OTHER_RETAILER_PK)],
    reads: { [RETAILER_PK]: readAt, [OTHER_RETAILER_PK]: readAt },
  });
  await runBackfill({ pool, batchRows: 1, clock: () => clocks[Math.min(calls++, 1)] });
  assert.equal(calls >= 2, true, 'the clock must be read once per batch');
  assert.equal(pool.written()[RETAILER_PK].serving_decision, 'public');
  assert.equal(pool.written()[OTHER_RETAILER_PK].serving_decision, 'shadow');
});

// ---------------------------------------------------------------------------
// Boot / job log of the effective switch
// ---------------------------------------------------------------------------

test('logCrawlFreshConfig reports the effective switch and N', () => {
  const lines = [];
  const stream = { write: (s) => lines.push(s) };
  let out = upserter.logCrawlFreshConfig('test', { stream });
  assert.equal(out.enabled, false);
  assert.equal(out.days, 7);
  process.env.CATALOG_TRUST_CRAWL_FRESH_ENABLED = ' On ';
  process.env.CATALOG_TRUST_CRAWL_FRESH_DAYS = '3.5';
  out = upserter.logCrawlFreshConfig('test', { stream });
  assert.equal(out.enabled, true);
  assert.equal(out.days, 3.5);
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.event, 'catalog_row_trust_crawl_fresh_config');
  assert.equal(last.component, 'test');
  assert.equal(last.served_market_currency, 'SG:SGD,US:USD');
  assert.equal(last.enabled, true);
  assert.equal(last.days, 3.5);
});

// Every script that writes or re-derives catalog_row_trust, and the context it
// logs under. Static over the sources, like the repo's other script pins.
const TRUST_SCRIPTS = [
  ['scripts/backfill-catalog-row-trust.cjs', 'backfill-catalog-row-trust'],
  ['scripts/backfill-pdp-identity-graph.js', 'backfill-pdp-identity-graph'],
  ['scripts/promote-pdp-identity-live-read.js', 'promote-pdp-identity-live-read'],
  ['scripts/pdp-identity-coverage-lift.js', 'pdp-identity-coverage-lift'],
  ['scripts/repairRetailerOfficialDomain.cjs', 'repairRetailerOfficialDomain'],
  ['scripts/reconcile-retired-merchant-catalog-rows.cjs', 'reconcile-retired-merchant-catalog-rows'],
  ['scripts/retire-demo-electronics-cohort.cjs', 'retire-demo-electronics-cohort'],
  ['scripts/retire-demo-fixtures-and-stores.cjs', 'retire-demo-fixtures-and-stores'],
  ['scripts/sync-external-seeds-to-catalog.cjs', 'sync-external-seeds-to-catalog'],
];

test('no script reaches the trust upserter without being in the boot-log list', () => {
  // Discovery, so a NEW trust-writing script cannot skip the log: anything under
  // scripts/ that imports the upserter or calls a pdpIdentityGraph entry point
  // that refreshes trust must be listed in TRUST_SCRIPTS (and so must log).
  const scriptsDir = path.join(__dirname, '..', 'scripts');
  const reaches = /catalogRowTrustUpserter|\b(promotePdpIdentityLiveRead|applyPdpIdentityOverride|runPdpIdentityCoverageLift)\b/;
  const listed = new Set(TRUST_SCRIPTS.map(([f]) => f));
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(c?js|mjs)$/.test(e.name) ? [full] : [];
  });
  const found = walk(scriptsDir)
    .filter((f) => reaches.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(path.join(__dirname, '..'), f).split(path.sep).join('/'));
  for (const f of found) assert.ok(listed.has(f), `${f} reaches catalog_row_trust but does not log the CRAWL_FRESH switch`);
  for (const f of listed) assert.ok(found.includes(f), `${f} is listed but no longer reaches the trust upserter`);
});

test('every entry point that writes or re-derives trust logs the switch it runs with', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.match(read('src/server.js'), /logCrawlFreshConfig\('gateway-boot'\)/);
  for (const [file, ctx] of TRUST_SCRIPTS) {
    assert.ok(read(file).includes(`logCrawlFreshConfig('${ctx}', { stream: process.stderr })`), file);
  }
  // ...and the scheduled jobs that run them carry the switch, not a silent off.
  for (const wf of ['pdp-identity-graph-backfill.yml', 'pdp-identity-live-read-promote.yml']) {
    const text = read(path.join('.github', 'workflows', wf));
    assert.ok(text.includes('CATALOG_TRUST_CRAWL_FRESH_ENABLED: ${{ vars.CATALOG_TRUST_CRAWL_FRESH_ENABLED }}'), wf);
    assert.ok(text.includes('CATALOG_TRUST_CRAWL_FRESH_DAYS: ${{ vars.CATALOG_TRUST_CRAWL_FRESH_DAYS }}'), wf);
  }
});

// ---------------------------------------------------------------------------
// Market drift: the served pairs the statement names are the registry's
// ---------------------------------------------------------------------------

test('the served (market, currency) pairs equal the backend\'s committed pin target', () => {
  // tests/fixtures/crawl_fresh_served_markets.backend.json is a VERBATIM copy of
  // pivota-backend config/crawl_fresh_served_markets.json (written by its
  // scripts/generate_crawl_fresh_served_markets.py from
  // CRAWL_SERVED_MARKET_CURRENCY_PAIRS, which the backend renders into its
  // statement). Copy the file again whenever the backend's changes.
  const pin = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'crawl_fresh_served_markets.backend.json'), 'utf8'),
  );
  assert.equal(pin.generated_from, 'pivota-backend services.catalog_row_trust_upserter.CRAWL_SERVED_MARKET_CURRENCY_PAIRS');
  assert.equal(pin.version, 1);
  assert.deepEqual(
    upserter.CRAWL_FRESH_SERVED_MARKET_CURRENCY_PAIRS.map((pair) => [...pair]),
    pin.served_market_currency,
  );
  assert.ok(
    upserter.CRAWL_OFFER_SERVED_MARKET_SQL.endsWith(
      ` IN (${pin.served_market_currency.map(([m, c]) => `('${m}', '${c}')`).join(', ')})`,
    ),
  );
});

// ---------------------------------------------------------------------------
// Round 3 specifics
// ---------------------------------------------------------------------------

test('round 3: the valid read requires a DECLARED market and is used in both arms; no DB clock', () => {
  const sql = upserter.CRAWL_ROW_PRICE_READ_SQL;
  assert.equal(sql.split("co.offer_payload->>'declared_market'").length - 1, 2);
  assert.equal(sql.split('CAST($2 AS timestamptz)').length - 1, 2);
  assert.ok(!/\bnow\(\)/.test(sql), 'the statement must not read the database clock');
  assert.ok(!sql.includes('::canonical'), 'every live offer counts; no canonical special case');
  assert.ok(!sql.includes('max('), 'the row date is the OLDEST valid read, not the newest');
});

test('round 3: with no `now` passed, the batch binds one Date and judges against it', async () => {
  switchOn();
  const pool = pathsPool();
  await upserter.upsertCatalogRowTrustMany(pool, [RETAILER_PK, OTHER_RETAILER_PK]);
  const sent = pool.sent(upserter.CRAWL_ROW_PRICE_READ_SQL);
  assert.equal(sent.length, 1);
  assert.ok(sent[0][1] instanceof Date);
});

test('round 3: a failed read logs catalog_row_trust_crawl_fresh_read_failed', async () => {
  switchOn();
  const logger = require('../src/logger');
  const seen = [];
  const orig = logger.error;
  logger.error = (obj) => seen.push(obj);
  try {
    const pool = pathsPool();
    const origQuery = pool.query.bind(pool);
    pool.query = async (sql, params) => {
      if (sql === upserter.CRAWL_ROW_PRICE_READ_SQL) throw new Error('boom');
      return origQuery(sql, params);
    };
    assert.equal(await upserter.crawlFreshByKey(pool, [joinedRow()], NOW), null);
  } finally {
    logger.error = orig;
  }
  assert.ok(seen.some((o) => o && o.event === 'catalog_row_trust_crawl_fresh_read_failed'));
});
