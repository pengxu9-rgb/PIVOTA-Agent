const nock = require('nock');
const request = require('supertest');
const { CANONICAL_ENTITY_GROUP_SQL_TAG } = require('../../src/services/catalogEntityResolutionSqlTag');

jest.setTimeout(60000);

// THE MERCHANT-PURCHASABILITY GATE, DRIVEN THROUGH THE REAL INVOKE ROUTE WITH A MARKET.
//
// docs/merchant-purchasability-gate.md §5/§8: the gate keys on the REQUEST's buyer market
// (`offersGateBuyerMarket` -> `selectBuyerMarket(search.market, payload.market, metadata.market)`)
// and never defaults. The helper-level tests (tests/merchant_purchasability_paths.node.test.cjs)
// inject `shouldOfferPurchase` and hand it a market directly, so nothing there proves that the
// six src/server.js call sites actually pass the request's market through. A site that dropped it
// would still pass every one of those tests: the unkeyable branch is ALSO a correct, tested
// behaviour, it is just the wrong one for a request that named its market.
//
// So here the real gate client runs against a stubbed `global.fetch` (its backend transport,
// captured when the process singleton is built — `jest.resetModules()` per test gives a fresh
// singleton and a fresh cache), and the observable is the ops URL the gate READ:
//   keyed      GET /ops/merchant-purchasability?domain=<host>&market=US
//   unkeyable  GET /ops/merchant-purchasability?domain=<host>          (the enforcement probe)
// plus what the served offer lost or kept.
//
// THE CALLER THIS IS FOR: the agent UI sends `metadata.market` and a `metadata.scope` on every
// call, and NO `search.market` / `payload.market`. `UI_METADATA` below is that shape verbatim.

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const ORIGINAL_ENV = process.env;
const ORIGINAL_FETCH = global.fetch;
let CUR = 'SGD';
// The member offer's own currency, when a case gives it one apart from the page's.
let OFFER_CUR = null;
// false: the card itself quotes no price (the seed and the group row carry none); only the member offer does.
let CARD_PRICED = true;
// Savings copy (pdp SAVINGS_PRESENTATION_FIELDS) on the card and on the member offer, when a case asks for it.
let SAVINGS = null;

// Unroutable on purpose (as in get_pdp_v2_caller_requested_merchant): every upstream leg on the
// PDP route is wrapped in a catch, so a dead base proves the page came from the mocked DB. The ops
// read goes through `global.fetch`, which is stubbed, so the origin only has to parse.
const API_BASE = 'http://127.0.0.1:9';
const OPS_URL = `${API_BASE}/ops/merchant-purchasability`;

const UI_METADATA = Object.freeze({
  market: 'US',
  scope: { catalog: 'global', region: null, language: null },
  entry: 'pdp',
  ui_source: 'shopping-agent-ui',
  source: 'shopping_agent',
});
const uiMetadata = (overrides = {}) => ({
  ...UI_METADATA,
  scope: { ...UI_METADATA.scope },
  ...overrides,
});
const uiMetadataWithoutMarket = (overrides = {}) => {
  const { market, ...rest } = uiMetadata(overrides);
  return rest;
};

const CHECKOUT_URL_KEYS = new Set([
  'merchant_checkout_url', 'merchantCheckoutUrl', 'checkout_url', 'checkoutUrl',
]);

function loadServer(envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: API_BASE,
    PIVOTA_API_KEY: 'test-token',
    PDP_IDENTITY_GRAPH_ENABLED: 'true',
    MERCHANT_PURCHASABILITY_GATE_ENABLED: 'true',
    // The DEV-FALLBACK credential (a static admin JWT). With no OIDC audience configured the
    // client uses it as-is; without ANY credential the gate is "not configured" and fails open,
    // which would make every decline assertion below pass or fail for the wrong reason.
    PIVOTA_OPS_ADMIN_TOKEN: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LW9wcyJ9.dGVzdC1zaWduYXR1cmU',
    ...envOverrides,
  };
  delete process.env.PIVOTA_OPS_OIDC_AUDIENCE;
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

// The backend, as the gate client sees it. `tierFor(domain, market)` answers a KEYED read; the
// market-less read gets the enforcement-probe body `parseEnforcementProbe` accepts (and nothing
// else). Every ops URL is recorded. Anything else on `global.fetch` is a dead upstream.
function installOpsBackend({ tierFor = () => 'browse_only', enforced = true } = {}) {
  const reads = [];
  global.fetch = jest.fn(async (input) => {
    const url = String(input && input.url ? input.url : input);
    if (!url.startsWith(OPS_URL)) throw new TypeError(`dead upstream in test: ${url}`);
    reads.push(url);
    const parsed = new URL(url);
    const domain = parsed.searchParams.get('domain');
    const body = parsed.searchParams.has('market')
      ? {
          domain,
          market: parsed.searchParams.get('market'),
          tier: tierFor(domain, parsed.searchParams.get('market')),
          enforced,
          sweep_enabled: true,
        }
      : { tier: 'browse_only', reason: 'market_unknown', market: null, enforced, sweep_enabled: true, facts: [] };
    return { ok: true, status: 200, json: async () => body };
  });
  return reads;
}

const keyedRead = (domain, market) => `${OPS_URL}?domain=${domain}&market=${market}`;
const probeRead = (domain) => `${OPS_URL}?domain=${domain}`;

// Every checkout-named value anywhere in the response that points at `host`. A declined merchant
// must have NONE — the page's canonical payload is hydrated from the offers, so looking only at
// `offers[i]` would miss a copy.
function checkoutUrlsOnHost(node, host, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      if (CHECKOUT_URL_KEYS.has(k) && v.includes(host)) out.push(`${k}=${v}`);
    } else {
      checkoutUrlsOnHost(v, host, out, depth + 1);
    }
  }
  return out;
}

const offersOf = (res) => (res.body?.modules || []).find((m) => m.type === 'offers')?.data?.offers || [];

// Every string anywhere under `node` that is `url` (exact) — for "this cart URL is in NO field".
function stringsEqualTo(node, url, out = [], path = '', depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      if (v === url) out.push(`${path}.${k}`);
    } else {
      stringsEqualTo(v, url, out, `${path}.${k}`, depth + 1);
    }
  }
  return out;
}

const offersModuleOf = (res) => (res.body?.modules || []).find((m) => m.type === 'offers') || null;

// WHAT DISTINGUISHES DECLINED FROM KEPT, and what does not.
//
// Every offer these lanes can build WITH A HOST is a redirect row: `buildOfferPurchaseMetadataFromProduct`
// (src/server.js) stamps `purchase_route: 'affiliate_outbound'` + `external_redirect_url`/`url`/
// `action.url` whenever the product has a redirect URL, and an `internal_checkout` row carries NO URL
// at all — so `readOfferMerchantDomain` is null for it and the gate never asks. Hence `links_out` /
// `redirect` / `affiliate_outbound` are true of the KEPT row too and prove nothing here. The
// discriminator is the checkout URL itself: kept, it is the `merchant_checkout_url` and every link on
// the row; declined, it is in NO field of the offers module. That is only a strong test when the
// destination is CART-shaped (a PDP-shaped link is kept on a declined row on purpose — F2 in
// tests/merchant_purchasability_paths.node.test.cjs), so the fixtures below use a Shopify cart
// permalink as the seed's destination.
function expectDeclined(res, offer, host, cartUrl) {
  // THE OFFER SURVIVES (browse / referral is what is left) ...
  expect(offer).toBeTruthy();
  expect(offer.offer_id).toBeTruthy();
  expect(offer.price).toBeTruthy();
  // ... but it no longer says "buy here", in any field of the offers module.
  expect(Object.prototype.hasOwnProperty.call(offer, 'merchant_checkout_url')).toBe(false);
  expect(checkoutUrlsOnHost(offersModuleOf(res), host)).toEqual([]);
  expect(stringsEqualTo(offersModuleOf(res), cartUrl)).toEqual([]);
  expect(offer.external_redirect_url).toBeUndefined();
  expect(offer.url).toBeUndefined();
  expect(offer.action && offer.action.url).toBeFalsy();
  expect(offer.commerce_mode).toBe('links_out');
}

function expectPurchasable(offer, cartUrl) {
  // The same row, KEPT: the cart URL is the checkout URL and every link. If the fixture could not
  // carry a cart URL end to end, expectDeclined's absence checks above would be vacuous.
  expect(offer).toBeTruthy();
  expect(offer.merchant_checkout_url).toBe(cartUrl);
  expect(offer.external_redirect_url).toBe(cartUrl);
  expect(offer.url).toBe(cartUrl);
  expect(offer.action && offer.action.url).toBe(cartUrl);
}

// ---------------------------------------------------------------------------
// Fixture 1 — the GROUP-MEMBERS lane (sites 1 and 3).
//
// The TestBrand observed-seller shape from get_pdp_v2_observed_seller_entry: a merch_obs_ seller
// whose only detail store is external_product_seeds, one approved + live identity listing, so
// `groupMembers.length > 0` and the offer is built by `buildOffersFromGroupMembers` (site 1) and
// then re-resolved before the offers stamp (site 3). The seed's DESTINATION is a Shopify cart
// permalink on the brand's own host (its canonical URL stays the PDP), so a decline is visible as
// the cart URL leaving every field — see expectDeclined.
// ---------------------------------------------------------------------------

const OBS_MERCHANT = 'merch_obs_022b65d47a58b87a';
const OBS_PRODUCT = 'testBrand_us_8129594163442';
const GROUP_SIG = 'sig_f5c76a8f7e9b00811b08b897';
const CONTENT_KEY = 'ck_a6dc8c29b854612edc1d71e7d90f8060';
const TEST_BRAND_HOST = 'store.example.com';
const TEST_BRAND_PDP = 'https://store.example.com/products/bone-conduction-headphone-wireless-waterproof';
const TEST_BRAND_CART = 'https://store.example.com/cart/44012345678:1';

const norm = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();

// Nothing is quarantined in these fixtures; an empty survivor list would mean "every member is
// quarantined" and would empty the offer group.
function quarantineSurvivors(params) {
  const requested = JSON.parse(String((Array.isArray(params) ? params[0] : null) || '[]'));
  return [{ members: requested.map((m) => ({ merchant_id: m.merchant_id, product_id: m.product_id })) }];
}

function testBrandGroupRow() {
  return {
    product_key: `prod::${OBS_MERCHANT}::external_seed::${OBS_PRODUCT}`,
    merchant_id: OBS_MERCHANT,
    platform: 'external_seed',
    source_product_id: OBS_PRODUCT,
    product_title: 'Test Headphone',
    product_description: 'Bone conduction headphones for sport.',
    brand: 'Test Brand',
    category: 'electronics',
    product_type: 'Headphones',
    category_path: null,
    canonical_url: TEST_BRAND_PDP,
    product_image_url: 'https://cdn.example.com/headphone.png',
    product_payload: {
      ...(CARD_PRICED
        ? { title: 'Test Headphone', brand: 'Test Brand', price_amount: 229.99, currency: CUR }
        : { title: 'Test Headphone', brand: 'Test Brand' }),
      ...(SAVINGS || {}),
    },
    pdp_lifecycle_stage: 'published',
    pivota_signature_id: 'sig_ca228ffe2b666f5c9e73a364c7bb30ba',
    pivota_canonical_url: null,
    pivota_signature_minted_at: '2026-07-10T00:00:00Z',
    content_key: CONTENT_KEY,
    updated_at: '2026-07-10T00:00:00Z',
    merchant_name: 'Test Brand',
    internal_product_group_id: 'pg_a6dc8c29b854612edc1d71e7d90f8060',
    is_primary: true,
    offer_count: 1,
  };
}

function testBrandSeedRow(destination) {
  return {
    id: `external_brand_crawl::${OBS_PRODUCT}`,
    external_product_id: OBS_PRODUCT,
    destination_url: destination,
    canonical_url: TEST_BRAND_PDP,
    domain: TEST_BRAND_HOST,
    title: 'Test Headphone',
    image_url: 'https://cdn.example.com/headphone.png',
    price_amount: CARD_PRICED ? 229.99 : null,
    price_currency: CARD_PRICED ? CUR : null,
    availability: 'in_stock',
    attached_product_key: `prod::${OBS_MERCHANT}::external_seed::${OBS_PRODUCT}`,
    seed_data: { title: 'Test Headphone', brand: 'Test Brand', description: 'Bone conduction.', category: 'electronics' },
    updated_at: '2026-07-10T00:00:00Z',
    created_at: '2026-07-10T00:00:00Z',
    status: 'active',
  };
}

function testBrandListingRow(destination) {
  return {
    source_listing_ref: `${OBS_MERCHANT}:${OBS_PRODUCT}`,
    merchant_id: OBS_MERCHANT,
    product_id: OBS_PRODUCT,
    source_kind: 'external_seed',
    source_tier: 'brand',
    identity_status: 'approved',
    live_read_enabled: true,
    review_required: false,
    sellable_item_group_id: GROUP_SIG,
    product_line_id: 'pl_9de56fa0890b0c15998dd67e',
    review_family_id: 'rf_9de56fa0890b0c15998dd67e',
    identity_confidence: 0.92,
    brand_norm: 'testBrand',
    match_basis: [],
    source_payload: {
      title: 'Test Headphone',
      brand: 'Test Brand',
      price: { amount: 229.99, currency: OFFER_CUR || CUR },
      currency: OFFER_CUR || CUR,
      in_stock: true,
      destination_url: destination,
      catalog_offer_v1: { offer_id: 'co_1', sku_key: 'sku_1', source_system: 'x', source_ref: 'y' },
      ...(SAVINGS || {}),
    },
    variant_axes: {},
    source_meta: {},
  };
}

function installGroupDb(db, { destination = TEST_BRAND_CART } = {}) {
  db.query.mockImplementation(async (sql, params = []) => {
    const s = norm(sql);
    if (s.includes('surviving_members AS')) return { rows: quarantineSurvivors(params) };
    if (s.includes(CANONICAL_ENTITY_GROUP_SQL_TAG)) return { rows: [testBrandGroupRow()] };
    if (s.includes('FROM catalog_products cp') && s.includes('LEFT JOIN index_pipeline_state ips')) {
      return {
        rows: [{
          content_key: CONTENT_KEY,
          product_key: `prod::${OBS_MERCHANT}::external_seed::${OBS_PRODUCT}`,
          source_system: 'external_product_seeds_mirror_v1',
          source_product_id: OBS_PRODUCT,
          pivota_signature_id: 'sig_ca228ffe2b666f5c9e73a364c7bb30ba',
          catalog_title: 'Test Headphone',
          catalog_image_url: null,
          catalog_description: null,
          external_seed_product_family: null,
          catalog_image_urls_count: 0,
          sync_status: 'live',
          pdp_lifecycle_stage: 'published',
          serving_eligible: true,
          readiness_tier: 'serving',
          pipeline_stage: 'serving',
          blocker_code: null,
          blocker_detail: null,
          content_quality_score: 82,
          active_external_seed_source_match: true,
        }],
      };
    }
    if (
      s.includes('FROM external_product_seeds') &&
      s.includes("status = 'active'") &&
      (s.includes('external_product_id = $1') || s.includes('id::text = $1'))
    ) {
      return params[0] === OBS_PRODUCT ? { rows: [testBrandSeedRow(destination)] } : { rows: [] };
    }
    if (s.includes('FROM pdp_identity_listing') && s.includes('merchant_id = $1') && s.includes('product_id = $2')) {
      return params[0] === OBS_MERCHANT && params[1] === OBS_PRODUCT ? { rows: [testBrandListingRow(destination)] } : { rows: [] };
    }
    if (
      s.includes('FROM pdp_identity_listing') &&
      (s.includes('sellable_item_group_id = $1') || s.includes('product_line_id = $1'))
    ) {
      return { rows: [testBrandListingRow(destination)] };
    }
    if (s.includes('FROM catalog_merchants') && s.includes('UNION ALL')) {
      return { rows: [{ merchant_id: OBS_MERCHANT, merchant_name: 'Test Brand' }] };
    }
    return { rows: [] };
  });
}

async function testBrandPdp(app, { metadata, payloadExtra = {} } = {}) {
  return request(app)
    .post('/agent/shop/v1/invoke')
    .send({
      operation: 'get_pdp_v2',
      payload: {
        product_ref: { merchant_id: OBS_MERCHANT, product_id: OBS_PRODUCT },
        include: ['offers'],
        ...payloadExtra,
      },
      ...(metadata ? { metadata } : {}),
    });
}

const testBrandOffer = (res) => offersOf(res).find((o) => o.merchant_id === OBS_MERCHANT);

afterEach(() => {
  process.env = ORIGINAL_ENV;
  global.fetch = ORIGINAL_FETCH;
  nock.cleanAll();
});

// THE GROUP LANE UNDER THE SERVING-CURRENCY GUARD (src/services/servingCurrencyGuard.js, src/server.js get_pdp_v2).
// The fixture above is tests/integration/get_pdp_v2_purchasability_gate_market.test.js's group page, its member
// offer (catalog_offer_v1) priced in CUR. The opened member's own offer is kept whatever its currency, and the
// card used to be re-priced from it (pickOfferForCanonicalPdpPrice fell back to every offer), so a US or
// market-less buyer was served that currency, with Buy, while the metadata said it was withheld. Once the guard
// withholds the page's money, that offer's money goes too and nothing re-prices the card.
function pageOf(res) {
  const pdp = (res.body.modules || []).find((m) => m.type === 'canonical')?.data?.pdp_payload || {};
  return {
    card: pdp.product?.price,
    actions: pdp.actions || [],
    offerPrices: offersOf(res).map((o) => o.price || null),
    guard: res.body?.metadata?.serving_currency_guard,
  };
}

describe('get_pdp_v2 currency guard: the group page is not re-priced from an off-market offer', () => {
  for (const [cur, metadata] of [['SGD', undefined], ['SGD', { market: 'US' }], ['GBP', undefined]]) {
    test(`${cur} member offer, ${metadata ? 'market US' : 'no market'}: unpriced, no Buy, no ${cur} money`, async () => {
      CUR = cur;
      const { app, db } = loadServer({ MERCHANT_PURCHASABILITY_GATE_ENABLED: 'false' });
      installOpsBackend({ enforced: false });
      installGroupDb(db, { destination: TEST_BRAND_PDP });
      const res = await testBrandPdp(app, { metadata });
      expect(res.status).toBe(200);
      const page = pageOf(res);
      expect(page.guard).toEqual({ withheld_currencies: [cur] });
      expect(page.card).toBeUndefined();
      expect(page.actions).toEqual([]);
      expect(page.offerPrices).toEqual([null]);
      expect(JSON.stringify({ card: page.card, actions: page.actions, offers: page.offerPrices })).not.toContain(cur);
    });
  }

  test('a USD card with an SGD member offer: only the offer is withheld, and the log line says scope offers', async () => {
    CUR = 'USD'; OFFER_CUR = 'SGD';
    try {
      const { app, db } = loadServer({ MERCHANT_PURCHASABILITY_GATE_ENABLED: 'false' });
      installOpsBackend({ enforced: false });
      installGroupDb(db, { destination: TEST_BRAND_PDP });
      const logger = require('../../src/logger');
      const info = jest.spyOn(logger, 'info');
      const res = await testBrandPdp(app, {});
      expect(res.status).toBe(200);
      expect(pageOf(res).guard).toEqual({ withheld_currencies: ['SGD'] });
      const lines = info.mock.calls.filter(([fields]) => fields?.event === 'pdp_currency_not_serving_market');
      expect(lines.map(([fields]) => fields)).toEqual([{
        event: 'pdp_currency_not_serving_market',
        scope: 'offers',
        serving_currency: 'USD',
        withheld_currencies: ['SGD'],
        merchant_id: expect.any(String),
        source_system: null,
      }]);
      info.mockRestore();
    } finally {
      OFFER_CUR = null;
    }
  });

  test('an offer in a third currency loses its money and is named in the guard too', async () => {
    CUR = 'SGD'; OFFER_CUR = 'JPY';
    try {
      const { app, db } = loadServer({ MERCHANT_PURCHASABILITY_GATE_ENABLED: 'false' });
      installOpsBackend({ enforced: false });
      installGroupDb(db, { destination: TEST_BRAND_PDP });
      const res = await testBrandPdp(app, {});
      expect(res.status).toBe(200);
      const page = pageOf(res);
      expect(page.guard).toEqual({ withheld_currencies: ['JPY', 'SGD'] });
      expect(page.offerPrices).toEqual([null]);
      expect(page.card).toBeUndefined();
    } finally {
      OFFER_CUR = null;
    }
  });

  // The card quotes no price of its own, so the guard has nothing of the card's to withhold: the member offer
  // is judged on its own, and it is not what prices the card (a US or market-less buyer used to get SGD 229.99
  // with Buy here, and no guard metadata at all).
  for (const metadata of [undefined, { market: 'US' }]) {
    test(`an unpriced card is not priced from an SGD member offer, ${metadata ? 'market US' : 'no market'}`, async () => {
      CUR = 'SGD'; CARD_PRICED = false;
      try {
        const { app, db } = loadServer({ MERCHANT_PURCHASABILITY_GATE_ENABLED: 'false' });
        installOpsBackend({ enforced: false });
        installGroupDb(db, { destination: TEST_BRAND_PDP });
        const res = await testBrandPdp(app, { metadata });
        expect(res.status).toBe(200);
        const page = pageOf(res);
        expect(page.guard).toEqual({ withheld_currencies: ['SGD'] });
        expect(page.card).toBeUndefined();
        expect(page.actions).toEqual([]);
        expect(page.offerPrices).toEqual([null]);
        expect(JSON.stringify(res.body.modules)).not.toContain('229.99');
      } finally {
        CARD_PRICED = true;
      }
    });
  }

  test('an unpriced card for an SG buyer is still priced from the SGD member offer', async () => {
    CUR = 'SGD'; CARD_PRICED = false;
    try {
      const { app, db } = loadServer({ MERCHANT_PURCHASABILITY_GATE_ENABLED: 'false' });
      installOpsBackend({ enforced: false });
      installGroupDb(db, { destination: TEST_BRAND_PDP });
      const res = await testBrandPdp(app, { metadata: { market: 'SG' } });
      expect(res.status).toBe(200);
      const page = pageOf(res);
      expect(page.guard).toBeUndefined();
      expect(page.card).toEqual(expect.objectContaining({ current: expect.objectContaining({ amount: 229.99, currency: 'SGD' }) }));
      expect(page.offerPrices).toEqual([{ amount: 229.99, currency: 'SGD' }]);
    } finally {
      CARD_PRICED = true;
    }
  });

  // The savings copy is money talk in the withheld currency ("save SGD 20 with card X"): it goes with the card's
  // money. For an SG buyer it stays, which shows the fixture carries it to the card. (A seed member's offer never
  // carries it: projectExternalSeedOfferPayload strips it when the offer is built.)
  const SAVINGS_COPY = {
    payment_offer_summary: { headline: 'Save SGD 20 with a partner card' },
    promotion_lines: ['SGD 20 off orders over SGD 200'],
  };
  const cardSavingsOf = (res) => {
    const pdp = (res.body.modules || []).find((m) => m.type === 'canonical')?.data?.pdp_payload || {};
    return Object.keys(SAVINGS_COPY).filter((k) => pdp.product && pdp.product[k] !== undefined);
  };
  for (const [market, expectGuard] of [[undefined, true], ['SG', false]]) {
    test(`savings copy on an SGD card: ${expectGuard ? 'withheld with the money' : 'kept for an SG buyer'}`, async () => {
      CUR = 'SGD'; SAVINGS = SAVINGS_COPY;
      try {
        const { app, db } = loadServer({ MERCHANT_PURCHASABILITY_GATE_ENABLED: 'false' });
        installOpsBackend({ enforced: false });
        installGroupDb(db, { destination: TEST_BRAND_PDP });
        const res = await testBrandPdp(app, { metadata: market ? { market } : undefined });
        expect(res.status).toBe(200);
        if (expectGuard) {
          expect(res.body?.metadata?.serving_currency_guard).toEqual({ withheld_currencies: ['SGD'] });
          expect(cardSavingsOf(res)).toEqual([]);
          expect(JSON.stringify(res.body.modules)).not.toContain('Save SGD 20');
        } else {
          expect(res.body?.metadata?.serving_currency_guard).toBeUndefined();
          expect(cardSavingsOf(res)).toEqual(Object.keys(SAVINGS_COPY));
        }
      } finally {
        SAVINGS = null;
      }
    });
  }

  test('SGD member offer for an SG buyer: priced in SGD, no guard', async () => {
    CUR = 'SGD';
    const { app, db } = loadServer({ MERCHANT_PURCHASABILITY_GATE_ENABLED: 'false' });
    installOpsBackend({ enforced: false });
    installGroupDb(db, { destination: TEST_BRAND_PDP });
    const res = await testBrandPdp(app, { metadata: { market: 'SG' } });
    expect(res.status).toBe(200);
    const page = pageOf(res);
    expect(page.guard).toBeUndefined();
    expect(page.offerPrices).toEqual([{ amount: 229.99, currency: 'SGD' }]);
  });
});
