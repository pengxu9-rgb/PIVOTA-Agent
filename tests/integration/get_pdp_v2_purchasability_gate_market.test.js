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
// The Mojawa observed-seller shape from get_pdp_v2_observed_seller_entry: a merch_obs_ seller
// whose only detail store is external_product_seeds, one approved + live identity listing, so
// `groupMembers.length > 0` and the offer is built by `buildOffersFromGroupMembers` (site 1) and
// then re-resolved before the offers stamp (site 3). The seed's DESTINATION is a Shopify cart
// permalink on the brand's own host (its canonical URL stays the PDP), so a decline is visible as
// the cart URL leaving every field — see expectDeclined.
// ---------------------------------------------------------------------------

const OBS_MERCHANT = 'merch_obs_022b65d47a58b87a';
const OBS_PRODUCT = 'mojawa_us_8129594163442';
const GROUP_SIG = 'sig_f5c76a8f7e9b00811b08b897';
const CONTENT_KEY = 'ck_a6dc8c29b854612edc1d71e7d90f8060';
const MOJAWA_HOST = 'mojawa.com';
const MOJAWA_PDP = 'https://mojawa.com/products/bone-conduction-headphone-wireless-waterproof';
const MOJAWA_CART = 'https://mojawa.com/cart/44012345678:1';

const norm = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();

// Nothing is quarantined in these fixtures; an empty survivor list would mean "every member is
// quarantined" and would empty the offer group.
function quarantineSurvivors(params) {
  const requested = JSON.parse(String((Array.isArray(params) ? params[0] : null) || '[]'));
  return [{ members: requested.map((m) => ({ merchant_id: m.merchant_id, product_id: m.product_id })) }];
}

function mojawaGroupRow() {
  return {
    product_key: `prod::${OBS_MERCHANT}::external_seed::${OBS_PRODUCT}`,
    merchant_id: OBS_MERCHANT,
    platform: 'external_seed',
    source_product_id: OBS_PRODUCT,
    product_title: 'HaptiFit Terra Bone Conduction Headphone',
    product_description: 'Bone conduction headphones for sport.',
    brand: 'Mojawa',
    category: 'electronics',
    product_type: 'Headphones',
    category_path: null,
    canonical_url: MOJAWA_PDP,
    product_image_url: 'https://cdn.example.com/haptifit.png',
    product_payload: { title: 'HaptiFit Terra Bone Conduction Headphone', brand: 'Mojawa', price_amount: 229.99, currency: 'USD' },
    pdp_lifecycle_stage: 'published',
    pivota_signature_id: 'sig_ca228ffe2b666f5c9e73a364c7bb30ba',
    pivota_canonical_url: null,
    pivota_signature_minted_at: '2026-07-10T00:00:00Z',
    content_key: CONTENT_KEY,
    updated_at: '2026-07-10T00:00:00Z',
    merchant_name: 'Mojawa',
    internal_product_group_id: 'pg_a6dc8c29b854612edc1d71e7d90f8060',
    is_primary: true,
    offer_count: 1,
  };
}

function mojawaSeedRow(destination) {
  return {
    id: `external_brand_crawl::${OBS_PRODUCT}`,
    external_product_id: OBS_PRODUCT,
    destination_url: destination,
    canonical_url: MOJAWA_PDP,
    domain: MOJAWA_HOST,
    title: 'HaptiFit Terra Bone Conduction Headphone',
    image_url: 'https://cdn.example.com/haptifit.png',
    price_amount: 229.99,
    price_currency: 'USD',
    availability: 'in_stock',
    attached_product_key: `prod::${OBS_MERCHANT}::external_seed::${OBS_PRODUCT}`,
    seed_data: { title: 'HaptiFit Terra Bone Conduction Headphone', brand: 'Mojawa', description: 'Bone conduction.', category: 'electronics' },
    updated_at: '2026-07-10T00:00:00Z',
    created_at: '2026-07-10T00:00:00Z',
    status: 'active',
  };
}

function mojawaListingRow(destination) {
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
    brand_norm: 'mojawa',
    match_basis: [],
    source_payload: {
      title: 'HaptiFit Terra Bone Conduction Headphone',
      brand: 'Mojawa',
      price: { amount: 229.99, currency: 'USD' },
      currency: 'USD',
      in_stock: true,
      destination_url: destination,
    },
    variant_axes: {},
    source_meta: {},
  };
}

function installMojawaGroupDb(db, { destination = MOJAWA_CART } = {}) {
  db.query.mockImplementation(async (sql, params = []) => {
    const s = norm(sql);
    if (s.includes('surviving_members AS')) return { rows: quarantineSurvivors(params) };
    if (s.includes(CANONICAL_ENTITY_GROUP_SQL_TAG)) return { rows: [mojawaGroupRow()] };
    if (s.includes('FROM catalog_products cp') && s.includes('LEFT JOIN index_pipeline_state ips')) {
      return {
        rows: [{
          content_key: CONTENT_KEY,
          product_key: `prod::${OBS_MERCHANT}::external_seed::${OBS_PRODUCT}`,
          source_system: 'external_product_seeds_mirror_v1',
          source_product_id: OBS_PRODUCT,
          pivota_signature_id: 'sig_ca228ffe2b666f5c9e73a364c7bb30ba',
          catalog_title: 'HaptiFit Terra Bone Conduction Headphone',
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
      return params[0] === OBS_PRODUCT ? { rows: [mojawaSeedRow(destination)] } : { rows: [] };
    }
    if (s.includes('FROM pdp_identity_listing') && s.includes('merchant_id = $1') && s.includes('product_id = $2')) {
      return params[0] === OBS_MERCHANT && params[1] === OBS_PRODUCT ? { rows: [mojawaListingRow(destination)] } : { rows: [] };
    }
    if (
      s.includes('FROM pdp_identity_listing') &&
      (s.includes('sellable_item_group_id = $1') || s.includes('product_line_id = $1'))
    ) {
      return { rows: [mojawaListingRow(destination)] };
    }
    if (s.includes('FROM catalog_merchants') && s.includes('UNION ALL')) {
      return { rows: [{ merchant_id: OBS_MERCHANT, merchant_name: 'Mojawa' }] };
    }
    return { rows: [] };
  });
}

async function mojawaPdp(app, { metadata, payloadExtra = {} } = {}) {
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

const mojawaOffer = (res) => offersOf(res).find((o) => o.merchant_id === OBS_MERCHANT);

afterEach(() => {
  process.env = ORIGINAL_ENV;
  global.fetch = ORIGINAL_FETCH;
  nock.cleanAll();
});

describe('get_pdp_v2 group-members lane: the UI’s metadata.market reaches the gate (sites 1 + 3)', () => {
  test('(a) UI metadata market US + enforcing + browse_only: the read is keyed on US and the offer is declined', async () => {
    const reads = installOpsBackend({ tierFor: () => 'browse_only' });
    const { app, db } = loadServer();
    installMojawaGroupDb(db);

    const res = await mojawaPdp(app, { metadata: uiMetadata() });

    expect(res.status).toBe(200);
    // EXACTLY the keyed read, and nothing market-less. Both sites ask the same (host, US) question;
    // the second is a cache hit, so one read is the whole wire. A site passing no market would add
    // a `?domain=` probe here (site 1) or answer from the enforcement flag (site 3 — see (b)).
    expect(reads).toEqual([keyedRead(MOJAWA_HOST, 'US')]);
    // Group-fused: the offer came through buildOffersFromGroupMembers, i.e. site 1 really ran.
    expect(offersOf(res).length).toBeGreaterThanOrEqual(1);
    expect(mojawaOffer(res).offer_source).toBe('group_fused');
    expectDeclined(res, mojawaOffer(res), MOJAWA_HOST, MOJAWA_CART);
    // The brand PDP is what is left to browse: the page's canonical product still links it.
    expect(res.body.modules[0].data.pdp_payload.product.canonical_url).toBe(MOJAWA_PDP);
  });

  test('(b) CONTROL: the same request with a purchase fact keeps its checkout URL', async () => {
    // Proves (a) is the GATE, not the fixture: the only thing that changed is the tier.
    //
    // This is also the test that catches a site that DROPS the market. A market-less site does
    // not read the fact at all — it declines from the enforcement flag, which the other site's
    // keyed read has just cached as `true` — so a purchase fact cannot save the offer.
    const reads = installOpsBackend({ tierFor: () => 'purchase' });
    const { app, db } = loadServer();
    installMojawaGroupDb(db);

    const res = await mojawaPdp(app, { metadata: uiMetadata() });

    expect(res.status).toBe(200);
    expect(reads).toEqual([keyedRead(MOJAWA_HOST, 'US')]);
    const offer = mojawaOffer(res);
    expect(offer.offer_source).toBe('group_fused');
    expectPurchasable(offer, MOJAWA_CART);
  });

  test('(c) NO market anywhere + enforcing: the read carries no market and the offer is declined as unkeyable', async () => {
    // TODAY'S BEHAVIOUR for every UI PDP that does not send metadata.market. The keyed fact
    // answers `purchase` on purpose: if anything defaulted a market, the offer would keep its URL.
    const reads = installOpsBackend({ tierFor: () => 'purchase' });
    const { app, db } = loadServer();
    installMojawaGroupDb(db);

    const res = await mojawaPdp(app, { metadata: uiMetadataWithoutMarket() });

    expect(res.status).toBe(200);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    for (const url of reads) expect(new URL(url).searchParams.has('market')).toBe(false);
    // Single-flight + a cached enforcement flag: ONE probe for the whole page.
    expect(reads).toEqual([probeRead(MOJAWA_HOST)]);
    expectDeclined(res, mojawaOffer(res), MOJAWA_HOST, MOJAWA_CART);
  });

  test('(c′) NO metadata at all behaves exactly like (c)', async () => {
    const reads = installOpsBackend({ tierFor: () => 'purchase' });
    const { app, db } = loadServer();
    installMojawaGroupDb(db);

    const res = await mojawaPdp(app);

    expect(res.status).toBe(200);
    expect(reads).toEqual([probeRead(MOJAWA_HOST)]);
    expectDeclined(res, mojawaOffer(res), MOJAWA_HOST, MOJAWA_CART);
  });

  test('(d) metadata.market "us" (lowercase) is keyed as US', async () => {
    const reads = installOpsBackend({ tierFor: () => 'browse_only' });
    const { app, db } = loadServer();
    installMojawaGroupDb(db);

    const res = await mojawaPdp(app, { metadata: uiMetadata({ market: 'us' }) });

    expect(res.status).toBe(200);
    expect(reads).toEqual([keyedRead(MOJAWA_HOST, 'US')]);
    expectDeclined(res, mojawaOffer(res), MOJAWA_HOST, MOJAWA_CART);
  });

  test.each([
    // A locale is not a market: "en-US" is not two letters, so it is not read as US.
    ['en-US'],
    // Two markets: which one is the buyer's is not ours to guess — never the first entry.
    ['US,SG'],
  ])('(d) metadata.market %p is UNKEYABLE — never keyed on US', async (market) => {
    // `purchase` for any keyed read, so a request mis-keyed on US would visibly keep its URL.
    const reads = installOpsBackend({ tierFor: () => 'purchase' });
    const { app, db } = loadServer();
    installMojawaGroupDb(db);

    const res = await mojawaPdp(app, { metadata: uiMetadata({ market }) });

    expect(res.status).toBe(200);
    expect(reads).toEqual([probeRead(MOJAWA_HOST)]);
    expect(reads.some((u) => u.includes('market='))).toBe(false);
    expectDeclined(res, mojawaOffer(res), MOJAWA_HOST, MOJAWA_CART);
  });

  test('(e) metadata.scope.region "US" with no market is UNKEYABLE — region is not a market fallback', async () => {
    // The UI's scope object carries a region slot. A buyer-market rule that read it would be a
    // new carrier nobody reviewed (and `region` is a scope filter, not where the buyer pays).
    const reads = installOpsBackend({ tierFor: () => 'purchase' });
    const { app, db } = loadServer();
    installMojawaGroupDb(db);

    const res = await mojawaPdp(app, {
      metadata: uiMetadataWithoutMarket({ scope: { catalog: 'global', region: 'US', language: null } }),
    });

    expect(res.status).toBe(200);
    expect(reads).toEqual([probeRead(MOJAWA_HOST)]);
    expectDeclined(res, mojawaOffer(res), MOJAWA_HOST, MOJAWA_CART);
  });

  test('CONTROL: with the backend NOT enforcing, the keyed read is still made on US and nothing is declined', async () => {
    // `enforced: false` means `tier` is browse_only for every merchant and is not consulted; this
    // pins that the market reaching the gate does not by itself change a page.
    const reads = installOpsBackend({ tierFor: () => 'browse_only', enforced: false });
    const { app, db } = loadServer();
    installMojawaGroupDb(db);

    const res = await mojawaPdp(app, { metadata: uiMetadata() });

    expect(res.status).toBe(200);
    expect(reads).toEqual([keyedRead(MOJAWA_HOST, 'US')]);
    expectPurchasable(mojawaOffer(res), MOJAWA_CART);
  });

  test('TODAY (open question, not a gate site): the declined host\'s cart URL still ships on the page-level product', async () => {
    // The gate strips the OFFERS module only. `modules[0].data.pdp_payload.product` is the seed's
    // own product record and keeps `external_redirect_url` / `destination_url` = the cart permalink
    // for a merchant the gate has just declined. Whether a client may treat that field as "buy
    // here" is not something this file can decide; it is pinned so the answer is a choice.
    installOpsBackend({ tierFor: () => 'browse_only' });
    const { app, db } = loadServer();
    installMojawaGroupDb(db);

    const res = await mojawaPdp(app, { metadata: uiMetadata() });

    expect(res.status).toBe(200);
    expectDeclined(res, mojawaOffer(res), MOJAWA_HOST, MOJAWA_CART);
    expect(stringsEqualTo(res.body, MOJAWA_CART).sort()).toEqual([
      '.modules.0.data.pdp_payload.product.destination_url',
      '.modules.0.data.pdp_payload.product.external_redirect_url',
    ]);
  });
});

// CARRIER PRECEDENCE through the real route: search.market, then payload.market, then
// metadata.market — the FIRST carrier that yields one ISO-2 market wins, and an unreadable one is
// skipped rather than decisive. The UI sends only metadata.market, so a metadata-first rewrite would
// pass every UI-shaped test above; these are the ones it cannot pass.
describe('get_pdp_v2: carrier precedence reaches the gate unchanged', () => {
  test.each([
    ['payload.search.market SG beats metadata.market US', { search: { market: 'SG' } }, 'SG'],
    ['payload.market SG beats metadata.market US', { market: 'SG' }, 'SG'],
    ['payload.search.market SG beats payload.market JP', { search: { market: 'SG' }, market: 'JP' }, 'SG'],
    ['an unreadable payload.search.market "USA" is skipped, not decisive', { search: { market: 'USA' } }, 'US'],
  ])('%s', async (_name, payloadExtra, expectedMarket) => {
    const reads = installOpsBackend({ tierFor: () => 'browse_only' });
    const { app, db } = loadServer();
    installMojawaGroupDb(db);

    const res = await mojawaPdp(app, { metadata: uiMetadata(), payloadExtra });

    expect(res.status).toBe(200);
    // The opened product's own offer is served whatever the buyer market's currency, so the page
    // has an offer to gate in every row.
    expect(mojawaOffer(res)).toBeTruthy();
    expect(reads).toEqual([keyedRead(MOJAWA_HOST, expectedMarket)]);
  });
});

// ---------------------------------------------------------------------------
// Fixture 2 — the SELF-OFFER FALLBACK with a SIBLING group (sites 2 and 3, independently).
//
// The "observed seller whose identity gate fails" shape from get_pdp_v2_observed_seller_entry:
// no group members, so the self-offer fallback runs; the catalog identity fails the gate
// (pending / review_required / not live-read) with a group id, so siblings are fetched and built
// by the SIBLING `buildOffersFromGroupMembers` (site 2). The self offer is NOT built by site 2 —
// it is gated only by the pre-stamp pass (site 3). The two sellers are on DIFFERENT hosts so each
// site's question is separately visible on the wire.
// ---------------------------------------------------------------------------

const SIB_OBS_MERCHANT = 'merch_obs_5c1d0e8a77b3f210';
const SIB_PRODUCT = 'brandy:41ba77e0c9d51236';
const SIB_GROUP_SIG = 'sig_bb22cc33dd44ee55ff660011';
const SIB_MEMBER_MERCHANT = 'merch_obs_9a0f2b6c4d8e1357';
const SIB_MEMBER_PRODUCT = 'brandy:772ac0e91f34d885';
const SELF_HOST = 'brandy.example';
const SELF_PDP = 'https://brandy.example/products/cream';
const SIB_HOST = 'brandy-depot.example';
const SIB_PDP = 'https://brandy-depot.example/products/barrier-cream';
// Both sellers' destinations are cart permalinks on their own hosts, for the reason given on
// expectDeclined; each canonical URL stays the product page.
const SELF_CART = 'https://brandy.example/cart/7788001:1';
const SIB_CART = 'https://brandy-depot.example/cart/5566001:1';

function installSiblingDb(db) {
  db.query.mockImplementation(async (sql, params = []) => {
    const s = norm(sql);
    if (s.includes('surviving_members AS')) return { rows: quarantineSurvivors(params) };
    // fetchApprovedLiveIdentityGroupMembersForOffers — identified by its exclude pair.
    if (s.includes('FROM pdp_identity_listing pil') && s.includes('NOT (pil.merchant_id = $2 AND pil.product_id = $3)')) {
      return {
        rows: [{
          source_listing_ref: `${SIB_MEMBER_MERCHANT}:${SIB_MEMBER_PRODUCT}`,
          merchant_id: SIB_MEMBER_MERCHANT,
          product_id: SIB_MEMBER_PRODUCT,
          source_kind: 'external_seed',
          source_tier: 'brand',
          // The sibling's own store link — the host site 2 must ask about.
          source_payload: { title: 'Brandy Barrier Cream', currency: 'USD', in_stock: true, destination_url: SIB_CART },
          variant_axes: {},
          platform: 'external_seed',
          merchant_name: 'Brandy Depot',
          catalog_title: 'Brandy Barrier Cream',
          catalog_brand: 'Brandy',
          catalog_canonical_url: SIB_PDP,
          catalog_image_url: null,
          catalog_electronics_meta: null,
          catalog_offer_id: null,
          catalog_sku_key: null,
          catalog_offer_currency: 'USD',
          catalog_offer_price: 29.0,
          catalog_offer_source_system: null,
          catalog_offer_source_ref: null,
        }],
      };
    }
    // resolveCatalogIdentityForProductRef: THE GATE FAILS for the addressed row.
    if (s.includes('FROM catalog_products cp') && s.includes('LEFT JOIN pdp_identity_listing pil') && s.includes('WHERE cp.merchant_id = $1')) {
      return {
        rows: [{
          merchant_id: params[0],
          platform: 'external_seed',
          source_product_id: params[1] || SIB_PRODUCT,
          product_key: `prod::${params[0]}::external_seed::${params[1] || SIB_PRODUCT}`,
          pivota_signature_id: SIB_GROUP_SIG,
          category: 'skincare',
          product_type: 'Cream',
          category_path: null,
          category_label_source: null,
          category_confidence: null,
          catalog_rating_value: null,
          catalog_rating_count: null,
          sellable_item_group_id: SIB_GROUP_SIG,
          product_line_id: null,
          review_family_id: null,
          identity_confidence: 0.71,
          match_basis: [],
          identity_status: 'pending',
          live_read_enabled: false,
          review_required: true,
        }],
      };
    }
    if (s.includes('FROM catalog_products cp') && s.includes('LEFT JOIN index_pipeline_state ips')) {
      return {
        rows: [{
          content_key: 'ck_brandy41ba77e0c9d51236',
          product_key: `prod::${SIB_OBS_MERCHANT}::external_seed::${SIB_PRODUCT}`,
          source_system: 'external_product_seeds_mirror_v1',
          source_product_id: SIB_PRODUCT,
          pivota_signature_id: SIB_GROUP_SIG,
          catalog_title: 'Brandy Barrier Cream',
          catalog_image_url: null,
          catalog_description: null,
          external_seed_product_family: null,
          catalog_image_urls_count: 1,
          sync_status: 'live',
          pdp_lifecycle_stage: 'published',
          serving_eligible: true,
          readiness_tier: 'serving',
          pipeline_stage: 'serving',
          blocker_code: null,
          blocker_detail: null,
          content_quality_score: 88,
          active_external_seed_source_match: true,
        }],
      };
    }
    if (
      s.includes('FROM external_product_seeds') &&
      s.includes("status = 'active'") &&
      (s.includes('external_product_id = $1') || s.includes('id::text = $1'))
    ) {
      if (params[0] !== SIB_PRODUCT) return { rows: [] };
      return {
        rows: [{
          id: `external_brand_crawl::${SIB_PRODUCT}`,
          external_product_id: SIB_PRODUCT,
          destination_url: SELF_CART,
          canonical_url: SELF_PDP,
          domain: SELF_HOST,
          title: 'Brandy Barrier Cream',
          image_url: 'https://cdn.example.com/brandy.png',
          price_amount: 31.5,
          price_currency: 'USD',
          availability: 'in_stock',
          attached_product_key: null,
          seed_data: { title: 'Brandy Barrier Cream', brand: 'Brandy', category: 'skincare' },
          updated_at: '2026-08-01T00:00:00Z',
          created_at: '2026-08-01T00:00:00Z',
          status: 'active',
        }],
      };
    }
    return { rows: [] };
  });
}

async function siblingPdp(app, metadata) {
  return request(app)
    .post('/agent/shop/v1/invoke')
    .send({
      operation: 'get_pdp_v2',
      payload: { product_ref: { merchant_id: SIB_OBS_MERCHANT, product_id: SIB_PRODUCT }, include: ['offers'] },
      ...(metadata ? { metadata } : {}),
    });
}

describe('get_pdp_v2 self-offer + sibling lane: the market reaches the sibling build (site 2) and the pre-stamp pass (site 3)', () => {
  test('self host browse_only, sibling host purchase: both reads keyed on US; self declined, sibling kept', async () => {
    const reads = installOpsBackend({ tierFor: (domain) => (domain === SELF_HOST ? 'browse_only' : 'purchase') });
    const { app, db } = loadServer();
    installSiblingDb(db);

    const res = await siblingPdp(app, uiMetadata());

    expect(res.status).toBe(200);
    // Site 2 asks about the sibling first (it builds before the self offer exists), site 3 about
    // both — the sibling's second ask is a cache hit. Nothing market-less.
    expect(reads).toEqual([keyedRead(SIB_HOST, 'US'), keyedRead(SELF_HOST, 'US')]);
    const offers = offersOf(res);
    const self = offers.find((o) => o.merchant_id === SIB_OBS_MERCHANT);
    const sibling = offers.find((o) => o.merchant_id === SIB_MEMBER_MERCHANT);
    expect(sibling).toBeTruthy();
    expectDeclined(res, self, SELF_HOST, SELF_CART);
    expectPurchasable(sibling, SIB_CART);
  });

  test('self host purchase, sibling host browse_only: self kept, sibling declined', async () => {
    // The mirror of the test above. A market-less site 3 would decline the SELF offer here from
    // the enforcement flag site 2's keyed read cached; a market-less site 2 would probe first.
    const reads = installOpsBackend({ tierFor: (domain) => (domain === SIB_HOST ? 'browse_only' : 'purchase') });
    const { app, db } = loadServer();
    installSiblingDb(db);

    const res = await siblingPdp(app, uiMetadata());

    expect(res.status).toBe(200);
    expect(reads).toEqual([keyedRead(SIB_HOST, 'US'), keyedRead(SELF_HOST, 'US')]);
    const offers = offersOf(res);
    const self = offers.find((o) => o.merchant_id === SIB_OBS_MERCHANT);
    const sibling = offers.find((o) => o.merchant_id === SIB_MEMBER_MERCHANT);
    expectPurchasable(self, SELF_CART);
    expectDeclined(res, sibling, SIB_HOST, SIB_CART);
  });

  test('NO market: the sibling build probes once, and both offers are declined as unkeyable', async () => {
    const reads = installOpsBackend({ tierFor: () => 'purchase' });
    const { app, db } = loadServer();
    installSiblingDb(db);

    const res = await siblingPdp(app, uiMetadataWithoutMarket());

    expect(res.status).toBe(200);
    expect(reads).toEqual([probeRead(SIB_HOST)]);
    const offers = offersOf(res);
    expectDeclined(res, offers.find((o) => o.merchant_id === SIB_OBS_MERCHANT), SELF_HOST, SELF_CART);
    expectDeclined(res, offers.find((o) => o.merchant_id === SIB_MEMBER_MERCHANT), SIB_HOST, SIB_CART);
  });
});

// ---------------------------------------------------------------------------
// Fixture 3 — the PRODUCT-INTEL doors (sites 4 and 5).
//
// The seed-routed seller-less shape from invoke.product_intel_seed_routed_seller_less: an ext_ id
// with no seller, answered by the seed store alone, so there are no group members and
// `buildProductIntelOffersDataForContext` builds the self offer and gates it on the market it was
// handed. Neither door serves its offers in the response body (intel is `available: false` here,
// coverage serves a draft), so the ops READ is the observable: it is the only place the market
// the door passed is visible end to end.
// ---------------------------------------------------------------------------

const SEED_ID = 'ext_seed_routed_seller_less_1';
const SEED_HOST = 'example.test';

function installSeedOnlyDb(db) {
  db.query.mockImplementation(async (sql, params) => {
    const text = String(sql || '');
    if (text.includes('FROM external_product_seeds') && text.includes('destination_url')) {
      if (String((Array.isArray(params) ? params[0] : '') || '') !== SEED_ID) return { rows: [] };
      return {
        rows: [{
          id: 'eps_seed_routed_seller_less_1',
          external_product_id: SEED_ID,
          status: 'active',
          canonical_url: 'https://example.test/products/seed-routed-probe',
          destination_url: 'https://example.test/products/seed-routed-probe',
          domain: SEED_HOST,
          title: 'Seed Routed Probe Cream',
          image_url: 'https://cdn.example.test/probe.png',
          price_amount: '58.00',
          price_currency: 'USD',
          availability: 'In Stock',
          seed_data: { brand: 'Probe Labs', description: 'A cream used only to pin the gate market.' },
        }],
      };
    }
    return { rows: [] };
  });
}

const INTEL_DOORS = [
  // site 4 — every member of PRODUCT_INTEL_AGENT_OPERATIONS shares the one call.
  ['get_product_intel_v1', { product_ref: { product_id: SEED_ID } }],
  ['get_product_feedback_v1', { product_ref: { product_id: SEED_ID } }],
  ['get_product_recommendation_intents_v1', { product_ref: { product_id: SEED_ID } }],
  // site 5 — the coverage door, one ref.
  ['prepare_pivota_insights_coverage_v1', { product_refs: [{ product_id: SEED_ID }], limit: 1 }],
];

describe('product-intel doors: the UI’s metadata.market reaches the offers gate (sites 4 + 5)', () => {
  test.each(INTEL_DOORS)('%s with UI metadata market US reads the fact keyed on US', async (operation, payload) => {
    const reads = installOpsBackend({ tierFor: () => 'browse_only' });
    const { app, db } = loadServer();
    installSeedOnlyDb(db);

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({ operation, payload, metadata: uiMetadata() });

    expect(res.status).toBe(200);
    expect(reads).toEqual([keyedRead(SEED_HOST, 'US')]);
  });

  test.each(INTEL_DOORS)('CONTROL: %s with NO market reads only the market-less probe', async (operation, payload) => {
    // Proves the door reaches the gate at all in this fixture, so the keyed test above cannot
    // pass merely because nothing was asked.
    const reads = installOpsBackend({ tierFor: () => 'browse_only' });
    const { app, db } = loadServer();
    installSeedOnlyDb(db);

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({ operation, payload, metadata: uiMetadataWithoutMarket() });

    expect(res.status).toBe(200);
    expect(reads).toEqual([probeRead(SEED_HOST)]);
  });
});

// ---------------------------------------------------------------------------
// offers.resolve (site 6) — NOT REACHABLE END TO END.
//
// handleInvokeRequest answers `operation === 'offers.resolve'` from `handleOffersResolveOperation`
// and RETURNS on every branch (response, 500 envelope, or the catch's no-offer failure) long before
// the `prioritizeOffersResolveResponseGated` call further down the same function. That call is
// dead code, and `handleOffersResolveOperation` itself never consults the gate: the cache-search
// upstream's offers are served verbatim. The first test pins today's behaviour so the gap is
// visible (and so a fix has a test to flip); the second pins what site 6 WOULD do at its narrowest
// real seam — the exact expression the site evaluates, with the real client on the wire.
// ---------------------------------------------------------------------------

const RESOLVE_HOST = 'gloss-shop.example';
const RESOLVE_CART = 'https://gloss-shop.example/cart/4511:1';

function resolveUpstreamBody() {
  return {
    status: 'success',
    offers: [{
      offer_id: 'of:internal_checkout:merch_gloss:7700001:1',
      merchant_id: 'merch_gloss',
      purchase_route: 'internal_checkout',
      checkout_url: RESOLVE_CART,
      price: { amount: 18, currency: 'USD' },
    }],
    offers_count: 1,
    mapping: {
      canonical_ref: 'pc:merch_gloss:shopify:7700001',
      canonical_product: { merchant_id: 'merch_gloss', platform: 'shopify', product_id: '7700001' },
    },
  };
}

describe('offers.resolve (site 6)', () => {
  // KNOWN GAP, written as the behaviour we WANT and marked `test.failing`: offers.resolve returns
  // from handleOffersResolveOperation (src/server.js, the early `operation === 'offers.resolve'`
  // branch) on every path, so the gated call further down the handler never runs — no ops read is
  // made and the cart URL is served under enforcement. When the door is gated this starts passing,
  // `test.failing` turns red, and the marker must be removed.
  test.failing('KNOWN GAP: offers.resolve keys the gate on the UI market and declines the offer', async () => {
    const reads = installOpsBackend({ tierFor: () => 'browse_only' });
    const { app } = loadServer({
      OFFERS_RESOLVE_SUBJECT_RETRY_MAX: '0',
      OFFERS_RESOLVE_CACHE_SEARCH_RETRY_MAX: '0',
      OFFERS_RESOLVE_CIRCUIT_FAILURE_THRESHOLD: '99',
    });
    // A bare numeric product id skips subject-resolve and goes straight to the cache search.
    const cacheScope = nock(API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body?.operation === 'offers.resolve')
      .reply(200, resolveUpstreamBody());

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        // The market in EVERY carrier the gate reads (payload.market, metadata.market) and in the
        // route's own documented slot (payload.offers.market): none of them can matter, because
        // the gate is never called.
        payload: { offers: { product: { product_id: '7700001' }, market: 'US' }, market: 'US' },
        metadata: uiMetadata(),
      });

    expect(res.status).toBe(200);
    expect(cacheScope.isDone()).toBe(true);
    expect(res.body.offers).toHaveLength(1);
    expect(reads).toEqual([keyedRead(RESOLVE_HOST, 'US')]);
    expect(checkoutUrlsOnHost(res.body, RESOLVE_HOST)).toEqual([]);
  });

  test('TODAY (the gap above, pinned so it cannot widen silently): no ops read, and the cart URL is served', async () => {
    const reads = installOpsBackend({ tierFor: () => 'browse_only' });
    const { app } = loadServer({
      OFFERS_RESOLVE_SUBJECT_RETRY_MAX: '0',
      OFFERS_RESOLVE_CACHE_SEARCH_RETRY_MAX: '0',
      OFFERS_RESOLVE_CIRCUIT_FAILURE_THRESHOLD: '99',
    });
    nock(API_BASE)
      .post('/agent/shop/v1/invoke', (body) => body?.operation === 'offers.resolve')
      .reply(200, resolveUpstreamBody());
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'offers.resolve',
        payload: { offers: { product: { product_id: '7700001' }, market: 'US' }, market: 'US' },
        metadata: uiMetadata(),
      });
    expect(res.status).toBe(200);
    expect(reads).toEqual([]);
    expect(res.body.offers[0].checkout_url).toBe(RESOLVE_CART);
  });

  test('SEAM: the expression site 6 evaluates keys the UI request on US and declines the offer', async () => {
    const reads = installOpsBackend({ tierFor: () => 'browse_only' });
    loadServer();
    // Required AFTER loadServer's resetModules, so this is the same fresh module graph (and the
    // same gate singleton) the server just built.
    const { offersGateBuyerMarket, prioritizeOffersResolveResponseGated } = require('../../src/offers/offersPriority');

    const uiPayload = { offers: { product: { product_id: '7700001' } } };
    const market = offersGateBuyerMarket(uiPayload, uiMetadata());
    expect(market).toBe('US');
    const out = await prioritizeOffersResolveResponseGated(resolveUpstreamBody(), { market });

    expect(reads).toEqual([keyedRead(RESOLVE_HOST, 'US')]);
    const [offer] = out.offers;
    expect(offer.offer_id).toBe('of:internal_checkout:merch_gloss:7700001:1');
    expect(Object.prototype.hasOwnProperty.call(offer, 'merchant_checkout_url')).toBe(false);
    expect(checkoutUrlsOnHost(out, RESOLVE_HOST)).toEqual([]);
    expect(offer.commerce_mode).toBe('links_out');
  });

  test('SEAM: offers.resolve’s own payload.offers.market is NOT a gate carrier', () => {
    // The route documents `{ offers: { product, market } }`; `offersGateBuyerMarket` reads
    // search.market, payload.market and metadata.market only. So even once site 6 is reachable, a
    // caller that puts its market ONLY in the route's own slot is unkeyable.
    loadServer();
    const { offersGateBuyerMarket } = require('../../src/offers/offersPriority');
    expect(offersGateBuyerMarket({ offers: { product: { product_id: '7700001' }, market: 'US' } }, {})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// find_products_multi — the /r seed-attribution mint carries the UI's market.
//
// Not a gate site, but the same caller and the same carrier: `seedAttributionMarket` (src/server.js,
// the find_products_multi send path) reads search.market, then payload.market, then
// metadata.market, and forwards it as `market` on the backend link mint. Fixture: the strict-surface
// ingredient-direct lane from invoke.find_products_multi_strict_surface — one seed card served from
// the seed table, nothing attributed yet, so exactly one mint call.
// ---------------------------------------------------------------------------

const MINT_BASE = 'http://pivota.test';

function fentySeedRow() {
  return {
    id: 'seed_fenty_niacinamide',
    market: 'US',
    tool: '*',
    destination_url: 'https://fentybeauty.com/products/watch-ya-tone-niacinamide-dark-spot-serum',
    canonical_url: 'https://fentybeauty.com/products/watch-ya-tone-niacinamide-dark-spot-serum',
    domain: 'fentybeauty.com',
    title: 'Watch Ya Tone Niacinamide Dark Spot Serum',
    image_url: 'https://cdn.example/fenty-watch-ya-tone.jpg',
    price_amount: 22,
    price_currency: 'USD',
    availability: 'in_stock',
    seed_data: {
      title: 'Watch Ya Tone Niacinamide Dark Spot Serum',
      description: 'Reviewed niacinamide serum external seed.',
      category: 'Serum',
      brand: 'Fenty Skin',
      reviewed_ingredient_ids: ['niacinamide'],
      variants: [{ id: 'seed_variant_default', title: 'Default Title', price: 22, availability: 'in_stock' }],
    },
    status: 'active',
    attached_product_key: null,
    created_at: '2026-03-23T00:00:00Z',
    updated_at: '2026-03-23T00:00:00Z',
  };
}

async function searchWithMint(metadata) {
  installOpsBackend();
  // The mint needs an INTERNAL key (PIVOTA_API_KEY, set by loadServer) — without one it refuses to
  // go out at all — and a nock'd base, since it travels over axios, not the stubbed fetch.
  const { app, db } = loadServer({
    PIVOTA_API_BASE: MINT_BASE,
    API_MODE: 'REAL',
    EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED: 'true',
  });
  db.query.mockImplementation(async (sql) => (
    String(sql || '').includes('FROM external_product_seeds') ? { rows: [fentySeedRow()] } : { rows: [] }
  ));
  const mintBodies = [];
  nock(MINT_BASE)
    .post('/agent/shop/v1/attribution/external-seed-links')
    .reply(200, (_uri, body) => {
      mintBodies.push(body);
      return { links: [] };
    });
  nock(MINT_BASE)
    .persist()
    .post('/agent/shop/v1/invoke')
    .reply(200, { status: 'success', success: true, products: [], total: 0, metadata: { query_source: 'cache_multi_intent' } });
  const res = await request(app)
    .post('/agent/shop/v1/invoke')
    .send({
      operation: 'find_products_multi',
      payload: { search: { query: 'niacinamide serum under €30', limit: 10, in_stock_only: true } },
      ...(metadata ? { metadata } : {}),
    });
  return { res, mintBodies };
}

describe('find_products_multi: the UI’s metadata.market reaches the seed-attribution mint', () => {
  test('UI metadata market US (no search.market) is forwarded as the mint market', async () => {
    const { res, mintBodies } = await searchWithMint(uiMetadata());
    expect(res.status).toBe(200);
    expect(res.body.products.some((p) => p.external_seed_id === 'seed_fenty_niacinamide')).toBe(true);
    expect(mintBodies).toHaveLength(1);
    expect(mintBodies[0]).toEqual(expect.objectContaining({ market: 'US', tool: 'find_products_multi' }));
  });

  test('CONTROL: with no market anywhere the mint carries market null', async () => {
    const { res, mintBodies } = await searchWithMint(uiMetadataWithoutMarket());
    expect(res.status).toBe(200);
    expect(mintBodies).toHaveLength(1);
    expect(mintBodies[0].market).toBeNull();
  });
});
