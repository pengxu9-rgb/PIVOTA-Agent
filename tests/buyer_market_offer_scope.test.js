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
    expect(scope.resolveOfferScopeCurrency('usd')).toBe('USD');
    expect(scope.resolveOfferScopeCurrency(null)).toBeNull();
  }));

  // The row shape the canonical readers SELECT, with agent_pdp_view.market_prices as
  // pivota-backend's build_market_prices writes it.
  const row = () => ({
    pivota_signature_id: 'sig_' + '1'.repeat(32),
    currency: 'USD', price_min: 45, price_max: 50, offer_count: 3,
    offers: [{ currency: 'USD', price: 45 }, { currency: 'USD', price: 50 }, { currency: 'SGD', price: 61 }],
    market_prices: JSON.stringify({
      US: { currency: 'USD', price_min: 45, price_max: 50, offer_count: 2, offers: [{ currency: 'USD', price: 45 }, { currency: 'USD', price: 50 }] },
      SG: { currency: 'SGD', price_min: 61, price_max: 61, offer_count: 1, offers: [{ currency: 'SGD', price: 61 }] },
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
    for (const marketPrices of [null, undefined, '{}', 'not json', JSON.stringify({ SG: { currency: 'USD', price_min: 1 } })]) {
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
    expect(sql).toContain("co.market = 'SG' AND co.currency = 'SGD'");
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

  test('flag on: a failed read leaves the members exactly as they were', () => withEnv({ [FLAG]: 'on' }, async () => {
    const members = [member('USD')];
    const queryFn = jest.fn(async () => { throw new Error('boom'); });
    expect(await debug.rescopeGroupMemberOffersToCurrency(members, 'SGD', { queryFn })).toBe(members);
  }));
});
