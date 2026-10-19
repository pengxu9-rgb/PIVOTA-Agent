const request = require('supertest');
const { CANONICAL_ENTITY_GROUP_SQL_TAG } = require('../../src/services/catalogEntityResolutionSqlTag');
const {
  readSignatureSeedNotActive,
  settleSignatureSeedNotActive,
  SEED_DATA_FALLBACK_MATCH_CLAUSE,
  SEED_EXACT_MATCHES,
  __internal: { ACTIVE_SEED_MATCH_SQL },
} = require('../../src/services/signatureSeedNotActive');

jest.setTimeout(60000);

// A retired product behind a RE-KEYED sig_ row must 404 with a settled reason.
//
// Prod, 2026-10-18: GET agent.pivota.cc/products/sig_bec7d573… (and sig_d839dd6f…)
// answered 500 to every bingbot crawl. get_pdp_v2 resolved the sig through the
// exact-signature lane onto a `merch_obs_` seller and a `<domain>:<hash>` seed id,
// found no ACTIVE seed, and returned `404 PRODUCT_NOT_FOUND` with `details: null`.
// The ext_ seed-status precheck that names `external_seed_not_active` never ran
// (it is keyed on an `ext_`-shaped id), and a reason-less 404 is
// indistinguishable from a swallowed DB error, so the frontend kept it a 500.
// The exact-signature row already carried the seed's status; this names it, but
// only after clean misses and a fresh check of the content lookup's whole match
// set. A DB blip must never become a cached 404 (review on #2461).

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const ORIGINAL_ENV = process.env;

// The prod shape: an ADR-009 re-keyed seed id, NOT ext_-prefixed.
const SEED_ID = 'coscorea-com:d26860c6915342c2';
const OBS_MERCHANT = 'merch_obs_5a931cc7ff5382e9';
const SIG_ID = 'sig_bec7d5736761a4cbba05e35d7d9ab4d3';
const CONTENT_KEY = 'ck_rekeyedseed000000000000000001';

function loadServer() {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: 'http://127.0.0.1:9',
    PIVOTA_API_KEY: 'test-token',
    // ON, as prod is: the rescue must also come up empty before the 404.
    PDP_IDENTITY_GRAPH_ENABLED: 'true',
  };
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

const norm = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();
const isCanonicalGroupQuery = (sql) =>
  norm(sql).includes(CANONICAL_ENTITY_GROUP_SQL_TAG) && norm(sql).includes('FROM catalog_products cp');
const isBareSigQuery = (sql) =>
  norm(sql).includes(
    'SELECT merchant_id, platform, source_product_id, product_key FROM catalog_products WHERE pivota_signature_id = $1',
  );
const isExactSigQuery = (sql) => norm(sql).includes('cp.pivota_signature_id = $1');
const isActiveSeedCheck = (sql) => norm(sql).includes('AS seed_snapshot_product_id');
// fetchExternalSeedProductDetailFromDb's statements (exact matches + seed_data fallback).
const isSeedDetailQuery = (sql) =>
  String(sql || '').includes('FROM external_product_seeds') &&
  String(sql || '').includes('destination_url');
const isSeedJsonFallback = (sql) => isSeedDetailQuery(sql) && norm(sql).includes("seed_data->>'product_id' = $1");

const NO_ACTIVE_SEED = {
  external_product_id: false,
  seed_id: false,
  seed_data_external_product_id: false,
  seed_data_product_id: false,
  seed_snapshot_product_id: false,
};

// A DIFFERENT seed row, active, that names the re-keyed id in seed_data.product_id.
// The sig resolver's join (external_product_id = source_product_id) cannot see
// it; the content lookup's seed_data fallback can, and renders the product.
function otherActiveSeedRow() {
  return {
    id: 'eps_other_active',
    external_product_id: 'coscorea-com:other',
    status: 'active',
    canonical_url: 'https://coscorea.example/products/live',
    destination_url: 'https://coscorea.example/products/live',
    domain: 'coscorea.example',
    title: 'Live Cream',
    image_url: 'https://cdn.example.test/live.png',
    price_amount: '20.00',
    price_currency: 'USD',
    availability: 'In Stock',
    seed_data: { brand: 'Probe Labs', description: 'live', product_id: SEED_ID },
  };
}

function exactSigRow(overrides = {}) {
  return {
    merchant_id: OBS_MERCHANT,
    platform: 'external_seed',
    source_product_id: SEED_ID,
    product_key: `prod::${OBS_MERCHANT}::external_seed::${SEED_ID}`,
    source_system: 'external_product_seeds_mirror_v1',
    pivota_signature_id: SIG_ID,
    content_key: CONTENT_KEY,
    catalog_title: 'Retired Cream',
    catalog_brand: 'Probe Labs',
    signature_serving_eligible: true,
    external_seed_id: 'eps_rekeyed_1',
    external_seed_external_product_id: SEED_ID,
    external_seed_status: 'inactive',
    external_seed_route_lane: 0,
    ...overrides,
  };
}

// Every content store misses: no active seed answers the re-keyed id, nothing is
// cached, the identity graph has nothing. Exactly what the prod trace shows.
//   seedDetail: 'miss' (healthy, no active seed) | 'throw' (DB blip) | 'other_active'
//   activeSeedCheck: the fresh confirmation statement's answer, or 'throw'
function install(db, row, { seedDetail = 'miss', activeSeedCheck = NO_ACTIVE_SEED } = {}) {
  const seen = [];
  db.query.mockImplementation(async (sql) => {
    seen.push(norm(sql).slice(0, 80));
    if (isCanonicalGroupQuery(sql)) return { rows: [] };
    if (isBareSigQuery(sql)) return { rows: [] };
    if (isExactSigQuery(sql)) return { rows: row ? [row] : [] };
    if (isActiveSeedCheck(sql)) {
      if (activeSeedCheck === 'throw') throw new Error('connection terminated unexpectedly');
      return { rows: [activeSeedCheck] };
    }
    if (isSeedDetailQuery(sql)) {
      if (seedDetail === 'throw') throw new Error('connection terminated unexpectedly');
      if (seedDetail === 'other_active' && isSeedJsonFallback(sql)) return { rows: [otherActiveSeedRow()] };
      return { rows: [] };
    }
    return { rows: [] };
  });
  return seen;
}

async function pdp(app, productRef) {
  return request(app)
    .post('/agent/shop/v1/invoke')
    .send({ operation: 'get_pdp_v2', payload: { product_ref: productRef, include: ['offers'] } });
}

const identityOf = (res) => res.body?.metadata?.identity_resolution || {};

describe('get_pdp_v2: a re-keyed sig_ row whose seed is retired', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test('404s with the settled external_seed_not_active reason', async () => {
    const { app, db } = loadServer();
    install(db, exactSigRow());

    const res = await pdp(app, { product_id: SIG_ID });

    expect(res.status).toBe(404);
    expect(res.body?.error).toBe('PRODUCT_NOT_FOUND');
    expect(res.body?.details).toEqual({
      reason: 'external_seed_not_active',
      external_seed_status: 'inactive',
      external_seed_id: 'eps_rekeyed_1',
      external_product_id: SEED_ID,
    });
    // CONTROL: this really is the prod lane, not the ext_ precheck exit.
    expect(identityOf(res)).toEqual(
      expect.objectContaining({
        requested_product_id: SIG_ID,
        resolved_product_id: SEED_ID,
        resolved_merchant_id: OBS_MERCHANT,
        resolution_source: 'catalog_products_signature_exact',
        entry_precheck_missing: true,
      }),
    );
  });

  test('CONTROL: an ACTIVE seed that still fails to build stays reason-less', async () => {
    // The status says nothing is wrong with the product, so the miss may be the
    // read path's fault. No reason is invented; the frontend keeps its 500.
    const { app, db } = loadServer();
    install(db, exactSigRow({ external_seed_status: 'active' }));

    const res = await pdp(app, { product_id: SIG_ID });

    expect(res.status).toBe(404);
    expect(res.body?.details).toBeNull();
  });

  test('CONTROL: a sig row with no seed joined stays reason-less', async () => {
    const { app, db } = loadServer();
    install(
      db,
      exactSigRow({
        external_seed_status: null,
        external_seed_id: null,
        external_seed_external_product_id: null,
        external_seed_route_lane: null,
      }),
    );

    const res = await pdp(app, { product_id: SIG_ID });

    expect(res.status).toBe(404);
    expect(res.body?.details).toBeNull();
  });

  describe('a DB blip can never become a settled 404', () => {
    test('reviewer case: another active seed + throwing seed-detail queries stays reason-less', async () => {
      // The sig row's own seed is inactive, but a DIFFERENT active seed names this
      // id in seed_data.product_id. Healthy, that renders (next test). Here the
      // seed-detail reads throw and are swallowed, so the miss is the read path's
      // fault. Even with the confirmation check answering "no active seed" (as if
      // asked at another moment), the swallowed failure must withhold the reason.
      const { app, db } = loadServer();
      install(db, exactSigRow(), { seedDetail: 'throw', activeSeedCheck: NO_ACTIVE_SEED });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(res.status).toBe(404);
      expect(res.body?.details).toBeNull();
    });

    test('CONTROL: the same rows on a healthy DB render the product', async () => {
      const { app, db } = loadServer();
      install(db, exactSigRow(), { seedDetail: 'other_active' });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(res.status).toBe(200);
    });

    test('a clean miss whose fresh check FINDS an active seed stays reason-less', async () => {
      // What a ledger cannot see: the content lookup answered from another
      // request's in-flight promise or a cache. The fresh check is the authority.
      const { app, db } = loadServer();
      install(db, exactSigRow(), {
        activeSeedCheck: { ...NO_ACTIVE_SEED, seed_data_product_id: true },
      });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(res.status).toBe(404);
      expect(res.body?.details).toBeNull();
    });

    test('a clean miss whose fresh check fails stays reason-less', async () => {
      const { app, db } = loadServer();
      install(db, exactSigRow(), { activeSeedCheck: 'throw' });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(res.status).toBe(404);
      expect(res.body?.details).toBeNull();
    });
  });
});

describe('readSignatureSeedNotActive', () => {
  const ref = (overrides = {}) => ({
    source: 'catalog_products_signature_exact',
    external_seed_status: 'paused',
    external_seed_id: 'eps_1',
    external_seed_external_product_id: SEED_ID,
    ...overrides,
  });
  const ctx = { resolvedMerchantId: OBS_MERCHANT, resolvedProductId: SEED_ID };

  test('names the settled reason for a re-keyed seed-supply row', () => {
    expect(readSignatureSeedNotActive(ref(), ctx)).toEqual({
      reason: 'external_seed_not_active',
      external_seed_status: 'paused',
      external_seed_id: 'eps_1',
      external_product_id: SEED_ID,
    });
  });

  test.each([
    ['an active seed', ref({ external_seed_status: 'active' }), ctx],
    ['no seed status', ref({ external_seed_status: '' }), ctx],
    ['a ref from another resolver lane', ref({ source: 'canonical_catalog_signature' }), ctx],
    ['a seed that is not the resolved id', ref({ external_seed_external_product_id: 'other-com:1' }), ctx],
    ['a connected (non-seed) seller', ref(), { ...ctx, resolvedMerchantId: 'merch_shopify_1' }],
    // The ext_ seed precheck already answers these; its exit stays untouched.
    ['an ext_ id', ref({ external_seed_external_product_id: 'ext_abc' }), { ...ctx, resolvedProductId: 'ext_abc' }],
    ['no ref', null, ctx],
  ])('returns null for %s', (_name, signatureRef, context) => {
    expect(readSignatureSeedNotActive(signatureRef, context)).toBeNull();
  });
});

describe('settleSignatureSeedNotActive', () => {
  const candidate = {
    reason: 'external_seed_not_active',
    external_seed_status: 'inactive',
    external_seed_id: 'eps_1',
    external_product_id: SEED_ID,
  };
  const answering = (row) => async () => ({ rows: [row] });

  test('settles only with a clean ledger and an all-false fresh check', async () => {
    await expect(
      settleSignatureSeedNotActive(candidate, {
        queryFn: answering(NO_ACTIVE_SEED),
        isLedgerClean: () => true,
        canonicalRefUnchanged: true,
      }),
    ).resolves.toEqual(candidate);
  });

  const ok = { isLedgerClean: () => true, canonicalRefUnchanged: true };
  test.each([
    ['a dirty ledger', { ...ok, queryFn: answering(NO_ACTIVE_SEED), isLedgerClean: () => false }],
    ['no ledger function', { ...ok, queryFn: answering(NO_ACTIVE_SEED), isLedgerClean: undefined }],
    ['no database', { ...ok, queryFn: null }],
    ['an active match', { ...ok, queryFn: answering({ ...NO_ACTIVE_SEED, seed_id: true }) }],
    ['a null column', { ...ok, queryFn: answering({ ...NO_ACTIVE_SEED, seed_id: null }) }],
    ['no row', { ...ok, queryFn: async () => ({ rows: [] }) }],
    ['a throwing check', { ...ok, queryFn: async () => { throw new Error('boom'); } }],
    ['the legacy detail fallback on', { ...ok, queryFn: answering(NO_ACTIVE_SEED), legacyDetailFallbackEnabled: true }],
    ['a canonical ref that moved after the signature resolved', {
      ...ok, queryFn: answering(NO_ACTIVE_SEED), canonicalRefUnchanged: false,
    }],
    ['no canonical-ref answer at all', { queryFn: answering(NO_ACTIVE_SEED), isLedgerClean: () => true }],
  ])('withholds on %s', async (_name, deps) => {
    await expect(settleSignatureSeedNotActive(candidate, deps)).resolves.toBeNull();
  });

  test('withholds when something fails WHILE the check runs', async () => {
    let clean = true;
    const queryFn = async () => {
      clean = false;
      return { rows: [NO_ACTIVE_SEED] };
    };
    await expect(
      settleSignatureSeedNotActive(candidate, { queryFn, isLedgerClean: () => clean, canonicalRefUnchanged: true }),
    ).resolves.toBeNull();
  });

  test("the fresh check covers the content lookup's whole match set, active seeds only", () => {
    const sql = norm(ACTIVE_SEED_MATCH_SQL);
    for (const clause of [
      'external_product_id = $1',
      'id::text = $1',
      "seed_data->>'external_product_id' = $1",
      "seed_data->>'product_id' = $1",
      "seed_data->'snapshot'->>'product_id' = $1",
    ]) {
      expect(sql).toContain(clause);
    }
    expect(sql.match(/status = 'active'/g)).toHaveLength(5);
    // No OR: each branch keeps its own (partial) index.
    expect(sql).not.toMatch(/\bOR\b/);
  });
});

describe('the seed-detail fallback lookup can use its indexes', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // Prod 2026-10-19 on gateway-00735-koh: the retired-seed 404 spent 5.6s in
  // precheck_entry_product and again in fetch_canonical_product, the same
  // unguarded `seed_data->>… = $1 OR …` lookup seq-scanning each time, so the
  // 404 took 11-13s and agent.pivota.cc gave up at 9s+3s with a 500.
  test('every seed_data arm the server sends carries its `seed_data ? k` guard', async () => {
    const { app, db } = loadServer();
    install(db, exactSigRow());
    const sent = [];
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      sent.push(norm(sql));
      return base(sql, params);
    });

    const res = await pdp(app, { product_id: SIG_ID });

    expect(res.status).toBe(404);
    const fallbacks = sent.filter((sql) => sql.includes('destination_url') && sql.includes("seed_data->>'product_id' = $1"));
    // The precheck and fetch_canonical_product both miss through it.
    expect(fallbacks.length).toBeGreaterThanOrEqual(1);
    for (const sql of fallbacks) {
      expect(sql).toContain(norm(SEED_DATA_FALLBACK_MATCH_CLAUSE));
      expect(sql).toContain("seed_data ? 'external_product_id' AND seed_data->>'external_product_id' = $1");
      expect(sql).toContain("seed_data ? 'product_id' AND seed_data->>'product_id' = $1");
      expect(sql).toContain("seed_data ? 'snapshot' AND seed_data->'snapshot'->>'product_id' = $1");
    }
  });

  test('the exact lookups the server sends are the fresh check\'s exact branches', async () => {
    const { app, db } = loadServer();
    install(db, exactSigRow());
    const sent = [];
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      sent.push(norm(sql));
      return base(sql, params);
    });

    await pdp(app, { product_id: SIG_ID });

    const detail = sent.filter((sql) => sql.includes('destination_url'));
    for (const [, clause] of SEED_EXACT_MATCHES) {
      expect(detail.some((sql) => sql.includes(`AND ${clause} ORDER BY`))).toBe(true);
      expect(norm(ACTIVE_SEED_MATCH_SQL)).toContain(clause);
    }
    expect(SEED_EXACT_MATCHES.map(([name]) => name)).toEqual(['external_product_id', 'seed_id']);
  });

  test('the fallback and the fresh check are one match set', () => {
    const check = norm(ACTIVE_SEED_MATCH_SQL);
    for (const arm of norm(SEED_DATA_FALLBACK_MATCH_CLAUSE).slice(2, -2).split(') OR (')) {
      expect(check).toContain(arm);
    }
  });
});

