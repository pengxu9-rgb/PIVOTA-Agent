// BUYER_MARKET_OFFER_SCOPE (src/services/buyerMarketOfferScope.js): the scope itself, its wiring
// into the discovery feed's canonical readers and cache keys, the recommendation offers leg and the
// PDP member re-pick. Flag off = today on every surface; flag on + a US (or silent) buyer = today;
// flag on + an SG buyer = SGD offers and prices. The real-SQL halves are in
// tests/integration/buyer_market_offer_scope_postgres.test.js and
// tests/integration/seed_reader_serving_currency_postgres.test.js.

const FLAG = 'BUYER_MARKET_OFFER_SCOPE';

function withEnv(values, fn) {
  const prior = {};
  for (const [key, value] of Object.entries(values)) {
    prior[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

describe('buyerMarketOfferScope', () => {
  const scope = require('../src/services/buyerMarketOfferScope');

  test('flag off: no scope for anyone', () => withEnv({ [FLAG]: undefined }, () => {
    expect(scope.resolveBuyerMarketOfferScope('SG')).toBeNull();
    expect(scope.resolveOfferScopeCurrency('SGD')).toBeNull();
  }));

  test('flag on: only a single market priced in another currency than the deployment gets a scope', () => withEnv({ [FLAG]: 'on' }, () => {
    expect(scope.resolveBuyerMarketOfferScope('SG')).toEqual({ market: 'SG', currency: 'SGD' });
    expect(scope.resolveBuyerMarketOfferScope('sg')).toEqual({ market: 'SG', currency: 'SGD' });
    for (const silentOrUs of [null, undefined, '', 'US', 'us']) {
      expect(scope.resolveBuyerMarketOfferScope(silentOrUs)).toBeNull();
    }
    for (const unpriced of ['US,SG', 'en-US', 'ZZ', "SG'; DROP TABLE x; --"]) {
      expect(scope.resolveBuyerMarketOfferScope(unpriced)).toBeNull();
    }
    // Priceable but not served (acquisition markets): no scope, no currency.
    for (const acquired of ['JP', 'AU']) expect(scope.resolveBuyerMarketOfferScope(acquired)).toBeNull();
    expect(scope.resolveOfferScopeCurrency('JPY')).toBeNull();
    expect(scope.resolveOfferScopeCurrency('usd')).toBe('USD');
    expect(scope.resolveOfferScopeCurrency('SGD')).toBe('SGD');
    expect(scope.resolveOfferScopeCurrency(null)).toBeNull();
  }));

  test('BUYER_MARKET_OFFER_SCOPE_MARKETS decides which buyer markets are scoped', () => withEnv({ [FLAG]: 'on', [scope.MARKETS_ENV]: 'US' }, () => {
    expect(scope.resolveBuyerMarketOfferScope('SG')).toBeNull();
    expect(scope.resolveOfferScopeCurrency('SGD')).toBeNull();
  }));

  test('marketPricesFreshSql serves the summary only while its stamp is the row\'s refreshed_at', () => {
    expect(scope.marketPricesFreshSql('apv')).toBe(
      "CASE WHEN apv.market_prices_refreshed_at = apv.refreshed_at AND apv.market_prices->>'version' = '1' THEN apv.market_prices END",
    );
  });

  // The row shape the canonical readers SELECT, with agent_pdp_view.market_prices as
  // pivota-backend's build_market_prices writes it.
  const row = () => ({
    pivota_signature_id: 'sig_' + '1'.repeat(32),
    currency: 'USD', price_min: 45, price_max: 50, offer_count: 3,
    offers: [{ currency: 'USD', price: 45 }, { currency: 'USD', price: 50 }, { currency: 'SGD', price: 61 }],
    market_prices: JSON.stringify({
      version: 1,
      currencies: {
        USD: { price_min: 45, price_max: 50, offer_count: 2, offers: [{ currency: 'USD', price: 45 }, { currency: 'USD', price: 50 }] },
        SGD: { price_min: 61, price_max: 61, offer_count: 1, offers: [{ currency: 'SGD', price: 61 }] },
      },
    }),
  });

  test('applyMarketPricesToIndexRow reads the scoped market summary (jsonb as text or object)', () => {
    const scoped = scope.applyMarketPricesToIndexRow(row(), { market: 'SG', currency: 'SGD' });
    expect(scoped).toMatchObject({ currency: 'SGD', price_min: 61, price_max: 61, offer_count: 1, offers: [{ currency: 'SGD', price: 61 }] });
    const asObject = { ...row(), market_prices: JSON.parse(row().market_prices) };
    const { market_prices: _text, ...fromText } = scoped;
    const { market_prices: _object, ...fromObject } = scope.applyMarketPricesToIndexRow(asObject, { market: 'SG', currency: 'SGD' });
    expect(fromObject).toEqual(fromText);
  });

  test('applyMarketPricesToIndexRow leaves the row alone without a scope, a summary, or a matching entry', () => {
    const base = row();
    expect(scope.applyMarketPricesToIndexRow(base, null)).toBe(base);
    for (const marketPrices of [null, undefined, '{}', 'not json', JSON.stringify({ SG: { currency: 'SGD', price_min: 1 } }),
      JSON.stringify({ version: 2, currencies: { SGD: { price_min: 1 } } }), JSON.stringify({ version: 1, currencies: { USD: { price_min: 1 } } })]) {
      const r = { ...row(), market_prices: marketPrices };
      expect(scope.applyMarketPricesToIndexRow(r, { market: 'SG', currency: 'SGD' })).toBe(r);
    }
  });

  test('isMissingMarketPricesColumnError matches only the missing market_prices column', () => {
    expect(scope.isMissingMarketPricesColumnError({ code: '42703', message: 'column apv.market_prices does not exist' })).toBe(true);
    expect(scope.isMissingMarketPricesColumnError({ code: '42703', message: 'column apv.other does not exist' })).toBe(false);
    expect(scope.isMissingMarketPricesColumnError({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(false);
  });
});

describe('discovery feed wiring', () => {
  const makeSigRow = (index, overrides = {}) => ({
    content_key: `ck_${index}`,
    pivota_signature_id: `sig_${String(index).padStart(32, '0')}`,
    first_party_merchant_id: null, first_party_platform: null, first_party_source_product_id: null, first_party_product_key: null,
    external_product_id: `ext_${index}`, external_product_key: `external_seed:ext_${index}`, external_brand: 'Alpha',
    external_canonical_url: `https://alpha.example.com/catalog/${index}`, external_seed_id: `eps_${index}`,
    external_destination_url: `https://alpha.example.com/buy/${index}`,
    brand: 'Alpha', title: `Canonical Product ${index}`, image_url: `https://example.com/images/${index}.jpg`, image_urls: [],
    currency: 'USD', price_min: 24, price_max: 24, offer_count: 1,
    offers: [{ merchant_id: 'external_seed', market: 'US', currency: 'USD', price: 24, availability: 'in_stock' }],
    category_path: ['Beauty', 'Skincare'],
    ...overrides,
  });

  function loadInternals() {
    const calls = [];
    const mock = jest.fn((sql, params) => {
      const text = String(sql || '');
      calls.push({ sql: text, params });
      if (text.includes('FROM agent_pdp_view apv')) return Promise.resolve({ rows: Array.from({ length: 120 }, (_, n) => makeSigRow(n + 1)) });
      return Promise.resolve({ rows: [] });
    });
    jest.resetModules();
    jest.doMock('../src/db', () => ({ query: mock }));
    // eslint-disable-next-line global-require
    const { _internals } = require('../src/services/discoveryFeed');
    _internals.resetDiscoveryDependencyProbeCache();
    return { internals: _internals, calls };
  }

  const browseRequest = (internals, extra = {}) => internals.normalizeDiscoveryRequest({
    surface: 'browse_products', page: 1, limit: 60,
    context: { auth_state: 'anonymous', locale: 'en-US', recent_views: [], recent_queries: [] },
    ...extra,
  });

  const sigSqlFor = (extra, env) => withEnv({ DATABASE_URL: 'postgres://scope-test', DISCOVERY_BROWSE_USES_CANONICAL_SIG: 'true', ...env }, async () => {
    const { internals, calls } = loadInternals();
    await internals.loadCatalogCandidates({ request: browseRequest(internals, extra), profile: { hasInterestSignals: false }, limit: 120 });
    return calls.filter((call) => call.sql.includes('FROM agent_pdp_view apv')).map((call) => call.sql);
  });

  afterEach(() => {
    jest.dontMock('../src/db');
    jest.resetModules();
  });

  test('generic browse: flag off, and flag on for US/silent buyers, send the identical sig statement', async () => {
    const baseline = await sigSqlFor({}, { [FLAG]: undefined });
    expect(baseline).toHaveLength(1);
    expect(baseline[0]).toContain("co.market = 'US' AND co.currency = 'USD'");
    expect(await sigSqlFor({ buyer_market: 'SG' }, { [FLAG]: undefined })).toEqual(baseline);
    expect(await sigSqlFor({}, { [FLAG]: 'on' })).toEqual(baseline);
    expect(await sigSqlFor({ buyer_market: 'US' }, { [FLAG]: 'on' })).toEqual(baseline);
  });

  test('generic browse: flag on + SG buyer prices the strict own offers in SG/SGD', async () => {
    const [sql] = await sigSqlFor({ buyer_market: 'SG' }, { [FLAG]: 'on' });
    // Currency alone (older SGD rows are stored market 'US'), before the LIMIT as well as in the lateral.
    expect(sql).toContain("AND co.currency = 'SGD' AND co.availability = 'in_stock'");
    expect(sql).not.toContain("co.market =");
    expect(sql.indexOf('JOIN catalog_offers co ON co.product_key = own_cp.product_key')).toBeLessThan(sql.lastIndexOf('LIMIT $1'));
    expect(sql).toContain("'SGD' AS currency");
    expect(sql).not.toContain("'USD'");
  });

  test('pool cache keys split only for a scoped buyer', () => {
    const { internals } = loadInternals();
    const key = (extra, env) => withEnv(env, () => internals.buildDiscoveryContextCacheKey(browseRequest(internals, extra)));
    const brandKey = (extra, env) => withEnv(env, () => internals.buildBrandDirectPoolCacheKey({
      request: browseRequest(internals, extra), normalizedAliases: ['alpha'], safeLimit: 120,
    }));
    for (const build of [key, brandKey]) {
      const silent = build({}, { [FLAG]: undefined });
      expect(build({ buyer_market: 'SG' }, { [FLAG]: undefined })).toBe(silent);
      expect(build({}, { [FLAG]: 'on' })).toBe(silent);
      expect(build({ buyer_market: 'US' }, { [FLAG]: 'on' })).toBe(silent);
      expect(build({ buyer_market: 'SG' }, { [FLAG]: 'on' })).not.toBe(silent);
    }
  });

  test('scopeCanonicalHistoryProduct: US default unchanged, SG scope keeps only SG/SGD in-stock offers', () => {
    const { internals } = loadInternals();
    const product = {
      product_id: 'sig_x', currency: 'USD',
      offers: [{ market: 'US', currency: 'USD', availability: 'in_stock', price: 45 }, { market: 'SG', currency: 'SGD', availability: 'in_stock', price: 61 }],
    };
    expect(internals.scopeCanonicalHistoryProduct(product)).toMatchObject({ currency: 'USD', price: 45, offers_count: 1 });
    expect(internals.scopeCanonicalHistoryProduct(product, { market: 'SG', currency: 'SGD' })).toBeNull();
    expect(internals.scopeCanonicalHistoryProduct({ ...product, currency: 'SGD' }, { market: 'SG', currency: 'SGD' }))
      .toMatchObject({ currency: 'SGD', price: 61, offers: [{ currency: 'SGD' }] });
    // An SGD offer stored market 'US' (the column default) still counts for the SG buyer.
    const legacyMarket = { ...product, currency: 'SGD', offers: [{ market: 'US', currency: 'SGD', availability: 'in_stock', price: 52 }] };
    expect(internals.scopeCanonicalHistoryProduct(legacyMarket, { market: 'SG', currency: 'SGD' })).toMatchObject({ price: 52 });
    expect(internals.scopeCanonicalHistoryProduct({ ...legacyMarket, currency: 'USD', offers: [{ market: 'SG', currency: 'USD', availability: 'in_stock', price: 9 }] }))
      .toBeNull();
  });

  // The buyer-market fallback under the scope. The curated readers return a FEW SGD rows; an SG
  // page is built from ONE sequence -- every curated SGD row, then the market's pool minus any
  // product already kept -- sliced by page, so every pool row lands on exactly one page and
  // `total` is the same on every page.
  const card = (id, currency, extra = {}) => ({ merchant_id: 'external_seed', product_id: id, pivota_signature_id: id, title: id, currency, price: 20, ...extra });
  const fallbackRun = ({ flag, curated, pool, page = 1, limit = 24 }) => withEnv({ [FLAG]: flag ? 'on' : undefined }, async () => {
    const { internals } = loadInternals();
    const payload = { surface: 'browse_products', page, limit, buyer_market: 'SG',
      context: { auth_state: 'anonymous', locale: 'en-US', recent_views: [], recent_queries: [] } };
    // The curated feed as the caller built it for THIS page, and as a page-independent window.
    const response = { products: curated.slice((page - 1) * limit, page * limit), metadata: { candidate_source: 'canonical_sig' } };
    const buildCurated = jest.fn(async (p) => ({ products: curated.slice(0, p.limit), metadata: { candidate_source: 'canonical_sig', serving_mode: 'exhaustive' } }));
    const fetchRows = jest.fn(async () => ({ products: pool, recallSummary: [], skipped: null }));
    const buildOnce = jest.fn(async (p, options) => ({
      products: options.candidateProducts.slice((p.page - 1) * p.limit, p.page * p.limit),
      metadata: { eligible_pool_count: options.candidateProducts.length, serving_mode: 'exhaustive' },
    }));
    const out = await internals.applyBuyerMarketFallback({ response, payload, fetchRows, buildOnce, buildCurated });
    return { out, fetchRows, buildOnce, buildCurated };
  });

  test('flag off: today\'s rule -- any SGD row on the page skips the fallback', async () => {
    const { out, fetchRows, buildCurated } = await fallbackRun({ flag: false, curated: [card('sig_c0', 'SGD'), card('sig_c1', 'USD')], pool: [card('sig_p0', 'SGD')] });
    expect(fetchRows).not.toHaveBeenCalled();
    expect(buildCurated).not.toHaveBeenCalled();
    expect(out.products.map((p) => p.product_id)).toEqual(['sig_c0', 'sig_c1']);
  });

  // 2 curated SGD rows (+1 USD), and a 60-row pool in which three rows are the kept products under
  // another id scheme: the same signature, the same external_product_id, the same content_key.
  const curated = [
    card('sig_c0', 'SGD', { external_product_id: 'ext_c0', content_key: 'ck_c0' }),
    card('sig_c1', 'SGD', { external_product_id: 'ext_c1', content_key: 'ck_c1' }),
    card('sig_c2', 'USD'),
  ];
  const pool = [
    card('sig_c0', 'SGD'),
    { ...card('ext_pool_dup_ext', 'SGD', { external_product_id: 'ext_c1' }), merchant_id: 'merch_obs_pool', pivota_signature_id: undefined },
    { ...card('ext_pool_dup_ck', 'SGD', { content_key: 'ck_c0' }), merchant_id: 'merch_obs_pool', pivota_signature_id: undefined },
    ...Array.from({ length: 57 }, (_, n) => ({ ...card(`ext_pool_${n}`, 'SGD'), merchant_id: 'merch_obs_pool', pivota_signature_id: undefined })),
  ];
  const pages = async () => Promise.all([1, 2, 3, 4].map((page) => fallbackRun({ flag: true, curated, pool, page })));

  test('flag on: every kept row and every distinct pool row lands on exactly one page', async () => {
    const outs = (await pages()).map(({ out }) => out);
    const ids = outs.flatMap((out) => out.products.map((p) => p.product_id));
    expect(new Set(ids).size).toBe(ids.length); // nothing twice, across pages
    const expected = ['sig_c0', 'sig_c1', ...Array.from({ length: 57 }, (_, n) => `ext_pool_${n}`)];
    expect([...ids].sort()).toEqual([...expected].sort()); // nothing skipped (ext_pool_23 included)
    expect(ids.slice(0, 2)).toEqual(['sig_c0', 'sig_c1']); // kept rows lead page 1
    expect(outs.every((out) => out.products.every((p) => p.currency === 'SGD'))).toBe(true);
  });

  test('flag on: the page size is honoured with a pool larger than a page', async () => {
    const outs = (await pages()).map(({ out }) => out);
    expect(outs.map((out) => out.products.length)).toEqual([24, 24, 11, 0]);
    expect(outs.map((out) => out.page_size)).toEqual([24, 24, 11, 0]);
    expect(outs.map((out) => out.metadata.has_more)).toEqual([true, true, false, false]);
  });

  test('flag on: total counts unique products after dedupe, the same on every page', async () => {
    const outs = (await pages()).map(({ out }) => out);
    expect(outs.map((out) => out.total)).toEqual([59, 59, 59, 59]);
    expect(outs.map((out) => out.metadata.corpus_total_count)).toEqual([59, 59, 59, 59]);
    expect(outs[0].metadata.buyer_market_fallback).toMatchObject({
      applied: true, curated_rows_kept: 2, curated_rows_on_page: 2, pool_rows_on_page: 22, pool_rows_duplicating_kept: 3, curated_rows_dropped: 1,
    });
    expect(outs[0].metadata.candidate_source).toBe('buyer_market_curated+products_search');
    expect(outs[1].metadata.candidate_source).toBe('buyer_market_products_search');
  });

  test('flag on: both halves are built over the page-independent window', async () => {
    const { buildOnce, buildCurated } = await fallbackRun({ flag: true, curated, pool, page: 3 });
    for (const fn of [buildOnce, buildCurated]) {
      expect(fn.mock.calls[0][0]).toMatchObject({ page: 1, limit: 100, cursor: '' });
    }
  });

  test('flag on: a page the pool adds nothing to is labelled as curated, not as the fallback', async () => {
    const many = Array.from({ length: 30 }, (_, n) => card(`sig_k${n}`, 'SGD'));
    const [{ out: first }, { out: second }] = await Promise.all([1, 2].map((page) => fallbackRun({ flag: true, curated: many, pool: pool.slice(3, 13), page })));
    expect(first.products.map((p) => p.product_id)).toEqual(many.slice(0, 24).map((p) => p.product_id));
    expect(first.metadata.candidate_source).toBe('canonical_sig');
    expect(first.metadata).not.toHaveProperty('fallback_triggered');
    expect(first.metadata.buyer_market_fallback).toMatchObject({ applied: false, pool_rows_on_page: 0, curated_rows_on_page: 24 });
    expect(second.products).toHaveLength(16);
    expect(second.metadata).toMatchObject({ candidate_source: 'buyer_market_curated+products_search', fallback_triggered: true });
    expect([first.total, second.total]).toEqual([40, 40]);
  });

  // ---- round 3: totals bounded by the sequence, cursor paging, one assembly, error fallback ----
  const bigPool = Array.from({ length: 150 }, (_, n) => ({ ...card(`ext_big_${n}`, 'SGD'), merchant_id: 'merch_obs_pool', pivota_signature_id: undefined }));
  const threeKept = [card('sig_k0', 'SGD'), card('sig_k1', 'SGD'), card('sig_k2', 'SGD')];
  const sequenceHarness = ({ curatedRows = threeKept, poolRows = bigPool, curatedImpl = null } = {}) => {
    const { internals } = loadInternals();
    const calls = { curated: 0, pool: 0, fetch: 0 };
    const buildCurated = jest.fn(async (p, options) => {
      calls.curated += 1;
      if (curatedImpl) return curatedImpl(p, options);
      return { products: curatedRows.slice(0, p.limit), metadata: { candidate_source: 'canonical_sig', serving_mode: 'exhaustive' } };
    });
    const buildOnce = jest.fn(async (p, options) => {
      calls.pool += 1;
      return { products: options.candidateProducts.slice((p.page - 1) * p.limit, p.page * p.limit), metadata: { eligible_pool_count: options.candidateProducts.length, serving_mode: 'exhaustive' } };
    });
    const fetchRows = jest.fn(async () => { calls.fetch += 1; return { products: poolRows, recallSummary: [], skipped: null }; });
    const payloadFor = (extra) => ({ surface: 'browse_products', limit: 24, buyer_market: 'SG',
      context: { auth_state: 'anonymous', locale: 'en-US', recent_views: [], recent_queries: [] }, ...extra });
    const call = (extra, response = { products: [], metadata: {} }) => internals.applyBuyerMarketFallback({
      response, payload: payloadFor(extra), fetchRows, buildOnce, buildCurated,
    });
    return { internals, calls, call };
  };

  test('flag on: with a pool larger than the window, total is what can be shown and the last page says so', () => withEnv({ [FLAG]: 'on' }, async () => {
    const { call } = sequenceHarness();
    const pages = [];
    for (let page = 1; page <= 10; page += 1) {
      const out = await call({ page });
      pages.push(out);
      if (!out.metadata.has_more) break;
    }
    const shown = pages.flatMap((out) => out.products.map((p) => p.product_id));
    expect(shown).toHaveLength(103); // 3 kept + the 100-row pool window
    expect(new Set(shown).size).toBe(103);
    expect(pages.every((out) => out.total === 103)).toBe(true);
    expect(pages.every((out) => out.products.length > 0)).toBe(true); // no empty page while has_more
    const last = pages[pages.length - 1];
    expect([last.metadata.has_more, last.cursor_info.next_cursor]).toEqual([false, null]);
    expect(pages[0].metadata.buyer_market_fallback.pool_eligible_total).toBe(150);
  }));

  test('flag on: following next_cursor walks the same pages as page numbers', () => withEnv({ [FLAG]: 'on' }, async () => {
    const { call } = sequenceHarness();
    const byPage = [];
    for (let page = 1; page <= 10; page += 1) {
      const out = await call({ page });
      byPage.push(out.products.map((p) => p.product_id));
      if (!out.metadata.has_more) break;
    }
    const byCursor = [];
    let cursor = null;
    for (let step = 0; step < 10; step += 1) {
      const out = await call(cursor ? { page: 1, cursor } : { page: 1 });
      byCursor.push(out.products.map((p) => p.product_id));
      if (step === 0) {
        // Both offsets point at the first row page 1 did not show.
        const decoded = JSON.parse(Buffer.from(out.cursor_info.next_cursor.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        expect([decoded.offset, decoded.absolute_offset]).toEqual([24, 24]);
      }
      cursor = out.cursor_info.next_cursor;
      if (!cursor) break;
    }
    expect(byCursor).toEqual(byPage);
  }));

  test('flag on: concurrent SG requests share one assembly, and page 2 slices the cached sequence', () => withEnv({ [FLAG]: 'on' }, async () => {
    const { call, calls } = sequenceHarness();
    const [a, b] = await Promise.all([call({ page: 1 }), call({ page: 1 })]);
    expect(a.products).toEqual(b.products);
    expect(calls).toEqual({ curated: 1, pool: 1, fetch: 1 });
    const page2 = await call({ page: 2 });
    expect(calls).toEqual({ curated: 1, pool: 1, fetch: 1 });
    expect(page2.metadata.buyer_market_fallback.sequence_cache_hit).toBe(true);
    expect(page2.products[0].product_id).toBe('ext_big_21');
    // A US request never reads the SG entry (its context key carries no scope; it takes no scoped path).
    expect(await call({ page: 1, buyer_market: 'US' }, { products: [card('sig_us', 'USD')], metadata: {} }))
      .toEqual({ products: [card('sig_us', 'USD')], metadata: {} });
  }));

  test('flag on: a failing window build falls back to today\'s unscoped behaviour', () => withEnv({ [FLAG]: 'on' }, async () => {
    // The 100-row window times out; the request's own page (24) still builds.
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const { call } = sequenceHarness({
      curatedImpl: (p) => {
        if (p.limit === 100) throw timeout;
        return { products: [card('sig_c0', 'USD')], metadata: { candidate_source: 'canonical_sig' } };
      },
    });
    // No page built by the caller (getDiscoveryFeed's scoped path): it is built now, and today's
    // rule (no SGD row on it) sends it to the market pool.
    const out = await call({ page: 1 }, null);
    expect(out.metadata.candidate_source).toBe('buyer_market_products_search');
    expect(out.metadata.buyer_market_fallback.scoped_sequence_error).toEqual(expect.any(String));
    // With an SGD row on the caller's page: today's rule leaves it as built, and says why.
    const kept = await call({ page: 1 }, { products: [card('sig_c1', 'SGD')], metadata: {} });
    expect(kept.products.map((p) => p.product_id)).toEqual(['sig_c1']);
    expect(kept.metadata.buyer_market_scoped_sequence_error).toEqual(expect.any(String));
  }));

  // ---- round 4: the cache key is the full request; failed / partial builds are not kept ----
  test('the sequence key changes with every build input, and only paging and identity leave it alone', () => withEnv({ [FLAG]: 'on' }, () => {
    const { internals } = loadInternals();
    const basePayload = { surface: 'browse_products', page: 1, limit: 24, buyer_market: 'SG',
      context: { auth_state: 'anonymous', locale: 'en-US', recent_views: [], recent_queries: [] } };
    const keyOf = (payload, market = 'SG') => internals.scopedSequenceCacheKey(internals.normalizeDiscoveryRequest(payload), market);
    const baseKey = keyOf(basePayload);
    const longQuery = 'q'.repeat(130);
    const variants = {
      source_product_ref: { source_product_ref: { merchant_id: 'merch_obs_x', product_id: 'sig_' + 'a'.repeat(32) } },
      query: { query: { text: 'barrier cream' } },
      query_past_120_chars: [{ query: { text: `${longQuery}a` } }, { query: { text: `${longQuery}b` } }],
      brand: { scope: { brand_names: ['Example'] } },
      category: { scope: { categories: ['serum'] } },
      buyer_market: { buyer_market: 'JP' },
      response_detail: { response_detail: 'card' },
      sort: { sort: 'price_asc' },
      surface: { surface: 'home_hot_deals' },
      locale: { context: { ...basePayload.context, locale: 'en-SG' } },
      auth_state: { context: { ...basePayload.context, auth_state: 'authenticated' } },
      recent_queries: { context: { ...basePayload.context, recent_queries: ['toner'] } },
      recent_views: { context: { ...basePayload.context, recent_views: [{ merchant_id: 'm1', product_id: 'p1', title: 'x' }] } },
    };
    for (const [name, variant] of Object.entries(variants)) {
      const [left, right] = Array.isArray(variant) ? variant : [{}, variant];
      expect([name, keyOf({ ...basePayload, ...left })]).not.toEqual([name, keyOf({ ...basePayload, ...right })]);
    }
    // The scoped market itself is part of the key (not only the request's own copy of it).
    expect(keyOf(basePayload, 'JP')).not.toBe(baseKey);
    // Paging and identity select a page of the same sequence: same key.
    for (const same of [{ page: 3 }, { limit: 48 }, { request_id: 'req-123' }]) {
      expect(keyOf({ ...basePayload, ...same })).toBe(baseKey);
    }
  }));

  test('scopedWindowErrored: provider failures, failed recall and truncation are errors; a clean build is not', () => {
    const { internals } = loadInternals();
    expect(internals.scopedWindowErrored({ provider_breakdown: [{ provider: 'canonical_sig', successful: true, returned: 3 }] })).toBe(false);
    expect(internals.scopedWindowErrored({ provider_breakdown: [{ provider: 'canonical_sig', failure_reason: 'timeout' }] })).toBe(true);
    expect(internals.scopedWindowErrored({ provider_breakdown: [{ provider: 'canonical_sig', zero_recall_reason: 'provider_error' }] })).toBe(true);
    expect(internals.scopedWindowErrored({ recall_summary: [{ label: 'x', truncated_by_budget: true }] })).toBe(true);
    expect(internals.scopedWindowErrored(null)).toBe(false);
    // A provider absent from this deployment is configuration, not a transient failure.
    expect(internals.scopedWindowErrored({ provider_breakdown: [
      { provider: 'canonical_sig', successful: true, returned: 3 },
      { provider: 'external_seeds', skipped: true, skip_reason: 'schema_missing', failure_reason: 'schema_missing' },
    ] })).toBe(false);
  });

  test('flag on: a build over a failed curated read is served but not cached; the next request rebuilds', () => withEnv({ [FLAG]: 'on' }, async () => {
    let fail = true;
    const { call, calls } = sequenceHarness({
      curatedImpl: (p) => {
        if (fail) {
          fail = false;
          return { products: [], metadata: { candidate_source: 'canonical_sig', provider_breakdown: [{ provider: 'canonical_sig', failure_reason: 'timeout' }] } };
        }
        return { products: threeKept.slice(0, p.limit), metadata: { candidate_source: 'canonical_sig', serving_mode: 'exhaustive' } };
      },
    });
    const first = await call({ page: 1 });
    expect(first.metadata.buyer_market_fallback).toMatchObject({ curated_rows_kept: 0, sequence_cacheable: false });
    const second = await call({ page: 1 });
    expect(calls.curated).toBe(2);
    expect(second.products.slice(0, 3).map((p) => p.product_id)).toEqual(['sig_k0', 'sig_k1', 'sig_k2']);
    await call({ page: 2 });
    expect(calls.curated).toBe(2); // the clean build was kept
  }));

  test('flag on: an empty pool is not cached', () => withEnv({ [FLAG]: 'on' }, async () => {
    const { call, calls } = sequenceHarness({ poolRows: [] });
    await call({ page: 1 });
    await call({ page: 1 });
    expect(calls).toEqual({ curated: 2, pool: 0, fetch: 2 });
  }));

  test.each([
    ['an incomplete round', { complete: false }],
    ['hops still pending', { hops_pending: 2 }],
    ['a stale pool', { stale: true }],
  ])('flag on: a partial pool (%s) is not cached', (_name, partial) => withEnv({ [FLAG]: 'on' }, async () => {
    const { internals } = loadInternals();
    const fetchRows = jest.fn(async () => ({ products: bigPool, recallSummary: [], skipped: null, ...partial }));
    const buildCurated = jest.fn(async () => ({ products: threeKept, metadata: {} }));
    const buildOnce = jest.fn(async (_p, options) => ({ products: options.candidateProducts.slice(0, 100), metadata: {} }));
    const payload = { surface: 'browse_products', page: 1, limit: 24, buyer_market: 'SG',
      context: { auth_state: 'anonymous', locale: 'en-US', recent_views: [], recent_queries: [] } };
    for (let n = 0; n < 2; n += 1) await internals.applyBuyerMarketFallback({ response: null, payload, fetchRows, buildOnce, buildCurated });
    expect(fetchRows).toHaveBeenCalledTimes(2);
  }));

  test('flag on: a card changed in place by a caller never reaches the cached sequence', () => withEnv({ [FLAG]: 'on' }, async () => {
    const { call } = sequenceHarness();
    const first = await call({ page: 1 });
    first.products[0].price = 999;
    first.products[0].title = 'mutated';
    const again = await call({ page: 1 });
    expect(again.metadata.buyer_market_fallback.sequence_cache_hit).toBe(true);
    expect([again.products[0].price, again.products[0].title]).toEqual([20, 'sig_k0']);
  }));

  // ---- follow-ups after #2408: deep copies, recall health on non-debug requests ----
  test('flag on: a NESTED field changed in place by a caller never reaches the cached sequence', () => withEnv({ [FLAG]: 'on' }, async () => {
    const nested = threeKept.map((c) => ({ ...c, offers: [{ offer_id: `${c.product_id}_o1`, currency: 'SGD', price: 20 }], variants: [{ id: 'v1', price: 20 }] }));
    const { call } = sequenceHarness({ curatedRows: nested });
    const first = await call({ page: 1 });
    first.products[0].offers[0].price = 999;
    first.products[0].offers.push({ offer_id: 'injected', currency: 'USD', price: 1 });
    first.products[0].variants[0].price = 999;
    const again = await call({ page: 1 });
    expect(again.metadata.buyer_market_fallback.sequence_cache_hit).toBe(true);
    expect(again.products[0].offers).toEqual([{ offer_id: 'sig_k0_o1', currency: 'SGD', price: 20 }]);
    expect(again.products[0].variants).toEqual([{ id: 'v1', price: 20 }]);
  }));

  test('flag on: a curated window whose recall step failed is not cached, though it returned rows and is not a debug request', () => withEnv({ [FLAG]: 'on' }, async () => {
    let fail = true;
    const { call, calls } = sequenceHarness({
      curatedImpl: (p, options) => {
        // Rows came back and the breakdown looks healthy; only the build's observed recall shows a
        // truncated step -- what a non-debug request sees, since metadata.recall_summary is debug-only.
        if (fail) {
          fail = false;
          options.observeRecall({ recallSummary: [{ label: 'canonical_sig_page_2', truncated_by_budget: true, returned: 0 }],
            providerBreakdown: [{ provider: 'canonical_sig', successful: true, returned: 3 }] });
        } else if (typeof options.observeRecall === 'function') {
          options.observeRecall({ recallSummary: [{ label: 'canonical_sig_page_1', returned: 3 }],
            providerBreakdown: [{ provider: 'canonical_sig', successful: true, returned: 3 }] });
        }
        return { products: threeKept.slice(0, p.limit), metadata: { candidate_source: 'canonical_sig', serving_mode: 'exhaustive' } };
      },
    });
    const first = await call({ page: 1 });
    expect(first.metadata.buyer_market_fallback).toMatchObject({ curated_rows_kept: 3, sequence_cacheable: false });
    await call({ page: 1 });
    expect(calls.curated).toBe(2); // rebuilt, not inherited
    await call({ page: 2 });
    expect(calls.curated).toBe(2); // the clean build was kept
  }));

  test('flag on: a pool fetch with a failed recall step is not cached', () => withEnv({ [FLAG]: 'on' }, async () => {
    const { internals } = loadInternals();
    const fetchRows = jest.fn(async () => ({ products: bigPool, recallSummary: [{ label: 'hop_1', error: 'timeout' }], skipped: null }));
    const buildCurated = jest.fn(async () => ({ products: threeKept, metadata: {} }));
    const buildOnce = jest.fn(async (_p, options) => ({ products: options.candidateProducts.slice(0, 100), metadata: {} }));
    const payload = { surface: 'browse_products', page: 1, limit: 24, buyer_market: 'SG',
      context: { auth_state: 'anonymous', locale: 'en-US', recent_views: [], recent_queries: [] } };
    for (let n = 0; n < 2; n += 1) await internals.applyBuyerMarketFallback({ response: null, payload, fetchRows, buildOnce, buildCurated });
    expect(fetchRows).toHaveBeenCalledTimes(2);
  }));

  test('scopedWindowErrored reads the observed recall: a failed step behind a healthy breakdown is an error', () => {
    const { internals } = loadInternals();
    const healthy = { provider_breakdown: [{ provider: 'canonical_sig', successful: true, returned: 3 }] };
    expect(internals.scopedWindowErrored(healthy, { recallSummary: [{ label: 'p1', returned: 3 }] })).toBe(false);
    expect(internals.scopedWindowErrored(healthy, { recallSummary: [{ label: 'p2', error: 'ECONNRESET' }] })).toBe(true);
    expect(internals.scopedWindowErrored(healthy, { providerBreakdown: [{ provider: 'canonical_sig', failure_reason: 'query_error' }] })).toBe(true);
    expect(internals.scopedWindowErrored(healthy, { providerBreakdown: [{ provider: 'external_seeds', failure_reason: 'schema_missing' }] })).toBe(false);
  });

  test('getDiscoveryFeed: a scoped SG request does not build its own page before the sequence', () => withEnv({
    [FLAG]: 'on', DATABASE_URL: 'postgres://scope-test', DISCOVERY_BROWSE_USES_CANONICAL_SIG: 'true',
  }, async () => {
    let sigQueries = 0;
    jest.resetModules();
    jest.doMock('../src/db', () => ({ query: jest.fn(async (sql) => {
      if (String(sql).includes('FROM agent_pdp_view apv')) sigQueries += 1;
      return { rows: [] };
    }) }));
    // eslint-disable-next-line global-require
    const feed = require('../src/services/discoveryFeed');
    const payload = { surface: 'browse_products', page: 1, limit: 24, buyer_market: 'SG',
      context: { auth_state: 'anonymous', locale: 'en-US', recent_views: [], recent_queries: [] } };
    expect(feed._internals.isScopedBuyerMarketRequest(payload)).toBe(true);
    expect(feed._internals.isScopedBuyerMarketRequest({ ...payload, buyer_market: 'US' })).toBe(false);
    await feed.getDiscoveryFeed(payload);
    expect(sigQueries).toBe(1); // the window build only
    jest.dontMock('../src/db');
  }));

  test('flag on: with no pool rows the page is the kept rows alone', async () => {
    const { out } = await fallbackRun({ flag: true, curated, pool: [] });
    expect(out.products.map((p) => p.product_id)).toEqual(['sig_c0', 'sig_c1']);
    expect(out.total).toBe(2);
    expect(out.metadata.buyer_market_fallback).toMatchObject({ applied: false, rows: 0 });
  });
});

describe('recommendation offers leg', () => {
  const { catalogProductPricedOnlyInCurrencySql } = require('../src/services/seedSearchOfferScope');

  test('default is the strict single-currency rule; the option adds the buyer-currency escape', () => {
    const strict = catalogProductPricedOnlyInCurrencySql('h', '$1');
    expect(strict).not.toContain('o_own');
    expect(catalogProductPricedOnlyInCurrencySql('h', '$1', { allowOtherCurrencyOffers: false })).toBe(strict);
    const relaxed = catalogProductPricedOnlyInCurrencySql('h', '$1', { allowOtherCurrencyOffers: true });
    expect(relaxed).toContain("upper(trim(coalesce(o_own.currency, ''))) = $1");
    // The seed legs (which price the card) are untouched.
    expect(relaxed.split('external_product_seeds eps_cur').length).toBe(strict.split('external_product_seeds eps_cur').length);
  });

  const catalogSqlFor = (env, servingCurrency) => withEnv({ DATABASE_URL: 'postgres://scope-test', ...env }, async () => {
    const statements = [];
    const run = jest.fn(async (sql) => { statements.push(String(sql)); return { rows: [] }; });
    jest.resetModules();
    jest.doMock('../src/db', () => ({ query: run, queryWithStatementTimeout: run }));
    // eslint-disable-next-line global-require
    const { _internals } = require('../src/services/RecommendationEngine');
    await _internals.fetchCatalogCandidates({ categoryPathHint: 'beauty/skincare/serum', sourceMerchantHint: 'external_seed', limit: 20, servingCurrency });
    jest.dontMock('../src/db');
    return statements.filter((sql) => sql.includes('currency_head'));
  });

  test('fetchCatalogCandidates uses the relaxed leg only under the flag', async () => {
    const off = await catalogSqlFor({ [FLAG]: undefined }, 'USD');
    expect(off).toHaveLength(1);
    expect(off[0]).not.toContain('o_own');
    for (const currency of ['USD', 'SGD']) {
      const [on] = await catalogSqlFor({ [FLAG]: 'on' }, currency);
      expect(on).toContain('o_own');
    }
  });
});

describe('PDP group member re-pick', () => {
  let debug;
  beforeAll(() => {
    // eslint-disable-next-line global-require
    debug = require('../src/server')._debug;
  });
  const member = (currency, extraPayload = {}) => ({
    merchant_id: 'merch_obs_a', product_id: 'ext_a',
    source_payload: { price: { amount: 45, currency }, price_amount: 45, currency, catalog_offer_v1: { offer_id: 'of_1', sku_key: 'sku_a' }, ...extraPayload },
  });
  const sgdRow = { picked_sku_key: 'sku_a', offer_id: 'of_2', sku_key: 'sku_a', currency: 'SGD', price: '61.00', source_system: 'retailer_ingest', source_ref: 'https://store.example.com/p' };

  test('flag off: members returned as is, no statement', () => withEnv({ [FLAG]: undefined }, async () => {
    const members = [member('USD')];
    const queryFn = jest.fn();
    expect(await debug.rescopeGroupMemberOffersToCurrency(members, 'SGD', { queryFn })).toBe(members);
    expect(queryFn).not.toHaveBeenCalled();
  }));

  test('flag on: re-prices a mismatched member; leaves members with variants, no ref, or no row', () => withEnv({ [FLAG]: 'on' }, async () => {
    const queryFn = jest.fn(async () => ({ rows: [sgdRow] }));
    const withVariants = member('USD', { variants: [{ id: 'v1', price: 45, currency: 'USD' }] });
    const noRef = { ...member('USD'), source_payload: { currency: 'USD', price_amount: 45 } };
    const [swapped, keptVariants, keptNoRef] = await debug.rescopeGroupMemberOffersToCurrency([member('USD'), withVariants, noRef], 'SGD', { queryFn });
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][1]).toEqual([['sku_a'], 'SGD']);
    expect(swapped.source_payload).toMatchObject({ currency: 'SGD', price_amount: 61, price: { amount: 61, currency: 'SGD' }, catalog_offer_v1: { offer_id: 'of_2' } });
    expect(keptVariants).toBe(withVariants);
    expect(keptNoRef).toBe(noRef);
    const none = jest.fn(async () => ({ rows: [] }));
    const [kept] = await debug.rescopeGroupMemberOffersToCurrency([member('USD')], 'SGD', { queryFn: none });
    expect(kept.source_payload.currency).toBe('USD');
  }));

  test('flag on: a member whose payload holds variants inside a STRINGIFIED seed_data is not re-priced', () => withEnv({ [FLAG]: 'on' }, async () => {
    const queryFn = jest.fn(async () => ({ rows: [sgdRow] }));
    const stringified = member('USD', { seed_data: JSON.stringify({ snapshot: { variants: [{ id: 'v1', price: 45, currency: 'USD' }] } }) });
    const [kept] = await debug.rescopeGroupMemberOffersToCurrency([stringified], 'SGD', { queryFn });
    expect(kept).toBe(stringified);
    expect(queryFn).not.toHaveBeenCalled();
  }));

  test('flag on: a failed read leaves the members exactly as they were', () => withEnv({ [FLAG]: 'on' }, async () => {
    const members = [member('USD')];
    const queryFn = jest.fn(async () => { throw new Error('boom'); });
    expect(await debug.rescopeGroupMemberOffersToCurrency(members, 'SGD', { queryFn })).toBe(members);
  }));
});

describe('product intel offers re-pick (BUYER_MARKET_OFFER_SCOPE)', () => {
  const sgdRow = { picked_sku_key: 'sku_pi', offer_id: 'of_pi_sgd', sku_key: 'sku_pi', currency: 'SGD', price: '61.00', source_system: 'retailer_ingest', source_ref: 'https://store.example.com/p' };
  const run = (flag) => withEnv({ [FLAG]: flag ? 'on' : undefined, AURORA_BFF_USE_MOCK: undefined }, async () => {
    const statements = [];
    jest.resetModules();
    jest.doMock('../src/db', () => ({
      query: jest.fn(async (sql) => {
        statements.push(String(sql));
        return { rows: String(sql).includes('picked_sku_key') ? [sgdRow] : [] };
      }),
    }));
    // eslint-disable-next-line global-require
    const { _debug } = require('../src/server');
    const member = {
      merchant_id: 'external_seed', product_id: 'ext_pi', source_kind: 'external_seed',
      source_payload: {
        title: 'Barrier Cream', brand: 'Example', price: { amount: 45, currency: 'USD' }, price_amount: 45, currency: 'USD',
        canonical_url: 'https://store.example.com/p', catalog_offer_v1: { offer_id: 'of_pi_usd', sku_key: 'sku_pi' },
      },
    };
    const offersData = await _debug.buildProductIntelOffersDataForContext({
      context: { canonicalProductRef: { merchant_id: 'external_seed', product_id: 'ext_pi' }, product: { title: 'Barrier Cream' }, groupMembers: [member] },
      productGroupId: 'sig_pi',
      servingCurrency: 'SGD',
    });
    jest.dontMock('../src/db');
    return { offersData, repicked: statements.some((sql) => sql.includes('picked_sku_key')) };
  });

  test('flag off: no re-pick, the member keeps its USD offer', async () => {
    const { offersData, repicked } = await run(false);
    expect(repicked).toBe(false);
    expect((offersData?.offers || []).map((o) => o.price?.currency)).toEqual(['USD']);
  });

  test('flag on, SG buyer: the member is offered in SGD, as on get_pdp_v2', async () => {
    const { offersData, repicked } = await run(true);
    expect(repicked).toBe(true);
    expect((offersData?.offers || []).map((o) => [o.price?.currency, o.price?.amount])).toEqual([['SGD', 61]]);
  });
});
