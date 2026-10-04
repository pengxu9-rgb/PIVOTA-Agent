const request = require('supertest');
const { CANONICAL_ENTITY_GROUP_SQL_TAG } = require('../../src/services/catalogEntityResolutionSqlTag');

jest.setTimeout(60000);

// get_pdp_v2 `subject: product_group` for a pg_ id is answered through the SIGNATURE lane of the member
// the group lane picks.
//
// Prod 2026-09-27: https://agent.pivota.cc/products/pg_2d55d9b5a6072061f298e44f728465b4 answered 500
// to crawlers because get_pdp_v2 answered the group 404 PRODUCT_NOT_FOUND, while the sig of the
// group's own published member (sig_4add79b09500029e7ecda4ed18379fdd) rendered 200. That member is a
// P3 minted canonical (source_system='catalog_enrichment_agent_v1'): its source_product_id
// `retailer:da5a…` is a name slug, and its content route is the attached seed's external_product_id
// `bluemercury-com:6904447685082a5b`. Only the signature resolver knows that translation
// (tests/integration/get_pdp_v2_minted_canonical_seed_route.test.js); the group lane handed the slug
// to fetch_canonical_product. 14,464 of 22,012 signed pg_ groups in prod pick a minted row.
//
// The fixtures below are that group, prod-shaped: two is_primary members (the brand's candidate
// mirror seed and the retailer's published minted row), the published one wins the pick.

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const ORIGINAL_ENV = process.env;

const GROUP_ID = 'pg_2d55d9b5a6072061f298e44f728465b4';
const CONTENT_KEY = 'ck_2d55d9b5a6072061f298e44f728465b4';
const MINTED_SIG = 'sig_4add79b09500029e7ecda4ed18379fdd';
const MINTED_MERCHANT = 'merch_obs_a2e07b1e8a08148b';
const MINTED_SLUG = 'retailer:da5a8910e8774397e5414958ef6651ac';
const MINTED_PRODUCT_KEY = 'ext:retailer:da5a8910e8774397e5414958ef6651ac';
const ATTACHED_SEED_EPID = 'bluemercury-com:6904447685082a5b';
const MIRROR_SIG = 'sig_f699a80bdb9f2c02150e41746659062c';
const MIRROR_MERCHANT = 'merch_obs_754ebc89aff23454';
const MIRROR_SEED = 'ext_036bd1946e3aa8d2bbb8d76f';

function loadServerWithDb(envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    // Unroutable on purpose: every upstream leg on this route is wrapped in a catch, so a dead base
    // proves the answer came from the mocked DB.
    PIVOTA_API_BASE: 'http://127.0.0.1:9',
    PIVOTA_API_KEY: 'test-token',
    ...envOverrides,
  };
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

const norm = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();
// ORDER MATTERS: the canonical-group SQL also contains `cp.pivota_signature_id = $1` when it is asked
// for a sig, so it must be matched before the exact-signature probe.
const isCanonicalGroupQuery = (sql) => norm(sql).includes(CANONICAL_ENTITY_GROUP_SQL_TAG);
const isExactSigQuery = (sql) => norm(sql).includes('cp.pivota_signature_id = $1');
const isSeedDetailQuery = (sql) =>
  String(sql || '').includes('FROM external_product_seeds') && String(sql || '').includes('destination_url');

function groupRows() {
  const base = {
    content_key: CONTENT_KEY,
    platform: 'external_seed',
    product_title: 'Slim Lip Color Shine',
    brand: 'Tom Ford',
    internal_product_group_id: GROUP_ID,
    is_primary: true,
    sync_status: 'live',
    offer_count: 0,
  };
  // In the resolver SQL's ORDER BY (is_primary, then lifecycle stage): with both members primary, the
  // published minted row comes first, and canonical_product_ref is the first primary member.
  return [
    {
      ...base,
      product_key: MINTED_PRODUCT_KEY,
      merchant_id: MINTED_MERCHANT,
      merchant_name: 'bluemercury.com',
      source_product_id: MINTED_SLUG,
      pivota_signature_id: MINTED_SIG,
      pdp_lifecycle_stage: 'published',
      pivota_signature_minted_at: '2026-09-25T02:29:22.000Z',
    },
    {
      ...base,
      product_key: `prod::external_seed::external_seed::${MIRROR_SEED}`,
      merchant_id: MIRROR_MERCHANT,
      merchant_name: 'Tom Ford Beauty',
      source_product_id: MIRROR_SEED,
      pivota_signature_id: MIRROR_SIG,
      pdp_lifecycle_stage: 'candidate',
      pivota_signature_minted_at: '2026-05-12T06:34:14.000Z',
    },
  ];
}

// The exact-signature row for the minted member: its seed came from LANE 1 (attached_product_key), so
// the signature lane presents the seed's external_product_id, not the slug.
function mintedSignatureRow() {
  return {
    merchant_id: MINTED_MERCHANT,
    platform: 'external_seed',
    source_product_id: MINTED_SLUG,
    product_key: MINTED_PRODUCT_KEY,
    source_system: 'catalog_enrichment_agent_v1',
    pivota_signature_id: MINTED_SIG,
    content_key: CONTENT_KEY,
    catalog_title: 'Slim Lip Color Shine',
    catalog_brand: 'Tom Ford',
    catalog_sync_status: 'live',
    catalog_pdp_lifecycle_stage: 'published',
    signature_serving_eligible: true,
    external_seed_id: 'eps_bluemercury_1',
    external_seed_external_product_id: ATTACHED_SEED_EPID,
    external_seed_status: 'active',
    external_seed_route_lane: 1,
  };
}

function seedDetailRow() {
  return {
    id: 'eps_bluemercury_1',
    external_product_id: ATTACHED_SEED_EPID,
    status: 'active',
    canonical_url: 'https://bluemercury.com/products/tom-ford-slim-lip-color-shine',
    destination_url: 'https://bluemercury.com/products/tom-ford-slim-lip-color-shine',
    domain: 'bluemercury.com',
    title: 'Slim Lip Color Shine',
    image_url: 'https://cdn.example.test/slim-lip.png',
    price_amount: '62.00',
    price_currency: 'USD',
    availability: 'In Stock',
    seed_data: { brand: 'Tom Ford', description: 'lip color' },
  };
}

function install(db, { groupQueryThrows = false, signatureRowOverrides = {}, currentOwnMoneyRows } = {}) {
  const seen = [];
  db.query.mockImplementation(async (sql, params) => {
    seen.push({ sql: String(sql || ''), params });
    if (String(sql || '').includes('FROM catalog_products own_cp') && String(sql || '').includes('JOIN catalog_offers co')) {
      expect(params).toEqual([MINTED_PRODUCT_KEY, MINTED_MERCHANT]);
      return { rows: currentOwnMoneyRows ?? [{
        offer_id: 'own_bluemercury_current', sku_key: `${MINTED_PRODUCT_KEY}::canonical`,
        source_variant_id: MINTED_PRODUCT_KEY, currency: 'USD', amount: '62.00',
      }] };
    }
    if (isCanonicalGroupQuery(sql)) {
      if (groupQueryThrows) throw new Error('connection terminated');
      return { rows: groupRows() };
    }
    if (isExactSigQuery(sql)) {
      return { rows: params?.[0] === MINTED_SIG ? [{ ...mintedSignatureRow(), ...signatureRowOverrides }] : [] };
    }
    if (isSeedDetailQuery(sql)) return { rows: [seedDetailRow()] };
    return { rows: [] };
  });
  return seen;
}

const BASE_PAYLOAD = {
  include: ['offers'],
  options: { serving_eligible_only: true },
  capabilities: { client: 'shopping' },
};

async function invoke(app, payload) {
  return request(app)
    .post('/agent/shop/v1/invoke')
    .send({ operation: 'get_pdp_v2', payload: { ...BASE_PAYLOAD, ...payload } });
}

const groupSubject = { subject: { type: 'product_group', id: GROUP_ID } };

describe('get_pdp_v2 product_group subject -> member signature lane', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test('a pg_ group whose pick is a minted row resolves onto the attached seed id via its sig', async () => {
    const { app, db } = loadServerWithDb();
    const seen = install(db);
    const res = await invoke(app, groupSubject);
    const identity = res.body?.metadata?.identity_resolution || {};

    // The group was looked up by its pg_ id, then answered as the request for the picked member's sig.
    const groupLookup = seen.find((q) => isCanonicalGroupQuery(q.sql) && q.params?.includes(GROUP_ID));
    expect(groupLookup).toBeTruthy();
    expect(identity.requested_product_group_id).toBe(GROUP_ID);
    expect(identity.requested_product_id).toBe(MINTED_SIG);
    expect(identity.resolution_source).toBe('catalog_products_signature_exact');
    expect(identity.resolved_merchant_id).toBe(MINTED_MERCHANT);
    expect(identity.resolved_product_id).toBe(ATTACHED_SEED_EPID);
    // The slug answers nothing anywhere; carrying it into fetch_canonical_product is the 404.
    expect(identity.resolved_product_id).not.toBe(MINTED_SLUG);
    expect(res.body?.error).not.toBe('PRODUCT_NOT_FOUND');
  });

  test('the pg_ route answers exactly as the sig route does', async () => {
    const { app, db } = loadServerWithDb();
    install(db);
    const viaGroup = await invoke(app, groupSubject);
    const viaSig = await invoke(app, { product_ref: { product_id: MINTED_SIG } });

    expect(viaGroup.status).toBe(viaSig.status);
    expect(viaGroup.status).toBe(200);
    expect(viaGroup.body?.error).toBeUndefined();
    const modules = (body) => (Array.isArray(body?.modules) ? body.modules.map((m) => m?.type) : []);
    expect(modules(viaGroup.body)).toEqual(modules(viaSig.body));
    expect(modules(viaGroup.body)).toContain('canonical');
    expect(viaGroup.body?.subject).toEqual(viaSig.body?.subject);

    const groupIdentity = { ...viaGroup.body.metadata.identity_resolution };
    expect(groupIdentity.requested_product_group_id).toBe(GROUP_ID);
    delete groupIdentity.requested_product_group_id;
    expect(groupIdentity).toEqual(viaSig.body.metadata.identity_resolution);
    // The sig request itself carries no group field.
    expect(viaSig.body.metadata.identity_resolution).not.toHaveProperty('requested_product_group_id');
  });

  test('the minted member with no current own offer renders unpriced and not purchasable on both routes, never at its seed price', async () => {
    const { app, db } = loadServerWithDb();
    install(db, { currentOwnMoneyRows: [] });
    for (const payload of [groupSubject, { product_ref: { product_id: MINTED_SIG } }]) {
      const res = await invoke(app, payload);
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      expect(res.body.metadata).toMatchObject({
        current_own_offer_status: 'unavailable',
        current_own_offer_reason_code: 'CURRENT_OWN_OFFER_UNAVAILABLE',
      });
      const product = res.body.modules.find((m) => m?.type === 'canonical')?.data?.pdp_payload?.product;
      expect(product?.title).toBe('Slim Lip Color Shine');
      expect(product).not.toHaveProperty('price');
      expect(product.availability.in_stock).toBe(false);
      expect(product.variants.length).toBeGreaterThan(0);
      for (const variant of product.variants) {
        expect(variant).toMatchObject({ current_own_offer_status: 'unavailable', availability: { in_stock: false } });
        expect(variant).not.toHaveProperty('price');
      }
      // The seed's 62.00 is not presented anywhere as current money.
      expect(JSON.stringify(res.body.modules)).not.toMatch(/"(amount|price|price_amount)":\s*"?62(\.0+)?"?[,}]/);
      expect(res.body.modules.some((m) => m?.type === 'price_promo')).toBe(false);
    }
  });

  test('kill switch off restores the group lane (the pre-fix 404 on the slug)', async () => {
    // Also the proof the two tests above test the fix: with it off, the same fixtures carry the
    // slug forward and never render. (Prod 404s this at fetch_canonical_product as PRODUCT_NOT_FOUND;
    // this mock has no eligibility rows, so the group lane stops one gate earlier.)
    const { app, db } = loadServerWithDb({ PDP_PRODUCT_GROUP_SUBJECT_VIA_SIGNATURE_ENABLED: 'false' });
    install(db);
    const res = await invoke(app, groupSubject);
    const identity = res.body?.metadata?.identity_resolution || {};
    expect(identity.resolution_source).toBe('canonical_catalog_subject_group');
    expect(identity.resolved_product_id).toBe(MINTED_SLUG);
    expect(identity).not.toHaveProperty('requested_product_group_id');
    expect(res.status).toBe(404);
  });

  test('a failed group lookup keeps the group lane instead of failing the request', async () => {
    const { app, db } = loadServerWithDb();
    install(db, { groupQueryThrows: true });
    const res = await invoke(app, groupSubject);
    const identity = res.body?.metadata?.identity_resolution || {};
    expect(res.status).not.toBe(500);
    expect(identity).not.toHaveProperty('requested_product_group_id');
    expect(identity.requested_product_id).not.toBe(MINTED_SIG);
  });

  test('a caller that also pinned a seller keeps the group lane', async () => {
    const { app, db } = loadServerWithDb();
    const seen = install(db);
    const res = await invoke(app, {
      ...groupSubject,
      product_ref: { merchant_id: MIRROR_MERCHANT },
    });
    const identity = res.body?.metadata?.identity_resolution || {};
    expect(identity).not.toHaveProperty('requested_product_group_id');
    expect(seen.some((q) => isExactSigQuery(q.sql) && !isCanonicalGroupQuery(q.sql))).toBe(false);
  });

  test('a non-pg_ subject id is not re-routed', async () => {
    const { app, db } = loadServerWithDb();
    const seen = install(db);
    const res = await invoke(app, { subject: { type: 'product_group', id: MINTED_SIG } });
    const identity = res.body?.metadata?.identity_resolution || {};
    expect(identity).not.toHaveProperty('requested_product_group_id');
    expect(seen.some((q) => isCanonicalGroupQuery(q.sql) && q.params?.includes(GROUP_ID))).toBe(false);
  });

  // Post-deploy monitoring counts pg_ traffic from the log, and on a re-routed request
  // requested_product_id is the SIG, so the pg_ id has to ride on the line itself.
  function spyLogger() {
    const logger = require('../../src/logger');
    return jest.spyOn(logger, 'info');
  }
  const logFields = (spy, msg) =>
    spy.mock.calls.filter((call) => call[1] === msg).map((call) => call[0] || {});

  test("the 'get_pdp_v2 completed' line carries the pg_ id of a re-routed request, null for a sig request", async () => {
    const { app, db } = loadServerWithDb();
    install(db);
    const spy = spyLogger();

    const viaGroup = await invoke(app, groupSubject);
    expect(viaGroup.status).toBe(200);
    const groupLines = logFields(spy, 'get_pdp_v2 completed');
    expect(groupLines).toHaveLength(1);
    expect(groupLines[0].requested_product_group_id).toBe(GROUP_ID);
    expect(groupLines[0].requested_product_id).toBe(MINTED_SIG);

    spy.mockClear();
    const viaSig = await invoke(app, { product_ref: { product_id: MINTED_SIG } });
    expect(viaSig.status).toBe(200);
    const sigLines = logFields(spy, 'get_pdp_v2 completed');
    expect(sigLines).toHaveLength(1);
    expect(sigLines[0].requested_product_group_id).toBeNull();
  });

  test('the serving-eligibility block line carries the pg_ id too', async () => {
    const { app, db } = loadServerWithDb();
    install(db, {
      signatureRowOverrides: {
        signature_serving_eligible: false,
        signature_blocker_code: 'low_quality',
        signature_blocker_detail: 'content quality below threshold',
        signature_content_quality_score: 0.1,
      },
    });
    const spy = spyLogger();

    const res = await invoke(app, groupSubject);
    expect(res.status).toBe(404);
    expect(res.body?.error).toBe('PRODUCT_NOT_SERVABLE');
    const blocked = logFields(spy, 'get_pdp_v2 blocked by serving eligibility gate');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].requested_product_group_id).toBe(GROUP_ID);
  });
});
