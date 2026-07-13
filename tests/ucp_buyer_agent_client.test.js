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
    expect(p.ucp.version).toBe('2026-04-08');
    expect(p.ucp.services['dev.ucp.shopping'][0].transport).toBe('mcp');
    expect(Object.keys(p.ucp.capabilities)).toEqual(
      expect.arrayContaining(['dev.ucp.shopping.catalog', 'dev.ucp.shopping.cart', 'dev.ucp.shopping.checkout']),
    );
    // payment_handlers must be present (may be empty) per the schema.
    expect(p.ucp.payment_handlers).toEqual({});
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

  test('checkout capability extends cart', () => {
    const p = buildUcpBuyerAgentProfile();
    expect(p.ucp.capabilities[CHECKOUT_CAPABILITY][0].extends).toBe('dev.ucp.shopping.cart');
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

    const search = await client.catalogSearch(endpoint, { query: 'cosrx' });
    expect(search.ok).toBe(true);

    const cart = await client.createCart(endpoint, {
      lineItems: [{ item: { id: '111', title: 'Snail Mucin' }, quantity: 1 }],
    });
    expect(cart.ok).toBe(true);
    expect(client.extractHandoffUrl(cart)).toMatch(/\/cart\/111/);

    const checkout = await client.createCheckout(endpoint, { cartId: 'cart_abc' });
    expect(checkout.ok).toBe(true);
    expect(client.extractHandoffUrl(checkout)).toBe('https://cosrx.example.myshopify.com/checkouts/xyz');

    // Every request carried the agent profile pointer + Bearer auth (token tier). Credential never in a URL.
    const mcpCall = fetchImpl.calls.find((c) => c.body && c.body.params && c.body.params.name === TOOL.CREATE_CART);
    expect(mcpCall.body.meta['ucp-agent'].profile).toBe('https://agent.pivota.cc/.well-known/ucp-agent');
    expect(mcpCall.headers.authorization).toBe('Bearer test-token');
    expect(fetchImpl.calls.every((c) => !String(c.url).includes('test-token'))).toBe(true);
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
    // idempotency-key + ucp-agent also travel in the JSON-RPC meta (MCP requirement).
    expect(call.body.meta['ucp-agent'].profile).toBe('https://agent.pivota.cc/.well-known/ucp-agent');
    expect(call.body.meta['idempotency-key']).toBe(call.headers['idempotency-key']);
    // End-to-end: the signature verifies against the PUBLISHED public JWK.
    const { ok } = verifyCapturedSignature(call, endpoint);
    expect(ok).toBe(true);
    // No credential/private material anywhere on the wire.
    expect(JSON.stringify(call)).not.toMatch(/BEGIN PRIVATE KEY|MIGHAgEA/);
  });
});
