const request = require('supertest');
const nock = require('nock');

jest.setTimeout(60000);
jest.mock('../../src/db', () => ({
  query: jest.fn(), withClient: jest.fn(async fn => fn({ query: jest.fn() })),
}));
const ORIGINAL_ENV = process.env;
// The incident's live catalog shape: an eligible referral row with no minted
// signature. Its content-key URL must resolve without losing its observed seller.
const CK = 'ck_4dc24acc8d9242a292e8692bd11f5c09';
const PID = 'ext_11c49350f95d48555a9f2a6b';
const MERCHANT = 'merch_obs_f90122172d141c2d';
const KEY = `prod::external_seed::external_seed::${PID}`;
const norm = sql => String(sql).replace(/\s+/g, ' ');

function load({ eligible = true, lookupError = false, lookupMiss = false, seedActive = true } = {}) {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test', DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: 'http://referral-content.test', PIVOTA_API_KEY: 'test-token',
    PDP_IDENTITY_GRAPH_ENABLED: 'false', PDP_SIMILAR_FIRST_PAINT_PREWARM_ENABLED: 'false',
    AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
  };
  const db = require('../../src/db');
  const seen = [];
  db.query.mockImplementation(async (sql, params = []) => {
    const text = norm(sql);
    seen.push({ sql: text, params });
    if (text.includes('/* referral_content_key_resolution */')) {
      expect(params).toEqual([CK]);
      if (lookupError) throw new Error('private connection failed');
      return { rows: lookupMiss ? [] : [{ merchant_id: MERCHANT, source_product_id: PID,
        product_key: KEY, content_key: CK, platform: 'external_seed',
        source_system: 'external_product_seeds_mirror_v1' }] };
    }
    if (text.includes('LEFT JOIN index_pipeline_state ips') && !text.includes('cp.pivota_signature_id = $1')) {
      // A naked ext_ fallback uses merchant external_seed and cannot find this
      // row. The content-key ref must survive all the way to this gate.
      return { rows: params.includes(CK) || (params.includes(MERCHANT) && params.includes(PID)) ? [{
        content_key: CK, product_key: KEY, source_system: 'external_product_seeds_mirror_v1',
        source_product_id: PID, pivota_signature_id: null, sync_status: 'live',
        pdp_lifecycle_stage: 'validated', serving_eligible: eligible,
        pipeline_stage: 'shadow_indexed', blocker_code: eligible ? 'none' : 'low_quality',
        content_quality_score: eligible ? 100 : 10, active_external_seed_source_match: true,
      }] : [] };
    }
    if (text.includes('FROM external_product_seeds')) {
      if (!seedActive && text.includes("status = 'active'")) return { rows: [] };
      return { rows: [{ id: 'eps_test', external_product_id: PID,
        status: seedActive ? 'active' : 'inactive',
        canonical_url: 'https://blindbarber.com/products/30-proof-styling-cream',
        destination_url: 'https://blindbarber.com/products/30-proof-styling-cream',
        domain: 'blindbarber.com', title: '30 Proof Styling Cream',
        image_url: 'https://cdn.example.test/cream.png', price_amount: 24,
        price_currency: 'USD', availability: 'out_of_stock',
        seed_data: { brand: 'Blind Barber', description: 'A weightless styling cream.' },
      }] };
    }
    return { rows: [] };
  });
  nock('http://referral-content.test').persist().get(/.*/).reply(404, {});
  nock('http://referral-content.test').persist().post(/.*/).reply(404, {});
  return { app: require('../../src/server'), seen };
}

const invoke = (app, productRef = { product_id: CK }, extra = {}) => request(app)
  .post('/agent/shop/v1/invoke').send({ operation: 'get_pdp_v2', payload: {
    product_ref: productRef, include: ['offers', 'variant_selector', 'product_overview'],
    options: { allow_read_only: true }, ...extra,
  } });

afterEach(() => { process.env = ORIGINAL_ENV; nock.cleanAll(); });

test('the incident content-key route renders the existing unminted referral product', async () => {
  const { app, seen } = load();
  const res = await invoke(app);
  expect(res.status).toBe(200);
  expect(res.body.error).toBeUndefined();
  expect(res.body.subject.canonical_product_ref).toMatchObject({ merchant_id: MERCHANT,
    product_id: PID, product_key: KEY, content_key: CK, platform: 'external_seed',
    source_system: 'external_product_seeds_mirror_v1' });
  expect(res.body.metadata.identity_resolution).toMatchObject({ requested_product_id: CK,
    requested_merchant_id: null, resolved_product_id: PID, resolved_merchant_id: MERCHANT,
    canonicalization_reason_code: 'CATALOG_CONTENT_KEY',
    content_key_resolution: { content_key: CK, product_key: KEY, product_id: PID, merchant_id: MERCHANT } });
  const canonical = res.body.modules.find(m => m.type === 'canonical').data;
  if (process.env.REFERRAL_CONTENT_KEY_RECEIPT) {
    require('fs').writeFileSync(process.env.REFERRAL_CONTENT_KEY_RECEIPT,
      JSON.stringify({ status: res.status, headers: res.headers, body: res.body }, null, 2));
  }
  const product = canonical.pdp_payload.product;
  expect(product.title).toBe('30 Proof Styling Cream');
  expect(product.merchant_id).toBe(MERCHANT);
  expect(product.availability.in_stock).toBe(false);
  const offers = res.body.modules.find(m => m.type === 'offers').data.offers;
  expect(offers).toHaveLength(1);
  expect(offers[0]).toMatchObject({ merchant_id: MERCHANT, product_id: PID,
    inventory: { in_stock: false }, commerce_mode: 'links_out', checkout_handoff: 'redirect',
    action: { type: 'redirect_url', url: 'https://blindbarber.com/products/30-proof-styling-cream' } });
  expect(seen.filter(q => q.sql.includes('/* referral_content_key_resolution */'))).toHaveLength(1);
});

test('a resolved content key still obeys the serving-eligibility gate', async () => {
  const { app } = load({ eligible: false });
  const res = await invoke(app);
  expect(res.status).toBe(404);
  expect(res.body.error).toBe('PRODUCT_NOT_SERVABLE');
  expect(res.body.details).toMatchObject({ content_key: CK, index_row_found: true, serving_eligible: false });
});

test('an inactive seed still returns the settled retirement reason', async () => {
  const { app } = load({ seedActive: false });
  const res = await invoke(app);
  expect(res.status).toBe(404);
  expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
  expect(res.body.details).toMatchObject({ reason: 'external_seed_not_active', external_seed_status: 'inactive' });
});

test('a failed content-key lookup is retryable503 and never a settled404', async () => {
  const { app } = load({ lookupError: true });
  const res = await invoke(app);
  expect(res.status).toBe(503);
  expect(res.body.error).toBe('TEMPORARY_UNAVAILABLE');
  expect(res.body.reason_code).toBe('CONTENT_KEY_RESOLVE_UNAVAILABLE');
  expect(JSON.stringify(res.body)).not.toContain('private connection');
});

test('a clean alias miss retains existing unknown-id handling', async () => {
  const { app } = load({ lookupMiss: true });
  const res = await invoke(app);
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('MISSING_MERCHANT_CONTEXT');
});

test.each([
  [{ product_id: CK, merchant_id: 'other_seller' }, {}],
  [{ product_id: CK, variant_id: 'v1' }, {}],
  [{ product_id: CK, offer_id: 'some_offer' }, {}],
  [{ product_id: CK }, { subject: { type: 'product_group', id: 'pg_other' } }],
])('does not rewrite an explicitly scoped request %#', async (productRef, extra) => {
  const { app, seen } = load();
  await invoke(app, productRef, extra);
  expect(seen.some(q => q.sql.includes('/* referral_content_key_resolution */'))).toBe(false);
});
