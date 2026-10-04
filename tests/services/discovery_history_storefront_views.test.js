// Regression for the 2026-10-04 production outage: get_discovery_feed returned
// catalog_status "unavailable" with zero products for every home/browse request
// that carried a storefront-recorded view. Inputs are the REAL producer shapes,
// captured from the public storefront proxy (see the fixture's _note): the
// browse_history entry pivota-agent-ui writes from a public PDP, the
// recent_view it sends, and the canonical card the reader maps for that sig.
jest.mock('../../src/db', () => ({ query: jest.fn() }));
const axios = require('axios');
const db = require('../../src/db');
const fixture = require('../fixtures/discovery_history_storefront_views_2026_10_04.json');
const { getDiscoveryFeed, buildDiscoveryProfile, _internals: i } = require('../../src/services/discoveryFeed');
const smoke = require('../../scripts/run_discovery_feed_smoke.cjs');

const { krave, judydoll, jurlique } = fixture.subjects;
const ANCHOR_SQL = 'AND apv.pivota_signature_id = ANY($2::text[])';

// The SQL row the canonical reader receives for a captured card: a mirror
// (external_seed) listing, no first-party row, the card's stored brand and
// category_path (TEXT), own offers by the card's offer sellers, and the public
// listing merchant the PDP showed (canonical_product_ref.merchant_id).
function rowFor(card, { title, price, listingMerchant, signature = card.product_id, brand = card.brand, categoryPath = card.category_path } = {}) {
  const productKey = card.external_product_key || 'key_' + signature;
  return {
    pivota_signature_id: signature,
    content_key: 'ck_' + signature,
    external_product_key: productKey,
    external_product_id: productKey,
    external_brand: brand,
    brand,
    title: title || 'Captured ' + signature,
    description: null,
    category_path: Array.isArray(categoryPath) ? categoryPath.join('/') : categoryPath ?? null,
    currency: 'USD',
    price_min: price,
    offers: (card.offer_merchant_ids || []).map((merchantId) => ({ offer_id: 'of_' + signature, product_key: productKey,
      merchant_id: merchantId, market: 'US', currency: 'USD', price, availability: 'in_stock' })),
    offer_count: (card.offer_merchant_ids || []).length,
    ...(listingMerchant ? { public_listing_merchant_ids: [listingMerchant] } : {}),
  };
}
const anchorFor = (subject) => rowFor(subject.canonical_card, { title: subject.recent_view.title,
  price: subject.browse_history_entry.price, listingMerchant: subject.pdp.canonical_product_ref.merchant_id });

// Captured Jurlique brand page (canonical cards, merch_obs listing offers).
const JURLIQUE_POOL = [
  ['sig_f6bb2d1156aaaaaaaaaaaaaaaaaaaaaa', 'Face Mist', 'Sweet Violet & Grapefruit Hydrating Mist', 44],
  ['sig_aac87f822aaaaaaaaaaaaaaaaaaaaaaa', 'Skincare Set', 'Skin Recovery Duo', 127],
  ['sig_3895bb0aa8aaaaaaaaaaaaaaaaaaaaaa', 'Gel Cleanser', 'Revitalising Cleansing Gel', 44],
  ['sig_110f5c5de4aaaaaaaaaaaaaaaaaaaaaa', 'Beauty Product', 'Lavender Pure Essential Oil', 31],
  ['sig_c46231d8eaaaaaaaaaaaaaaaaaaaaaaa', 'Beauty Product', 'Lavender Hydrating Mist', 48],
  ['sig_fd91dfb83eaaaaaaaaaaaaaaaaaaaaaa', 'Beauty Product', 'Rose Love Balm', 20],
  ['sig_ba68a1c261aaaaaaaaaaaaaaaaaaaaaa', 'Skincare Set', '8+2 Revitalizing Duo', 120],
  ['sig_a996276358aaaaaaaaaaaaaaaaaaaaaa', 'Skincare Tool', 'Cooling Facial Spoons', 15],
].map(([signature, leaf, title, price]) => rowFor({ ...jurlique.canonical_card, external_product_key: null,
  offer_merchant_ids: [jurlique.pdp.product_merchant_id] }, { signature, categoryPath: [leaf], title, price }));
// Captured Judydoll brand page: the viewed lip ink plus two unclassifiable leaves.
const JUDYDOLL_POOL = [
  rowFor(judydoll.canonical_card, { title: judydoll.recent_view.title, price: 13.99 }),
  rowFor({ ...judydoll.canonical_card, external_product_key: null }, { signature: 'sig_f15748a12c2929ca5ced9c263ff3c1b2', categoryPath: ['Bronzer'], title: 'Dual-Ended Contour Stick', price: 12.99 }),
  rowFor({ ...judydoll.canonical_card, external_product_key: null }, { signature: 'sig_d4f93c2b9b88ac7bd32f44d13ebe9d31', categoryPath: ['Highlighter'], title: 'Sheer Tinted Highlighter', price: 12.99 }),
];
// The cold canonical feed: captured cold-home cards (stored leaves), padded with
// the captured Jurlique cards so home/browse have a full page.
const COLD_POOL = [
  rowFor(fixture.smoke_seed_card, { title: fixture.smoke_seed_card.title, price: 6 }),
  ...JURLIQUE_POOL,
];

let env;
let calls;
function mockCatalog({ anchors = [], brandPool = [], cold = COLD_POOL, coldError = null } = {}) {
  calls = { anchor: 0, brand: 0, cold: 0 };
  db.query.mockImplementation(async (sql) => {
    if (sql.includes(ANCHOR_SQL)) { calls.anchor += 1; return { rows: anchors }; }
    if (sql.includes('WITH brand_match')) { calls.brand += 1; return { rows: brandPool }; }
    if (sql.includes('FROM agent_pdp_view apv')) { calls.cold += 1; if (coldError) throw coldError; return { rows: cold }; }
    return { rows: [] };
  });
}
const graphMustNotRun = () => { throw Error('relationship graph must not run'); };
const opts = { identityGraphRowsResolverFn: async () => [], relationshipGraphRecallFn: graphMustNotRun };
function feed(views, override = {}) {
  return getDiscoveryFeed({ surface: 'home_hot_deals', page: 1, limit: 6, debug: true,
    context: { locale: 'en-US', recent_views: views }, ...override }, opts);
}
const canonicalBreakdown = (response) => response.metadata.provider_breakdown.find((entry) => entry.provider === 'canonical_sig');

beforeEach(() => {
  env = { ...process.env };
  process.env.DATABASE_URL = 'postgres://synthetic-unused';
  process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';
  process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET = 'US';
  process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'https://synthetic-primary.invalid';
  process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'synthetic-local-only';
  db.query.mockReset();
  jest.spyOn(axios, 'get').mockRejectedValue(new Error('no legacy SDK HTTP may be dispatched'));
  jest.spyOn(axios, 'post').mockRejectedValue(new Error('no legacy SDK HTTP may be dispatched'));
  i.resetProductsSearchBreaker();
  i.resetBrowseCatalogCountCache();
});
afterEach(() => { jest.restoreAllMocks(); process.env = env; });

describe('captured producer shapes', () => {
  test('the storefront records the PDP listing merchant, which the canonical card does not carry', () => {
    for (const subject of [krave, judydoll, jurlique]) {
      // What agent-ui stores and what it sends are the PDP's product identity.
      expect(subject.browse_history_entry.merchant_id).toBe(subject.pdp.product_merchant_id);
      expect(subject.recent_view.merchant_id).toBe(subject.pdp.canonical_product_ref.merchant_id);
      // The canonical card maps the mirror listing to the shared seed convention.
      const anchor = i.mapCanonicalIndexRowToProduct(anchorFor(subject));
      expect(anchor.merchant_id).toBe(subject.canonical_card.merchant_id);
      expect(anchor.merchant_id).not.toBe(subject.recent_view.merchant_id);
    }
    // Jurlique's own offer seller differs from the listing merchant the PDP shows,
    // so offers alone cannot identify the recorded subject.
    expect(jurlique.canonical_card.offer_merchant_ids).not.toContain(jurlique.recent_view.merchant_id);
  });

  test('the observed production failure is recorded in the fixture', () => {
    const observed = fixture.observed_prod_gateway_1e225cc40;
    expect(observed.home_krave_view).toMatchObject({ products: 0, catalog_status: 'unavailable',
      canonical_sig: { failure_reason: 'canonical_history_subject_conflict' } });
    expect(observed.home_smoke_seed_view.canonical_sig.failure_reason).toBe('canonical_history_domain_conflict');
    expect(observed.home_no_history.products).toBeGreaterThan(0);
  });

  test('stored category paths map into the profile domain vocabulary', () => {
    expect(i.canonicalStoredDomain(krave.canonical_card.category_path)).toBeNull();
    expect(i.canonicalStoredDomain(judydoll.canonical_card.category_path)).toBe('beauty');
    expect(i.canonicalStoredDomain(fixture.smoke_seed_card.category_path)).toBe('beauty');
    expect(i.canonicalStoredDomain(jurlique.canonical_card.category_path)).toBeNull();
    expect(i.canonicalStoredDomain(jurlique.pdp.category_path)).toBe('beauty');
    expect(i.canonicalStoredDomain(['Bronzer'])).toBeNull();
    expect(i.canonicalStoredDomain('fashion/dresses')).toBe('apparel');
    expect(i.canonicalStoredDomain('home/decor')).toBe('home');
  });
});

describe('stored subject identity', () => {
  test('anchor SQL exposes public listing merchants only on the history read', async () => {
    mockCatalog({ anchors: [anchorFor(krave)] });
    const [anchor] = await i.fetchCanonicalSigBrowseCandidates({ limit: 1, signatureIds: [krave.recent_view.product_id] });
    const anchorSql = db.query.mock.calls[0][0];
    expect(anchorSql).toContain('AS public_listing_merchant_ids');
    expect(anchorSql).toContain("listing_trust.serving_decision = 'public'");
    expect(anchor.history_subject_merchant_ids).toEqual(expect.arrayContaining([krave.pdp.product_merchant_id, krave.canonical_card.merchant_id]));
    await i.fetchCanonicalSigBrowseCandidates({ limit: 48 });
    expect(db.query.mock.calls[1][0]).not.toContain('public_listing_merchant_ids');
  });

  test('a single storefront view of a mirror sig resolves and personalizes (Jurlique)', async () => {
    mockCatalog({ anchors: [anchorFor(jurlique)], brandPool: [anchorFor(jurlique), ...JURLIQUE_POOL] });
    const request = i.normalizeDiscoveryRequest({ surface: 'home_hot_deals', limit: 6, context: { locale: 'en-US', recent_views: [jurlique.recent_view] } });
    const primary = await i.loadCanonicalHistoryPrimary({ request, profile: buildDiscoveryProfile(request.context), limit: 48 });
    expect(primary.recallSummary[0]).toMatchObject({ status: 200 });
    expect(primary.recallSummary[0]).not.toHaveProperty('failure_reason');

    const response = await feed([jurlique.recent_view]);
    expect(response.metadata.catalog_status).toBeUndefined();
    expect(response.metadata.candidate_source).toBe('canonical_sig_personalized');
    expect(response.products.length).toBeGreaterThanOrEqual(4);
    expect(response.products.every((p) => p.brand === 'Jurlique')).toBe(true);
    expect(response.products.some((p) => p.product_id === jurlique.recent_view.product_id)).toBe(false);
    expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
  });

  test.each(['home_hot_deals', 'browse_products'])('the Krave repro view is never an unavailable catalog on %s', async (surface) => {
    mockCatalog({ anchors: [anchorFor(krave)], brandPool: [anchorFor(krave)] });
    const response = await feed([krave.recent_view], { surface });
    expect(response.metadata.catalog_status).toBeUndefined();
    expect(response.products.length).toBeGreaterThanOrEqual(surface === 'browse_products' ? 6 : 4);
    // The subject resolves; the history text says beauty ("KraveBeauty") while
    // the stored row has no category, so the reader refuses on domain and the
    // cold canonical feed is served with that reason.
    expect(response.metadata).toMatchObject({ candidate_source: 'canonical_sig', primary_path_used: 'canonical_sig',
      fallback_triggered: true, fallback_reason: 'canonical_history_domain_conflict',
      history_fallback_reason: 'canonical_history_domain_conflict', discovery_strategy: 'cold_start_curated' });
    expect(canonicalBreakdown(response)).toMatchObject({ successful: true,
      history_failure_reason: 'canonical_history_domain_conflict', history_fallback: 'canonical_sig_cold' });
    expect(calls.brand).toBe(0);
    expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
  });

  test.each(['home_hot_deals', 'browse_products'])('the Judydoll repro view resolves, and an exhausted stored scope serves the cold feed on %s', async (surface) => {
    mockCatalog({ anchors: [anchorFor(judydoll)], brandPool: JUDYDOLL_POOL });
    const response = await feed([judydoll.recent_view], { surface });
    expect(response.metadata.catalog_status).toBeUndefined();
    expect(response.products.length).toBeGreaterThan(0);
    expect(response.metadata.fallback_reason).toBe('canonical_history_pool_empty');
    expect(response.products.some((p) => p.product_id === judydoll.recent_view.product_id)).toBe(false);
    const steps = response.metadata.rank_debug.recall_summary.filter((step) => step.provider === 'canonical_sig');
    expect(steps.map((step) => step.label)).toEqual(['canonical_sig_personalized_unresolved', 'canonical_sig_browse']);
    expect(steps[0]).toMatchObject({ history_failure_reason: 'canonical_history_pool_empty', status: null });
    expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
  });

  test('a forged pairing (sig with a merchant it never had) is refused and served the cold feed', async () => {
    mockCatalog({ anchors: [anchorFor(krave)], brandPool: [anchorFor(krave)] });
    const forged = { ...krave.recent_view, merchant_id: judydoll.recent_view.merchant_id };
    const request = i.normalizeDiscoveryRequest({ surface: 'home_hot_deals', limit: 6, context: { locale: 'en-US', recent_views: [forged] } });
    const primary = await i.loadCanonicalHistoryPrimary({ request, profile: buildDiscoveryProfile(request.context), limit: 48 });
    expect(primary.recallSummary[0].failure_reason).toBe('canonical_history_subject_conflict');

    const response = await feed([forged]);
    expect(response.products.length).toBeGreaterThanOrEqual(4);
    expect(response.metadata).toMatchObject({ candidate_source: 'canonical_sig', fallback_reason: 'canonical_history_subject_conflict' });
    expect(canonicalBreakdown(response).history_failure_reason).toBe('canonical_history_subject_conflict');
    expect(response.products.every((p) => !String(p.brand).includes('Krave'))).toBe(true);
    expect(calls.brand).toBe(0);
    expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
  });

  test('a private listing merchant cannot vouch for the subject', async () => {
    // The anchor SQL only lists public live listings; a merchant absent from it is foreign.
    mockCatalog({ anchors: [{ ...anchorFor(krave), public_listing_merchant_ids: [] , offers: [] }] });
    const request = i.normalizeDiscoveryRequest({ surface: 'home_hot_deals', limit: 6, context: { locale: 'en-US', recent_views: [krave.recent_view] } });
    const primary = await i.loadCanonicalHistoryPrimary({ request, profile: buildDiscoveryProfile(request.context), limit: 48 });
    expect(primary.recallSummary[0].failure_reason).toBe('canonical_history_subject_conflict');
  });
});

describe('fail soft for personalization only', () => {
  test('the cold fallback equals the no-history cold feed (same products, cold strategy)', async () => {
    // A cold canonical pool large enough that the no-history request is itself
    // served by canonical_sig (below its threshold it uses the seed fastpath).
    const wideCold = Array.from({ length: 60 }, (_, n) => ({ ...COLD_POOL[n % COLD_POOL.length],
      pivota_signature_id: 'sig_' + String(n + 1).padStart(32, '0'), content_key: 'ck_wide_' + n,
      external_product_key: 'wide_' + n, title: COLD_POOL[n % COLD_POOL.length].title + ' ' + n }));
    mockCatalog({ anchors: [anchorFor(krave)], cold: wideCold });
    const fallback = await feed([krave.recent_view]);
    mockCatalog({ cold: wideCold });
    const cold = await feed([]);
    expect(cold.metadata.candidate_source).toBe('canonical_sig');
    expect(cold.metadata).not.toHaveProperty('history_fallback_reason');
    expect(canonicalBreakdown(cold)).not.toHaveProperty('history_failure_reason');
    expect(fallback.products.map((p) => p.product_id)).toEqual(cold.products.map((p) => p.product_id));
    expect(fallback.metadata.discovery_strategy).toBe(cold.metadata.discovery_strategy);
  });

  test('a history whose cold read also fails is still a catalog failure, not a silent empty page', async () => {
    mockCatalog({ anchors: [anchorFor(krave)], coldError: Object.assign(Error('canceling statement due to statement timeout'), { code: '57014' }) });
    await expect(feed([krave.recent_view])).rejects.toThrow();
    expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
  });

  test.each([
    ['not public', () => ({ anchors: [] }), 'canonical_history_subject_not_public'],
    ['currency', () => ({ anchors: [{ ...anchorFor(jurlique), currency: 'GBP' }] }), 'canonical_history_currency_mismatch'],
    ['item unavailable', () => ({ anchors: [{ ...anchorFor(jurlique), offers: [], offer_count: 0, price_min: null }] }), 'canonical_history_item_unavailable'],
  ])('%s serves the cold feed with the reason recorded', async (_name, setup, reason) => {
    mockCatalog(setup());
    const response = await feed([jurlique.recent_view]);
    expect(response.products.length).toBeGreaterThanOrEqual(4);
    expect(response.metadata.fallback_reason).toBe(reason);
    expect(canonicalBreakdown(response).history_failure_reason).toBe(reason);
    expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
  });

  test('the history step of a fallback never reads as a canonical failure', () => {
    expect(i.resolveCanonicalHistoryFailureReason({ recallSummary: [{ status: 200 }] })).toBeNull();
    expect(i.resolveCanonicalHistoryFailureReason({ recallSummary: [{ status: 200, eligibility_reason: 'canonical_history_pool_empty' }] })).toBe('canonical_history_pool_empty');
    expect(i.resolveCanonicalHistoryFailureReason({ recallSummary: [{ status: null, failure_reason: 'timeout' }] })).toBe('timeout');
    expect(i.resolveCanonicalHistoryFailureReason(null)).toBeNull();
  });
});

describe('release-gate smoke logic against this code', () => {
  // runSmoke's own steps, with the gate's own validator and expectations: the
  // seed is today's first cold card (Good Molecules, stored leaf 'Serum').
  async function runGateSteps({ brandPool }) {
    mockCatalog({ anchors: [rowFor(fixture.smoke_seed_card, { title: fixture.smoke_seed_card.title, price: 6 })], brandPool });
    const view = smoke.buildRecentView(fixture.smoke_seed_card);
    const context = { auth_state: 'authenticated', locale: 'en-US', recent_views: [view], recent_queries: [smoke.deriveRecentQuery(fixture.smoke_seed_card)] };
    const suppressedKey = `${view.merchant_id}::${view.product_id}`;
    const base = { discoveryStrategy: 'personalized_interest', personalizationSource: 'account_history',
      candidateSource: ['multi_provider', 'beauty_interest_mainline', 'beauty_interest_mainline+multi_provider', 'canonical_sig_personalized'],
      requireRankDebug: true, excludeProductKeys: [suppressedKey] };
    const home = await getDiscoveryFeed({ surface: 'home_hot_deals', page: 1, limit: 6, debug: true, context }, opts);
    const homeResult = smoke.validateDiscoveryResponse(home, smoke.resolvePersonalizedExpectations(home, { ...base, minProducts: 4,
      requiredRecallLabels: [['interest_pool', 'external_seed_pool_fastpath', 'beauty_interest_mainline', 'canonical_sig_personalized'],
        ['expansion_pool', 'external_seed_pool_fastpath', 'beauty_interest_mainline', 'canonical_sig_personalized']] }));
    const browse = await getDiscoveryFeed({ surface: 'browse_products', page: 1, limit: 6, debug: true, context }, opts);
    const browseResult = smoke.validateDiscoveryResponse(browse, smoke.resolvePersonalizedExpectations(browse, { ...base, minProducts: 6,
      requiredRecallLabels: [['browse_pool', 'expansion_pool', 'beauty_interest_mainline', 'canonical_sig_personalized']] }));
    return { homeResult, browseResult };
  }

  test('the seed that hit canonical_history_domain_conflict now personalizes and passes the gate', async () => {
    const siblings = JURLIQUE_POOL.map((row, n) => ({ ...row, brand: 'Good Molecules', external_brand: 'Good Molecules',
      category_path: n % 2 ? 'Serum' : 'Face Cream', title: 'Good Molecules ' + row.title }));
    const { homeResult, browseResult } = await runGateSteps({ brandPool: siblings });
    expect(homeResult.candidateSource).toBe('canonical_sig_personalized');
    expect(browseResult.candidateSource).toBe('canonical_sig_personalized');
    expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
  });

  test('the captured one-product brand passes the gate on the declared cold fallback', async () => {
    const { homeResult, browseResult } = await runGateSteps({ brandPool: [] });
    expect(homeResult).toMatchObject({ candidateSource: 'canonical_sig', historyColdFallbackReason: 'canonical_history_pool_empty' });
    expect(browseResult.historyColdFallbackReason).toBe('canonical_history_pool_empty');
  });

  test('a subject that fails to resolve still fails the gate', async () => {
    mockCatalog({ anchors: [] });
    const view = smoke.buildRecentView(fixture.smoke_seed_card);
    const response = await getDiscoveryFeed({ surface: 'home_hot_deals', page: 1, limit: 6, debug: true,
      context: { auth_state: 'authenticated', locale: 'en-US', recent_views: [view], recent_queries: [] } }, opts);
    expect(response.metadata.fallback_reason).toBe('canonical_history_subject_not_public');
    expect(() => smoke.validateDiscoveryResponse(response, smoke.resolvePersonalizedExpectations(response, {
      discoveryStrategy: 'personalized_interest', candidateSource: ['canonical_sig_personalized'], minProducts: 4,
    }))).toThrow(/candidate_source/);
  });
});

describe('invoke route', () => {
  // The storefront proxy forwards get_discovery_feed to this route.
  async function invoke(payload) {
    const app = require('../../src/server');
    const request = require('supertest');
    return request(app).post('/agent/shop/v1/invoke').send({ operation: 'get_discovery_feed', payload,
      metadata: { entry: 'plp', scope: { catalog: 'global', region: 'US', language: 'en-US' }, ui_source: 'shopping-agent-ui', source: 'shopping_agent', market: 'US' } });
  }

  test.each([
    ['krave', 'home_hot_deals'], ['judydoll', 'browse_products'], ['jurlique', 'home_hot_deals'],
  ])('a stored %s view on %s returns products, never DISCOVERY_CATALOG_UNAVAILABLE', async (name, surface) => {
    const subject = fixture.subjects[name];
    const brandPool = name === 'jurlique' ? [anchorFor(jurlique), ...JURLIQUE_POOL] : name === 'judydoll' ? JUDYDOLL_POOL : [anchorFor(krave)];
    mockCatalog({ anchors: [anchorFor(subject)], brandPool });
    const res = await invoke({ surface, limit: 4, context: { locale: 'en-US', recent_views: [subject.recent_view] } });
    expect(res.status).toBe(200);
    expect(res.body.metadata?.catalog_status).not.toBe('unavailable');
    expect(res.body.metadata?.error_code).toBeUndefined();
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.products.some((p) => p.product_id === subject.recent_view.product_id)).toBe(false);
    expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
  });

  test('an empty history is unchanged: the cold canonical feed', async () => {
    mockCatalog();
    const res = await invoke({ surface: 'home_hot_deals', limit: 4, context: { locale: 'en-US', recent_views: [] } });
    expect(res.status).toBe(200);
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.metadata).not.toHaveProperty('history_fallback_reason');
    expect(calls.anchor).toBe(0);
  });
});
