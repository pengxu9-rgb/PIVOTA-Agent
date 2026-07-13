'use strict';

/*
 * Fixture-based unit tests for the OUTBOUND UCP buyer-agent client + capability profile.
 * NO live network: every fetch is a synthetic/recorded UCP response injected via `fetchImpl`.
 * Asserts the HARD SAFETY BOUNDS: the client never has/attempts a complete_checkout path, never leaks the
 * credential, requests only catalog+cart+checkout scopes, and correctly captures the storefront handoff URL.
 */

const {
  createUcpBuyerAgentClient,
  TOOL,
  TRUST_TIER,
} = require('../src/services/ucpBuyerAgentClient');
const {
  buildUcpBuyerAgentProfile,
  assertNoPurchaseCompletion,
  CHECKOUT_CAPABILITY,
} = require('../src/services/ucpBuyerAgentProfile');

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
    calls.push({ url, headers: init.headers || {}, body });
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
});
