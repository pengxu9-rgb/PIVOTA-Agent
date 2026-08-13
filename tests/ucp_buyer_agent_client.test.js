'use strict';

/*
 * Fixture-based unit tests for the OUTBOUND UCP buyer-agent client + capability profile.
 * NO live network: every fetch is a synthetic/recorded UCP response injected via `fetchImpl`.
 * Asserts the HARD SAFETY BOUNDS: the client never has/attempts a complete_checkout path, never leaks the
 * credential, requests only catalog+cart+checkout scopes, and correctly captures the storefront handoff URL.
 */

const nodeCrypto = require('node:crypto');
const {
  createUcpBuyerAgentClient,
  TOOL,
  TRUST_TIER,
  buildUcpSignatureBase,
  signUcpRequest,
  contentDigestFor,
  loadSigningPrivateKey,
} = require('../src/services/ucpBuyerAgentClient');
const {
  buildUcpBuyerAgentProfile,
  assertNoPurchaseCompletion,
  ALLOWED_BUYER_CAPABILITIES,
  resolveSigningKeys,
  CHECKOUT_CAPABILITY,
} = require('../src/services/ucpBuyerAgentProfile');

// ---- deterministic TEST-ONLY ECDSA P-256 keypair --------------------------
// Generated once for these tests; NOT a production key and NOT published anywhere. The client loads the
// PRIVATE key from env/options; here we inject it directly so signing is deterministic and verifiable offline.
const TEST_PRIVATE_PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg2fN8OxOlC9VwiMwu',
  'Q0tpTsXRIH3nnlwnWwQwLnsAQoKhRANCAASp8aRruLtbq+P9X5jOjbpOOrgSX+Mf',
  'rx2Rl5cYEhcK8JJbntMGQeGDoTXqmaJskgNtd81kC+TOUjRLfzvvVRU4',
  '-----END PRIVATE KEY-----',
  '',
].join('\n');
const TEST_PUBLIC_JWK = Object.freeze({
  kty: 'EC',
  x: 'qfGka7i7W6vj_V-Yzo26Tjq4El_jH68dkZeXGBIXCvA',
  y: 'klue0wZB4YOhNeqZomySA213zWQL5M5SNEt_O-9VFTg',
  crv: 'P-256',
  kid: 'pivota-test-key-1',
  use: 'sig',
});
const TEST_KEY_ID = 'pivota-test-key-1';

/** Verify a captured signed MCP request end-to-end against the published PUBLIC JWK. */
function verifyCapturedSignature(call, endpoint) {
  const sigInput = call.headers['signature-input'];
  const sigHeader = call.headers.signature;
  const m = /^sig1=\((.*?)\)(.*)$/.exec(sigInput);
  if (!m) throw new Error(`unparseable signature-input: ${sigInput}`);
  const covered = m[1].split(' ').map((s) => s.replace(/"/g, ''));
  const params = `(${m[1]})${m[2]}`;
  const u = new URL(endpoint);
  const lines = covered.map((name) => {
    switch (name) {
      case '@method': return '"@method": POST';
      case '@authority': return `"@authority": ${u.host}`;
      case '@path': return `"@path": ${u.pathname}`;
      case '@query': return `"@query": ${u.search}`;
      default: return `"${name}": ${call.headers[name]}`;
    }
  });
  lines.push(`"@signature-params": ${params}`);
  const base = lines.join('\n');
  const sigB64 = /^sig1=:(.*):$/.exec(sigHeader)[1];
  const pub = nodeCrypto.createPublicKey({ key: TEST_PUBLIC_JWK, format: 'jwk' });
  const ok = nodeCrypto.verify('sha256', Buffer.from(base, 'utf8'), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64, 'base64'));
  return { ok, covered, base };
}

// ---- fixtures --------------------------------------------------------------

const BUSINESS_PROFILE_FIXTURE = {
  ucp: {
    version: '2026-04-08',
    services: {
      'dev.ucp.shopping': [
        { version: '2026-04-08', transport: 'mcp', endpoint: 'https://cosrx.example.myshopify.com/ucp/mcp' },
      ],
    },
    capabilities: { 'dev.ucp.shopping.cart': [{ version: '2026-04-08' }] },
    payment_handlers: {},
  },
};

const GET_PRODUCT_FIXTURE = {
  jsonrpc: '2.0',
  id: '1',
  result: {
    content: [{ type: 'json', json: { id: 'gid://shopify/ProductVariant/111', variant_id: '111', title: 'Snail Mucin' } }],
  },
};

const CREATE_CART_FIXTURE = {
  jsonrpc: '2.0',
  id: '2',
  result: {
    content: [{
      type: 'json',
      json: {
        id: 'cart_abc',
        line_items: [{ item: { id: '111', title: 'Snail Mucin' }, quantity: 1 }],
        currency: 'USD',
        totals: { total: '1600' },
        continue_url: 'https://cosrx.example.myshopify.com/cart/111:1?payment=shop_pay',
      },
    }],
  },
};

const CREATE_CHECKOUT_FIXTURE = {
  jsonrpc: '2.0',
  id: '3',
  result: {
    content: [{
      type: 'json',
      json: {
        id: 'checkout_xyz',
        status: 'incomplete',
        continue_url: 'https://cosrx.example.myshopify.com/checkouts/xyz',
      },
    }],
  },
};

/** Build a fake fetch that routes by URL/tool and records what it was called with (headers, body). */
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    let body;
    try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    calls.push({ url, headers: init.headers || {}, body, rawBody: init.body });
    // well-known discovery
    if (String(url).endsWith('/.well-known/ucp')) {
      return jsonResponse(routes.wellKnown ?? BUSINESS_PROFILE_FIXTURE, routes.wellKnownStatus ?? 200);
    }
    // MCP tools/call — pick fixture by tool name
    const tool = body && body.params && body.params.name;
    const fixture = routes[tool];
    if (fixture === undefined) return jsonResponse({ error: { code: -32601, message: 'unknown tool' } }, 404);
    if (typeof fixture === 'function') return fixture(body, init);
    return jsonResponse(fixture, routes[`${tool}Status`] ?? 200);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(obj, status = 200) {
  const text = JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return obj; },
    async text() { return text; },
  };
}

// ---- profile ---------------------------------------------------------------

describe('buildUcpBuyerAgentProfile', () => {
  test('matches the shopify.dev/agents/profiles schema shape', () => {
    const p = buildUcpBuyerAgentProfile({ profileUrl: 'https://agent.pivota.cc/.well-known/ucp-agent' });
    // Anchored literal on purpose: everything else asserts "equals the shared constant", which a wrong
    // constant would satisfy. This states the value Pivota actually publishes on BOTH UCP roles today —
    // the seller profile (/.well-known/ucp) reads the same pin, safety-kernel/src/protocol/ucpSpecVersion.cjs.
    // A deliberate spec bump updates that file and this line together; nothing else needs touching.
    expect(p.ucp.version).toBe('2026-04-08');
    expect(p.ucp.services['dev.ucp.shopping'][0].transport).toBe('mcp');
    expect(Object.keys(p.ucp.capabilities)).toEqual(
      expect.arrayContaining([
        'dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.catalog.lookup',
        'dev.ucp.shopping.cart', 'dev.ucp.shopping.checkout',
      ]),
    );
    // payment_handlers must be present (may be empty) per the schema.
    expect(p.ucp.payment_handlers).toEqual({});
  });

  test('every requested capability id EXISTS in the UCP vocabulary', () => {
    // Negotiation is a set INTERSECTION, so an id that exists nowhere intersects with nothing and fails
    // SILENTLY — the profile is accepted and the tools are simply absent. `dev.ucp.shopping.catalog` was
    // exactly that: no such capability at any version (2026-04-08 splits it into .search/.lookup, and
    // 2026-01-23 has no catalog capability at all), and it cost us every catalog tool at a live merchant.
    //
    // This list is the SPEC's, transcribed from ucp.dev/2026-04-08 (specification/overview + /catalog) —
    // deliberately not derived from the module under test, which would only assert our spelling against
    // itself. That self-agreement is why the old id survived: the previous assertion named the same wrong
    // string the code did.
    const SPEC_SHOPPING_CAPABILITIES = [
      'dev.ucp.shopping.catalog.search',
      'dev.ucp.shopping.catalog.lookup',
      'dev.ucp.shopping.cart',
      'dev.ucp.shopping.checkout',
      'dev.ucp.shopping.discount',
      'dev.ucp.shopping.fulfillment',
      'dev.ucp.shopping.order',
      'dev.ucp.shopping.ap2_mandate',
    ];
    const p = buildUcpBuyerAgentProfile();
    for (const id of Object.keys(p.ucp.capabilities)) {
      expect(SPEC_SHOPPING_CAPABILITIES).toContain(id);
    }
    for (const id of p.agent.requested_scopes) {
      expect(SPEC_SHOPPING_CAPABILITIES).toContain(id);
    }
    // The capability block and the requested scopes must not drift apart either: a merchant reads one or
    // the other depending on implementation, and a mismatch grants a different set than we advertise.
    expect([...p.agent.requested_scopes].sort()).toEqual(Object.keys(p.ucp.capabilities).sort());
  });

  test('fulfillment is requested — negotiation gates argument SHAPES, not just the tool list', () => {
    // The spec's fulfillment extension "adds a `fulfillment` field to Checkout" (methods/destinations/groups).
    // Without requesting it, a merchant's negotiated create_checkout schema omits that field entirely —
    // measured 2026-08-13, cosrx's create_checkout for our profile contained no `fulfillment` at all, which
    // is how an earlier note concluded, wrongly, that UCP carries no shipping address.
    const p = buildUcpBuyerAgentProfile();
    expect(Object.keys(p.ucp.capabilities)).toContain('dev.ucp.shopping.fulfillment');
    // `extends` is the spec's CANONICAL single-parent string for this capability
    // (`"extends": "dev.ucp.shopping.checkout"`, in both profile examples and in prose). An earlier revision
    // used the array [checkout, cart] on one merchant's authority and claimed a string would be "our own
    // spelling" — backwards. Multi-parent means "at least ONE parent must be present", so the array would
    // let fulfillment survive a cart-only intersection where it means nothing.
    const entry = p.ucp.capabilities['dev.ucp.shopping.fulfillment'][0];
    expect(entry.extends).toBe('dev.ucp.shopping.checkout');
    // Requesting it must NOT smuggle in a money capability: fulfillment ships goods, it does not pay.
    expect(p.agent.completes_payment).toBe(false);
    expect(p.ucp.payment_handlers).toEqual({});
  });

  test('BOTH catalog halves are requested — the client uses each', () => {
    // searchCatalog is free text (.search); getProduct is retrieval by identifier (.lookup). Requesting one
    // would leave the other method calling a tool the merchant never granted.
    const caps = Object.keys(buildUcpBuyerAgentProfile().ucp.capabilities);
    expect(caps).toContain('dev.ucp.shopping.catalog.search');
    expect(caps).toContain('dev.ucp.shopping.catalog.lookup');
    // and the id that never existed is gone
    expect(caps).not.toContain('dev.ucp.shopping.catalog');
  });

  test('requests catalog+cart+checkout scopes but NOT purchase-completion / payment', () => {
    const p = buildUcpBuyerAgentProfile();
    const capNames = Object.keys(p.ucp.capabilities);
    // no capability implies completing a purchase or handling payment
    expect(capNames.some((c) => /(complete|payment|charge|purchase)/i.test(c))).toBe(false);
    // and we declare no payment handler + advertise completes_payment:false truthfully
    expect(p.ucp.payment_handlers).toEqual({});
    expect(p.agent.completes_payment).toBe(false);
    expect(p.agent.is_payment_processor).toBe(false);
  });

  test('checkout declares NO `extends` — it is a root capability, and `extends` is a pruning key', () => {
    // This test previously asserted `extends === 'dev.ucp.shopping.cart'`, pinning a live hazard in place.
    // Intersection step 3: "Remove any capability where `extends` is set but none of its parent capabilities
    // are in the intersection." So a merchant advertising checkout but NOT cart pruned our checkout
    // entirely — all five checkout tools gone, silently. The spec: `extends` is "Present for extensions,
    // absent for ROOT capabilities", and both profile examples declare checkout with none.
    const p = buildUcpBuyerAgentProfile();
    expect(p.ucp.capabilities[CHECKOUT_CAPABILITY][0].extends).toBeUndefined();
    for (const root of ['dev.ucp.shopping.cart', 'dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.catalog.lookup']) {
      expect(p.ucp.capabilities[root][0].extends).toBeUndefined();
    }
    // Only the extension carries one, and only to its real parent.
    expect(p.ucp.capabilities['dev.ucp.shopping.fulfillment'][0].extends).toBe('dev.ucp.shopping.checkout');
  });

  test('every capability entry carries the REQUIRED spec and schema members', () => {
    // The spec marks both required on a capability entry and every profile example carries them; without
    // them a validating merchant answers `profile_malformed` (422) — a negotiation failure for a reason
    // nothing in the profile announces.
    const p = buildUcpBuyerAgentProfile();
    for (const [id, entries] of Object.entries(p.ucp.capabilities)) {
      for (const e of entries) {
        expect(typeof e.spec).toBe('string');
        expect(typeof e.schema).toBe('string');
        expect(e.spec.startsWith('https://')).toBe(true);
        expect(e.schema.startsWith('https://')).toBe(true);
        expect(e.version).toBe(p.ucp.version);
        expect(id).toBeTruthy();
      }
    }
  });

  test('a payment-authorizing capability is REFUSED even though the denylist cannot spell it', () => {
    // `dev.ucp.shopping.ap2_mandate` is THE money capability and matches none of
    // /(complete|payment|charge|purchase)/i — so the denylist that existed to keep it out was the one thing
    // that could not see it, and adding it to the requested set passed the entire suite. The allowlist
    // refuses it for being ABSENT rather than for being predicted.
    for (const money of [
      'dev.ucp.shopping.ap2_mandate', 'com.google.pay', 'dev.shopify.shop_pay', 'dev.ucp.processor_tokenizer',
    ]) {
      expect(() => assertNoPurchaseCompletion([money])).toThrow();
    }
    // …and the vetted set is exactly what the profile requests — no drift between guard and profile.
    const p = buildUcpBuyerAgentProfile();
    expect([...ALLOWED_BUYER_CAPABILITIES].sort()).toEqual([...p.agent.requested_scopes].sort());
  });

  test('rejects a non-https profileUrl', () => {
    expect(() => buildUcpBuyerAgentProfile({ profileUrl: 'http://insecure.example' })).toThrow(/https/);
  });

  test('assertNoPurchaseCompletion throws on a completion capability', () => {
    expect(() => assertNoPurchaseCompletion(['dev.ucp.shopping.checkout.complete'])).toThrow(/purchase-completion/);
    expect(() => assertNoPurchaseCompletion(['dev.ucp.shopping.cart'])).not.toThrow();
  });
});

// ---- client: identity / tiers ---------------------------------------------

describe('createUcpBuyerAgentClient identity', () => {
  test('anonymous tier when no credential; never exposes a credential value', () => {
    const client = createUcpBuyerAgentClient({ credential: undefined, fetchImpl: makeFetch({}) });
    const d = client.describeTier();
    expect(d.tier).toBe(TRUST_TIER.ANONYMOUS);
    expect(d.has_credential).toBe(false);
    expect(d.completes_checkout).toBe(false);
    expect(JSON.stringify(d)).not.toMatch(/secret|Bearer/i);
  });

  test('token tier when credential present; credential never appears in describeTier output', () => {
    const client = createUcpBuyerAgentClient({ credential: 'super-secret-jwt', fetchImpl: makeFetch({}) });
    const d = client.describeTier();
    expect(d.tier).toBe(TRUST_TIER.TOKEN);
    expect(d.has_credential).toBe(true);
    expect(JSON.stringify(d)).not.toContain('super-secret-jwt');
  });
});

// ---- client: happy path over fixtures -------------------------------------

describe('createUcpBuyerAgentClient over recorded UCP responses', () => {
  function newClient(routes, credential = 'test-token') {
    const fetchImpl = makeFetch(routes);
    const client = createUcpBuyerAgentClient({
      credential,
      profileUrl: 'https://agent.pivota.cc/.well-known/ucp-agent',
      fetchImpl,
    });
    return { client, fetchImpl };
  }

  test('discoverEndpoint extracts the MCP endpoint from /.well-known/ucp', async () => {
    const { client } = newClient({});
    const disco = await client.discoverEndpoint('https://cosrx.com');
    expect(disco.wellKnownUrl).toBe('https://cosrx.com/.well-known/ucp');
    expect(disco.mcpEndpoint).toBe('https://cosrx.example.myshopify.com/ucp/mcp');
  });

  test('catalog search -> cart build -> checkout create -> handoff URL captured', async () => {
    const { client, fetchImpl } = newClient({
      [TOOL.GET_PRODUCT]: GET_PRODUCT_FIXTURE,
      [TOOL.CREATE_CART]: CREATE_CART_FIXTURE,
      [TOOL.CREATE_CHECKOUT]: CREATE_CHECKOUT_FIXTURE,
    });
    const endpoint = 'https://cosrx.example.myshopify.com/ucp/mcp';

    const product = await client.getProduct(endpoint, { productId: 'gid://shopify/Product/1' });
    expect(product.ok).toBe(true);

    const cart = await client.createCart(endpoint, {
      lineItems: [{ item: { id: 'gid://shopify/ProductVariant/111' }, quantity: 1 }],
    });
    expect(cart.ok).toBe(true);
    expect(client.extractHandoffUrl(cart)).toMatch(/\/cart\/111/);

    const checkout = await client.createCheckout(endpoint, { cartId: 'cart_abc' });
    expect(checkout.ok).toBe(true);
    expect(client.extractHandoffUrl(checkout)).toBe('https://cosrx.example.myshopify.com/checkouts/xyz');

    // Every request carried the agent profile pointer + Bearer auth (token tier). Credential never in a URL.
    // LIVE shape: meta sits at params.arguments.meta (NOT body.meta / params._meta), alongside the tool fields.
    const mcpCall = fetchImpl.calls.find((c) => c.body && c.body.params && c.body.params.name === TOOL.CREATE_CART);
    expect(mcpCall.body.params.arguments.meta['ucp-agent'].profile).toBe('https://agent.pivota.cc/.well-known/ucp-agent');
    expect(mcpCall.headers.authorization).toBe('Bearer test-token');
    expect(fetchImpl.calls.every((c) => !String(c.url).includes('test-token'))).toBe(true);
  });

  test('create_cart args carry cart.line_items[0].item.id DIRECTLY under arguments (no `input` wrapper)', async () => {
    const { client, fetchImpl } = newClient({ [TOOL.CREATE_CART]: CREATE_CART_FIXTURE });
    const endpoint = 'https://cosrx.example.myshopify.com/ucp/mcp';
    const variantGid = 'gid://shopify/ProductVariant/51895645012184';

    const cart = await client.createCart(endpoint, { lineItems: [{ item: { id: variantGid }, quantity: 1 }] });
    expect(cart.ok).toBe(true);

    const call = fetchImpl.calls.find((c) => c.body && c.body.params && c.body.params.name === TOOL.CREATE_CART);
    const args = call.body.params.arguments;
    // Tool fields sit directly alongside meta — NO `input` wrapper anywhere.
    expect(args.input).toBeUndefined();
    expect(call.body.params._meta).toBeUndefined();
    expect(call.body.meta).toBeUndefined();
    // create_cart's field is a `cart` object wrapping line_items (live cosrx schema).
    expect(args.cart.line_items[0].item.id).toBe(variantGid);
    expect(args.cart.line_items[0].quantity).toBe(1);
    // meta stays at params.arguments.meta.
    expect(args.meta['ucp-agent'].profile).toBe('https://agent.pivota.cc/.well-known/ucp-agent');
  });

  test('extractHandoffUrl pulls continue_url out of a fixture cart result', async () => {
    const { client } = newClient({ [TOOL.CREATE_CART]: CREATE_CART_FIXTURE });
    const endpoint = 'https://cosrx.example.myshopify.com/ucp/mcp';
    const cart = await client.createCart(endpoint, {
      lineItems: [{ item: { id: 'gid://shopify/ProductVariant/111' }, quantity: 1 }],
    });
    expect(client.extractHandoffUrl(cart)).toBe(
      'https://cosrx.example.myshopify.com/cart/111:1?payment=shop_pay',
    );
  });

  test('surfaces a tier/auth refusal without throwing', async () => {
    const { client } = newClient({
      [TOOL.CREATE_CHECKOUT]: () => jsonResponse({ error: { code: -32000, message: 'authentication required' } }, 401),
    });
    const res = await client.createCheckout('https://cosrx.example.myshopify.com/ucp/mcp', { cartId: 'cart_abc' });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

// ---- client: hard safety bounds -------------------------------------------

describe('hard safety bounds', () => {
  test('client exposes no completeCheckout method', () => {
    const client = createUcpBuyerAgentClient({ credential: 'x', fetchImpl: makeFetch({}) });
    expect(client.completeCheckout).toBeUndefined();
    expect(typeof client.refuseCompleteCheckout).toBe('function');
  });

  test('refuseCompleteCheckout returns a refusal and makes NO network call', async () => {
    const fetchImpl = makeFetch({});
    const client = createUcpBuyerAgentClient({ credential: 'x', fetchImpl });
    const refusal = client.refuseCompleteCheckout();
    expect(refusal.refused).toBe(true);
    expect(refusal.tool).toBe('complete_checkout');
    expect(fetchImpl.calls.length).toBe(0);
  });

  test('callTool hard-blocks complete_checkout even if invoked directly', async () => {
    const fetchImpl = makeFetch({});
    const client = createUcpBuyerAgentClient({ credential: 'x', fetchImpl });
    await expect(client.callTool('https://cosrx.example.myshopify.com/ucp/mcp', 'complete_checkout', {}))
      .rejects.toThrow(/hard-disabled/);
    expect(fetchImpl.calls.length).toBe(0);
  });

  test('complete_checkout is hard-blocked at the SIGNED tier too', async () => {
    const fetchImpl = makeFetch({});
    const client = createUcpBuyerAgentClient({
      signingPrivateKey: TEST_PRIVATE_PEM, signingKeyId: TEST_KEY_ID, fetchImpl,
    });
    expect(client.tier).toBe(TRUST_TIER.SIGNED);
    expect(client.completeCheckout).toBeUndefined();
    await expect(client.callTool('https://cosrx.example.myshopify.com/ucp/mcp', 'complete_checkout', {}))
      .rejects.toThrow(/hard-disabled/);
    expect(fetchImpl.calls.length).toBe(0);
  });
});

// ---- profile: signing_keys publication ------------------------------------

describe('buildUcpBuyerAgentProfile signing_keys', () => {
  test('defaults to an empty signing_keys array (anonymous/token only)', () => {
    const p = buildUcpBuyerAgentProfile({ signingKeys: [] });
    expect(Array.isArray(p.ucp.signing_keys)).toBe(true);
    expect(p.ucp.signing_keys.length).toBe(0);
  });

  test('publishes a provided PUBLIC JWK with its kid', () => {
    const p = buildUcpBuyerAgentProfile({ signingKeys: [TEST_PUBLIC_JWK] });
    expect(p.ucp.signing_keys).toHaveLength(1);
    const k = p.ucp.signing_keys[0];
    expect(k.kty).toBe('EC');
    expect(k.crv).toBe('P-256');
    expect(k.kid).toBe(TEST_KEY_ID);
    expect(k.use).toBe('sig');
  });

  test('REFUSES to publish a private key (throws on a `d` member)', () => {
    const withPrivate = { ...TEST_PUBLIC_JWK, d: 'super-secret-private-scalar' };
    expect(() => buildUcpBuyerAgentProfile({ signingKeys: [withPrivate] })).toThrow(/private material/i);
  });

  test('resolveSigningKeys reads a single JWK object from env and never leaks private material', () => {
    const keys = resolveSigningKeys({ env: { UCP_AGENT_SIGNING_PUBLIC_JWK: JSON.stringify(TEST_PUBLIC_JWK) } });
    expect(keys).toHaveLength(1);
    expect(keys[0].kid).toBe(TEST_KEY_ID);
    expect(JSON.stringify(keys[0])).not.toMatch(/"d"/);
  });
});

// ---- client: SIGNED-tier identity + derivation ----------------------------

describe('SIGNED tier identity + derivation', () => {
  test('signing key present, no token -> SIGNED tier; private key never leaked', () => {
    const client = createUcpBuyerAgentClient({
      signingPrivateKey: TEST_PRIVATE_PEM, signingKeyId: TEST_KEY_ID,
      signingKeys: [TEST_PUBLIC_JWK], fetchImpl: makeFetch({}),
    });
    const d = client.describeTier();
    expect(client.tier).toBe(TRUST_TIER.SIGNED);
    expect(d.supports_signed_tier).toBe(true);
    expect(d.has_signing_key).toBe(true);
    expect(d.signing_key_id).toBe(TEST_KEY_ID);
    expect(d.published_signing_key_ids).toContain(TEST_KEY_ID);
    expect(d.completes_checkout).toBe(false);
    // The private key/PEM must never appear in the descriptor.
    expect(JSON.stringify(d)).not.toMatch(/BEGIN PRIVATE KEY|MIGHAgEA/);
  });

  test('token beats signing key (TOKEN tier when both present)', () => {
    const client = createUcpBuyerAgentClient({
      credential: 'jwt', signingPrivateKey: TEST_PRIVATE_PEM, signingKeyId: TEST_KEY_ID, fetchImpl: makeFetch({}),
    });
    expect(client.tier).toBe(TRUST_TIER.TOKEN);
  });

  test('no key + no token -> ANONYMOUS, supports_signed_tier false', () => {
    const client = createUcpBuyerAgentClient({ fetchImpl: makeFetch({}) });
    expect(client.tier).toBe(TRUST_TIER.ANONYMOUS);
    expect(client.describeTier().supports_signed_tier).toBe(false);
  });

  test('signing key without a resolvable keyid throws', () => {
    // PEM carries no kid, and no keyid is supplied -> must fail loudly.
    expect(() => createUcpBuyerAgentClient({ signingPrivateKey: TEST_PRIVATE_PEM, fetchImpl: makeFetch({}) }))
      .toThrow(/keyid/i);
  });
});

// ---- RFC 9421 signature construction (deterministic) ----------------------

describe('RFC 9421 signature construction', () => {
  const endpoint = 'https://cosrx.example.myshopify.com/ucp/mcp';
  const bodyString = JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'create_checkout' } });

  test('content digest is RFC 9530 sha-256 base64 wrapped in colons', () => {
    const cd = contentDigestFor(bodyString);
    const expected = `sha-256=:${nodeCrypto.createHash('sha256').update(bodyString, 'utf8').digest('base64')}:`;
    expect(cd).toBe(expected);
  });

  test('covered components + params match the UCP signature spec for a POST body', () => {
    const { covered, params } = buildUcpSignatureBase({
      method: 'POST', url: endpoint, bodyString,
      ucpAgentValue: 'profile="https://agent.pivota.cc/.well-known/ucp-agent"',
      idempotencyKey: 'idem-123', keyid: TEST_KEY_ID, created: 1000, expires: 1300,
    });
    expect(covered).toEqual([
      '@method', '@authority', '@path', 'ucp-agent', 'idempotency-key', 'content-digest', 'content-type',
    ]);
    // keyid present; NO alg param (derived from JWK crv); created/expires present.
    expect(params).toContain(';keyid="pivota-test-key-1"');
    expect(params).toContain(';created=1000');
    expect(params).toContain(';expires=1300');
    expect(params).not.toMatch(/;alg=/);
  });

  test('signUcpRequest produces a signature verifiable with the PUBLIC JWK (raw r||s)', () => {
    const { keyObject } = loadSigningPrivateKey(TEST_PRIVATE_PEM);
    const { headers, signatureBase } = signUcpRequest({
      method: 'POST', url: endpoint, bodyString,
      ucpAgentValue: 'profile="https://agent.pivota.cc/.well-known/ucp-agent"',
      idempotencyKey: 'idem-123', keyObject, keyid: TEST_KEY_ID, created: 1000, expires: 1300,
    });
    expect(headers['content-digest']).toBe(contentDigestFor(bodyString));
    expect(headers['signature-input']).toMatch(/^sig1=\("@method" "@authority" "@path" "ucp-agent" "idempotency-key" "content-digest" "content-type"\);created=1000;expires=1300;keyid="pivota-test-key-1"$/);
    // Raw r||s ECDSA signature (64 bytes for P-256), NOT DER.
    const sigB64 = /^sig1=:(.*):$/.exec(headers.signature)[1];
    expect(Buffer.from(sigB64, 'base64').length).toBe(64);
    const pub = nodeCrypto.createPublicKey({ key: TEST_PUBLIC_JWK, format: 'jwk' });
    const ok = nodeCrypto.verify('sha256', Buffer.from(signatureBase, 'utf8'), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64, 'base64'));
    expect(ok).toBe(true);
  });
});

// ---- client: SIGNED-tier checkout-create over fixtures --------------------

describe('SIGNED tier checkout-create reaches the handoff URL credential-free', () => {
  test('signs create_checkout, sends NO Authorization, and the signature verifies', async () => {
    const fetchImpl = makeFetch({
      [TOOL.CREATE_CHECKOUT]: CREATE_CHECKOUT_FIXTURE,
    });
    const client = createUcpBuyerAgentClient({
      signingPrivateKey: TEST_PRIVATE_PEM, signingKeyId: TEST_KEY_ID, signingKeys: [TEST_PUBLIC_JWK],
      profileUrl: 'https://agent.pivota.cc/.well-known/ucp-agent', fetchImpl,
    });
    const endpoint = 'https://cosrx.example.myshopify.com/ucp/mcp';

    const checkout = await client.createCheckout(endpoint, { cartId: 'cart_abc' });
    expect(checkout.ok).toBe(true);
    expect(checkout.tier).toBe(TRUST_TIER.SIGNED);
    expect(client.extractHandoffUrl(checkout)).toBe('https://cosrx.example.myshopify.com/checkouts/xyz');

    const call = fetchImpl.calls.find((c) => c.body && c.body.params && c.body.params.name === TOOL.CREATE_CHECKOUT);
    // SIGNED tier sends NO Bearer token — checkout is reached credential-free.
    expect(call.headers.authorization).toBeUndefined();
    // Signature + digest + covered pointers are attached.
    expect(call.headers['signature-input']).toMatch(/keyid="pivota-test-key-1"/);
    expect(call.headers.signature).toMatch(/^sig1=:.*:$/);
    expect(call.headers['ucp-agent']).toBe('profile="https://agent.pivota.cc/.well-known/ucp-agent"');
    expect(call.headers['idempotency-key']).toBeTruthy();
    // content-digest binds the exact wire body.
    expect(call.headers['content-digest']).toBe(contentDigestFor(call.rawBody));
    // idempotency-key + ucp-agent also travel in the JSON-RPC meta at params.arguments.meta (live shape).
    expect(call.body.params.arguments.meta['ucp-agent'].profile).toBe('https://agent.pivota.cc/.well-known/ucp-agent');
    expect(call.body.params.arguments.meta['idempotency-key']).toBe(call.headers['idempotency-key']);
    // End-to-end: the signature verifies against the PUBLISHED public JWK.
    const { ok } = verifyCapturedSignature(call, endpoint);
    expect(ok).toBe(true);
    // No credential/private material anywhere on the wire.
    expect(JSON.stringify(call)).not.toMatch(/BEGIN PRIVATE KEY|MIGHAgEA/);
  });
});
