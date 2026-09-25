const ORIGINAL_ENV = { ...process.env };

const request = require('supertest');
const nock = require('nock');

// CONSUMER CONTRACT for a withheld external-seed price.
//
// The backend's external-seed builder (pivota-backend routes/agent_api.py) withholds price and
// stock when the referral gate requires live verification, and marks the row
// `commerce_verification: {required: true, status: 'live_quote_required', ...}`. Its v2 serializer
// (routes/agent_v2.py _canonicalize_search_product) used to drop that mark and print the missing
// price as "0" and the missing stock as in_stock: true — measured on prod 2026-09-24: "Round Lab"
// on MCP search_catalog served five rows at price "0", one of them out of stock in the DB, while
// every seed carried a real price (2.50-29.99).
//
// The backend fix sends price: null, in_stock: null and the commerce_verification block. This
// suite pins what the gateway does with THAT shape, and must be green before the backend ships
// it: a null must never come back out as 0 or true, and the verification mark must reach the
// agent. Two doors: the MCP door (no request metadata) and the shopping-agent door (which also
// runs the canonical price contract).

function withheldRow(overrides = {}) {
  return {
    product_id: 'round-lab:85dd4c56da58a259',
    canonical_title: 'Round Lab Sheet Mask Sampler - 9pc',
    canonical_category: 'external',
    brand: 'ROUND LAB',
    dedupe_group_id: 'round-lab:85dd4c56da58a259',
    variants: [{ variant_id: 'round-lab:85dd4c56da58a259', variant_attributes: {} }],
    offers: [
      {
        offer_id: 'offer::external_seed::round-lab:85dd4c56da58a259',
        merchant_id: 'external_seed',
        variant_id: 'round-lab:85dd4c56da58a259',
        price: null,
        currency: 'USD',
        availability: { in_stock: null, inventory_quantity: null },
        source_type: 'external_seed',
        connector: 'external',
      },
    ],
    provenance: {
      merchant_id: 'external_seed',
      merchant_name: 'External',
      connector: 'external',
      source_type: 'external_seed',
    },
    commerce_verification: {
      required: true,
      status: 'live_quote_required',
      reasons: ['stale_commerce_facts'],
      price_trusted: false,
      availability_trusted: false,
    },
    ...overrides,
  };
}

function pricedRow() {
  return {
    product_id: 'eyurs-com:df568001f820cfd7',
    canonical_title: 'Round Lab 1025 Dokdo Mud Pack 100ml',
    canonical_category: 'external',
    brand: 'ROUND LAB',
    variants: [{ variant_id: 'eyurs-com:df568001f820cfd7', variant_attributes: {} }],
    offers: [
      {
        offer_id: 'offer::external_seed::eyurs-com:df568001f820cfd7',
        merchant_id: 'external_seed',
        variant_id: 'eyurs-com:df568001f820cfd7',
        price: '13.0',
        currency: 'USD',
        availability: { in_stock: true, inventory_quantity: 999 },
        source_type: 'external_seed',
        connector: 'external',
      },
    ],
    provenance: { merchant_id: 'external_seed', merchant_name: 'External', source_type: 'external_seed' },
    commerce_verification: {
      required: false,
      status: 'catalog_facts_accepted',
      reasons: [],
      price_trusted: true,
      availability_trusted: true,
    },
  };
}

// Returns a live counter of upstream calls, so a test can prove its rows came
// from THIS mock rather than from another lane.
function mockUpstream(products) {
  const calls = { count: 0 };
  nock(process.env.PIVOTA_API_BASE)
    .post('/agent/v2/products/search')
    .query(true)
    .times(6)
    .reply(200, () => {
      calls.count += 1;
      return { status: 'success', success: true, total: products.length, metadata: { query_source: 'test_upstream' }, products };
    });
  return calls;
}

function invoke(app, metadata) {
  return request(app)
    .post('/agent/shop/v1/invoke')
    .send({
      operation: 'find_products_multi',
      payload: { search: { query: 'Round Lab', page: 1, limit: 10 } },
      ...(metadata ? { metadata } : {}),
    });
}

function isZeroPrice(value) {
  return value !== null && value !== undefined && Number(value) === 0;
}

// Unknown stock is null/absent. `false` would be an invented claim too.
function isUnknown(value) {
  return value === null || value === undefined;
}

describe('find_products_multi: a withheld external-seed price stays unknown', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      PIVOTA_API_BASE: 'http://localhost:8080',
      PIVOTA_API_KEY: 'test-token',
      API_MODE: 'REAL',
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'false',
    };
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    nock.cleanAll();
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it('MCP door (no metadata): no zero price, no invented stock, the verification mark reaches the agent', async () => {
    const upstream = mockUpstream([withheldRow(), pricedRow()]);
    const app = require('../../src/server');
    const resp = await invoke(app, null);

    expect(resp.status).toBe(200);
    // Premise: the rows came from the mocked v2 upstream, not another lane.
    expect(upstream.count).toBeGreaterThan(0);
    const withheld = resp.body.products.find((p) => p.product_id === 'round-lab:85dd4c56da58a259');
    expect(withheld).toBeDefined();
    expect(isZeroPrice(withheld.price)).toBe(false);
    expect(isUnknown(withheld.in_stock)).toBe(true);
    expect(withheld.commerce_verification).toEqual(expect.objectContaining({ required: true, status: 'live_quote_required' }));
    // Non-vacuous: the offer-level checks below must have offers to check.
    expect(Array.isArray(withheld.offers) && withheld.offers.length > 0).toBe(true);
    for (const offer of withheld.offers) {
      expect(isZeroPrice(offer.price)).toBe(false);
      expect(isUnknown(offer.availability?.in_stock)).toBe(true);
    }

    // CONTROL: a trusted row keeps its real price and stock through the same path.
    const priced = resp.body.products.find((p) => p.product_id === 'eyurs-com:df568001f820cfd7');
    expect(priced).toBeDefined();
    expect(Number(priced.price)).toBe(13);
    expect(priced.in_stock).toBe(true);
  });

  it('shopping-agent door: the price contract keeps the withheld row as verification-required, unpriced', async () => {
    mockUpstream([withheldRow(), pricedRow()]);
    const app = require('../../src/server');
    const resp = await invoke(app, { source: 'shopping_agent' });

    expect(resp.status).toBe(200);
    const withheld = resp.body.products.find((p) => p.product_id === 'round-lab:85dd4c56da58a259');
    expect(withheld).toBeDefined();
    expect(isZeroPrice(withheld.price)).toBe(false);
    expect(isUnknown(withheld.in_stock)).toBe(true);
    expect(resp.body.metadata.price_contract).toEqual(
      expect.objectContaining({ dropped_unpriced: 0, verification_required_unpriced_kept: 1 }),
    );
  });

  it('CONTROL: an unmarked row with no price is still dropped by the shopping-agent price contract', async () => {
    const { commerce_verification: _drop, ...unmarked } = withheldRow({ product_id: 'unmarked:1', dedupe_group_id: 'unmarked:1' });
    mockUpstream([unmarked, pricedRow()]);
    const app = require('../../src/server');
    const resp = await invoke(app, { source: 'shopping_agent' });

    expect(resp.status).toBe(200);
    expect(resp.body.products.find((p) => p.product_id === 'unmarked:1')).toBeUndefined();
    expect(resp.body.metadata.price_contract).toEqual(expect.objectContaining({ dropped_unpriced: 1 }));
  });
});
