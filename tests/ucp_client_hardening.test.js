'use strict';

/*
 * H1/H3/H4 client-robustness tests for src/services/ucpBuyerAgentClient.js. NO live network — every fetch is a
 * fixture. Covers: jittered-backoff retry (idempotent GET retried, mutating cart NOT retried, timeout NOT
 * retried), the error taxonomy, token-tier verification with a no-leak assertion, and the H4 profile
 * self-reference (no hardcoded host).
 */

const {
  createUcpBuyerAgentClient,
  TRUST_TIER,
  FAILURE_REASON,
  classifyUcpFailure,
  backoffDelay,
} = require('../src/services/ucpBuyerAgentClient');
const { buildUcpBuyerAgentProfile } = require('../src/services/ucpBuyerAgentProfile');

const DISCOVERY_OK = {
  services: [{ transport: 'mcp', endpoint: 'https://brand.example.com/api/ucp/mcp' }],
};
const CART_OK = {
  jsonrpc: '2.0',
  id: '1',
  result: { content: [{ type: 'json', json: { id: 'cart_1', continue_url: 'https://x/cart/1' } }] },
};

function res(obj, status = 200) {
  const text = JSON.stringify(obj);
  return { ok: status >= 200 && status < 300, status, async json() { return obj; }, async text() { return text; } };
}
function netError() { return new Error('ECONNRESET simulated'); }

// P-256 test key (same fixture as tests/ucp_buyer_agent_client.test.js) — a client holding one signs, which
// is what makes the covered-header assertions below reachable.
const SIGNING_PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg2fN8OxOlC9VwiMwu',
  'Q0tpTsXRIH3nnlwnWwQwLnsAQoKhRANCAASp8aRruLtbq+P9X5jOjbpOOrgSX+Mf',
  'rx2Rl5cYEhcK8JJbntMGQeGDoTXqmaJskgNtd81kC+TOUjRLfzvvVRU4',
  '-----END PRIVATE KEY-----',
  '',
].join('\n');

// A fetch whose behavior is a scripted queue of ('throw'|'500'|'ok') outcomes; records call count.
function scriptedFetch(script, okBody) {
  let i = 0;
  const fn = async () => {
    fn.calls += 1;
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step === 'throw') throw netError();
    if (step === '500') return res({ error: 'server' }, 500);
    return res(okBody, 200);
  };
  fn.calls = 0;
  return fn;
}

describe('H1 retry/backoff — idempotent GET is retried on transient errors', () => {
  test('discoverEndpoint retries a thrown network error, then succeeds (default 2 retries => 3 tries)', async () => {
    const fetchImpl = scriptedFetch(['throw', 'throw', 'ok'], DISCOVERY_OK);
    const client = createUcpBuyerAgentClient({ fetchImpl, sleepImpl: async () => {} });
    const out = await client.discoverEndpoint('https://brand.example.com');
    expect(out.mcpEndpoint).toBe('https://brand.example.com/api/ucp/mcp');
    expect(fetchImpl.calls).toBe(3);
  });

  test('discoverEndpoint retries a 5xx, then succeeds', async () => {
    const fetchImpl = scriptedFetch(['500', 'ok'], DISCOVERY_OK);
    const client = createUcpBuyerAgentClient({ fetchImpl, sleepImpl: async () => {} });
    const out = await client.discoverEndpoint('https://brand.example.com');
    expect(out.mcpEndpoint).toBe('https://brand.example.com/api/ucp/mcp');
    expect(fetchImpl.calls).toBe(2);
  });

  test('retries are bounded — exhausting them surfaces the last error without hanging', async () => {
    const fetchImpl = scriptedFetch(['throw', 'throw', 'throw', 'throw'], DISCOVERY_OK);
    const client = createUcpBuyerAgentClient({ fetchImpl, sleepImpl: async () => {}, retryAttempts: 2 });
    await expect(client.discoverEndpoint('https://brand.example.com')).rejects.toThrow(/ECONNRESET/);
    expect(fetchImpl.calls).toBe(3); // 1 + 2 retries, then gives up
  });
});

describe('H1 retry/backoff — mutating cart/checkout calls are NEVER blind-retried', () => {
  test('createCart does NOT retry a 5xx (single POST attempt)', async () => {
    const fetchImpl = scriptedFetch(['500', 'ok'], CART_OK);
    const client = createUcpBuyerAgentClient({ fetchImpl, sleepImpl: async () => {}, retryAttempts: 3 });
    const out = await client.createCart('https://brand.example.com/api/ucp/mcp', { lineItems: [{ item: { id: 'gid://v/1' }, quantity: 1 }] });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(500);
    expect(fetchImpl.calls).toBe(1); // NOT retried
  });

  test('createCart does NOT retry a thrown network error (single POST attempt, rethrows)', async () => {
    const fetchImpl = scriptedFetch(['throw', 'ok'], CART_OK);
    const client = createUcpBuyerAgentClient({ fetchImpl, sleepImpl: async () => {}, retryAttempts: 3 });
    await expect(
      client.createCart('https://brand.example.com/api/ucp/mcp', { lineItems: [{ item: { id: 'gid://v/1' }, quantity: 1 }] }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(fetchImpl.calls).toBe(1);
  });
});

describe('H1 — a per-call TIMEOUT is not retried (bounds total latency)', () => {
  test('an aborted (timeout) idempotent GET fails after ONE attempt', async () => {
    // A fetch that never resolves until the abort signal fires -> our withTimeout aborts it -> AbortError.
    const fetchImpl = (url, init = {}) => new Promise((_resolve, reject) => {
      const signal = init.signal;
      if (signal) signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    fetchImpl.calls = 0;
    const wrapped = (...a) => { wrapped.calls += 1; return fetchImpl(...a); };
    wrapped.calls = 0;
    const client = createUcpBuyerAgentClient({ fetchImpl: wrapped, sleepImpl: async () => {}, timeoutMs: 5, retryAttempts: 3 });
    await expect(client.discoverEndpoint('https://brand.example.com')).rejects.toThrow(/abort/i);
    expect(wrapped.calls).toBe(1); // a timeout is NOT retried
  });
});

describe('backoffDelay bounds', () => {
  test('full-jitter delay stays within [0, min(max, base*2^(n-1))]', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(backoffDelay(1, 100, 2000)).toBeGreaterThanOrEqual(0);
      expect(backoffDelay(1, 100, 2000)).toBeLessThanOrEqual(100);
      expect(backoffDelay(3, 100, 2000)).toBeLessThanOrEqual(400);
      expect(backoffDelay(10, 100, 2000)).toBeLessThanOrEqual(2000); // capped
    }
  });
});

describe('H1 error taxonomy — classifyUcpFailure', () => {
  test('thrown AbortError => timeout', () => {
    const e = new Error('x'); e.name = 'AbortError';
    expect(classifyUcpFailure({ thrown: e })).toBe(FAILURE_REASON.TIMEOUT);
  });
  test('thrown network error during discovery => profile_unreachable', () => {
    expect(classifyUcpFailure({ thrown: netError(), phase: 'discovery' })).toBe(FAILURE_REASON.PROFILE_UNREACHABLE);
  });
  test('thrown network error elsewhere => tool_error', () => {
    expect(classifyUcpFailure({ thrown: netError(), phase: 'create_cart' })).toBe(FAILURE_REASON.TOOL_ERROR);
  });
  test('out-of-stock / sold-out / not-available-for-sale text => out_of_stock', () => {
    for (const m of ['The product is out of stock', 'Sold out', 'This item is not available for sale']) {
      expect(classifyUcpFailure({ errorMessage: m })).toBe(FAILURE_REASON.OUT_OF_STOCK);
    }
  });
  test('variant-not-found / discontinued text => variant_invalid', () => {
    for (const m of ['Variant not found', 'This product was discontinued', 'no such variant id']) {
      expect(classifyUcpFailure({ errorMessage: m })).toBe(FAILURE_REASON.VARIANT_INVALID);
    }
  });
  test('schema / missing-argument text => invalid_input', () => {
    expect(classifyUcpFailure({ errorMessage: 'Invalid arguments: missing required properties: line_items' }))
      .toBe(FAILURE_REASON.INVALID_INPUT);
  });
  test('bare 5xx status => tool_error; nothing => unknown', () => {
    expect(classifyUcpFailure({ status: 503 })).toBe(FAILURE_REASON.TOOL_ERROR);
    expect(classifyUcpFailure({})).toBe(FAILURE_REASON.UNKNOWN);
  });
});

describe('H3 token-tier verification — no credential leak', () => {
  const CLIENT_ID = 'pivota-agent-client-id';
  const CLIENT_SECRET = 'super-secret-DO-NOT-LEAK';
  const TOKEN_ENDPOINT = 'https://api.shopify.com/auth/access_token';

  function tokenFetch() {
    let mint = 0;
    return async (url) => {
      if (String(url) === TOKEN_ENDPOINT) { mint += 1; return res({ access_token: `jwt-mint-${mint}`, expires_in: 3600 }); }
      return res(CART_OK);
    };
  }

  test('verifyTokenTier reports TOKEN tier + minted-via-exchange with BOOLEANS only (no secret/JWT in output)', async () => {
    const client = createUcpBuyerAgentClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: tokenFetch() });
    expect(client.tier).toBe(TRUST_TIER.TOKEN);
    const out = await client.verifyTokenTier();
    expect(out.ok).toBe(true);
    expect(out.tier).toBe(TRUST_TIER.TOKEN);
    expect(out.token_present).toBe(true);
    expect(out.minted_via_exchange).toBe(true);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toMatch(/jwt-mint-/); // the JWT value is never surfaced
    // describeTier must also never leak.
    expect(JSON.stringify(client.describeTier())).not.toContain(CLIENT_SECRET);
  });

  test('a failed exchange returns a status-only error carrying no credential material', async () => {
    const fetchImpl = async (url) => (String(url) === TOKEN_ENDPOINT ? res({ error: 'invalid_client' }, 401) : res(CART_OK));
    const client = createUcpBuyerAgentClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl });
    const out = await client.verifyTokenTier();
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/status 401/);
    expect(out.error).not.toContain(CLIENT_SECRET);
    expect(out.error).not.toContain(CLIENT_ID);
  });
});

describe('H4 profile self-reference — no hardcoded host', () => {
  test('buildUcpBuyerAgentProfile self-references the configured profileUrl', () => {
    const url = 'https://ucp.pivota.cc/.well-known/ucp-agent';
    const profile = buildUcpBuyerAgentProfile({ profileUrl: url });
    expect(profile.ucp.profile_url).toBe(url);
    const serialized = JSON.stringify(profile);
    // No hardcoded frontend/railway host baked into the profile body.
    expect(serialized).not.toContain('agent.pivota.cc');
    expect(serialized).not.toContain('railway.app');
  });

  test('the client surfaces the configured profile URL (env-configurable, not hardcoded)', () => {
    const url = 'https://ucp.pivota.cc/.well-known/ucp-agent';
    const client = createUcpBuyerAgentClient({ profileUrl: url });
    expect(client.describeTier().profile_url).toBe(url);
  });
});

/*
 * THE CATALOG TOOLS' WIRE SHAPES.
 *
 * `catalogSearch` sent a FLAT `{ query, id, sku }` to `get_product` and conflated three distinct live tools.
 * Against the LIVE schemas (cosrx tools/list, 2026-08-13):
 *   - `get_product`    required ["meta","catalog"], `catalog.required = ["id"]`  — the id is NESTED
 *   - `search_catalog` required ["meta","catalog"], catalog carries `query`      — a DIFFERENT tool
 *   - `lookup_catalog` required ["meta","catalog"], `catalog.required = ["ids"]` — batch by id
 * and `sku` is a member of NONE of them. The old call could not have been answered by any of the three.
 */
describe('the catalog tools send the live nested-catalog shape', () => {
  const capture = (seen) => async (url, init) => { seen.push({ url, init }); return res(CART_OK, 200); };
  const argsOf = (seen) => JSON.parse(seen[0].init.body).params.arguments;
  const nameOf = (seen) => JSON.parse(seen[0].init.body).params.name;
  const ENDPOINT = 'https://brand.example.com/api/ucp/mcp';
  const newClient = (fetchImpl) => createUcpBuyerAgentClient({
    profileUrl: 'https://ucp.pivota.cc/.well-known/ucp-agent', fetchImpl,
  });

  test('getProduct nests the id under `catalog` and calls get_product', async () => {
    const seen = [];
    await newClient(capture(seen)).getProduct(ENDPOINT, { productId: 'gid://shopify/Product/42' });

    expect(nameOf(seen)).toBe('get_product');
    // The whole catalog object, exactly. A flat `id` beside it is the shape the merchant rejects.
    expect(argsOf(seen).catalog).toEqual({ id: 'gid://shopify/Product/42' });
    expect(argsOf(seen).id).toBeUndefined();
    expect(argsOf(seen).sku).toBeUndefined();
    expect(argsOf(seen).query).toBeUndefined();
  });

  test('a free-text query goes to search_catalog — NOT to get_product', async () => {
    const seen = [];
    await newClient(capture(seen)).searchCatalog(ENDPOINT, { query: 'cleanser' });

    // The conflation this fixes: `query` is not a member of get_product at all, so the old call was
    // unanswerable by the very tool it was sent to.
    expect(nameOf(seen)).toBe('search_catalog');
    expect(argsOf(seen).catalog).toEqual({ query: 'cleanser' });
  });

  test('search pagination rides inside `catalog`, and a query-less search is still legal', async () => {
    const seen = [];
    await newClient(capture(seen)).searchCatalog(ENDPOINT, { pagination: { limit: 10 } });
    // `catalog` declares no required member on the live search schema.
    expect(argsOf(seen).catalog).toEqual({ pagination: { limit: 10 } });
  });

  test('getProduct refuses a missing id rather than sending an empty catalog', async () => {
    const seen = [];
    await expect(newClient(capture(seen)).getProduct(ENDPOINT, {})).rejects.toThrow(/productId/);
    expect(seen).toHaveLength(0);
  });

  test('the removed `catalogSearch` is gone, not silently kept alongside the fix', () => {
    // Leaving the old name exported would let a caller keep sending the unanswerable shape while the new
    // methods sit unused — the drift this fix exists to end.
    expect(newClient(capture([])).catalogSearch).toBeUndefined();
  });

  test('both catalog reads are retry-eligible, like every other read', () => {
    // Adding search_catalog as a tool without adding it to IDEMPOTENT_TOOLS would silently drop its
    // transient-error retry. Driven, not asserted on the constant: a scripted 500-then-ok must be retried.
    const fn = scriptedFetch(['500', 'ok'], CART_OK);
    return newClient(fn).searchCatalog(ENDPOINT, { query: 'x' }).then((out) => {
      expect(fn.calls).toBe(2);
      expect(out.ok).toBe(true);
    });
  });
});

/*
 * THE POINTER THE MERCHANT ACTUALLY FETCHES.
 *
 * `meta["ucp-agent"].profile` is not decoration: the merchant FETCHES it during the handshake and refuses the
 * whole call when it cannot resolve — live-verified 2026-08-13, where a UCP endpoint answered
 * `422 / -32001 { code: 'profile_unreachable' }` and never looked at the arguments at all.
 *
 * The bug these lock: the last-resort default was the literal `https://agent.pivota.cc/.well-known/ucp-agent`,
 * and agent.pivota.cc is the FRONTEND web app (see PROJECT_COMPLETION_SUMMARY.md), not this gateway — it
 * answers that path with the Next.js 404 page. So every environment without UCP_AGENT_PROFILE_URL set failed
 * EVERY outbound UCP call. Production sets the var, which is exactly why it stayed invisible. The test above
 * already forbade that host in the served profile BODY; nothing forbade it in the pointer we send.
 */
describe('the agent profile pointer is configured, never invented', () => {
  const ENV_KEYS = [
    'UCP_AGENT_PROFILE_URL', 'UCP_BASE_URL', 'AGENT_CHECKOUT_UCP_BASE_URL',
    'MCP_OAUTH_RESOURCE', 'UCP_BUYER_AGENT_PROFILE_ENABLED',
  ];
  // Deriving a pointer requires the buyer-profile ROUTE to be lit, not just an origin to exist — see the
  // note at the resolution. Tests that exercise derivation must say so explicitly.
  const LIT = () => { process.env.UCP_BUYER_AGENT_PROFILE_ENABLED = '1'; };
  let saved;
  beforeEach(() => {
    saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const captureFetch = (seen) => async (url, init) => { seen.push({ url, init }); return res(CART_OK, 200); };
  const buildCart = (client) => client.createCart('https://brand.example.com/api/ucp/mcp', {
    lineItems: [{ item: { id: 'gid://shopify/ProductVariant/1' }, quantity: 1 }],
  });

  test('with NOTHING configured it invents no host — least of all the frontend', () => {
    // Absent, not guessed: a merchant then names the missing field, instead of reporting an unreachable URL
    // for a host that was never this service.
    expect(createUcpBuyerAgentClient({}).describeTier().profile_url).toBeFalsy();
  });

  test('the gateway origin DERIVES the pointer, so it can only name a host we serve', () => {
    LIT();
    process.env.UCP_BASE_URL = 'https://ucp.pivota.cc';
    expect(createUcpBuyerAgentClient({}).describeTier().profile_url)
      .toBe('https://ucp.pivota.cc/.well-known/ucp-agent');
    // A trailing slash or a path on the origin must not produce a doubled or nested path.
    process.env.UCP_BASE_URL = 'https://ucp.pivota.cc/';
    expect(createUcpBuyerAgentClient({}).describeTier().profile_url)
      .toBe('https://ucp.pivota.cc/.well-known/ucp-agent');
    process.env.UCP_BASE_URL = 'https://ucp.pivota.cc/some/base';
    expect(createUcpBuyerAgentClient({}).describeTier().profile_url)
      .toBe('https://ucp.pivota.cc/.well-known/ucp-agent');
    // The seller door's alternate spelling works too, so one configured gateway origin is enough.
    delete process.env.UCP_BASE_URL;
    process.env.AGENT_CHECKOUT_UCP_BASE_URL = 'https://alt.pivota.cc';
    expect(createUcpBuyerAgentClient({}).describeTier().profile_url)
      .toBe('https://alt.pivota.cc/.well-known/ucp-agent');
    // …and the seller chain's third link, so the two roles resolve the same origins.
    delete process.env.AGENT_CHECKOUT_UCP_BASE_URL;
    process.env.MCP_OAUTH_RESOURCE = 'https://oauth.pivota.cc/some/resource';
    expect(createUcpBuyerAgentClient({}).describeTier().profile_url)
      .toBe('https://oauth.pivota.cc/.well-known/ucp-agent');
  });

  test('a DARK buyer-profile route derives NOTHING — an origin is not a served route', () => {
    // The defect this closes: UCP_BASE_URL gates the SELLER door
    // (AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED); /.well-known/ucp-agent is its own door behind
    // UCP_BUYER_AGENT_PROFILE_ENABLED, default OFF. An environment with UCP_BASE_URL set and the buyer door
    // dark is the DEFAULT state — deriving there would hand merchants a URL that 404s on our own host,
    // trading a frontend 404 for a gateway 404 while reporting success.
    process.env.UCP_BASE_URL = 'https://ucp.pivota.cc';
    process.env.AGENT_CHECKOUT_UCP_BASE_URL = 'https://alt.pivota.cc';
    process.env.MCP_OAUTH_RESOURCE = 'https://oauth.pivota.cc/r';
    expect(createUcpBuyerAgentClient({}).describeTier().profile_url).toBeFalsy();
    // Lighting the door is what makes derivation honest.
    LIT();
    expect(createUcpBuyerAgentClient({}).describeTier().profile_url)
      .toBe('https://ucp.pivota.cc/.well-known/ucp-agent');
  });

  test('an EXPLICIT pointer is never gated — an operator may name a URL served elsewhere', () => {
    // Deliberate asymmetry: the flag describes THIS process. An explicit value is the operator saying they
    // know better, which must keep working when the client and the route are deployed separately.
    process.env.UCP_AGENT_PROFILE_URL = 'https://explicit.example/.well-known/ucp-agent';
    expect(createUcpBuyerAgentClient({}).describeTier().profile_url)
      .toBe('https://explicit.example/.well-known/ucp-agent');
    expect(createUcpBuyerAgentClient({ profileUrl: 'https://opt.example/p' }).describeTier().profile_url)
      .toBe('https://opt.example/p');
  });

  test('an explicit UCP_AGENT_PROFILE_URL wins over the derived one, and an option wins over both', () => {
    LIT();
    process.env.UCP_BASE_URL = 'https://ucp.pivota.cc';
    process.env.UCP_AGENT_PROFILE_URL = 'https://explicit.example/.well-known/ucp-agent';
    expect(createUcpBuyerAgentClient({}).describeTier().profile_url)
      .toBe('https://explicit.example/.well-known/ucp-agent');
    expect(createUcpBuyerAgentClient({ profileUrl: 'https://opt.example/p' }).describeTier().profile_url)
      .toBe('https://opt.example/p');
  });

  test('an unusable origin yields NO pointer rather than a guess', () => {
    // http is not servable cross-origin for this fetch, and junk is not a host. Both must stay absent —
    // deriving something "close enough" is how a dead pointer gets shipped in the first place.
    LIT();
    for (const bad of ['http://insecure.example', 'not a url', '   ', 'ftp://x.example']) {
      process.env.UCP_BASE_URL = bad;
      expect(createUcpBuyerAgentClient({}).describeTier().profile_url).toBeFalsy();
    }
  });

  test('the wire carries the real pointer — and never the string "undefined"', async () => {
    LIT();
    process.env.UCP_BASE_URL = 'https://ucp.pivota.cc';
    const seen = [];
    await buildCart(createUcpBuyerAgentClient({ fetchImpl: captureFetch(seen) }));

    const body = JSON.parse(seen[0].init.body);
    expect(body.params.arguments.meta['ucp-agent'].profile)
      .toBe('https://ucp.pivota.cc/.well-known/ucp-agent');
    expect(seen[0].init.body).not.toContain('agent.pivota.cc');
  });

  test('SIGNED tier REFUSES to sign without a profile rather than covering an absent header', async () => {
    // At SIGNED tier `ucp-agent` is a COVERED RFC 9421 component. Signing it while the value is absent
    // produces a signature the merchant recomputes differently and rejects as tampering — an authentication
    // failure that reads like a key problem and is actually a missing config value. Refuse, and say which.
    const seen = [];
    const client = createUcpBuyerAgentClient({
      signingPrivateKey: SIGNING_PEM,
      signingKeyId: 'pivota-ucp-test',
      fetchImpl: captureFetch(seen),
    });
    expect(client.describeTier().tier).toBe(TRUST_TIER.SIGNED);
    await expect(buildCart(client)).rejects.toThrow(/UCP_AGENT_PROFILE_URL|UCP_BASE_URL/);
    // and nothing was put on the wire under a signature it could not honestly produce
    expect(seen).toHaveLength(0);
  });

  test('SIGNED tier proceeds once an origin IS configured', async () => {
    LIT();
    process.env.UCP_BASE_URL = 'https://ucp.pivota.cc';
    const seen = [];
    const client = createUcpBuyerAgentClient({
      signingPrivateKey: SIGNING_PEM,
      signingKeyId: 'pivota-ucp-test',
      fetchImpl: captureFetch(seen),
    });
    await buildCart(client);
    expect(seen).toHaveLength(1);
    // the covered header carries the derived pointer verbatim
    expect(seen[0].init.headers['ucp-agent']).toBe('profile="https://ucp.pivota.cc/.well-known/ucp-agent"');
    expect(seen[0].init.headers['ucp-agent']).not.toContain('undefined');
  });

  test('with no pointer configured the key is OMITTED, not shipped as the string "undefined"', async () => {
    const seen = [];
    await buildCart(createUcpBuyerAgentClient({ fetchImpl: captureFetch(seen) }));
    const body = JSON.parse(seen[0].init.body);
    // Naive interpolation would have sent `profile: "undefined"` — a string a merchant dutifully tries to
    // fetch, turning a config gap into a mystery 404 on someone else's host.
    expect(body.params.arguments.meta['ucp-agent'].profile).toBeUndefined();
    expect(seen[0].init.body).not.toContain('undefined');
  });
});
