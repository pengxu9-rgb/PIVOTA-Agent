'use strict';

// Wiring of the merchant door relay switch (MERCHANT_DOOR_RELAY, MERCHANT_DOOR_RELAY_URL). What is pinned:
//   - off (the default): ucpBuyerAgentClient's default merchant transport is createPublicNetworkFetch, exactly as
//     before, and the catalog attribution default fetch is globalThis.fetch;
//   - on with a valid URL: both default to the relay fetch (an injected fetch still wins), and the relay hop carries
//     our ID token while the merchant's own headers (a Shopify bearer included) ride inside the body;
//   - on with no valid URL: door calls refuse with PIVOTA_RELAY_UNCONFIGURED, one warning, and nothing goes out on
//     either path (fail closed, never back onto the gateway's own egress);
//   - payment partners never use the relay: only an allowlist of files may name it.
// Every outbound call here lands on a fake (node:https.request swapped, globalThis.fetch swapped).

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeHttps = require('node:https');
const { EventEmitter } = require('node:events');

const { createUcpBuyerAgentClient } = require('../src/services/ucpBuyerAgentClient');
const {
  resetMerchantDoorRelayState,
  merchantDoorFetchFromEnv,
  METADATA_IDENTITY_URL,
} = require('../src/services/doorRelay/relayFetch');

const RELAY = 'https://door-relay.example';
const ENV_KEYS = [
  'MERCHANT_DOOR_RELAY', 'MERCHANT_DOOR_RELAY_URL',
  'SHOPIFY_CATALOG_CLIENT_ID', 'SHOPIFY_CATALOG_CLIENT_SECRET', 'SHOPIFY_CATALOG_ID', 'SHOPIFY_CATALOG_DRAFT_PROFILE_URL',
];
const PUBLIC_LOOKUP = (_h, _o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]);

function jwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.c2ln`;
}
const ID_TOKEN = jwt({ aud: RELAY, exp: Math.floor(Date.now() / 1000) + 3600, kind: 'google-id-token-fixture' });

let saved;
let realFetch;
let realRequest;
let httpsCalls;
let fetchCalls;

function stubHttps() {
  nodeHttps.request = (url, opts) => {
    httpsCalls.push({ hostname: url.hostname, headers: opts.headers });
    const request = new EventEmitter();
    request.write = () => true;
    request.destroy = () => {};
    request.end = () => process.nextTick(() => request.emit('error', Object.assign(new Error('stopped here'), { code: 'ECONNRESET' })));
    return request;
  };
}

/** globalThis.fetch as the metadata server plus the relay; `answer(payload)` plays the merchant. */
function stubFetch(answer) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, init });
    if (u.startsWith(METADATA_IDENTITY_URL)) return new Response(ID_TOKEN, { status: 200 });
    if (u === `${RELAY}/v1/fetch`) {
      const payload = JSON.parse(init.body);
      const merchant = answer(payload);
      return new Response(JSON.stringify({
        status: merchant.status || 200,
        headers: [['content-type', 'application/json']],
        body_b64: Buffer.from(JSON.stringify(merchant.json)).toString('base64'),
      }), { status: 200 });
    }
    throw new Error(`unexpected direct fetch to ${u}`);
  };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  realFetch = globalThis.fetch;
  realRequest = nodeHttps.request;
  httpsCalls = [];
  fetchCalls = [];
  stubHttps();
  globalThis.fetch = async (url, init) => { fetchCalls.push({ url: String(url), init }); throw new Error('no network in tests'); };
  resetMerchantDoorRelayState();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  nodeHttps.request = realRequest;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  resetMerchantDoorRelayState();
});

const relayHops = () => fetchCalls.filter((c) => c.url === `${RELAY}/v1/fetch`);

describe('ucpBuyerAgentClient default merchant transport', () => {
  test('off (unset): the pinned node:https transport, as before; no relay, no metadata call', async () => {
    const client = createUcpBuyerAgentClient({ forceAnonymous: true, retryAttempts: 0, dnsLookup: PUBLIC_LOOKUP });
    await assert.rejects(client.discoverEndpoint('https://merchant.example'), { code: 'ECONNRESET' });
    assert.equal(httpsCalls.length, 1);
    assert.equal(httpsCalls[0].hostname, 'merchant.example');
    assert.equal(fetchCalls.length, 0);
  });

  test('off (any value but "on"): same', async () => {
    process.env.MERCHANT_DOOR_RELAY = 'true';
    process.env.MERCHANT_DOOR_RELAY_URL = RELAY;
    const client = createUcpBuyerAgentClient({ forceAnonymous: true, retryAttempts: 0, dnsLookup: PUBLIC_LOOKUP });
    await assert.rejects(client.discoverEndpoint('https://merchant.example'));
    assert.equal(httpsCalls.length, 1);
    assert.equal(fetchCalls.length, 0);
  });

  test('on + URL: the relay carries the call; the ID token is only on the hop', async () => {
    process.env.MERCHANT_DOOR_RELAY = 'on';
    process.env.MERCHANT_DOOR_RELAY_URL = RELAY;
    stubFetch(() => ({ json: { ucp: { version: '2026-04-08', services: {} } } }));
    const client = createUcpBuyerAgentClient({ forceAnonymous: true, retryAttempts: 0 });
    const out = await client.discoverEndpoint('https://merchant.example');
    assert.equal(out.status, 200);
    assert.equal(out.wellKnownUrl, 'https://merchant.example/.well-known/ucp');
    assert.equal(httpsCalls.length, 0, 'the gateway itself opened no merchant socket');
    const hops = relayHops();
    assert.equal(hops.length, 1);
    assert.equal(hops[0].init.headers.authorization, `Bearer ${ID_TOKEN}`);
    const payload = JSON.parse(hops[0].init.body);
    assert.equal(payload.url, 'https://merchant.example/.well-known/ucp');
    assert.equal(payload.method, 'GET');
    assert.equal(JSON.stringify(payload).includes(ID_TOKEN), false);
    assert.equal(fetchCalls.filter((c) => c.url.startsWith(METADATA_IDENTITY_URL)).length, 1);
  });

  test('on + URL: an explicit fetchImpl / merchantFetchImpl still wins', async () => {
    process.env.MERCHANT_DOOR_RELAY = 'on';
    process.env.MERCHANT_DOOR_RELAY_URL = RELAY;
    const seen = [];
    const fake = async (url) => { seen.push(String(url)); return new Response('{}', { status: 404 }); };
    await createUcpBuyerAgentClient({ forceAnonymous: true, retryAttempts: 0, fetchImpl: fake }).discoverEndpoint('https://merchant.example');
    await createUcpBuyerAgentClient({ forceAnonymous: true, retryAttempts: 0, merchantFetchImpl: fake }).discoverEndpoint('https://merchant.example');
    assert.equal(seen.length, 2);
    assert.equal(fetchCalls.length, 0);
    assert.equal(httpsCalls.length, 0);
  });

  for (const [label, url] of [['missing', undefined], ['http', 'http://door-relay.example'], ['garbage', 'not a url']]) {
    test(`on + ${label} URL: door calls refuse with PIVOTA_RELAY_UNCONFIGURED and nothing goes out`, async () => {
      process.env.MERCHANT_DOOR_RELAY = 'on';
      if (url !== undefined) process.env.MERCHANT_DOOR_RELAY_URL = url;
      const warnings = [];
      const logger = { warn: (fields, msg) => warnings.push({ fields, msg }), info() {}, error() {} };
      for (let i = 0; i < 2; i += 1) {
        const client = createUcpBuyerAgentClient({ forceAnonymous: true, retryAttempts: 0, dnsLookup: PUBLIC_LOOKUP, logger });
        await assert.rejects(client.discoverEndpoint('https://merchant.example'), { code: 'PIVOTA_RELAY_UNCONFIGURED' });
      }
      assert.equal(httpsCalls.length, 0, 'no fallback onto the gateway egress');
      assert.equal(fetchCalls.length, 0);
      assert.equal(warnings.length, 1, 'warned once');
      assert.equal(JSON.stringify(warnings).includes('door-relay.example'), false, 'the URL value is not logged');
    });
  }
});

describe('Shopify catalog attribution default fetch', () => {
  let attribution;
  beforeEach(async () => { attribution = await import('../mcp-server/src/shopifyCatalogAttribution.js'); });

  test('off: globalThis.fetch, called directly', async () => {
    const seen = [];
    globalThis.fetch = async (url) => { seen.push(String(url)); return new Response('{}'); };
    await attribution.attributionFetch({})(attribution.TOKEN_ENDPOINT, { method: 'POST' });
    assert.deepEqual(seen, [attribution.TOKEN_ENDPOINT]);
  });

  test('on + no URL: refuses (the lookup then fails and the cart is built as today)', async () => {
    const quiet = { MERCHANT_DOOR_RELAY: 'on' };
    const fetchFn = attribution.attributionFetch(quiet);
    await assert.rejects(fetchFn(attribution.CATALOG_ENDPOINT, {}), { code: 'PIVOTA_RELAY_UNCONFIGURED' });
    assert.equal(fetchCalls.length, 0);
  });

  test('on + URL: the default client sends the token exchange and the catalog lookup through the relay', async () => {
    Object.assign(process.env, {
      MERCHANT_DOOR_RELAY: 'on',
      MERCHANT_DOOR_RELAY_URL: RELAY,
      SHOPIFY_CATALOG_CLIENT_ID: 'client-id-fixture',
      SHOPIFY_CATALOG_CLIENT_SECRET: 'client-secret-fixture',
      SHOPIFY_CATALOG_ID: '01testcatalogid000000000000',
      SHOPIFY_CATALOG_DRAFT_PROFILE_URL: 'https://agent.example/.well-known/ucp-agent-catalog-draft',
    });
    const shopifyToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, kind: 'shopify-token-fixture' });
    stubFetch((payload) => {
      if (payload.url === attribution.TOKEN_ENDPOINT) return { json: { access_token: shopifyToken } };
      return { json: { jsonrpc: '2.0', id: 1, result: { structuredContent: { products: [] } } } };
    });
    attribution.resetDefaultCatalogAttribution();
    try {
      await attribution.defaultCatalogAttribution().lookupTracked(['gid://shopify/ProductVariant/123'], {
        market: 'US', sellerHost: 'store.example', budgetMs: 800,
      });
    } finally {
      attribution.resetDefaultCatalogAttribution();
    }
    const hops = relayHops();
    const urls = hops.map((h) => JSON.parse(h.init.body).url);
    assert.deepEqual(urls, [attribution.TOKEN_ENDPOINT, attribution.CATALOG_ENDPOINT]);
    for (const hop of hops) assert.equal(hop.init.headers.authorization, `Bearer ${ID_TOKEN}`);
    const catalogHeaders = JSON.parse(hops[1].init.body).headers;
    assert.deepEqual(catalogHeaders.find(([n]) => n.toLowerCase() === 'authorization'), ['authorization', `Bearer ${shopifyToken}`],
      'the merchant-side bearer rides inside the body; the outer header is ours');
    assert.equal(fetchCalls.some((c) => c.url === attribution.TOKEN_ENDPOINT || c.url === attribution.CATALOG_ENDPOINT), false,
      'no direct call to the catalog or its token endpoint');
  });

  test('attributionFetch and the buyer client share one relay fetch per origin (one token cache)', async () => {
    const env = { MERCHANT_DOOR_RELAY: 'on', MERCHANT_DOOR_RELAY_URL: RELAY };
    assert.equal(attribution.attributionFetch(env), merchantDoorFetchFromEnv({ env }));
  });
});

describe('payment partners never use the relay', () => {
  const ROOT = path.join(__dirname, '..');
  const ALLOWED = new Set([
    'src/services/doorRelay/relayFetch.js',
    'src/services/doorRelay/server.js',
    'src/services/ucpBuyerAgentClient.js',
    'mcp-server/src/shopifyCatalogAttribution.js',
    // Merchant-facing reads moved onto createMerchantDoorFetch (G1). Each is pinned by count in the inventory below.
    'src/server.js', // shop.json currency read only
    'src/services/cafe24GlobalCatalog.js',
    'src/services/liveMerchantSearchPrice.js',
    'src/services/shopifyVariantResolver.js',
    'src/services/storefrontProductPage.js',
    'src/services/ucpSignatureVerifier.js',
    'tests/door_relay_server.node.test.cjs',
    'tests/door_relay_fetch.node.test.cjs',
    'tests/door_relay_wiring.node.test.cjs',
    'tests/door_relay_signed_roundtrip.node.test.cjs',
  ]);
  const PAYMENT_RE = /reap|evonet|visa|agenpa[sz]|a2a|card|payment|psp|stripe|adyen|checkout_pay/i;
  // Skipped anywhere: dependencies and git. Skipped at the top only: folders that hold no gateway code.
  const SKIP_ANYWHERE = new Set(['node_modules', '.git']);
  const SKIP_TOP = new Set(['artifacts', 'tmp', 'reports', 'datasets', 'data']);
  const CODE_RE = /\.(c|m)?[jt]s$/;
  const NEEDLE = /doorRelay|relayFetch|MERCHANT_DOOR_RELAY|createMerchantDoorFetch/;

  function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_ANYWHERE.has(entry.name) || (dir === ROOT && SKIP_TOP.has(entry.name))) continue;
        yield* walk(path.join(dir, entry.name));
      } else if (entry.isFile() && CODE_RE.test(entry.name)) {
        yield path.join(dir, entry.name);
      }
    }
  }

  test('only the allowlisted files name the relay', () => {
    const found = [];
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const stat = fs.statSync(file);
      if (stat.size > 4 * 1024 * 1024) continue;
      if (NEEDLE.test(fs.readFileSync(file, 'utf8'))) found.push(rel);
    }
    const outside = found.filter((rel) => !ALLOWED.has(rel));
    assert.deepEqual(outside, [], 'a file outside the allowlist names the merchant door relay');
    for (const rel of ['src/services/doorRelay/relayFetch.js', 'src/services/ucpBuyerAgentClient.js', 'mcp-server/src/shopifyCatalogAttribution.js']) {
      assert.ok(found.includes(rel), `${rel} is expected to wire the relay`);
    }
  });

  test('no allowlisted file is a payment, card or partner-rail module', () => {
    for (const rel of ALLOWED) assert.equal(PAYMENT_RE.test(rel), false, rel);
  });

  test('the relay modules require no payment, card or partner-rail module', () => {
    for (const rel of ['src/services/doorRelay/relayFetch.js', 'src/services/doorRelay/server.js']) {
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
      for (const spec of required) assert.equal(PAYMENT_RE.test(spec), false, `${rel} requires ${spec}`);
    }
  });
});

// THE OUTBOUND INVENTORY. Every merchant-transport primitive in gateway runtime code (src, mcp-server/src, connectors,
// safety-kernel/src), counted per file, against a pinned list. A NEW direct site (a createPublicNetworkFetch that is not
// the relay's own, a hand-built pinned lookup, a raw node:https request, another axios public-URL lane) fails here, and
// so does a site that moves: either way the list and its reasons are updated on purpose. Generic fetch/axios calls
// cannot be told apart from internal ones by reading source, so a second pin lists the files that combine a
// merchant-door path with a generic outbound call.
describe('merchant-facing outbound inventory', () => {
  const ROOT = path.join(__dirname, '..');
  const SCAN = ['src', 'mcp-server/src', 'connectors', 'safety-kernel/src'];
  const PRIMITIVES = {
    // createPublicNetworkFetch: the transport that leaves from THIS process's egress.
    direct_transport: /\bcreatePublicNetworkFetch\s*\(/g,
    // The switching transport: direct with the relay off, the relay with it on. Pinned so a new caller is a decision.
    door_fetch: /\bcreateMerchantDoorFetch\s*\(/g,
    pinned_lookup: /\bcreatePublicOnlyLookup\s*\(/g,
    raw_https: /\b(?:https|nodeHttps|http2|nodeHttp2)\.(?:request|get|connect)\s*\(/g,
    axios_public_lane: /\bcreatePublicUrlFetch\s*\(/g,
  };
  // file -> { primitive: count }, each with why it is where it is.
  const EXPECTED = {
    // The transport itself (definition, createMerchantDoorFetch's off branch, the client's off default), its
    // pinned lookup (definition + use) and its one node:https request.
    'src/services/ucpBuyerAgentClient.js': { direct_transport: 3, door_fetch: 1, pinned_lookup: 2, raw_https: 1 },
    // The relay service's own outbound call: it runs on the relay's egress, not the gateway's.
    'src/services/doorRelay/server.js': { direct_transport: 1 },
    // LATER PHASE: the AgenPaz product image fetcher (src/agenpas/productImage.js), wired here. Stays direct.
    // shop.json currency read: moved.
    'src/server.js': { direct_transport: 1, door_fetch: 1 },
    'src/services/cafe24GlobalCatalog.js': { door_fetch: 1 },
    'src/services/liveMerchantSearchPrice.js': { door_fetch: 1 },
    'src/services/shopifyVariantResolver.js': { door_fetch: 1 },
    'src/services/storefrontProductPage.js': { door_fetch: 1 },
    'src/services/ucpSignatureVerifier.js': { door_fetch: 1 },
    // LATER PHASE: the aurora BFF product-URL lane (axios, decoded-size cap, gzip): its fence and its one use.
    'src/services/publicUrlFetch.js': { pinned_lookup: 2, axios_public_lane: 1 },
    // axios public-URL lane (LATER PHASE, above), and one node:https request to the Gemini REST API (not a merchant).
    'src/auroraBff/routes.js': { axios_public_lane: 1, raw_https: 1 },
  };
  // Files whose code names a merchant-door path AND makes a generic fetch/axios call.
  const MERCHANT_PATH_RE = /\/\.well-known\/ucp|products\.json|\/admin\/api\/|\/api\/ucp\/mcp|\/cart\.js|\.myshopify\.com/;
  const GENERIC_CALL_RE = /\bglobalThis\.fetch\b|\bglobal\.fetch\b|\baxios\s*\.\s*(?:get|post|put|request|head)\s*\(|\baxios\s*\(|(?<![\w.])fetch\s*\(/;
  const EXPECTED_GENERIC = [
    // Serves our own /.well-known/ucp routes; its generic calls go to our backend and model APIs (sampled), and its
    // one merchant admin read (shop.json) is on createMerchantDoorFetch.
    'src/server.js',
    // The client's token exchange (global fetch to the configured token endpoint) and its own profile URL helpers.
    'src/services/ucpBuyerAgentClient.js',
    // The catalog and its token endpoint, through attributionFetch (the relay when on).
    'mcp-server/src/shopifyCatalogAttribution.js',
    // LATER PHASE: legacy Shopify admin connector (globalThis.fetch); not required by gateway runtime code.
    'connectors/shopify/ShopifyConnector.js',
  ];

  function codeLines(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => {
      const t = line.trim();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
    });
  }
  function* walkCode(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walkCode(full);
      else if (entry.isFile() && /\.(c|m)?[jt]s$/.test(entry.name)) yield full;
    }
  }
  function scan() {
    const counts = {};
    const generic = [];
    for (const root of SCAN) {
      for (const file of walkCode(path.join(ROOT, root))) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        const lines = codeLines(file);
        const text = lines.join('\n');
        for (const [name, re] of Object.entries(PRIMITIVES)) {
          const n = (text.match(re) || []).length;
          if (n) (counts[rel] ||= {})[name] = n;
        }
        if (MERCHANT_PATH_RE.test(text) && GENERIC_CALL_RE.test(text)) generic.push(rel);
      }
    }
    return { counts, generic: generic.sort() };
  }

  test('every merchant-transport primitive is where the inventory says, and nowhere else', () => {
    const { counts } = scan();
    assert.deepEqual(counts, EXPECTED,
      'a merchant-facing transport was added, moved or removed: route it through createMerchantDoorFetch (or the '
      + 'buyer client) when the relay must carry it, and update this inventory with the reason either way');
  });

  test('the files that pair a merchant-door path with a generic fetch/axios call are the pinned ones', () => {
    assert.deepEqual(scan().generic, [...EXPECTED_GENERIC].sort());
  });

  test('no payment, card or partner-rail module holds a merchant transport primitive', () => {
    for (const rel of Object.keys(EXPECTED)) assert.equal(PAYMENT_RE_INVENTORY.test(rel), false, rel);
  });
  const PAYMENT_RE_INVENTORY = /reap|evonet|visa|agenpa[sz]|a2a|card|payment|psp|stripe|adyen/i;
});

describe('moved merchant reads follow the switch', () => {
  const { createMerchantDoorFetch } = require('../src/services/ucpBuyerAgentClient');

  test('createMerchantDoorFetch off: the pinned node:https transport; on: the relay, with the caller budget', async () => {
    const doorFetch = createMerchantDoorFetch(PUBLIC_LOOKUP, { timeoutMs: 2500 });
    await assert.rejects(doorFetch('https://merchant.example/products/x.json'), { code: 'ECONNRESET' });
    assert.equal(httpsCalls.length, 1);
    assert.equal(fetchCalls.length, 0);
    process.env.MERCHANT_DOOR_RELAY = 'on';
    process.env.MERCHANT_DOOR_RELAY_URL = RELAY;
    stubFetch(() => ({ json: { ok: true } }));
    const res = await doorFetch('https://merchant.example/products/x.json', { headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(httpsCalls.length, 1, 'no new direct socket');
    const [hop] = relayHops();
    const payload = JSON.parse(hop.init.body);
    assert.equal(payload.url, 'https://merchant.example/products/x.json');
    assert.equal(payload.timeout_ms, 2500);
    assert.deepEqual(payload.headers, [['accept', 'application/json']]);
  });

  test('createMerchantDoorFetch on: the local pre-flight still refuses before any hop', async () => {
    process.env.MERCHANT_DOOR_RELAY = 'on';
    process.env.MERCHANT_DOOR_RELAY_URL = RELAY;
    stubFetch(() => ({ json: {} }));
    const doorFetch = createMerchantDoorFetch();
    await assert.rejects(doorFetch('https://169.254.169.254/x'), { code: 'PIVOTA_SSRF_LITERAL' });
    await assert.rejects(doorFetch('https://metadata.google.internal/x'), { code: 'PIVOTA_SSRF_NAME' });
    await assert.rejects(doorFetch('http://merchant.example/x'), /must be https/);
    await assert.rejects(doorFetch('https://u:p@merchant.example/x'), /userinfo/);
    assert.equal(fetchCalls.length, 0);
    assert.equal(httpsCalls.length, 0);
  });

  test('createMerchantDoorFetch on + no URL: refuses, nothing goes out', async () => {
    process.env.MERCHANT_DOOR_RELAY = 'on';
    const doorFetch = createMerchantDoorFetch(PUBLIC_LOOKUP, { logger: { warn() {} } });
    await assert.rejects(doorFetch('https://merchant.example/x'), { code: 'PIVOTA_RELAY_UNCONFIGURED' });
    assert.equal(fetchCalls.length + httpsCalls.length, 0);
  });

  test('the buyer client sends its per-call budget (default 15 s) to the relay', async () => {
    process.env.MERCHANT_DOOR_RELAY = 'on';
    process.env.MERCHANT_DOOR_RELAY_URL = RELAY;
    stubFetch(() => ({ json: { ucp: {} } }));
    await createUcpBuyerAgentClient({ forceAnonymous: true, retryAttempts: 0 }).discoverEndpoint('https://merchant.example');
    await createUcpBuyerAgentClient({ forceAnonymous: true, retryAttempts: 0, timeoutMs: 2500 }).discoverEndpoint('https://merchant.example');
    assert.deepEqual(relayHops().map((h) => JSON.parse(h.init.body).timeout_ms), [15000, 2500]);
  });

  test('storefrontProductPage\'s default fetch goes through the relay when on', async () => {
    process.env.MERCHANT_DOOR_RELAY = 'on';
    process.env.MERCHANT_DOOR_RELAY_URL = RELAY;
    stubFetch(() => ({ json: { product: { variants: [{ id: 1 }] } } }));
    const { readStorefrontProductPage } = require('../src/services/storefrontProductPage');
    await readStorefrontProductPage('https://shop-one.example/products/relay-wiring-handle');
    assert.equal(httpsCalls.length, 0);
    assert.equal(relayHops().length >= 1, true);
    assert.equal(new URL(JSON.parse(relayHops()[0].init.body).url).hostname, 'shop-one.example');
  });

  test('shopifyVariantResolver\'s products.json read goes through the relay when on, and directly when off', async () => {
    const { resolveVariantViaProductsJson } = require('../src/services/shopifyVariantResolver');
    await resolveVariantViaProductsJson({ brandDomain: 'shop-two.example', handle: 'h' }, { maxPages: 1, timeoutMs: 1000 });
    assert.equal(httpsCalls.length > 0, true, 'off: the pinned transport');
    assert.equal(fetchCalls.length, 0);
    httpsCalls.length = 0;
    process.env.MERCHANT_DOOR_RELAY = 'on';
    process.env.MERCHANT_DOOR_RELAY_URL = RELAY;
    stubFetch(() => ({ status: 404, json: {} }));
    await resolveVariantViaProductsJson({ brandDomain: 'shop-two.example', handle: 'h' }, { maxPages: 1, timeoutMs: 1000 });
    assert.equal(httpsCalls.length, 0);
    assert.equal(relayHops().length > 0, true);
    for (const hop of relayHops()) assert.equal(new URL(JSON.parse(hop.init.body).url).hostname, 'shop-two.example');
  });
});
