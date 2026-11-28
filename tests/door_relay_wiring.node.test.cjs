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
    'tests/door_relay_server.node.test.cjs',
    'tests/door_relay_fetch.node.test.cjs',
    'tests/door_relay_wiring.node.test.cjs',
  ]);
  const PAYMENT_RE = /reap|evonet|visa|agenpa[sz]|a2a|card|payment|psp|stripe|adyen|checkout_pay/i;
  // Skipped anywhere: dependencies and git. Skipped at the top only: folders that hold no gateway code.
  const SKIP_ANYWHERE = new Set(['node_modules', '.git']);
  const SKIP_TOP = new Set(['artifacts', 'tmp', 'reports', 'datasets', 'data']);
  const CODE_RE = /\.(c|m)?[jt]s$/;
  const NEEDLE = /doorRelay|relayFetch|MERCHANT_DOOR_RELAY/;

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
