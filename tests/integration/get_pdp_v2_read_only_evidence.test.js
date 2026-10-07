const request = require('supertest');
const nock = require('nock');
const { CANONICAL_ENTITY_GROUP_SQL_TAG } = require('../../src/services/catalogEntityResolutionSqlTag');
const receipts = [
  require('../fixtures/canonical-offer-live-20261004/sig_6bb6c7ae7b7e71e838aefb564c60371a.json'),
  require('../fixtures/canonical-offer-live-20261004/sig_7dbc9be45ef987752f80014d6abaac30.json'),
  require('../fixtures/canonical-offer-live-20261004/sig_6bf0fddcae29af92f2556dd0e2687196.json'),
];

jest.setTimeout(60000);
jest.mock('../../src/db', () => ({
  query: jest.fn(), withClient: jest.fn(async fn => fn({ query: jest.fn() })),
}));
const ORIGINAL_ENV = process.env;

// Public receipts prove the IDs, content and observed failure. They are not a
// dump of private catalog rows. Only the DB envelope below is constructed at
// the route's persistence boundary; money validation/builders are real.
function start(receipt, { moneyRows = [], readError = false, readDelayMs = 0, variants,
  sourceSystem = 'catalog_enrichment_agent_v1' } = {}) {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test', DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: 'http://readonly-evidence.test', PIVOTA_API_KEY: 'test-token',
    PDP_IDENTITY_GRAPH_ENABLED: 'false',
    PDP_CURRENT_OWN_MONEY_READ_BUDGET_MS: '100', PDP_SELF_OFFER_FALLBACK_ENABLED: 'true',
    AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
    PDP_SIMILAR_FIRST_PAINT_PREWARM_ENABLED: 'false',
  };
  const db = require('../../src/db');
  const card = receipt.search_card;
  const identity = receipt.public_unscoped_pdp.body.metadata.identity_resolution;
  const pid = identity.resolved_product_id;
  const merchant = identity.resolved_merchant_id;
  const key = `fixture::${card.product_id}`;
  const seen = [];
  db.query.mockImplementation(async (sql, params = []) => {
    const text = String(sql);
    seen.push({ sql: text, params });
    if (text.includes('FROM catalog_products own_cp') && text.includes('JOIN catalog_offers co')) {
      expect(params).toEqual([key, merchant]);
      if (readError) throw new Error('private database connection failure');
      if (readDelayMs) await new Promise(resolve => setTimeout(resolve, readDelayMs));
      return { rows: typeof moneyRows === 'function' ? moneyRows({ key, pid, merchant }) : moneyRows };
    }
    if (text.includes(CANONICAL_ENTITY_GROUP_SQL_TAG)) return { rows: [] };
    if (text.includes('cp.pivota_signature_id = $1') && text.includes('AS catalog_title')) {
      return { rows: params[0] === card.product_id ? [{
        merchant_id: merchant, platform: 'external_seed',
        source_product_id: sourceSystem === 'catalog_enrichment_agent_v1' ? 'fixture-canonical-slug' : pid,
        product_key: key,
        source_system: sourceSystem, pivota_signature_id: card.product_id,
        content_key: `fixture-content::${card.product_id}`, catalog_title: card.title,
        catalog_brand: card.brand, catalog_sync_status: 'live',
        catalog_pdp_lifecycle_stage: 'published', signature_serving_eligible: true,
        external_seed_id: `fixture-seed::${pid}`, external_seed_external_product_id: pid,
        external_seed_status: 'active', external_seed_route_lane: 1,
      }] : [] };
    }
    if (text.includes('FROM external_product_seeds')) {
      return { rows: params[0] === pid ? [{
        id: `fixture-seed::${pid}`, external_product_id: pid, status: 'active',
        title: card.title, image_url: card.image_url, price_amount: String(card.price),
        price_currency: card.currency, availability: 'In Stock',
        // A test-only merchant URL makes any accidental executable fallback visible.
        canonical_url: 'https://merchant.example.test/products/read-only',
        destination_url: 'https://merchant.example.test/products/read-only',
        domain: 'merchant.example.test',
        seed_data: { brand: card.brand, description: card.description,
          ...(variants ? { variants } : {}),
        },
      }] : [] };
    }
    return { rows: [] };
  });
  nock('http://readonly-evidence.test').persist().get(/.*/).reply(404, {});
  nock('http://readonly-evidence.test').persist().post(/.*/).reply(404, {});
  const app = require('../../src/server');
  return { app, seen, key, pid, merchant };
}

function invoke(app, receipt, options = {}, extra = {}) {
  return request(app).post('/agent/shop/v1/invoke').send({
    operation: 'get_pdp_v2', payload: {
      product_ref: { product_id: receipt.search_card.product_id },
      include: ['offers', 'variant_selector', 'product_overview', 'ingredients_inci', 'media_gallery'],
      options, ...extra,
    },
  });
}

function assertReadOnly(res, receipt) {
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toContain('no-store');
  const commerce = { state: 'unavailable', read_only: true, purchase_eligible: false,
    reason_code: 'CURRENT_OWN_OFFER_UNAVAILABLE' };
  expect(res.body.metadata.commerce).toEqual(commerce);
  const canonical = res.body.modules.find(m => m.type === 'canonical').data;
  expect(canonical.commerce).toEqual(commerce);
  expect(canonical.pdp_payload.commerce).toEqual(commerce);
  expect(canonical.pdp_payload.actions).toEqual([]);
  expect(canonical.pdp_payload.quality_signals.gating.buy_box_ok).toBe(false);
  expect(canonical.pdp_payload.quality_signals.coverage_by_module.price_promo).toBe(0);
  expect(canonical.pdp_payload.modules.find(m => m.type === 'media_gallery').data.items[0].url)
    .toBe(receipt.search_card.image_url);
  const product = canonical.pdp_payload.product;
  // The normal builder removes a repeated leading brand from Missha's title.
  expect(product.title.length).toBeGreaterThan(10);
  expect(receipt.search_card.title).toContain(product.title);
  expect(product.image_url).toBeTruthy();
  expect(product.availability).toEqual({});
  expect(product.purchase_eligible).toBe(false);
  expect(product.commerce_mode).toBe('read_only');
  expect(product).not.toHaveProperty('price');
  expect(product).not.toHaveProperty('external_redirect_url');
  expect(product).not.toHaveProperty('destination_url');
  expect(JSON.stringify(canonical)).not.toMatch(/"in_stock"|"available_quantity"|"price"|"pricing"|"buy_now"|"add_to_cart"/);
  const offers = res.body.modules.find(m => m.type === 'offers').data;
  expect(offers).toMatchObject({ status: 'unavailable', offers: [], offers_count: 0,
    default_offer_id: null, best_price_offer_id: null });
  expect(res.body.metadata.identity_resolution).toMatchObject({
    requested_product_id: receipt.search_card.product_id,
    resolved_product_id: receipt.public_unscoped_pdp.body.metadata.identity_resolution.resolved_product_id,
    resolved_merchant_id: receipt.public_unscoped_pdp.body.metadata.identity_resolution.resolved_merchant_id,
  });
}

afterEach(() => { nock.cleanAll(); process.env = ORIGINAL_ENV; });

test.each(receipts)('$search_card.title: captured409 becomes opt-in evidence with no commerce', async receipt => {
  expect(receipt.public_unscoped_pdp.status).toBe(409);
  expect(receipt.public_unscoped_pdp.body.error).toBe('CURRENT_OWN_OFFER_UNAVAILABLE');
  const { app, seen } = start(receipt);
  const res = await invoke(app, receipt, { allow_read_only: true });
  assertReadOnly(res, receipt);
  if (process.env.SHOPPING_READ_ONLY_RECEIPT_DIR) {
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync(process.env.SHOPPING_READ_ONLY_RECEIPT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.SHOPPING_READ_ONLY_RECEIPT_DIR, `${receipt.search_card.product_id}.json`),
      JSON.stringify({ source: 'local_integrated_route_with_public_receipt_inputs',
        status: res.status, headers: res.headers, body: res.body }, null, 2));
  }
  expect(seen.some(q => q.sql.includes('FROM catalog_products own_cp'))).toBe(true);
  expect(seen.filter(q => q.sql.includes('FROM catalog_products own_cp'))).toHaveLength(1);
});

test.each([undefined, false, 'true'])('preserves current-main legacy unpriced200 when opt-in is %p', async flag => {
  const receipt = receipts[0];
  const { app } = start(receipt);
  const res = await invoke(app, receipt, { allow_read_only: flag });
  expect(res.status).toBe(200);
  expect(res.body.metadata.commerce).toBeUndefined();
  expect(res.body.metadata.current_own_offer_reason_code).toBe('CURRENT_OWN_OFFER_UNAVAILABLE');
  const product = res.body.modules.find(m => m.type === 'canonical').data.pdp_payload.product;
  expect(product).not.toHaveProperty('price');
  expect(product.availability.in_stock).toBe(false); // Preserved upstream legacy presentation only.
  expect(product.variants.every(v => v.current_own_offer_status === 'unavailable' && !v.price)).toBe(true);
  // 2026-10-05: a listing that cannot be bought no longer offers targetless purchase actions to
  // legacy callers (MCP agents and other non-evidence clients); the page itself is unchanged.
  const actions = res.body.modules.find(m => m.type === 'canonical').data.pdp_payload.actions || [];
  expect(actions.map(a => a.action_type)).not.toContain('add_to_cart');
  expect(actions.map(a => a.action_type)).not.toContain('buy_now');
});

test('a DB read failure remains distinguishable503 even with evidence opt-in', async () => {
  const { app } = start(receipts[0], { readError: true });
  const res = await invoke(app, receipts[0], { allow_read_only: true });
  expect(res.status).toBe(503);
  expect(res.body.error).toBe('CURRENT_OWN_OFFER_READ_FAILED');
  expect(JSON.stringify(res.body)).not.toContain('private database');
});

test.each([
  ['wrong currency', [{ source_variant_id: '111', sku_key: 'fixture-owned', amount: 12, currency: 'GBP' }]],
  ['different variant', [{ source_variant_id: '222', sku_key: 'fixture-owned', amount: 12, currency: 'USD' }]],
  ['conflicting own prices', [{ source_variant_id: '111', sku_key: 'fixture-owned', amount: 12, currency: 'USD' },
    { source_variant_id: '111', sku_key: 'fixture-owned-2', amount: 24, currency: 'USD' }]],
])('%s never borrows stale seed price or changes the selected variant', async (_label, moneyRows) => {
  const { app } = start(receipts[0], { moneyRows, variants: [{ variant_id: '111', title: '120g',
    options: [{ name: 'Size', value: '120g' }], price: 11.9, currency: 'USD', in_stock: true }] });
  const res = await invoke(app, receipts[0], { allow_read_only: true });
  assertReadOnly(res, receipts[0]);
  expect(res.body.modules.find(m => m.type === 'canonical').data.pdp_payload.product.default_variant_id).toBe('111');
});

test('a valid exact current-own product offer remains executable when opt-in is supplied', async () => {
  const { app, pid, merchant } = start(receipts[0], { moneyRows: ({ key }) => [{
    source_variant_id: key, sku_key: `${key}::canonical`, amount: 19.95, currency: 'USD',
  }] });
  const res = await invoke(app, receipts[0], { allow_read_only: true });
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toContain('no-store');
  const canonical = res.body.modules.find(m => m.type === 'canonical').data;
  const product = canonical.pdp_payload.product;
  const commerce = { state: 'ready', read_only: false, purchase_eligible: true,
    reason_code: 'CURRENT_OWN_OFFER_VERIFIED',
    product_ref: { merchant_id: merchant, product_id: pid }, selected_variant_id: product.default_variant_id,
    verified_variants: [{ variant_id: product.default_variant_id, amount: 19.95, currency: 'USD' }],
    // No other seller is displayed in this fixture, so no other seller's offer is certified.
    verified_offers: [],
    verified_at: expect.any(String), expires_at: expect.any(String) };
  expect(Date.parse(res.body.metadata.commerce.expires_at) - Date.parse(res.body.metadata.commerce.verified_at)).toBe(60000);
  expect(Date.parse(res.body.metadata.commerce.verified_at)).toBeLessThanOrEqual(Date.now());
  expect(res.body.metadata.commerce).toEqual(commerce);
  expect(canonical.commerce).toEqual(commerce);
  expect(canonical.pdp_payload.commerce).toEqual(commerce);
  expect(product.price.current)
    .toEqual({ amount: 19.95, currency: 'USD' });
  if (process.env.SHOPPING_READ_ONLY_RECEIPT_DIR) {
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync(process.env.SHOPPING_READ_ONLY_RECEIPT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.SHOPPING_READ_ONLY_RECEIPT_DIR, 'fullcream-verified-current-own-offer.json'),
      JSON.stringify({ source: 'local_integrated_route_with_public_receipt_inputs_and_control_current_money',
        status: res.status, headers: res.headers, body: res.body }, null, 2));
  }
});

// 2026-10-07: 545 public enrichment listings were single items whose seed carries ONLY the lane's minted
// product-level variant (pivota-backend services/catalog_enrichment_agent/ingestion.py synthetic_variant:
// `<external_product_id>::canonical`, product title, no options), priced by the `<product_key>::canonical`
// placeholder SKU. Each stayed CURRENT_OWN_OFFER_UNAVAILABLE although its current own money was verified.
// (This receipt's title carries "120g", so the builder derives a one-value Size option for the sole variant:
// a description of the one item, not a choice.)
const lanePlaceholderVariant = (pid, title) => ({ variant_id: `${pid}::canonical`, id: `${pid}::canonical`,
  sku: pid, title, currency: 'USD', price_amount: 32, price: 32, availability: 'in_stock', in_stock: true,
  variant_id_provenance: 'product_derived', purchasable: false });
const placeholderMoney = ({ key }) => [{ source_variant_id: key, sku_key: `${key}::canonical`, amount: 19.95, currency: 'USD' }];

test('a single item carrying only the lane-minted <pid>::canonical variant is ready on its verified money', async () => {
  const card = receipts[0].search_card;
  const pid = receipts[0].public_unscoped_pdp.body.metadata.identity_resolution.resolved_product_id;
  const { app, merchant } = start(receipts[0], { variants: [lanePlaceholderVariant(pid, card.title)], moneyRows: placeholderMoney });
  const res = await invoke(app, receipts[0], { allow_read_only: true });
  expect(res.status).toBe(200);
  expect(res.body.metadata.commerce).toMatchObject({ state: 'ready', purchase_eligible: true,
    product_ref: { merchant_id: merchant, product_id: pid }, selected_variant_id: `${pid}::canonical`,
    verified_variants: [{ variant_id: `${pid}::canonical`, amount: 19.95, currency: 'USD' }] });
  const product = res.body.modules.find(m => m.type === 'canonical').data.pdp_payload.product;
  expect(product.price.current).toEqual({ amount: 19.95, currency: 'USD' });
  expect(product.variants).toHaveLength(1);
  expect(product.variants[0]).toMatchObject({ variant_id: `${pid}::canonical`, options: [{ name: 'Size', value: '120 g' }] });
  // This fixture has no identity group members, so its offers module is blocked; the selected offer's own
  // check is covered in tests/canonical_pdp_own_money.test.js with the live offer shape.
  // Legacy callers get the same verified money, with no gap reason.
  const legacy = await invoke(app, receipts[0]);
  expect(legacy.body.metadata.current_own_offer_reason_code).toBeUndefined();
  expect(legacy.body.modules.find(m => m.type === 'canonical').data.pdp_payload.product.price.current)
    .toEqual({ amount: 19.95, currency: 'USD' });
});

test.each([
  ['two shades (the seed lists real variants)', pid => [
    { variant_id: 'C-AMLP99-001A', title: 'Shade 1', price: 18, currency: 'USD', in_stock: true },
    { variant_id: 'C-AMLP99-002A', title: 'Shade 2', price: 18, currency: 'USD', in_stock: true }]],
  ['the minted id beside a real variant', (pid, title) => [lanePlaceholderVariant(pid, title),
    { variant_id: 'C-AMLP99-001A', title: 'Shade 1', price: 18, currency: 'USD', in_stock: true }]],
  ['a sole real variant', () => [{ variant_id: 'C-AMLP99-001A', title: 'Shade 1', price: 18, currency: 'USD', in_stock: true }]],
  ['another product\'s minted id', (pid, title) => [lanePlaceholderVariant(`${pid}x`, title)]],
  ['two minted ids', (pid, title) => [lanePlaceholderVariant(pid, title), lanePlaceholderVariant(`${pid}-b`, title)]],
])('product-level placeholder money never prices %s', async (_label, variantsFor) => {
  const pid = receipts[0].public_unscoped_pdp.body.metadata.identity_resolution.resolved_product_id;
  const { app } = start(receipts[0], { variants: variantsFor(pid, receipts[0].search_card.title), moneyRows: placeholderMoney });
  const res = await invoke(app, receipts[0], { allow_read_only: true });
  assertReadOnly(res, receipts[0]);
});

test('a verified numeric variant proof names the exact displayed variant and its own money', async () => {
  const { app, pid, merchant } = start(receipts[0], {
    variants: [{ variant_id: '111', title: '120g', options: [{ name: 'Size', value: '120g' }],
      price: 11.9, currency: 'USD', in_stock: true }],
    moneyRows: [{ source_variant_id: '111', sku_key: 'fixture-own-sku', amount: 19.95, currency: 'USD' }],
  });
  const res = await invoke(app, receipts[0], { allow_read_only: true });
  expect(res.status).toBe(200);
  expect(res.body.metadata.commerce).toMatchObject({ state: 'ready',
    product_ref: { product_id: pid, merchant_id: merchant }, selected_variant_id: '111' });
  const product = res.body.modules.find(m => m.type === 'canonical').data.pdp_payload.product;
  expect(product.default_variant_id).toBe('111');
  expect(product.variants.find(v => v.variant_id === '111').price.current)
    .toEqual({ amount: 19.95, currency: 'USD' });
  if (process.env.SHOPPING_READ_ONLY_RECEIPT_DIR) {
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync(process.env.SHOPPING_READ_ONLY_RECEIPT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.SHOPPING_READ_ONLY_RECEIPT_DIR, 'fullcream-verified-numeric-variant.json'),
      JSON.stringify({ source: 'local_integrated_route_with_public_receipt_inputs_and_control_variant_money',
        status: res.status, headers: res.headers, body: res.body }, null, 2));
  }
});

test('opt-in does not label a legacy signature lane as verified without the own-money gate', async () => {
  const { app, seen } = start(receipts[0], { sourceSystem: 'external_product_seeds_mirror_v1' });
  const res = await invoke(app, receipts[0], { allow_read_only: true });
  expect(res.status).toBe(200);
  expect(seen.some(q => q.sql.includes('FROM catalog_products own_cp'))).toBe(false);
  expect(res.body.metadata.commerce).toBeUndefined();
  expect(res.body.modules.find(m => m.type === 'canonical').data.commerce).toBeUndefined();
});

test('an unrelated explicitly pinned seller cannot gain evidence by opt-in', async () => {
  const { app } = start(receipts[0]);
  const res = await invoke(app, receipts[0], { allow_read_only: true }, {
    product_ref: { product_id: receipts[0].search_card.product_id, merchant_id: 'unrelated-merchant' },
  });
  expect(res.status).not.toBe(200);
  expect(res.body.metadata?.commerce).toBeUndefined();
});

test('core evidence without offers still carries the unavailable commerce state', async () => {
  const { app } = start(receipts[0]);
  const res = await invoke(app, receipts[0], { allow_read_only: true }, { include: ['product_overview'] });
  expect(res.status).toBe(200);
  expect(res.body.metadata.commerce).toMatchObject({ read_only: true, purchase_eligible: false });
  const payload = res.body.modules.find(m => m.type === 'canonical').data.pdp_payload;
  expect(payload.actions).toEqual([]);
  expect(payload.product).not.toHaveProperty('price');
});

test('offer seller scope from the actual Missha card is not silently rewritten by evidence opt-in', async () => {
  const receipt = receipts[1];
  expect(receipt.public_scoped_pdp.status).toBe(404);
  const { app } = start(receipt);
  const res = await invoke(app, receipt, { allow_read_only: true }, {
    product_ref: receipt.public_scoped_pdp.request.payload.product_ref,
  });
  expect(res.status).toBe(404);
  expect(res.body.metadata?.commerce).toBeUndefined();
});

test.each([true, false])('each displayed variant needs its own verified money (second covered=%p)', async secondCovered => {
  const variants = [
    { variant_id: '111', title: '120g', options: [{ name: 'Size', value: '120g' }], price: 11.9, currency: 'USD', in_stock: true },
    { variant_id: '222', title: '500g', options: [{ name: 'Size', value: '500g' }], price: 28.9, currency: 'USD', in_stock: true },
  ];
  const { app } = start(receipts[0], { variants, moneyRows: [
    { source_variant_id: '111', sku_key: 'fixture-111', amount: 19.95, currency: 'USD' },
    ...(secondCovered ? [{ source_variant_id: '222', sku_key: 'fixture-222', amount: 31.5, currency: 'USD' }] : []),
  ] });
  const res = await invoke(app, receipts[0], { allow_read_only: true });
  expect(res.status).toBe(200);
  expect(res.body.metadata.commerce.verified_variants).toEqual([
    { variant_id: '111', amount: 19.95, currency: 'USD' },
    ...(secondCovered ? [{ variant_id: '222', amount: 31.5, currency: 'USD' }] : []),
  ]);
  if (!secondCovered) {
    const p = res.body.modules.find(m => m.type === 'canonical').data.pdp_payload.product;
    expect(p.variants.find(v => v.variant_id === '222')).not.toHaveProperty('price');
  }
  if (process.env.SHOPPING_READ_ONLY_RECEIPT_DIR) {
    const fs = require('fs'); const path = require('path');
    fs.writeFileSync(path.join(process.env.SHOPPING_READ_ONLY_RECEIPT_DIR, `fullcream-variant-proof-${secondCovered}.json`), JSON.stringify({ source: 'local_integrated_route_with_explicit_control_variant_money', status: res.status, body: res.body }, null, 2));
  }
});


test.each(['unknown_vendor_import_v999', '', null])('unknown canonical source %s remains evidence-only', async (sourceSystem) => {
  const { app } = start(receipts[0], { sourceSystem });
  const res = await invoke(app, receipts[0], { allow_read_only: true });
  assertReadOnly(res, receipts[0]);
  if (sourceSystem === 'unknown_vendor_import_v999' && process.env.SHOPPING_READ_ONLY_RECEIPT_DIR) {
    const fs = require('fs'), path = require('path');
    fs.writeFileSync(path.join(process.env.SHOPPING_READ_ONLY_RECEIPT_DIR, 'unknown-canonical-source.json'), JSON.stringify({
      source: 'local_route_unknown_source_control_not_production', status: res.status, body: res.body }, null, 2));
  }
});

test.each(['unknown_vendor_import_v999', '', null])('legacy source %s gains no new proof and explicit evidence remains read-only', async (sourceSystem) => {
  const { app } = start(receipts[0], { sourceSystem });
  const res = await invoke(app, receipts[0]);
  expect(res.status).toBe(200);
  expect(res.body.metadata.commerce).toBeUndefined();
  const optedIn = await invoke(app, receipts[0], { allow_read_only: true });
  assertReadOnly(optedIn, receipts[0]);
});

test.each(['merchant_checkout_url', 'merchantCheckoutUrl', 'checkoutUrl', 'externalRedirectUrl', 'redirect_url', 'redirectUrl', 'buyUrl'])(
  'read-only projection removes consumed destination alias %s while keeping media', (alias) => {
    const { projectReadOnlyPdpResponse } = require('../../src/services/pdpReadOnlyEvidence');
    const product = { product_id: 'p', [alias]: 'https://merchant.test/buy', variants: [{ variant_id: 'v', [alias]: 'https://merchant.test/buy' }] };
    const source = { modules: [{ type: 'canonical', data: { pdp_payload: { product, modules: [], actions: [] } } }, { type: 'media_gallery', data: { items: [{ url: 'https://merchant.test/photo.jpg' }] } }] };
    const result = projectReadOnlyPdpResponse(source, 'CURRENT_OWN_OFFER_UNAVAILABLE');
    expect(result.modules[0].data.pdp_payload.product).not.toHaveProperty(alias);
    expect(result.modules[0].data.pdp_payload.product.variants[0]).not.toHaveProperty(alias);
    expect(result.modules[1].data.items[0].url).toBe('https://merchant.test/photo.jpg');
  });


test.each([false, true])('bounded read timeout preserves legacy fallback but explicit evidence gets503 (opt-in:%s)', async allow => {
  const { app } = start(receipts[0], { readDelayMs: 350 });
  const res = await invoke(app, receipts[0], { allow_read_only: allow });
  if (allow) {
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('CURRENT_OWN_OFFER_READ_FAILED');
    expect(res.body.metadata?.commerce).toBeUndefined();
  } else {
    expect(res.status).toBe(200);
    expect(res.body.metadata.current_own_offer_reason_code).toBe('CURRENT_OWN_OFFER_READ_FAILED');
    const product = res.body.modules.find(m => m.type === 'canonical').data.pdp_payload.product;
    expect(product).not.toHaveProperty('price');
    expect(product.variants.every(v => !v.price && v.current_own_offer_status === 'unavailable')).toBe(true);
  }
  // Settle the read; late completion must not change the emitted response.
  await new Promise(resolve => setTimeout(resolve, 360));
  expect(res.status).toBe(allow ? 503 : 200);
});
