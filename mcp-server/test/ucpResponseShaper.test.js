// The UCP RESPONSE shaper — native search result -> the spec's catalog_search response — driven two ways:
// as a pure function, and through the real commerce surface + UCP projection, so the wiring (after the
// cache, per dialect, on a clone) is proven rather than described.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  shapeUcpProduct,
  shapeUcpSearchResponse,
  shapeUcpResult,
  encodeSearchCursor,
  decodeSearchCursor,
  UCP_RESPONSE_VERSION,
  UCP_SHAPED_OPERATION_IDS,
} from '../src/ucpResponseShaper.js';
import { createCommerceToolSurface, ucpDialectSurface } from '../src/commerceToolSurface.js';
import { canonicalOpForUcpTool } from '../../safety-kernel/src/protocol/canonicalContract.js';

const AGENT_META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' } };
const SESSION = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };

// A representative NATIVE search row, in the shape the public projector already reads (product_id/sig,
// brand, title, category, price in MAJOR units, currency, availability string, image_url).
const ROW = Object.freeze({
  product_id: 'sig_615cde705e4be2eaf7eea5f25b391728',
  pivota_signature_id: 'sig_615cde705e4be2eaf7eea5f25b391728',
  brand: 'Good Molecules',
  title: 'Niacinamide Serum',
  category: 'Serum',
  price: 25.99,
  currency: 'USD',
  availability: 'in_stock',
  in_stock: false, // deliberately CONTRADICTS the string — the string must win (verified stale boolean, prod 2026-08-01)
  image_url: 'https://cdn.example/niacinamide.jpg',
  description: 'A 10% niacinamide serum.',
  merchant_id: 'merch_obs_deadbeef', // internal — must NOT appear anywhere in the UCP product
});

// ---- 1. the spec's required arrays, transcribed with provenance ---------------------------------------------

describe('the published response matches the spec, field for field', () => {
  // PROVENANCE: fetched 2026-08-18 from https://ucp.dev/2026-04-08/schemas/shopping/catalog_search.json and
  // its $refs. These `required` arrays are the spec's, transcribed verbatim (see the module header).
  const REQUIRED = Object.freeze({
    search_response: ['ucp', 'products'],
    ucp: ['version'],
    product: ['id', 'title', 'description', 'price_range', 'variants'],
    variant: ['id', 'title', 'description', 'price'],
    price_range: ['min', 'max'],
    price: ['amount', 'currency'],
    media: ['type', 'url'],
    category: ['value'],
    pagination: ['has_next_page'],
    message_warning: ['type', 'code', 'content'],
    message_info: ['type', 'content'],
  });
  const hasAll = (obj, keys, label) => {
    for (const k of keys) assert.ok(obj && Object.prototype.hasOwnProperty.call(obj, k), `${label}: missing required "${k}"`);
  };

  test('a full response carries every required member at every level', () => {
    const out = shapeUcpSearchResponse(
      { products: [ROW, { ...ROW, product_id: 'sig_2', pivota_signature_id: 'sig_2', title: 'Second' }], total: 15 },
      { params: { payload: { search: { query: 'niacinamide', page_size: 2 } } }, ucpArgs: { meta: AGENT_META, catalog: { query: 'niacinamide' } } },
    );
    hasAll(out, REQUIRED.search_response, 'search_response');
    hasAll(out.ucp, REQUIRED.ucp, 'ucp');
    assert.equal(out.ucp.version, UCP_RESPONSE_VERSION);
    assert.equal(out.ucp.status, 'success');
    assert.equal(out.products.length, 2);
    for (const p of out.products) {
      hasAll(p, REQUIRED.product, 'product');
      hasAll(p.price_range, REQUIRED.price_range, 'price_range');
      hasAll(p.price_range.min, REQUIRED.price, 'price');
      assert.ok(Array.isArray(p.variants) && p.variants.length >= 1, 'variants minItems 1');
      for (const v of p.variants) {
        hasAll(v, REQUIRED.variant, 'variant');
        hasAll(v.price, REQUIRED.price, 'variant.price');
      }
      for (const m of p.media ?? []) hasAll(m, REQUIRED.media, 'media');
      for (const c of p.categories ?? []) hasAll(c, REQUIRED.category, 'category');
    }
    hasAll(out.pagination, REQUIRED.pagination, 'pagination');
  });

  test('`amount` is an INTEGER in ISO 4217 minor units, minimum 0 — 25.99 USD is 2599, ¥1500 is 1500, BHD 1.5 is 1500', () => {
    const usd = shapeUcpProduct(ROW).product;
    assert.deepEqual(usd.price_range.min, { amount: 2599, currency: 'USD' });
    assert.deepEqual(usd.price_range.max, { amount: 2599, currency: 'USD' });
    assert.deepEqual(usd.variants[0].price, { amount: 2599, currency: 'USD' });
    assert.ok(Number.isInteger(usd.price_range.min.amount));

    const jpy = shapeUcpProduct({ ...ROW, price: 1500, currency: 'JPY' }).product;
    assert.deepEqual(jpy.price_range.min, { amount: 1500, currency: 'JPY' });
    const bhd = shapeUcpProduct({ ...ROW, price: 1.5, currency: 'BHD' }).product;
    assert.deepEqual(bhd.price_range.min, { amount: 1500, currency: 'BHD' });
    // UGX is ISO exponent 0 (the CHARGE table says 2): a 5000-shilling price is 5000 minor units, not 500000.
    const ugx = shapeUcpProduct({ ...ROW, price: 5000, currency: 'UGX' }).product;
    assert.deepEqual(ugx.price_range.min, { amount: 5000, currency: 'UGX' });
    // A price that is a string ("19.99") in the row still converts; a free item is 0, not dropped.
    assert.equal(shapeUcpProduct({ ...ROW, price: '19.99' }).product.price_range.min.amount, 1999);
    assert.equal(shapeUcpProduct({ ...ROW, price: 0 }).product.price_range.min.amount, 0);
  });

  test('a message is a spec `warning` or `info` with its required members, and never anything else', () => {
    const out = shapeUcpSearchResponse(
      { products: [ROW, { ...ROW, price: undefined }] },
      { params: { payload: { search: {} } }, ucpArgs: { meta: AGENT_META, catalog: { filters: { categories: ['skincare'] } } } },
    );
    assert.ok(Array.isArray(out.messages) && out.messages.length === 2);
    for (const m of out.messages) {
      assert.ok(['warning', 'info'].includes(m.type), `unexpected message type ${m.type}`);
      hasAll(m, m.type === 'warning' ? REQUIRED.message_warning : REQUIRED.message_info, `message_${m.type}`);
    }
  });
});

// ---- 2. what maps, and what deliberately does not -------------------------------------------------------------

describe('one native row -> one UCP product', () => {
  test('the sig id is BOTH the product id and its single variant id — the id a checkout line item accepts', () => {
    const { product } = shapeUcpProduct(ROW);
    assert.equal(product.id, ROW.pivota_signature_id);
    assert.equal(product.variants.length, 1);
    assert.equal(product.variants[0].id, product.id);
    // and the canonical PDP is CONSTRUCTED from it, never read off a row URL field
    assert.equal(product.url, `https://agent.pivota.cc/products/${ROW.pivota_signature_id}`);
    assert.equal(product.variants[0].url, product.url);
  });

  test('brand rides in metadata (UCP has no brand member) and is never folded into the title', () => {
    const { product } = shapeUcpProduct(ROW);
    assert.equal(product.title, 'Niacinamide Serum');
    assert.deepEqual(product.metadata, { brand: 'Good Molecules' });
    assert.equal(JSON.stringify(product).includes('Good Molecules Niacinamide'), false);
  });

  test('availability: the STRING wins over a contradicting in_stock boolean; unknown is OMITTED, not guessed', () => {
    assert.deepEqual(shapeUcpProduct(ROW).product.variants[0].availability, { available: true, status: 'in_stock' });
    assert.deepEqual(
      shapeUcpProduct({ ...ROW, availability: 'sold out', in_stock: true }).product.variants[0].availability,
      { available: false, status: 'out_of_stock' },
    );
    assert.deepEqual(
      shapeUcpProduct({ ...ROW, availability: 'discontinued' }).product.variants[0].availability,
      { available: false, status: 'discontinued' },
    );
    // no string -> the boolean still carries signal
    assert.deepEqual(shapeUcpProduct({ ...ROW, availability: undefined, in_stock: true }).product.variants[0].availability, { available: true, status: 'in_stock' });
    // neither -> omitted (the schema does not require it; a guess would be published as fact)
    assert.equal(shapeUcpProduct({ ...ROW, availability: 'unknown', in_stock: undefined }).product.variants[0].availability, undefined);
  });

  test('description is `{plain}` when the row has prose and `{}` when it does not — never a fabricated sentence', () => {
    assert.deepEqual(shapeUcpProduct(ROW).product.description, { plain: 'A 10% niacinamide serum.' });
    assert.deepEqual(shapeUcpProduct({ ...ROW, description: undefined }).product.description, {});
    assert.deepEqual(shapeUcpProduct({ ...ROW, description: undefined, summary_short: 'Short.' }).product.description, { plain: 'Short.' });
  });

  test('a row with no title gets brand, then id — a true statement, not an invented title', () => {
    assert.equal(shapeUcpProduct({ ...ROW, title: undefined }).product.title, 'Good Molecules');
    assert.equal(shapeUcpProduct({ ...ROW, title: undefined, brand: undefined }).product.title, ROW.pivota_signature_id);
  });

  test('media and category are optional and omitted when absent; a category is `{value}`', () => {
    const { product } = shapeUcpProduct(ROW);
    assert.deepEqual(product.media, [{ type: 'image', url: ROW.image_url }]);
    assert.deepEqual(product.categories, [{ value: 'Serum' }]);
    const bare = shapeUcpProduct({ ...ROW, image_url: undefined, category: undefined }).product;
    assert.equal(bare.media, undefined);
    assert.equal(bare.categories, undefined);
    assert.equal(bare.variants[0].media, undefined);
  });

  test('a row with NO price, or a price with NO currency, cannot be a spec product and is DROPPED with a reason', () => {
    assert.deepEqual(shapeUcpProduct({ ...ROW, price: undefined }), { product: undefined, dropped: 'no_price' });
    assert.deepEqual(shapeUcpProduct({ ...ROW, price: null }), { product: undefined, dropped: 'no_price' });
    assert.deepEqual(shapeUcpProduct({ ...ROW, currency: undefined }), { product: undefined, dropped: 'no_price' });
    assert.deepEqual(shapeUcpProduct({ ...ROW, price: -1 }), { product: undefined, dropped: 'no_price' });
    assert.deepEqual(shapeUcpProduct({ ...ROW, product_id: undefined, pivota_signature_id: undefined, id: undefined }), { product: undefined, dropped: 'no_id' });
    assert.deepEqual(shapeUcpProduct('not a row'), { product: undefined, dropped: 'not_a_row' });
  });

  test('internal fields never leak into the UCP product', () => {
    const wire = JSON.stringify(shapeUcpProduct({
      ...ROW, merchant_id: 'merch_obs_LEAK', product_key: 'prod::LEAK', ingredient_intel: { x: 'LEAK_INTEL' },
      destination_url: 'https://reseller.example/LEAK', pivota_canonical_url: 'https://reseller.example/LEAK2',
    }).product);
    for (const s of ['LEAK', 'merch_obs', 'prod::', 'reseller.example']) {
      assert.equal(wire.includes(s), false, `${s} must not be published`);
    }
  });
});

// ---- 3. pagination is COMPUTED, and the cursor round-trips ----------------------------------------------------

describe('pagination', () => {
  const rows = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ ...ROW, product_id: `sig_${from + i}`, pivota_signature_id: `sig_${from + i}` }));
  const shape = (native, search = {}) => shapeUcpSearchResponse(native, { params: { payload: { search } }, ucpArgs: { meta: AGENT_META, catalog: {} } });

  test('with a total: has_next_page is page*page_size < total, cursor present exactly when true, total_count echoed', () => {
    const p1 = shape({ products: rows(10), total: 25 }, { page_size: 10 });
    assert.equal(p1.pagination.has_next_page, true);
    assert.equal(p1.pagination.total_count, 25);
    assert.equal(decodeSearchCursor(p1.pagination.cursor), 2, 'the cursor continues to page 2');
    const p3 = shape({ products: rows(5, 21), total: 25 }, { page_size: 10, page: 3 });
    assert.deepEqual(p3.pagination, { has_next_page: false, total_count: 25 }, 'last page: no cursor');
    // exactly full: 2 pages of 10 with total 20 -> page 2 has NO next page
    assert.equal(shape({ products: rows(10, 11), total: 20 }, { page_size: 10, page: 2 }).pagination.has_next_page, false);
    // page 1 with a cursor-derived page 2 request continues to 3
    assert.equal(decodeSearchCursor(shape({ products: rows(10, 11), total: 30 }, { page_size: 10, page: 2 }).pagination.cursor), 3);
  });

  test('without a total: only a FULL page can claim a next page; without a page_size, nothing is claimed', () => {
    assert.equal(shape({ products: rows(10) }, { page_size: 10 }).pagination.has_next_page, true);
    assert.equal(shape({ products: rows(7) }, { page_size: 10 }).pagination.has_next_page, false);
    assert.equal(shape({ products: rows(0) }, { page_size: 10 }).pagination.has_next_page, false);
    // No page_size and no total: we do not know the lane's page size, so we do not claim a next page.
    assert.deepEqual(shape({ products: rows(20) }).pagination, { has_next_page: false });
  });

  test('has_next_page is computed from what the LANE returned, not from what survived our drops', () => {
    // 10 rows returned, 3 unpriced -> 7 published, but the lane's page was full, so there IS a next page.
    const native = { products: [...rows(7), ...rows(3, 8).map((r) => ({ ...r, price: undefined }))], total: 30 };
    const out = shape(native, { page_size: 10 });
    assert.equal(out.products.length, 7);
    assert.equal(out.pagination.has_next_page, true);
    assert.equal(out.messages.find((m) => m.code === 'products.omitted_no_price').content.startsWith('3 matching products omitted'), true);
    // …and WITHOUT a total, where the count IS the arithmetic: the lane returned a full page of 10 (7 priced),
    // so there may be more — a shaper counting the 7 it published would say "no more" and truncate the
    // caller's pagination at the first page that happened to carry unpriced rows.
    const noTotal = shape({ products: native.products }, { page_size: 10 });
    assert.equal(noTotal.products.length, 7);
    assert.equal(noTotal.pagination.has_next_page, true, 'a full LANE page has a next page even when rows were dropped');
    assert.equal(decodeSearchCursor(noTotal.pagination.cursor), 2);
  });

  test('the cursor is opaque, versioned, bounded and round-trips; page 1 is never a cursor', () => {
    for (const p of [2, 3, 50, 100000]) assert.equal(decodeSearchCursor(encodeSearchCursor(p)), p);
    assert.equal(encodeSearchCursor(1), undefined, 'page 1 is the start, not a continuation');
    assert.equal(encodeSearchCursor(0), undefined);
    assert.equal(encodeSearchCursor(100001), undefined, 'bounded');
    assert.equal(encodeSearchCursor(2.5), undefined);
    assert.equal(decodeSearchCursor(''), undefined);
    assert.equal(decodeSearchCursor('not-base64url-json'), undefined);
    assert.equal(decodeSearchCursor(Buffer.from('{"v":1,"page":1}').toString('base64url')), undefined, 'a forged page-1 cursor is refused');
    assert.equal(decodeSearchCursor(Buffer.from('{"v":9,"page":2}').toString('base64url')), undefined, 'unknown version');
    assert.equal(decodeSearchCursor(Buffer.from('{"v":1,"page":"2"}').toString('base64url')), undefined, 'page must be an integer');
    assert.equal(decodeSearchCursor(`${'A'.repeat(65)}`), undefined, 'over-long token');
    assert.equal(decodeSearchCursor(42), undefined);
    // Opaque: the token is not JSON and does not carry its field names in the clear.
    assert.throws(() => JSON.parse(encodeSearchCursor(2)));
    assert.equal(encodeSearchCursor(2).includes('page'), false);
    assert.match(encodeSearchCursor(2), /^[A-Za-z0-9_-]+$/, 'base64url alphabet only');
  });
});

// ---- 4. messages say what was NOT done ------------------------------------------------------------------------

describe('messages', () => {
  const shape = (native, catalog) => shapeUcpSearchResponse(native, { params: { payload: { search: {} } }, ucpArgs: { meta: AGENT_META, catalog } });

  test('sending filters.categories earns a WARNING that it was not applied — silence would read as "applied"', () => {
    const out = shape({ products: [ROW] }, { query: 'q', filters: { categories: ['skincare'] } });
    const w = out.messages.find((m) => m.type === 'warning');
    assert.equal(w.code, 'filters.categories_not_applied');
    assert.equal(w.path, '$.filters.categories');
    assert.match(w.content, /not narrowed by category/);
    // …and NO warning when categories were not sent (empty array counts as not sent).
    assert.equal(shape({ products: [ROW] }, { query: 'q' }).messages, undefined);
    assert.equal(shape({ products: [ROW] }, { query: 'q', filters: { categories: [] } }).messages, undefined);
  });

  test('`messages` is OMITTED entirely when there is nothing to say', () => {
    const out = shape({ products: [ROW], total: 1 }, { query: 'q' });
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'messages'), false);
  });
});

// ---- 5. wiring: through the real surface, per dialect, after the cache, on a clone ---------------------------

describe('the shaper is applied on the UCP dialect only, after the shared cache, and never mutates the cached value', () => {
  const NATIVE = Object.freeze({ products: [ROW], total: 1, page: 1 });
  function executorReturning(value) {
    const seen = [];
    return {
      seen,
      async execute(op, params) { seen.push({ op, params }); return structuredClone(value); },
    };
  }

  test('search_catalog is shaped on /ucp and NATIVE on /mcp for the SAME query — one executor call, one cache entry', async () => {
    const executor = executorReturning(NATIVE);
    const native = createCommerceToolSurface(executor, { cache: true });
    const ucp = ucpDialectSurface(native);

    const viaUcp = await ucp.callTool('search_catalog', { meta: AGENT_META, catalog: { query: 'niacinamide' } }, SESSION);
    assert.equal(viaUcp.ucp.version, UCP_RESPONSE_VERSION, 'UCP dialect returns the spec envelope');
    assert.equal(viaUcp.products[0].price_range.min.amount, 2599);
    assert.equal(executor.seen.length, 1);

    const viaMcp = await native.callTool('search_catalog', { query: 'niacinamide' }, SESSION);
    assert.equal(executor.seen.length, 1, 'the /mcp call was served from the entry the UCP call populated');
    assert.equal(viaMcp.ucp, undefined, 'the NATIVE dialect is NOT shaped');
    assert.equal(viaMcp.products[0].price, 25.99, 'native keeps MAJOR units');
    assert.equal(viaMcp.products[0].merchant_id, 'merch_obs_deadbeef', 'native keeps its own fields');

    // …and the reverse order: a UCP read of an entry /mcp populated is still shaped, and still one call.
    const viaUcp2 = await ucp.callTool('search_catalog', { meta: AGENT_META, catalog: { query: 'niacinamide' } }, SESSION);
    assert.equal(executor.seen.length, 1);
    assert.equal(viaUcp2.ucp.version, UCP_RESPONSE_VERSION);
    assert.equal(viaUcp2.products[0].price_range.min.amount, 2599);
  });

  test('the shaper does not mutate its input (a cache entry must stay native for the next reader)', () => {
    const input = structuredClone(NATIVE);
    const before = JSON.stringify(input);
    shapeUcpSearchResponse(input, { params: { payload: { search: {} } }, ucpArgs: { meta: AGENT_META, catalog: {} } });
    assert.equal(JSON.stringify(input), before);
  });

  test('only search_catalog is shaped today; other ops pass through native (get_product remains native)', () => {
    assert.deepEqual([...UCP_SHAPED_OPERATION_IDS], ['search_catalog']);
    const getProduct = canonicalOpForUcpTool('get_product');
    const passthrough = { product: { product_id: 'sig_x' } };
    assert.equal(shapeUcpResult(getProduct, passthrough, {}), passthrough);
  });

  test('a native error result is not dressed up as a success envelope', async () => {
    // The surface throws on failures (never returns an error body), so the shaper only ever sees successes;
    // pin that a thrown executor error still surfaces as a throw on the UCP dialect, not as `{ucp,products}`.
    const executor = { async execute() { throw new Error('upstream down'); } };
    const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
    await assert.rejects(ucp.callTool('search_catalog', { meta: AGENT_META, catalog: { query: 'q' } }, SESSION));
  });
});
