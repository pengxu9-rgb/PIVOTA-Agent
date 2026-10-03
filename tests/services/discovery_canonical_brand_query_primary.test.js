jest.mock('../../src/db', () => ({
  query: jest.fn()
}));
const axios = require('axios');
const db = require('../../src/db');
const {
  getDiscoveryFeed,
  buildDiscoveryProfile,
  _internals: i
} = require('../../src/services/discoveryFeed');
let env;
const row = (n, extra = {}) => ({
  pivota_signature_id: 'sig_' + String(n).padStart(32, '0'),
  content_key: 'local-' + n,
  brand: 'Judydoll',
  external_brand: 'Judydoll',
  title: 'Silky Matte Lip Ink ' + n,
  description: 'Lip color',
  category_path: 'beauty/makeup/lipstick',
  currency: 'USD',
  price_min: 13.99,
  image_url: 'https://local.invalid/img',
  external_product_key: 'local-' + n,
  external_product_id: 'ext_local' + n,
  external_canonical_url: 'https://judydoll.com/products/local-' + n,
  offers: [{
    market: 'US',
    currency: 'USD',
    price: 13.99,
    availability: 'in_stock'
  }],
  ...extra
});
const payload = (text = 'Judydoll', extra = {}) => ({
  surface: 'browse_products',
  response_detail: 'card',
  page: 1,
  limit: 24,
  sort: 'popular',
  query: {
    text
  },
  context: {
    recent_views: [],
    recent_queries: [],
    auth_state: 'anonymous',
    locale: 'en-US'
  },
  ...extra
});
const req = (text, extra) => i.normalizeDiscoveryRequest(payload(text, extra));
async function load(text = 'Judydoll', extra) {
  const request = req(text, extra);
  return i.loadCanonicalBrandQueryPrimary({
    request,
    profile: buildDiscoveryProfile(request.context)
  });
}
beforeEach(() => {
  env = {
    ...process.env
  };
  process.env.DATABASE_URL = 'postgres://local-only';
  process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';
  process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET = 'US';
  db.query.mockReset();
  db.query.mockImplementation(async sql => ({
    rows: sql.includes('canonical_exact_brand_admission') ? [{
      brand: 'Judydoll'
    }] : sql.includes('WITH brand_match') ? [row(1), row(2), row(3)] : []
  }));
  jest.spyOn(axios, 'get').mockRejectedValue(Error('SDK forbidden'));
  i.resetProductsSearchBreaker();
});
afterEach(() => {
  process.env = env;
  jest.restoreAllMocks();
});
test('exact native cold anonymous Judydoll query selects canonical primary, no SDK or alternate graph', async () => {
  const r = await getDiscoveryFeed(payload(), {
    identityGraphRowsResolverFn: async () => [],
    relationshipGraphRecallFn: () => {
      throw Error('graph alternate forbidden');
    }
  });
  expect(r.products).toHaveLength(3);
  expect(r.total).toBe(3);
  expect(r.metadata.primary_path_used).toBe('canonical_sig_explicit_brand');
  expect(r.metadata.count_source).toBe('runtime_canonical_brand_query_pool');
  expect(r.metadata.provider_breakdown.find(p => p.provider === 'products_search')).toMatchObject({
    skipped: true,
    skip_reason: 'canonical_sig_explicit_brand_primary_selected'
  });
  expect(r.metadata.fallback_triggered).toBe(false);
  expect(axios.get).not.toHaveBeenCalled();
  expect(db.query.mock.calls.find(c => c[0].includes('WITH brand_match'))[1][2]).toBe(400);
});
test.each(['Judydoll', '  JUDYDOLL  ', 'judydoll'])('exact case/outer whitespace brand admission %s', async text => {
  expect((await load(text)).products).toHaveLength(3);
  expect(db.query.mock.calls[0][1]).toEqual(['judydoll']);
  expect(axios.get).not.toHaveBeenCalled();
});
test.each(['unknown brand', 'Judydoll lipstick', 'notJudydoll', 'Judydoll%', 'serum'])('unadmitted/free-text %s intentionally retains legacy selection, no fabricated match', async text => {
  db.query.mockResolvedValue({
    rows: []
  });
  expect(await load(text)).toBeNull();
  expect(db.query).toHaveBeenCalledTimes(1);
});
test.each(['', '   '])('blank %p does not run brand authority lookup', async text => {
  expect(await load(text)).toBeNull();
  expect(db.query).not.toHaveBeenCalled();
});
test('catalog admission error does not become unknown-brand/SDK', async () => {
  db.query.mockRejectedValue(Error('authority database unavailable'));
  await expect(getDiscoveryFeed(payload())).rejects.toThrow();
  expect(axios.get).not.toHaveBeenCalled();
});
test('selected brand pool error never dispatches SDK', async () => {
  db.query.mockImplementation(async sql => {
    if (sql.includes('WITH brand_match')) throw Error('pool unavailable');
    return {
      rows: [{
        brand: 'Judydoll'
      }]
    };
  });
  await expect(getDiscoveryFeed(payload())).rejects.toThrow();
  expect(axios.get).not.toHaveBeenCalled();
});
test('known brand own pool empty is honest empty no alternate', async () => {
  db.query.mockImplementation(async sql => ({
    rows: sql.includes('canonical_exact_brand_admission') ? [{
      brand: 'Judydoll'
    }] : []
  }));
  const r = await getDiscoveryFeed(payload(), {
    relationshipGraphRecallFn: () => {
      throw Error('graph');
    }
  });
  expect(r.products).toEqual([]);
  expect(r.metadata.primary_path_used).toBe('canonical_sig_explicit_brand');
  expect(axios.get).not.toHaveBeenCalled();
});
test('foreign brand/currency/market/stock offers are excluded', async () => {
  db.query.mockImplementation(async sql => ({
    rows: sql.includes('canonical_exact_brand_admission') ? [{
      brand: 'Judydoll'
    }] : [row(1), row(2, {
      brand: 'Other'
    }), row(3, {
      currency: 'GBP'
    }), row(4, {
      offers: [{
        market: 'GB',
        currency: 'USD',
        price: 1,
        availability: 'in_stock'
      }]
    }), row(5, {
      offers: [{
        market: 'US',
        currency: 'USD',
        price: 1,
        availability: 'out_of_stock'
      }]
    })]
  }));
  expect((await load()).products).toHaveLength(1);
});
test.each([{
  scope: {
    brand_names: ['Other']
  }
}, {
  scope: {
    categories: ['serum']
  }
}, {
  context: {
    locale: 'en-SG',
    recent_views: [],
    recent_queries: []
  }
}, {
  context: {
    locale: 'en-US',
    recent_views: [{
      product_id: 'sig_' + '1'.repeat(32),
      merchant_id: 'external_seed'
    }]
  }
}, {
  context: {
    locale: 'en-US',
    recent_views: [],
    recent_queries: ['Jurlique']
  }
}])('other explicit/history scopes keep initial legacy selection %p', async extra => {
  expect(await load('Judydoll', extra)).toBeNull();
  expect(db.query).not.toHaveBeenCalled();
});
test('non-US market does not substitute USD canonical query', async () => {
  process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET = 'GB';
  expect(await load()).toBeNull();
  expect(db.query).not.toHaveBeenCalled();
});
test('multi-word exact server brand works; caller suffix cannot broaden it', async () => {
  db.query.mockImplementation(async (sql, params) => ({
    rows: sql.includes('canonical_exact_brand_admission') ? params[0] === 'fenty beauty' ? [{
      brand: 'Fenty Beauty'
    }] : [] : [row(1, {
      brand: 'Fenty Beauty'
    })]
  }));
  expect((await load('Fenty Beauty')).products).toHaveLength(1);
  expect(await load('Fenty Beauty serum')).toBeNull();
});

 test.each([{}, {rows:null}, {rows:[{brand:'Foreign'}]}])('malformed/conflicting authority refuses before SDK: %p', async result => {
  db.query.mockResolvedValue(result);
  await expect(getDiscoveryFeed(payload())).rejects.toThrow();
  expect(axios.get).not.toHaveBeenCalled();
 });
