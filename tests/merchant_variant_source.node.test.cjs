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

// THE DOUBLE MUST NOT INVENT THE SHAPE. The first revision's fake returned a bare endpoint string, which
// `createUcpBuyerAgentClient` has NEVER emitted (it answers `{ mcpEndpoint, businessProfile, wellKnownUrl,
// status }`), and the source read a `.endpoint` key that does not exist — so every test passed while the
// feature was a no-op in production. `realClientOver` builds the ACTUAL client over an injected fetch, so
// discovery shape is the client's own; `clientReturning` is kept only for cases that need to force a
// failure, and its discovery return is pinned against the real one by the contract test below.
const { createUcpBuyerAgentClient, unwrapToolPayload } = require('../src/services/ucpBuyerAgentClient');

const MCP_ENDPOINT = 'https://murad-us.myshopify.com/api/ucp/mcp';

function wellKnownBody() {
  return {
    ucp: {
      version: '2026-04-08',
      services: { 'dev.ucp.shopping': [{ version: '2026-04-08', transport: 'mcp', endpoint: MCP_ENDPOINT }] },
    },
  };
}

/** The real client, with only the network replaced. Discovery therefore returns the client's real shape. */
function realClientOver(products, opts = {}) {
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('/.well-known/ucp')) {
      return { ok: true, status: 200, json: async () => wellKnownBody(), text: async () => JSON.stringify(wellKnownBody()) };
    }
    if (opts.onSearch) opts.onSearch(u, JSON.parse(String(init?.body || '{}')));
    if (opts.throwOnSearch) throw new Error('merchant refused');
    const payload = { result: { content: [{ type: 'text', text: JSON.stringify({ products }) }] } };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return createUcpBuyerAgentClient({ fetchImpl, timeoutMs: 2000, retryAttempts: 0 });
}

function clientReturning(products, opts = {}) {
  return {
    discoverEndpoint: async () => (
      'endpoint' in opts ? { mcpEndpoint: opts.endpoint } : { mcpEndpoint: MCP_ENDPOINT }
    ),
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
  // A HANGING merchant must be bounded by the source's own deadline — and the deadline must actually FIRE
  // when nothing else keeps the event loop alive, which is exactly what an `unref()`d timer breaks (CI caught
  // that: "Promise resolution is still pending but the event loop has already resolved"). Asserting elapsed
  // time pins the deadline as a real wall-clock bound rather than a hope.
  const hanging = { discoverEndpoint: () => new Promise(() => {}), searchCatalog: async () => ({ products: [] }) };
  const src = createMerchantVariantSource({ ucpClient: hanging, timeoutMs: 40 });
  const startedAt = Date.now();
  assert.equal(await src(seedRead(), 'sig_seed_1'), null, 'timeout');
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 35, `the deadline must actually elapse (got ${elapsed}ms)`);
  assert.ok(elapsed < 5000, `and must not wait on the hanging call (got ${elapsed}ms)`);
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
  const src = createMerchantVariantSource({
    ucpClient: { discoverEndpoint: async () => ({ mcpEndpoint: MCP_ENDPOINT }), searchCatalog: async () => envelope },
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
  assert.match(server, /sourceMerchantVariants: buildMerchantVariantSource\(logger\)/,
    'the commerce surface must receive the source');
  assert.match(server, /createMerchantVariantSource\(\{/, 'the builder must construct the real source');
  assert.match(server, /unwrap: unwrapToolPayload/, 'and unwrap with the client\'s own envelope reader, not a copy');
  assert.match(server, /isEnabled: isMerchantVariantSourcingEnabled/,
    'the flag must be a THUNK so it stays a live kill switch, not frozen at construction');
  const surface = fs.readFileSync(require.resolve('../mcp-server/src/commerceToolSurface'), 'utf8');
  // BOTH doors: native create_checkout_session and the UCP checkout door. UCP needs it more — a UCP item.id
  // carries a product id only — and the first revision threaded only the native one.
  const threaded = surface.match(/createDefaultVariantResolver\(\{[^}]*sourceMerchantVariants[^}]*\}\)/g) || [];
  assert.equal(threaded.length, 2,
    `both resolver call sites must receive the source (found ${threaded.length})`);
});

test('the deadline fires on a QUIET event loop — the unref regression, reproduced deterministically', () => {
  // An `unref()`d deadline does not hold the loop open, so when the merchant call is the only pending work
  // the loop drains and the timeout NEVER fires: the lookup hangs and the caller's refusal never arrives.
  // Inside node:test that is invisible — the runner's own handles keep the loop alive, so the mutant passes.
  // CI caught it because the file ran with a quiet loop. This runs the hanging lookup in a CHILD process with
  // nothing else pending, which is that condition on purpose: ref'd -> prints "null"; unref'd -> the child
  // drains and prints nothing. Without this, restoring `t.unref()` is a surviving mutant.
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const modulePath = path.join(__dirname, '..', 'src', 'services', 'merchantVariantSource.js');
  const script = `
    const { createMerchantVariantSource } = require(${JSON.stringify(modulePath)});
    const src = createMerchantVariantSource({
      ucpClient: { discoverEndpoint: () => new Promise(() => {}), searchCatalog: async () => ({}) },
      timeoutMs: 50,
    });
    src({ product: { product_id: 'p', destination_url: 'https://shop.example/products/a' } }, 'p')
      .then((v) => process.stdout.write(String(v)));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 }).trim();
  assert.equal(out, 'null',
    'the child printed nothing: its loop drained before the deadline fired (the timer is unref\'d)');
});

// ---- the three defects an adversarial review found, each pinned ------------------------------------------

test('BLOCKER 1: it works against the REAL client — discovery shape is never invented', async () => {
  // The first revision read `discovery.endpoint`; the client emits `{ mcpEndpoint, … }`. Both doubles had
  // invented a bare string, so the suite was green while the feature was a production no-op. This drives the
  // ACTUAL createUcpBuyerAgentClient over an injected fetch: nothing here can invent a shape.
  const src = createMerchantVariantSource({
    ucpClient: realClientOver([catalogProduct(PDP, [GID_A])]),
    unwrap: unwrapToolPayload,
  });
  assert.deepEqual(await src(seedRead(), 'sig_seed_1'), [GID_A]);
});

test('BLOCKER 1b: the double\'s discovery shape matches what the real client returns', async () => {
  const real = await realClientOver([]).discoverEndpoint('https://www.murad.com');
  const fake = await clientReturning([]).discoverEndpoint('https://www.murad.com');
  assert.deepEqual(Object.keys(fake), ['mcpEndpoint'], 'the fake exposes only keys the real client also has');
  assert.ok(Object.prototype.hasOwnProperty.call(real, 'mcpEndpoint'),
    'and mcpEndpoint is the key the real client actually publishes');
  assert.equal(typeof real.mcpEndpoint, 'string');
});

test('BLOCKER 2: a truncated walk can never assert uniqueness — it refuses', async () => {
  // Two entries carry OUR url, with enough filler between them that the second sits past the candidate cap.
  // Answering from a partial view would resolve to whichever copy the walk reached first — possibly an
  // archived listing with a stale SKU. The verdict must not depend on catalogue size.
  const filler = Array.from({ length: 40 }, (_, i) =>
    catalogProduct(`https://www.murad.com/products/filler-${i}`, [`gid://shopify/ProductVariant/9${i}`]));
  const products = [catalogProduct(PDP, [GID_A]), ...filler, catalogProduct(PDP, [GID_B])];
  const src = createMerchantVariantSource({ ucpClient: clientReturning(products) });
  assert.equal(await src(seedRead(), 'sig_seed_1'), null,
    'a duplicate hidden past the cap must not become a confident answer');
  // and the same two entries adjacent (no truncation) still refuse, for the ordinary reason
  const adjacent = [catalogProduct(PDP, [GID_A]), catalogProduct(PDP, [GID_B])];
  assert.equal(await createMerchantVariantSource({ ucpClient: clientReturning(adjacent) })(seedRead(), 'sig_seed_1'), null);
});

test('BLOCKER 3: a crawled ?variant= pins the SKU — never resolved to a sibling', async () => {
  const pdpWithVariant = `${PDP}?variant=51348961657135`;
  // the catalogue publishes both variants; only the pinned one may be returned
  const src = createMerchantVariantSource({ ucpClient: clientReturning([catalogProduct(PDP, [GID_A, GID_B])]) });
  assert.deepEqual(await src(seedRead({ destination_url: pdpWithVariant }), 'sig_seed_1'), [GID_A],
    'the row was crawled, priced and displayed as this variant');

  // if the catalogue no longer publishes the pinned variant, REFUSE rather than substitute a sibling
  const gone = createMerchantVariantSource({ ucpClient: clientReturning([catalogProduct(PDP, [GID_B])]) });
  assert.equal(await gone(seedRead({ destination_url: pdpWithVariant }), 'sig_seed_1'), null,
    'substituting the surviving variant would open a checkout on a different SKU than was displayed');

  // the hint is matched on the id's trailing segment, anchored — never a substring
  const { idNamesVariant, variantHintOf } = require('../src/services/merchantVariantSource');
  assert.equal(variantHintOf(pdpWithVariant), '51348961657135');
  assert.equal(variantHintOf(`${PDP}?utm_source=pivota`), null);
  assert.equal(idNamesVariant(GID_A, '51348961657135'), true);
  assert.equal(idNamesVariant(GID_A, '1657135'), false, 'a substring of the id must not satisfy the pin');
  assert.equal(idNamesVariant(GID_A, '51348961689903'), false);
});

test('the source memo collapses CONCURRENT lookups only — the sequential case is the caller\'s job', async () => {
  // Stated as narrowly as the code delivers. The first revision asserted this with Promise.all and then
  // claimed in a comment that it bounded a 50-line cart; the resolver calls sequentially, so it bounded
  // nothing there. The per-cart guarantee is pinned in the safety-kernel suite, against the real loop.
  let searches = 0;
  const client = clientReturning([catalogProduct(PDP, [GID_A])], { onSearch: () => { searches += 1; } });
  const src = createMerchantVariantSource({ ucpClient: client });
  const read = seedRead();
  const results = await Promise.all([src(read, 'sig_seed_1'), src(read, 'sig_seed_1'), src(read, 'sig_seed_1')]);
  for (const r of results) assert.deepEqual(r, [GID_A]);
  assert.equal(searches, 1, 'concurrent lines for one product share a single lookup');
});

test('a nested `related_products` response still RESOLVES — the candidate cap no longer walls it off', async () => {
  // Review finding: with a 25-node candidate cap, a routine catalogue of 9 products each nesting 2
  // recommendations is 27 product-shaped nodes -> truncated -> refuse. The flag could have been armed and
  // resolved almost nothing. Only the visit budget bounds the walk now.
  const products = Array.from({ length: 9 }, (_, i) => ({
    ...catalogProduct(i === 4 ? PDP : `https://www.murad.com/products/other-${i}`, [`gid://shopify/ProductVariant/7${i}`]),
    related_products: [
      catalogProduct(`https://www.murad.com/products/rel-${i}-a`, [`gid://shopify/ProductVariant/8${i}1`]),
      catalogProduct(`https://www.murad.com/products/rel-${i}-b`, [`gid://shopify/ProductVariant/8${i}2`]),
    ],
  }));
  const src = createMerchantVariantSource({ ucpClient: clientReturning(products) });
  assert.deepEqual(await src(seedRead(), 'sig_seed_1'), ['gid://shopify/ProductVariant/74']);
});

test('a generic ?variant= value is NOT a pin — only Shopify\'s numeric id shape is', async () => {
  const { variantHintOf } = require('../src/services/merchantVariantSource');
  for (const v of ['large', 'us', 'mobile', 'true', '12abc']) {
    assert.equal(variantHintOf(`${PDP}?variant=${v}`), null, `?variant=${v} must not pin`);
  }
  assert.equal(variantHintOf(`${PDP}?variant=51348961657135`), '51348961657135');
  // and a row carrying a generic value still resolves rather than refusing
  const src = createMerchantVariantSource({ ucpClient: clientReturning([catalogProduct(PDP, [GID_A])]) });
  assert.deepEqual(await src(seedRead({ destination_url: `${PDP}?variant=large` }), 'sig_seed_1'), [GID_A]);
});

// ---- pilot scoping: a named brand is contacted, every other merchant is not -------------------------------

test('brand matching covers subdomains and www, never a non-boundary suffix', () => {
  const { hostMatchesBrand, brandAllowlistMatcher } = require('../src/services/merchantVariantSource');
  // the PDPs we crawl are www.murad.com; a pilot should be able to write "murad.com"
  assert.equal(hostMatchesBrand('www.murad.com', 'murad.com'), true);
  assert.equal(hostMatchesBrand('murad.com', 'murad.com'), true);
  assert.equal(hostMatchesBrand('shop.murad.com', 'murad.com'), true);
  assert.equal(hostMatchesBrand('MURAD.com', 'murad.com'), true);
  assert.equal(hostMatchesBrand('murad.com', 'www.murad.com'), true, 'a brand written with www still matches');
  assert.equal(hostMatchesBrand('murad.com', '.murad.com'), true, 'a leading dot is tolerated');
  // the dangerous near-misses
  assert.equal(hostMatchesBrand('notmurad.com', 'murad.com'), false);
  assert.equal(hostMatchesBrand('murad.com.evil.test', 'murad.com'), false);
  assert.equal(hostMatchesBrand('murad.co', 'murad.com'), false);
  assert.equal(hostMatchesBrand('', 'murad.com'), false);
  assert.equal(hostMatchesBrand('murad.com', ''), false);
  // parsing
  const m = brandAllowlistMatcher(' murad.com , www.cosrx.com ,, ');
  assert.deepEqual(m.brands, ['murad.com', 'cosrx.com']);
  assert.equal(m.isAllowed('www.murad.com'), true);
  assert.equal(m.isAllowed('theordinary.com'), false);
  assert.deepEqual(brandAllowlistMatcher('').brands, [], 'empty list parses to no brands');
  assert.equal(brandAllowlistMatcher('').isAllowed('murad.com'), false, 'empty list allows NOTHING');
});

test('a non-piloted merchant receives NO outbound traffic at all', async () => {
  let contacted = false;
  const client = clientReturning([catalogProduct(PDP, [GID_A])], { onSearch: () => { contacted = true; } });
  const src = createMerchantVariantSource({
    ucpClient: { ...client, discoverEndpoint: async () => { contacted = true; return { mcpEndpoint: MCP_ENDPOINT }; } },
    isBrandAllowed: (host) => host === 'cosrx.com',
  });
  assert.equal(await src(seedRead(), 'sig_seed_1'), null, 'murad is not in this pilot');
  assert.equal(contacted, false, 'scope is checked BEFORE discovery — not one request is sent');
});

test('the piloted merchant resolves normally', async () => {
  const src = createMerchantVariantSource({
    ucpClient: clientReturning([catalogProduct(PDP, [GID_A])]),
    isBrandAllowed: (host) => host === 'murad.com',
  });
  assert.deepEqual(await src(seedRead(), 'sig_seed_1'), [GID_A]);
});

test('the server reads the brand list per call and warns when armed with none', () => {
  const fs = require('node:fs');
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(server, /isBrandAllowed: \(host\) => merchantVariantSourcingBrands\(\)\.isAllowed\(host\)/,
    'the allowlist must be read per call, so a pilot changes without a redeploy');
  assert.match(server, /MERCHANT_VARIANT_SOURCING_BRANDS is empty/,
    'armed-but-inert must be loud, since empty-means-none cannot otherwise be told from working');
});

// ---- publishing the merchant's variants on the PDP -------------------------------------------------------

const MERCHANT_VARIANTS = [
  { id: GID_A, sku: '15391', title: 'One-Pack', price: { amount: 4800, currency: 'USD' }, availability: { available: true }, options: [{ name: 'Select Size', label: 'One-Pack' }] },
  { id: GID_B, sku: '15392', title: 'Two-Pack', price: { amount: 8600, currency: 'USD' }, availability: { available: false }, options: [{ name: 'Select Size', label: 'Two-Pack' }] },
];

test('money is converted MINOR -> MAJOR, and an unverifiable currency yields no price at all', () => {
  const { majorUnitsOf, currencyExponent } = require('../src/services/merchantVariantSource');
  // UCP amounts are minor units: 4800 USD is $48.00, and publishing 4800 would be a $4,800 product.
  assert.deepEqual(majorUnitsOf({ amount: 4800, currency: 'USD' }), { amount: 48, currency: 'USD' });
  // zero-decimal currencies must NOT be divided
  assert.deepEqual(majorUnitsOf({ amount: 4800, currency: 'JPY' }), { amount: 4800, currency: 'JPY' });
  assert.deepEqual(majorUnitsOf({ amount: 4800, currency: 'KRW' }), { amount: 4800, currency: 'KRW' });
  assert.deepEqual(majorUnitsOf({ amount: 4800, currency: 'BHD' }), { amount: 4.8, currency: 'BHD' }, 'three-decimal');
  // a currency we cannot verify is NO price rather than a guessed one — Intl answers 2 for junk codes,
  // so the ISO check is what stops `XYZ` becoming a confident $48.00
  assert.equal(currencyExponent('XYZ'), null);
  assert.equal(majorUnitsOf({ amount: 4800, currency: 'XYZ' }), null);
  assert.equal(majorUnitsOf({ amount: 4800, currency: '' }), null);
  assert.equal(majorUnitsOf({ amount: -1, currency: 'USD' }), null);
  assert.equal(majorUnitsOf({ amount: 'abc', currency: 'USD' }), null);
  assert.equal(majorUnitsOf(null), null);
});

test('details publishes every storefront option in the shape the PDP builder consumes', async () => {
  const src = createMerchantVariantSource({
    ucpClient: clientReturning([{ ...catalogProduct(PDP, []), variants: MERCHANT_VARIANTS }]),
    isBrandAllowed: () => true,
  });
  const out = await src.details(seedRead(), 'sig_seed_1');
  assert.equal(out.length, 2, 'both options are shown — that is what lets an agent break the ambiguous tie');
  assert.deepEqual(out[0], {
    variant_id: GID_A, sku_id: '15391', title: 'One-Pack',
    options: [{ name: 'Select Size', value: 'One-Pack' }],
    in_stock: true, price_amount: 48, price_currency: 'USD',
    price: { current: { amount: 48, currency: 'USD' } },
  });
  assert.equal(out[1].price_amount, 86, 'the sibling carries ITS OWN price — showing both at one price lies');
  assert.equal(out[1].in_stock, false);
});

test('details is NOT pinned by ?variant= — the resolver must not guess, but a shopper should see the options', async () => {
  const src = createMerchantVariantSource({
    ucpClient: clientReturning([{ ...catalogProduct(PDP, []), variants: MERCHANT_VARIANTS }]),
    isBrandAllowed: () => true,
  });
  const read = seedRead({ destination_url: `${PDP}?variant=51348961657135` });
  const ids = await src(read, 'sig_seed_1');
  assert.deepEqual(ids, [GID_A], 'the RESOLVER still honours the pin');
  const details = await src.details(read, 'sig_seed_1');
  assert.deepEqual(details.map((v) => v.variant_id), [GID_A, GID_B], 'the PDP still shows both');
});

test('details obeys the same scope and fails closed the same way', async () => {
  let contacted = false;
  const client = clientReturning([{ ...catalogProduct(PDP, []), variants: MERCHANT_VARIANTS }], { onSearch: () => { contacted = true; } });
  const scoped = createMerchantVariantSource({ ucpClient: client, isBrandAllowed: () => false });
  assert.equal(await scoped.details(seedRead(), 'sig_seed_1'), null);
  assert.equal(contacted, false, 'a non-piloted brand receives no request from the PDP path either');

  const off = createMerchantVariantSource({ ucpClient: client, isEnabled: () => false });
  assert.equal(await off.details(seedRead(), 'sig_seed_1'), null);

  const broken = createMerchantVariantSource({ ucpClient: clientReturning([], { throwOnSearch: true }), isBrandAllowed: () => true });
  assert.equal(await broken.details(seedRead(), 'sig_seed_1'), null);

  const noVariants = createMerchantVariantSource({ ucpClient: clientReturning([catalogProduct(PDP, [])]), isBrandAllowed: () => true });
  assert.equal(await noVariants.details(seedRead(), 'sig_seed_1'), null, 'a product with no variants publishes nothing');
});

test('the PDP wiring publishes ONLY over fabricated variants, and never costs the read', () => {
  const fs = require('node:fs');
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(server, /merchantSource\.details\(\{ product: canonicalProductForPdp \}, ownPid\)/,
    'the PDP must call the details publisher with the product it is about to render');
  assert.match(server, /if \(!hasRealIdentity\) \{/,
    'a row that already carries real crawled identity must keep it and pay no round trip');
  assert.match(server, /'merchant variant publish skipped'/,
    'a slow or hostile storefront must leave the PDP exactly as it was');
});
