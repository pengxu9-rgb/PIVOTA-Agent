'use strict';

// The JOIN is the whole safety argument of merchant variant sourcing: `search_catalog` only enumerates
// candidates, and the merchant PDP URL is what SELECTS one. A title match would silently buy the wrong
// product — the same class of defect as a forged variant id. These tests pin the join, not the plumbing.
//
// Shapes are taken from a live probe of murad.com (2026-08-27): products carry `url`, `handle`, and
// `variants[] { id: "gid://shopify/ProductVariant/…", sku, title }`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMerchantVariantSource, urlIdentity } = require('../src/services/merchantVariantSource');

const PDP = 'https://www.murad.com/products/deep-relief-acne-treatment';
const GID_A = 'gid://shopify/ProductVariant/51348961657135';
const GID_B = 'gid://shopify/ProductVariant/51348961689903';

function catalogProduct(url, variantIds) {
  return {
    id: 'gid://shopify/Product/9517125239087',
    title: 'Deep Relief Acne Treatment',
    url,
    handle: 'deep-relief-acne-treatment',
    variants: variantIds.map((id, i) => ({ id, sku: `sku-${i}`, title: `Pack ${i + 1}` })),
  };
}

function clientReturning(products, opts = {}) {
  return {
    discoverEndpoint: async () => opts.endpoint ?? 'https://murad-us.myshopify.com/api/ucp/mcp',
    searchCatalog: async (endpoint, args) => {
      if (opts.onSearch) opts.onSearch(endpoint, args);
      if (opts.throwOnSearch) throw new Error('merchant refused');
      return { products };
    },
  };
}

const seedRead = (over = {}) => ({
  product: {
    product_id: 'sig_seed_1',
    title: 'Deep Relief Acne Treatment',
    destination_url: PDP,
    // Pivota's own urls — these must never be used as the join key.
    url: 'https://agent.pivota.cc/products/sig_seed_1',
    canonical_url: 'https://agent.pivota.cc/products/sig_seed_1',
    ...over,
  },
});

test('urlIdentity normalises exactly the differences a crawl introduces, and nothing more', () => {
  const base = urlIdentity(PDP);
  assert.equal(base, 'murad.com/products/deep-relief-acne-treatment');
  // utm params, trailing slash, host case and www. are noise between our crawl and their catalogue
  assert.equal(urlIdentity(`${PDP}?utm_source=pivota&pvt_click_id=clk_1`), base);
  assert.equal(urlIdentity(`${PDP}/`), base);
  assert.equal(urlIdentity('https://MURAD.com/products/deep-relief-acne-treatment'), base);
  assert.equal(urlIdentity('https://murad.com/products/deep-relief-acne-treatment#reviews'), base);
  // ...but a DIFFERENT product or host is a different identity
  assert.notEqual(urlIdentity('https://www.murad.com/products/rapid-relief-acne-spot-treatment'), base);
  assert.notEqual(urlIdentity('https://www.sephora.com/products/deep-relief-acne-treatment'), base);
  // unusable input can never match unusable input
  for (const bad of ['', '   ', 'not a url', 'ftp://x/y', null, undefined, 42]) {
    assert.equal(urlIdentity(bad), null);
  }
});

test('an exact URL match returns the storefront variant ids', async () => {
  const src = createMerchantVariantSource({ ucpClient: clientReturning([catalogProduct(PDP, [GID_A])]) });
  assert.deepEqual(await src(seedRead(), 'sig_seed_1'), [GID_A]);
});

test('a URL that differs only by utm/case/slash still matches — that is the crawl-vs-catalogue gap', async () => {
  const src = createMerchantVariantSource({
    ucpClient: clientReturning([catalogProduct('https://murad.com/products/deep-relief-acne-treatment/', [GID_A])]),
  });
  const read = seedRead({ destination_url: `${PDP}?utm_source=pivota` });
  assert.deepEqual(await src(read, 'sig_seed_1'), [GID_A]);
});

test('NEVER a title match: a same-titled product at a DIFFERENT url returns nothing', async () => {
  const impostor = catalogProduct('https://www.murad.com/products/deep-relief-acne-treatment-travel', [GID_B]);
  const src = createMerchantVariantSource({ ucpClient: clientReturning([impostor]) });
  assert.equal(await src(seedRead(), 'sig_seed_1'), null,
    'identical title, different url — resolving this would buy the wrong SKU');
});

test('two catalogue entries publishing OUR url is ambiguous at the source: refuse', async () => {
  const src = createMerchantVariantSource({
    ucpClient: clientReturning([catalogProduct(PDP, [GID_A]), catalogProduct(PDP, [GID_B])]),
  });
  assert.equal(await src(seedRead(), 'sig_seed_1'), null);
});

test('multi-variant products return ALL real ids — the ambiguity is the caller\'s to refuse', async () => {
  const src = createMerchantVariantSource({ ucpClient: clientReturning([catalogProduct(PDP, [GID_A, GID_B])]) });
  assert.deepEqual(await src(seedRead(), 'sig_seed_1'), [GID_A, GID_B]);
});

test('Pivota\'s own urls are never used as the join key', async () => {
  let searched = false;
  const client = clientReturning([], { onSearch: () => { searched = true; } });
  // destination_url absent: only agent.pivota.cc urls remain on the row
  const src = createMerchantVariantSource({ ucpClient: client, selfHosts: ['agent.pivota.cc'] });
  const read = { product: { product_id: 'sig_seed_1', url: 'https://agent.pivota.cc/products/sig_seed_1', canonical_url: 'https://agent.pivota.cc/products/sig_seed_1' } };
  assert.equal(await src(read, 'sig_seed_1'), null);
  assert.equal(searched, false, 'no storefront call is made when the row names no merchant pdp');
});

test('a self-host that sneaks into destination_url is refused, not searched', async () => {
  let searched = false;
  const client = clientReturning([], { onSearch: () => { searched = true; } });
  const src = createMerchantVariantSource({ ucpClient: client, selfHosts: ['agent.pivota.cc'] });
  const read = seedRead({ destination_url: 'https://agent.pivota.cc/products/sig_seed_1', source_url: undefined, external_redirect_url: undefined });
  assert.equal(await src(read, 'sig_seed_1'), null);
  assert.equal(searched, false);
});

test('FAIL CLOSED on every unhappy path', async () => {
  const cases = {
    'search throws': clientReturning([], { throwOnSearch: true }),
    'no endpoint discovered': clientReturning([], { endpoint: '' }),
    'no products': clientReturning([]),
    'product has no variants': clientReturning([catalogProduct(PDP, [])]),
  };
  for (const [name, ucpClient] of Object.entries(cases)) {
    const src = createMerchantVariantSource({ ucpClient });
    assert.equal(await src(seedRead(), 'sig_seed_1'), null, name);
  }
  // discovery that hangs is bounded by the source's own deadline
  const hanging = { discoverEndpoint: () => new Promise(() => {}), searchCatalog: async () => ({ products: [] }) };
  const src = createMerchantVariantSource({ ucpClient: hanging, timeoutMs: 40 });
  assert.equal(await src(seedRead(), 'sig_seed_1'), null, 'timeout');
});

test('the flag gate short-circuits before any storefront contact', async () => {
  let searched = false;
  const client = clientReturning([catalogProduct(PDP, [GID_A])], { onSearch: () => { searched = true; } });
  const src = createMerchantVariantSource({ ucpClient: client, isEnabled: () => false });
  assert.equal(await src(seedRead(), 'sig_seed_1'), null);
  assert.equal(searched, false);
});

test('the search term is derived from the merchant handle, and never selects the product', async () => {
  let seenQuery = null;
  const client = clientReturning([catalogProduct(PDP, [GID_A])], { onSearch: (_e, args) => { seenQuery = args.query; } });
  const src = createMerchantVariantSource({ ucpClient: client });
  await src(seedRead(), 'sig_seed_1');
  assert.equal(seenQuery, 'deep relief acne treatment', 'handle text, not our crawled title');
});

test('a client missing the tools it needs fails at construction, not at checkout', () => {
  assert.throws(() => createMerchantVariantSource({}), /requires a ucp client/);
  assert.throws(() => createMerchantVariantSource({ ucpClient: { discoverEndpoint() {} } }), /requires a ucp client/);
});

// ---- the REAL wire shape ---------------------------------------------------------------------------------
// A hand-written fixture proves only that the code agrees with itself. This envelope is the VERBATIM
// `search_catalog` response from murad.com's live UCP endpoint (captured 2026-08-27, trimmed to the fields
// this module reads), unwrapped with the client's OWN `unwrapToolPayload` — so a merchant that changes which
// content shape it sends, or a drift between the client's unwrap and this module's walker, fails here.

test('the LIVE murad.com envelope yields its real variant gids through the real unwrapper', async () => {
  const envelope = require('./fixtures/ucp_search_catalog_murad.json');
  const { unwrapToolPayload } = require('../src/services/ucpBuyerAgentClient');
  const src = createMerchantVariantSource({
    ucpClient: {
      discoverEndpoint: async () => 'https://murad-us.myshopify.com/api/ucp/mcp',
      searchCatalog: async () => envelope,
    },
    unwrap: unwrapToolPayload,
  });
  const ids = await src(seedRead(), 'sig_seed_1');
  assert.ok(Array.isArray(ids) && ids.length === 2, `expected the 2 live variants, got ${JSON.stringify(ids)}`);
  for (const id of ids) assert.match(id, /^gid:\/\/shopify\/ProductVariant\/\d+$/);
  // and the ids are DISTINCT real identities, not the product id restated
  assert.equal(new Set(ids).size, 2);
});

test('the server wiring consumes this module — the delivery line is pinned', () => {
  // #1898: the fix is only real on the line that WIRES it. Reverting the server.js hook would leave every
  // test above green while no checkout ever consulted a storefront.
  const fs = require('node:fs');
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(server, /sourceMerchantVariants: isMerchantVariantSourcingEnabled\(\)\s*\n\s*\? buildMerchantVariantSource\(logger\)/,
    'the commerce surface must receive the source, gated by the flag');
  assert.match(server, /createMerchantVariantSource\(\{/, 'the builder must construct the real source');
  assert.match(server, /unwrap: unwrapToolPayload/, 'and unwrap with the client\'s own envelope reader, not a copy');
  const surface = fs.readFileSync(require.resolve('../mcp-server/src/commerceToolSurface'), 'utf8');
  assert.match(surface, /createDefaultVariantResolver\(\{ executor, sourceMerchantVariants \}\)/,
    'the surface must thread it into the resolver');
});
