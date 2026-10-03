jest.mock('../../src/db', () => ({ query: jest.fn() }));
const axios = require('axios');
const db = require('../../src/db');
const { getDiscoveryFeed, buildDiscoveryProfile, _internals: i } = require('../../src/services/discoveryFeed');
const { buildRecentView, deriveRecentQuery } = require('../../scripts/run_discovery_feed_smoke.cjs');
const SIG = 'sig_3d1b5a5627cbb101f388e5a90c80b4e5';
// Exact public first-card text, not an invented beauty category. SQL rows below
// are explicitly synthetic local stored-source projections, not provider proof.
const card = { merchant_id: 'external_seed', product_id: SIG, title: 'Iconic Starter Ritual', brand: 'Jurlique',
  description: 'Indulge in this iconic discovery set for a complete ritual that transforms your skincare experience. Perfect for gifting or self-pampering. $64 value* *Valued by Jurlique based on RRP of full-sized products.' };
const row = (sig = SIG, override = {}) => ({ pivota_signature_id: sig, content_key: 'ck_synthetic_' + sig,
  title: sig === SIG ? card.title : 'Jurlique Daily Skincare Ritual ' + sig, description: card.description,
  brand: 'Jurlique', external_brand: 'Jurlique', external_product_key: 'synthetic-own-' + sig, category_path: 'beauty/sets/gift-set', currency: 'USD', price_min: 45,
  image_url: 'https://synthetic.example/product.png', external_product_id: 'local-' + sig,
  external_canonical_url: 'https://jurlique.com/products/local-synthetic-' + sig, external_seed_id: 'synthetic-' + sig,
  offers: [{ market: 'US', currency: 'USD', price: 45, availability: 'in_stock' }], offer_count: 1, ...override });
const candidates = Array.from({ length: 10 }, (_, n) => row('sig_' + String(n + 1).padStart(32, '0')));
let env;
beforeEach(() => {
  env = { ...process.env };
  process.env.DATABASE_URL = 'postgres://synthetic-unused';
  process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';
  process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET = 'US';
  process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'https://synthetic-primary.invalid';
  process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'synthetic-local-only';
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => ({ rows: sql.includes('WITH brand_match') ? candidates : sql.includes('AND apv.pivota_signature_id = ANY($2::text[])') ? [row()] : [] }));
  jest.spyOn(axios, 'get').mockRejectedValue(new Error('no HTTP transport should be dispatched'));
  i.resetProductsSearchBreaker();
});
afterEach(() => { jest.restoreAllMocks(); process.env = env; });
function request(override = {}) {
  return i.normalizeDiscoveryRequest({ surface: 'home_hot_deals', page: 1, limit: 6, debug: true,
    context: { auth_state: 'authenticated', locale: 'en-US', recent_views: [buildRecentView(card)], recent_queries: [deriveRecentQuery(card)] }, ...override });
}
async function primary(req = request()) { return i.loadCanonicalHistoryPrimary({ request: req, profile: buildDiscoveryProfile(req.context), limit: 48 }); }

test('actual category-less Iconic Starter Ritual history selects stored canonical primary with zero SDK HTTP', async () => {
  const req = request(); expect(buildDiscoveryProfile(req.context).dominantDomain).toBeNull();
  const response = await getDiscoveryFeed(req, { identityGraphRowsResolverFn: async () => [], relationshipGraphRecallFn: () => { throw Error('alternate graph must not run'); } });
  expect(response.products.length).toBeGreaterThanOrEqual(4);
  expect(response.metadata.candidate_source).toBe('canonical_sig_personalized');
  expect(response.metadata.provider_breakdown.find(x => x.provider === 'canonical_sig')).toMatchObject({ successful: true, returned: 10 });
  expect(response.metadata.provider_breakdown.find(x => x.provider === 'products_search')).toMatchObject({ skipped: true, skip_reason: 'canonical_sig_personalized_primary_selected' });
  expect(axios.get).not.toHaveBeenCalled();
  expect(db.query.mock.calls[0][1][1]).toEqual([SIG]);
});

test.each(['beauty/sets/gift-set', ['beauty', 'sets', 'gift-set']])('canonical category path preserves physical TEXT and compatible arrays %p', (path) => {
  expect(i.mapCanonicalIndexRowToProduct(row(SIG, { category_path: path }))).toMatchObject({ category_path: ['beauty', 'sets', 'gift-set'], category: 'gift-set' });
});

test.each([
 ['missing anchor', () => db.query.mockResolvedValue({ rows: [] }), 'canonical_history_subject_not_public'],
 ['foreign merchant', () => db.query.mockResolvedValue({ rows: [row(SIG, { first_party_merchant_id: 'foreign' })] }), 'canonical_history_subject_conflict'],
 ['wrong currency', () => db.query.mockResolvedValue({ rows: [row(SIG, { currency: 'GBP' })] }), 'canonical_history_currency_mismatch'],
 ['database error', () => db.query.mockRejectedValue(Error('database timed out')), null],
])('%s is an explicit canonical primary refusal, zero alternate HTTP', async (name, set, reason) => {
  set(); const result = await primary(); expect(result.products).toEqual([]); expect(result.recallSummary[0].status).toBeNull();
  if (reason) expect(result.recallSummary[0].failure_reason).toBe(reason);
  expect(axios.get).not.toHaveBeenCalled();
});

test('empty canonical pool stays honestly empty without alternate providers or graph recall', async () => {
  db.query.mockImplementation(async sql => ({ rows: sql.includes('WITH brand_match') ? [] : sql.includes('AND apv.pivota_signature_id = ANY($2::text[])') ? [row()] : [] }));
  const response = await getDiscoveryFeed(request(), { relationshipGraphRecallFn: () => { throw Error('alternate graph'); } });
  expect(response.products).toEqual([]); expect(response.metadata.candidate_source).toBe('canonical_sig_personalized');
  expect(axios.get).not.toHaveBeenCalled();
});

test('stored brand is authority and caller brand conflict refuses before candidate query', async () => {
  const req = request(); req.context.recent_views[0].brand = 'Foreign Brand';
  const result = await primary(req); expect(result.recallSummary[0].failure_reason).toBe('canonical_history_subject_conflict');
  expect(db.query).toHaveBeenCalledTimes(1);
});

test('brand candidates cannot broaden to another brand/currency', async () => {
  db.query.mockImplementation(async sql => ({ rows: sql.includes('WITH brand_match') ? [...candidates, row('sig_' + 'f'.repeat(32), { brand: 'Foreign' }), row('sig_' + 'e'.repeat(32), { currency: 'GBP' })] : [row()] }));
  expect((await primary()).products).toHaveLength(10);
});

test('an explicit conflicting beauty/fashion domain is not inferred from brand', async () => {
  const req = request(); const profile = buildDiscoveryProfile(req.context); profile.dominantDomain = 'apparel';
  const result = await i.loadCanonicalHistoryPrimary({ request: req, profile, limit: 48 });
  expect(result.recallSummary[0].failure_reason).toBe('canonical_history_domain_conflict');
});

test.each(['fashion/dresses', null])('stored nonbeauty/unknown domain is not turned into beauty %p', async (path) => {
  db.query.mockImplementation(async sql => ({ rows: sql.includes('WITH brand_match') ? candidates.map(x => ({ ...x, category_path: path })) : [row(SIG, { category_path: path })] }));
  const result = await primary(); expect(result.products).toHaveLength(10); expect(result.provider).toBe('canonical_sig');
});

test.each([
 { scope: { brand_names: ['Foreign'] } }, { scope: { categories: ['serum'] } }, { query: { text: 'serum' } },
 { context: { auth_state: 'authenticated', locale: 'en-SG', recent_views: [buildRecentView(card)], recent_queries: ['Jurlique'] } },
])('explicit request scope/locale keeps its original initial route %p', async override => {
  expect(await primary(request(override))).toBeNull(); expect(db.query).not.toHaveBeenCalled();
});

test('different history query cannot be silently replaced by stored brand', async () => {
  const req = request(); req.context.recent_queries = ['vitamin c serum']; expect(await primary(req)).toBeNull();
  expect(db.query).toHaveBeenCalledTimes(1); expect(axios.get).not.toHaveBeenCalled();
});

 test('stored primary domain refuses unknown anchors under an explicit domain', async () => {
  db.query.mockResolvedValue({rows:[row(SIG,{category_path:null})]});
  const req=request();const profile=buildDiscoveryProfile(req.context);profile.dominantDomain='beauty';
  const result=await i.loadCanonicalHistoryPrimary({request:req,profile,limit:48});
  expect(result.recallSummary[0].failure_reason).toBe('canonical_history_domain_conflict');
  expect(db.query).toHaveBeenCalledTimes(1);expect(axios.get).not.toHaveBeenCalled();
 });
 test('stored category domain excludes foreign or unknown candidate domains',async()=>{
  db.query.mockImplementation(async sql=>({rows:sql.includes('WITH brand_match')?[...candidates,row('sig_'+'f'.repeat(32),{category_path:'fashion/dress'}),row('sig_'+'e'.repeat(32),{category_path:null})]:[row()]}));
  expect((await primary()).products).toHaveLength(10);
 });
 test('new mapped first-card taxonomy remains a valid exact stored history query',async()=>{
  const mapped=i.mapCanonicalIndexRowToProduct(row());
  const req=request({context:{auth_state:'authenticated',locale:'en-US',recent_views:[buildRecentView(mapped)],recent_queries:[deriveRecentQuery(mapped)]}});
  expect(req.context.recent_queries).toEqual(['gift-set']);
  expect((await primary(req)).products).toHaveLength(10);expect(axios.get).not.toHaveBeenCalled();
 });
