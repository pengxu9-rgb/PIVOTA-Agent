// Regression for the 2026-10-04 production outage: get_discovery_feed returned
// catalog_status "unavailable" with zero products for every home/browse request
// that carried a storefront-recorded view. Inputs are the REAL producer shapes,
// captured from the public storefront proxy (see the fixture's _note): the
// browse_history entry pivota-agent-ui writes from a public PDP, the recent_view
// it sends, the canonical cards the reader maps, and each sig's listing taxonomy
// as its own PDP serves it.
jest.mock('../../src/db', () => ({ query: jest.fn() }));
const axios = require('axios');
const db = require('../../src/db');
const fixture = require('../fixtures/discovery_history_storefront_views_2026_10_04.json');
const { getDiscoveryFeed, buildDiscoveryProfile, _internals: i } = require('../../src/services/discoveryFeed');
const smoke = require('../../scripts/run_discovery_feed_smoke.cjs');

const { krave, judydoll, jurlique } = fixture.subjects;
const ANCHOR_SQL = 'AND apv.pivota_signature_id = ANY($2::text[])';
const fold = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// The SQL row the canonical readers receive for a captured card: a mirror
// (external_seed) listing, the card's stored brand and agent_pdp_view leaf,
// own offers by the card's offer sellers, the PDP listing merchant and the
// listing's own taxonomy (catalog_products.category_path).
function poolRow(entry, overrides = {}) {
  const productKey = 'listing_' + entry.product_id;
  return {
    pivota_signature_id: entry.product_id,
    content_key: 'ck_' + entry.product_id,
    external_product_key: productKey,
    external_product_id: productKey,
    external_brand: entry.brand,
    brand: entry.brand,
    title: entry.title,
    description: null,
    category_path: Array.isArray(entry.card_category_path) ? entry.card_category_path.join('/') : entry.card_category_path ?? null,
    listing_category_path: entry.listing_category_path ?? null,
    currency: 'USD',
    price_min: entry.price,
    offers: entry.offer_merchant_ids.map((merchantId) => ({ offer_id: 'of_' + entry.product_id, product_key: productKey,
      merchant_id: merchantId, market: 'US', currency: 'USD', price: entry.price, availability: 'in_stock' })),
    offer_count: entry.offer_merchant_ids.length,
    public_listing_merchant_ids: entry.pdp_merchant_id ? [entry.pdp_merchant_id] : [],
    ...overrides,
  };
}
const POOLS = Object.fromEntries(Object.entries(fixture.brand_pools).map(([key, rows]) => [key, rows.map((row) => poolRow(row))]));
const seed = fixture.smoke_seed_card;
const SEED_ROW = poolRow({ product_id: seed.product_id, brand: seed.brand, title: seed.title, card_category_path: seed.category_path,
  listing_category_path: null, offer_merchant_ids: seed.offer_merchant_ids, price: 6, pdp_merchant_id: seed.offer_merchant_ids[0] });
const rowOf = (subject) => Object.values(POOLS).flat().find((row) => row.pivota_signature_id === subject.recent_view.product_id);

// A cold canonical universe large enough that the no-history request itself is
// served by canonical_sig (its coverage threshold is 24 on home, 18 on browse).
function coldUniverse(base = Object.values(POOLS).flat(), size = 48) {
  return Array.from({ length: size }, (_, n) => {
    const row = base[n % base.length];
    if (n < base.length) return row;
    const signature = 'sig_' + String(n + 1).padStart(32, '0');
    return { ...row, pivota_signature_id: signature, content_key: 'ck_' + signature, external_product_key: 'listing_' + signature,
      title: row.title + ' ' + n };
  });
}

let env;
let calls;
// catalog: every row the anchor and brand readers may return; cold: the cold reader's rows.
function mockCatalog({ catalog = [...Object.values(POOLS).flat(), SEED_ROW], cold = coldUniverse(), anchorError = null, coldError = null } = {}) {
  calls = { anchor: 0, brand: 0, cold: 0 };
  db.query.mockImplementation(async (sql, params = []) => {
    if (sql.includes(ANCHOR_SQL)) {
      calls.anchor += 1;
      if (anchorError) throw anchorError;
      return { rows: catalog.filter((row) => params[1].includes(row.pivota_signature_id)) };
    }
    if (sql.includes('WITH brand_match')) {
      calls.brand += 1;
      const aliases = new Set((params[0] || []).map(fold));
      return { rows: catalog.filter((row) => aliases.has(fold(row.brand))) };
    }
    if (sql.includes('FROM agent_pdp_view apv')) {
      calls.cold += 1;
      if (coldError) throw coldError;
      return { rows: cold };
    }
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
const noSdk = () => { expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled(); };
const forgedKrave = () => ({ ...krave.recent_view, merchant_id: judydoll.recent_view.merchant_id });
async function outcome(promise) {
  try {
    const response = await promise;
    return { ok: true, products: response.products.map((p) => p.product_id), candidate_source: response.metadata.candidate_source,
      primary_path_used: response.metadata.primary_path_used, catalog_status: response.metadata.catalog_status ?? null,
      strategy: response.metadata.discovery_strategy };
  } catch (err) {
    return { ok: false, code: err.code, statusCode: err.statusCode };
  }
}

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
      expect(subject.browse_history_entry.merchant_id).toBe(subject.pdp.product_merchant_id);
      expect(subject.recent_view.merchant_id).toBe(subject.pdp.canonical_product_ref.merchant_id);
      const anchor = i.mapCanonicalIndexRowToProduct(rowOf(subject));
      expect(anchor.merchant_id).toBe(subject.canonical_card.merchant_id);
      expect(anchor.merchant_id).not.toBe(subject.recent_view.merchant_id);
    }
    // Jurlique's own offer seller differs from the listing merchant the PDP shows.
    expect(jurlique.canonical_card.offer_merchant_ids).not.toContain(jurlique.recent_view.merchant_id);
  });

  test('the observed production failure is recorded in the fixture', () => {
    const observed = fixture.observed_prod_gateway_1e225cc40;
    expect(observed.home_krave_view).toMatchObject({ products: 0, catalog_status: 'unavailable',
      canonical_sig: { failure_reason: 'canonical_history_subject_conflict' } });
    expect(observed.home_smoke_seed_view.canonical_sig.failure_reason).toBe('canonical_history_domain_conflict');
    expect(observed.home_no_history.products).toBeGreaterThan(0);
  });
});

describe('stored domain', () => {
  test('the agent_pdp_view leaf alone leaves most real rows unknown', () => {
    const unknown = Object.values(fixture.brand_pools).flat().filter((row) => !i.canonicalStoredDomain(row.card_category_path));
    expect(unknown.map((row) => row.title)).toEqual(expect.arrayContaining(['24 Carrot Retinal', 'Lavender Shampoo', 'Sheer Tinted Highlighter']));
  });

  test('the listing taxonomy the PDP serves maps every captured Krave, Jurlique and Judydoll row to beauty', () => {
    for (const row of Object.values(POOLS).flat()) {
      const product = { ...i.mapCanonicalIndexRowToProduct(row), stored_listing_category_path: row.listing_category_path };
      expect(i.canonicalHistoryProductDomain(product)).toBe('beauty');
    }
  });

  test.each([
    [null, null], [['Serum'], 'beauty'], ['Beauty Product', 'beauty'], [['gift-set'], null], [['Bronzer'], null],
    ['beauty/sets/gift-set', 'beauty'], ['fashion/dresses', 'apparel'], ['home/decor', 'home'],
  ])('canonicalStoredDomain(%p) = %p', (path, domain) => {
    expect(i.canonicalStoredDomain(path)).toBe(domain);
  });

  test('the history reads select the listing taxonomy, other reads do not', async () => {
    mockCatalog();
    const [anchor] = await i.fetchCanonicalSigBrowseCandidates({ limit: 1, signatureIds: [krave.recent_view.product_id] });
    expect(db.query.mock.calls[0][0]).toContain('AS listing_category_path');
    expect(anchor.stored_listing_category_path).toBe('beauty/skincare/treat/serum');
    await i.fetchCanonicalSigBrowseCandidates({ limit: 48 });
    expect(db.query.mock.calls[1][0]).not.toContain('listing_category_path');
    await i.fetchBrandScopedCanonicalCandidates({ brandAliases: ['KraveBeauty'], limit: 48, strictPublicSource: true });
    expect(db.query.mock.calls[2][0]).not.toContain('listing_category_path');
  });
});

describe('stored subject identity and personalization', () => {
  test('anchor SQL exposes public listing merchants only on the history read', async () => {
    mockCatalog();
    const [anchor] = await i.fetchCanonicalSigBrowseCandidates({ limit: 1, signatureIds: [krave.recent_view.product_id] });
    const anchorSql = db.query.mock.calls[0][0];
    expect(anchorSql).toContain('AS public_listing_merchant_ids');
    expect(anchorSql).toContain("listing_trust.serving_decision = 'public'");
    expect(anchor.history_subject_merchant_ids).toEqual(expect.arrayContaining([krave.pdp.product_merchant_id, krave.canonical_card.merchant_id]));
  });

  test.each([
    ['krave', 'home_hot_deals', 4], ['krave', 'browse_products', 6],
    ['jurlique', 'home_hot_deals', 4], ['jurlique', 'browse_products', 6],
    ['judydoll', 'home_hot_deals', 2],
  ])('a single storefront %s view personalizes on %s', async (name, surface, minimum) => {
    const subject = fixture.subjects[name];
    mockCatalog();
    // Judydoll has two siblings; home backfills a viewed item only into an underfilled page.
    const response = await feed([subject.recent_view], { surface, ...(name === 'judydoll' ? { limit: 2 } : {}) });
    expect(response.metadata.catalog_status).toBeUndefined();
    expect(response.metadata.candidate_source).toBe('canonical_sig_personalized');
    expect(response.metadata).not.toHaveProperty('fallback_reason');
    expect(response.metadata).not.toHaveProperty('history_fallback_reason');
    expect(response.products.length).toBeGreaterThanOrEqual(minimum);
    expect(response.products.every((p) => p.brand === subject.recent_view.brand)).toBe(true);
    expect(response.products.some((p) => p.product_id === subject.recent_view.product_id)).toBe(false);
    expect(response.products.every((p) => !('stored_listing_category_path' in p))).toBe(true);
    expect(calls.cold).toBe(0);
    noSdk();
  });

  test('a forged pairing (sig with a merchant it never had) is refused and served the cold feed', async () => {
    mockCatalog();
    const forged = forgedKrave();
    const request = i.normalizeDiscoveryRequest({ surface: 'home_hot_deals', limit: 6, context: { locale: 'en-US', recent_views: [forged] } });
    const primary = await i.loadCanonicalHistoryPrimary({ request, profile: buildDiscoveryProfile(request.context), limit: 48 });
    expect(primary.recallSummary[0].failure_reason).toBe('canonical_history_subject_conflict');

    const response = await feed([forged]);
    expect(response.products.length).toBeGreaterThanOrEqual(4);
    expect(response.metadata).toMatchObject({ candidate_source: 'canonical_sig', fallback_reason: 'canonical_history_subject_conflict',
      history_fallback_reason: 'canonical_history_subject_conflict', discovery_strategy: 'cold_start_curated' });
    expect(canonicalBreakdown(response)).toMatchObject({ successful: true, history_failure_reason: 'canonical_history_subject_conflict' });
    expect(calls.brand).toBe(0);
    noSdk();
  });

  test('a private listing merchant cannot vouch for the subject', async () => {
    mockCatalog({ catalog: [{ ...rowOf(krave), public_listing_merchant_ids: [], offers: [] }] });
    const request = i.normalizeDiscoveryRequest({ surface: 'home_hot_deals', limit: 6, context: { locale: 'en-US', recent_views: [krave.recent_view] } });
    const primary = await i.loadCanonicalHistoryPrimary({ request, profile: buildDiscoveryProfile(request.context), limit: 48 });
    expect(primary.recallSummary[0].failure_reason).toBe('canonical_history_subject_conflict');
  });

  test('an unclassifiable listing under an explicit history domain is still a conflict', async () => {
    mockCatalog({ catalog: POOLS.krave.map((row) => row.pivota_signature_id === krave.recent_view.product_id ? { ...row, listing_category_path: null } : row) });
    const response = await feed([krave.recent_view]);
    expect(response.metadata.fallback_reason).toBe('canonical_history_domain_conflict');
    expect(response.products.length).toBeGreaterThan(0);
  });
});

describe('fail soft for personalization only', () => {
  test('a one-product brand (the captured smoke seed) serves the cold feed as canonical_history_pool_empty', async () => {
    mockCatalog();
    const response = await feed([smoke.buildRecentView(seed)]);
    expect(response.metadata).toMatchObject({ candidate_source: 'canonical_sig', fallback_reason: 'canonical_history_pool_empty' });
    const steps = response.metadata.rank_debug.recall_summary.filter((step) => step.provider === 'canonical_sig');
    expect(steps[0]).toMatchObject({ label: 'canonical_sig_personalized_unresolved', history_failure_reason: 'canonical_history_pool_empty', status: null });
    noSdk();
  });

  test.each(['home_hot_deals', 'browse_products'])('the fallback is the no-history request on %s (wide cold universe)', async (surface) => {
    const forged = forgedKrave();
    mockCatalog();
    const fallback = await outcome(feed([forged], { surface }));
    mockCatalog();
    const cold = await outcome(feed([], { surface }));
    expect(cold.candidate_source).toBe('canonical_sig');
    expect(fallback.candidate_source).toBe(cold.candidate_source);
    expect(fallback.primary_path_used).toBe(cold.primary_path_used);
    expect(fallback.strategy).toBe(cold.strategy);
    // Same ranking; only the viewed sig is suppressed.
    expect(fallback.products).toEqual(cold.products.filter((id) => id !== forged.product_id).slice(0, fallback.products.length));
  });

  test.each([
    ['below the canonical threshold', { cold: Object.values(POOLS).flat().slice(0, 5) }],
    ['zero cold rows', { cold: [] }],
    ['a failing cold read', { coldError: Object.assign(Error('relation "agent_pdp_view" is broken'), { code: 'XX000' }) }],
  ])('with %s the fallback takes the same route as the no-history request', async (_name, coldSetup) => {
    const forged = forgedKrave();
    mockCatalog(coldSetup);
    const fallback = await outcome(feed([forged]));
    const fallbackHttp = axios.get.mock.calls.length + axios.post.mock.calls.length;
    axios.get.mockClear(); axios.post.mockClear(); i.resetProductsSearchBreaker();
    mockCatalog(coldSetup);
    const cold = await outcome(feed([]));
    const coldHttp = axios.get.mock.calls.length + axios.post.mock.calls.length;
    expect(cold.candidate_source).not.toBe('canonical_sig');
    expect(fallback).toEqual(cold);
    expect(fallbackHttp).toBe(coldHttp);
  });

  test('fallback browse pages 1-3 never repeat a card when the viewed sig is the no-history page-1 top card', async () => {
    const cold = coldUniverse();
    mockCatalog({ cold, catalog: cold });
    const noHistoryPageOne = await feed([], { surface: 'browse_products', page: 1, limit: 6 });
    const top = noHistoryPageOne.products[0];
    // A view of that top card under a merchant it never had: the subject is
    // refused and the request falls back to the no-history feed.
    const view = { ...krave.recent_view, product_id: top.product_id, brand: top.brand, title: top.title,
      merchant_id: judydoll.recent_view.merchant_id };
    const pages = [];
    for (const page of [1, 2, 3]) {
      mockCatalog({ cold, catalog: cold });
      const response = await feed([view], { surface: 'browse_products', page, limit: 6 });
      expect(response.metadata.fallback_reason).toBe('canonical_history_subject_conflict');
      pages.push(response.products.map((p) => p.product_id));
    }
    const all = pages.flat();
    const duplicates = all.filter((id, index) => all.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
    expect(all).toHaveLength(18);
    expect(all).not.toContain(top.product_id);
  });

  const STRESS = [
    ['statement timeout', () => Object.assign(Error('canceling statement due to statement timeout'), { code: '57014' })],
    ['pg query read timeout', () => Error('Query read timeout')],
    ['pool acquire timeout', () => Error('timeout exceeded when trying to connect')],
    ['too many connections', () => Object.assign(Error('sorry, too many clients already'), { code: '53300' })],
    ['connection terminated', () => Error('Connection terminated unexpectedly')],
    ['connection reset', () => Object.assign(Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['out of memory', () => Object.assign(Error('out of memory'), { code: '53200' })],
  ];
  const NOT_STRESS = [
    ['lock timeout', () => Object.assign(Error('canceling statement due to lock timeout'), { code: '55P03' })],
    ['lock-timeout cancel under 57014', () => Object.assign(Error('canceling statement due to lock timeout'), { code: '57014' })],
    ['user cancel', () => Object.assign(Error('canceling statement due to user request'), { code: '57014' })],
    ['idle in transaction', () => Object.assign(Error('terminating connection due to idle-in-transaction timeout'), { code: '25P03' })],
    ['an unrelated "timeout" word', () => Error('upstream timeout budget exceeded')],
    ['schema', () => Object.assign(Error('column "x" does not exist'), { code: '42703' })],
  ];

  test.each(STRESS)('a history anchor %s keeps the unavailable outcome without a second (cold) read', async (_name, make) => {
    mockCatalog({ anchorError: make() });
    await expect(feed([jurlique.recent_view])).rejects.toMatchObject({ code: 'DISCOVERY_CATALOG_UNAVAILABLE' });
    expect(calls.cold).toBe(0);
    noSdk();
  });

  test.each([STRESS[0], STRESS[2]])('a history BRAND-read %s keeps the unavailable outcome without a cold read', async (_name, make) => {
    mockCatalog();
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (sql.includes('WITH brand_match')) { calls.brand += 1; throw make(); }
      return base(sql, params);
    });
    await expect(feed([jurlique.recent_view])).rejects.toMatchObject({ code: 'DISCOVERY_CATALOG_UNAVAILABLE' });
    expect(calls.brand).toBe(1);
    expect(calls.cold).toBe(0);
    noSdk();
  });

  test('a non-stress brand-read failure still falls back to the cold feed', async () => {
    mockCatalog();
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (sql.includes('WITH brand_match')) throw Object.assign(Error('canceling statement due to lock timeout'), { code: '55P03' });
      return base(sql, params);
    });
    const response = await feed([jurlique.recent_view]);
    expect(response.metadata.fallback_reason).toBe('canonical_history_query_failed');
    expect(response.products.length).toBeGreaterThan(0);
  });

  test.each(NOT_STRESS)('a history anchor %s is not stress and falls back to the cold feed', async (_name, make) => {
    mockCatalog({ anchorError: make() });
    const response = await feed([jurlique.recent_view]);
    expect(response.metadata.history_fallback_reason).toBeTruthy();
    expect(response.products.length).toBeGreaterThan(0);
    expect(calls.cold).toBe(1);
  });

  test('stress classifier', () => {
    for (const [, make] of STRESS) expect(i.isDiscoveryDatabaseStressError(make())).toBe(true);
    for (const [, make] of NOT_STRESS) expect(i.isDiscoveryDatabaseStressError(make())).toBe(false);
  });

  test.each([
    ['not public', { catalog: [] }, 'canonical_history_subject_not_public'],
    ['currency', { catalog: [{ ...POOLS.jurlique[0], pivota_signature_id: jurlique.recent_view.product_id, currency: 'GBP' }] }, 'canonical_history_currency_mismatch'],
    ['item unavailable', { catalog: [{ ...rowOf(jurlique), offers: [], offer_count: 0, price_min: null }] }, 'canonical_history_item_unavailable'],
  ])('%s serves the cold feed with the reason recorded', async (_name, setup, reason) => {
    mockCatalog(setup);
    const response = await feed([jurlique.recent_view]);
    expect(response.products.length).toBeGreaterThanOrEqual(4);
    expect(response.metadata.fallback_reason).toBe(reason);
    expect(canonicalBreakdown(response).history_failure_reason).toBe(reason);
    noSdk();
  });

  test('failure-reason resolver', () => {
    expect(i.resolveCanonicalHistoryFailureReason({ recallSummary: [{ status: 200 }] })).toBeNull();
    expect(i.resolveCanonicalHistoryFailureReason({ recallSummary: [{ status: 200, eligibility_reason: 'canonical_history_pool_empty' }] })).toBe('canonical_history_pool_empty');
    expect(i.resolveCanonicalHistoryFailureReason({ recallSummary: [{ status: null, failure_reason: 'query_error' }] })).toBe('query_error');
    expect(i.resolveCanonicalHistoryFailureReason(null)).toBeNull();
  });
});

describe('release-gate smoke (runSmoke) against a local gateway on this code', () => {
  let server;
  let baseUrl;
  beforeAll(async () => {
    const app = require('../../src/server');
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
  const run = () => smoke.runSmoke({ baseUrl, endpoint: '/agent/shop/v1/invoke', timeoutMs: 20000 });

  test('passes on a genuinely personalized seed, skipping one-product brands', async () => {
    // Cold order: the captured one-product seed brand first, then Jurlique rows.
    const cold = [SEED_ROW, ...coldUniverse(POOLS.jurlique, 47)];
    mockCatalog({ cold, catalog: cold });
    const result = await run();
    expect(result.personalizedHome.topProducts.every((p) => p.product_id !== SEED_ROW.pivota_signature_id)).toBe(true);
    // The one-product seed brand was walked past, not used as the personalization seed.
    expect(console.log.mock.calls.some(([line]) => String(line).startsWith('SKIP seed') && String(line).includes(SEED_ROW.pivota_signature_id))).toBe(true);
    expect(result.personalizedHome.candidateSource).toBe('canonical_sig_personalized');
    expect(result.browsePageOne.candidateSource).toBe('canonical_sig_personalized');
    noSdk();
  });

  test('fails with a clear reason when no cold card has a multi-row brand', async () => {
    const solos = Array.from({ length: 48 }, (_, n) => ({ ...SEED_ROW, pivota_signature_id: 'sig_' + String(n + 1).padStart(32, '0'),
      content_key: 'ck_solo_' + n, external_product_key: 'solo_' + n, brand: 'Solo Brand ' + n, external_brand: 'Solo Brand ' + n,
      title: 'Solo Serum ' + n }));
    mockCatalog({ cold: solos, catalog: solos });
    await expect(run()).rejects.toThrow(/no multi-row brand to test personalization/);
  });

  test('a seed whose history refuses on domain fails the gate instead of passing on the cold feed', async () => {
    // Krave cards whose listing taxonomy says fashion while their text says beauty.
    const conflicted = coldUniverse(POOLS.krave).map((row) => ({ ...row, listing_category_path: 'fashion/dresses' }));
    mockCatalog({ cold: conflicted, catalog: conflicted });
    await expect(run()).rejects.toThrow(/fell back|candidate_source|discovery_strategy/);
  });

  test('seed helpers', () => {
    const response = { products: [{ merchant_id: 'm', product_id: 'a', title: 'A', brand: 'X' }, { merchant_id: 'm', product_id: 'b', title: 'B', brand: 'x' },
      { merchant_id: 'm', product_id: 'c', title: 'C', brand: 'Y' }] };
    expect(smoke.listSeedProducts(response).map((p) => p.product_id)).toEqual(['a', 'c']);
    expect(smoke.isExhaustedHistoryScope({ metadata: { fallback_reason: 'canonical_history_pool_empty', history_fallback_reason: 'canonical_history_pool_empty' } })).toBe(true);
    expect(smoke.isExhaustedHistoryScope({ metadata: { fallback_reason: 'canonical_history_domain_conflict', history_fallback_reason: 'canonical_history_domain_conflict' } })).toBe(false);
  });
});

describe('invoke route', () => {
  async function invoke(payload) {
    const app = require('../../src/server');
    const request = require('supertest');
    return request(app).post('/agent/shop/v1/invoke').send({ operation: 'get_discovery_feed', payload,
      metadata: { entry: 'plp', scope: { catalog: 'global', region: 'US', language: 'en-US' }, ui_source: 'shopping-agent-ui', source: 'shopping_agent', market: 'US' } });
  }

  test.each([
    ['krave', 'home_hot_deals'], ['judydoll', 'browse_products'], ['jurlique', 'home_hot_deals'],
  ])('a stored %s view on %s returns personalized products, never DISCOVERY_CATALOG_UNAVAILABLE', async (name, surface) => {
    const subject = fixture.subjects[name];
    mockCatalog();
    const res = await invoke({ surface, limit: 4, context: { locale: 'en-US', recent_views: [subject.recent_view] } });
    expect(res.status).toBe(200);
    expect(res.body.metadata?.catalog_status).not.toBe('unavailable');
    expect(res.body.metadata?.candidate_source).toBe('canonical_sig_personalized');
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.products.some((p) => p.product_id === subject.recent_view.product_id)).toBe(false);
    noSdk();
  });

  test('an empty history is unchanged: the cold canonical feed', async () => {
    mockCatalog();
    const res = await invoke({ surface: 'home_hot_deals', limit: 4, context: { locale: 'en-US', recent_views: [] } });
    expect(res.status).toBe(200);
    expect(res.body.metadata.candidate_source).toBe('canonical_sig');
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.metadata).not.toHaveProperty('history_fallback_reason');
    expect(calls.anchor).toBe(0);
  });
});
