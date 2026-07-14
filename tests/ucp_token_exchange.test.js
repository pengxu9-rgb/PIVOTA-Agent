'use strict';

/*
 * Money-safety tests for the TOKEN-tier client-credential exchange (Part A of
 * docs/ucp_inchat_preview_build_2026-07-13.md). Shopify Dev Dashboard flow:
 *   POST { client_id, client_secret, grant_type:"client_credentials" } -> a 60-min JWT fed into the Bearer path.
 *
 * Asserts: the JWT is fetched from the token endpoint, cached (not re-minted while fresh), REFRESHED before the
 * 60-min expiry, and the client_secret + minted JWT never appear in any surfaced output (describeTier, the
 * callTool result, or a thrown error). NO live network — the token endpoint + MCP are fixtures.
 */

const { createUcpBuyerAgentClient, TRUST_TIER } = require('../src/services/ucpBuyerAgentClient');

const CLIENT_ID = 'pivota-agent-client-id';
const CLIENT_SECRET = 'super-secret-client-secret-DO-NOT-LEAK';
const TOKEN_ENDPOINT = 'https://api.shopify.com/auth/access_token';
const MCP_ENDPOINT = 'https://cosrx.example.myshopify.com/ucp/mcp';

const CREATE_CART_FIXTURE = {
  jsonrpc: '2.0',
  id: '2',
  result: {
    content: [{
      type: 'json',
      json: { id: 'cart_abc', line_items: [{ item: { id: '111' }, quantity: 1 }], continue_url: 'https://x/cart/1' },
    }],
  },
};

function jsonResponse(obj, status = 200) {
  const text = JSON.stringify(obj);
  return { ok: status >= 200 && status < 300, status, async json() { return obj; }, async text() { return text; } };
}

/**
 * Build a fetch that mints a distinct JWT per token-endpoint hit (jwt-mint-1, jwt-mint-2, ...) and records the
 * secret it saw, so a test can assert the exchange happened and count re-mints.
 */
function makeTokenFetch({ expiresIn = 3600, mcpFixture = CREATE_CART_FIXTURE } = {}) {
  const calls = [];
  let mintCount = 0;
  const fetchImpl = async (url, init = {}) => {
    let body;
    try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    calls.push({ url: String(url), headers: init.headers || {}, body });
    if (String(url) === TOKEN_ENDPOINT) {
      mintCount += 1;
      return jsonResponse({ access_token: `jwt-mint-${mintCount}`, token_type: 'bearer', expires_in: expiresIn });
    }
    return jsonResponse(mcpFixture);
  };
  fetchImpl.calls = calls;
  fetchImpl.tokenCalls = () => calls.filter((c) => c.url === TOKEN_ENDPOINT);
  fetchImpl.mcpCalls = () => calls.filter((c) => c.url === MCP_ENDPOINT);
  return fetchImpl;
}

describe('token-credential exchange (client_credentials grant)', () => {
  test('client_id+secret => TOKEN tier; a JWT is fetched from the token endpoint and attached as Bearer', async () => {
    const fetchImpl = makeTokenFetch();
    const client = createUcpBuyerAgentClient({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl,
    });
    expect(client.tier).toBe(TRUST_TIER.TOKEN);

    const cart = await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: '111' }, quantity: 1 }] });
    expect(cart.ok).toBe(true);

    // The token endpoint was hit with the client_credentials grant BEFORE the MCP call.
    const tokenCalls = fetchImpl.tokenCalls();
    expect(tokenCalls.length).toBe(1);
    expect(tokenCalls[0].body.grant_type).toBe('client_credentials');
    expect(tokenCalls[0].body.client_id).toBe(CLIENT_ID);

    // The minted JWT was attached to the MCP request as a Bearer token.
    const mcpCall = fetchImpl.mcpCalls()[0];
    expect(mcpCall.headers.authorization).toBe('Bearer jwt-mint-1');
  });

  test('the JWT is CACHED — a second call while fresh does NOT re-mint', async () => {
    const fetchImpl = makeTokenFetch({ expiresIn: 3600 });
    const client = createUcpBuyerAgentClient({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl,
      tokenRefreshSkewMs: 0, // no skew: a fresh token is reused
    });
    await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: '111' }, quantity: 1 }] });
    await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: '111' }, quantity: 1 }] });

    // Two MCP calls, but only ONE token mint (the cached JWT was reused).
    expect(fetchImpl.mcpCalls().length).toBe(2);
    expect(fetchImpl.tokenCalls().length).toBe(1);
    expect(fetchImpl.mcpCalls().every((c) => c.headers.authorization === 'Bearer jwt-mint-1')).toBe(true);
  });

  test('the JWT is REFRESHED before the 60-min expiry (re-mint inside the refresh window)', async () => {
    // expires_in 3600s but a 3600s refresh skew => the token is ALWAYS inside the refresh window, forcing a
    // fresh mint on every call. This proves the client refreshes BEFORE the stated 60-min TTL, never after.
    const fetchImpl = makeTokenFetch({ expiresIn: 3600 });
    const client = createUcpBuyerAgentClient({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl,
      tokenRefreshSkewMs: 3600 * 1000,
    });
    await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: '111' }, quantity: 1 }] });
    await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: '111' }, quantity: 1 }] });

    // Each MCP call re-minted (refreshed) the JWT ahead of expiry -> the second call used a NEW token.
    expect(fetchImpl.tokenCalls().length).toBe(2);
    expect(fetchImpl.mcpCalls()[0].headers.authorization).toBe('Bearer jwt-mint-1');
    expect(fetchImpl.mcpCalls()[1].headers.authorization).toBe('Bearer jwt-mint-2');
  });

  test('the client_secret and the minted JWT never appear in describeTier or the callTool result', async () => {
    const fetchImpl = makeTokenFetch();
    const client = createUcpBuyerAgentClient({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl,
    });

    const describe = JSON.stringify(client.describeTier());
    expect(describe).not.toContain(CLIENT_SECRET);
    expect(describe).not.toMatch(/jwt-mint-/);
    // Booleans only.
    expect(client.describeTier().has_client_credentials).toBe(true);
    expect(client.describeTier().has_token_tier_credential).toBe(true);

    const cart = await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: '111' }, quantity: 1 }] });
    // The result surfaced to callers carries neither the secret nor the JWT (the JWT lives only on the wire header).
    const resultJson = JSON.stringify(cart);
    expect(resultJson).not.toContain(CLIENT_SECRET);
    expect(resultJson).not.toMatch(/jwt-mint-/);
  });

  test('a failed exchange throws a status-only error that leaks NO credential material', async () => {
    const fetchImpl = async (url) => {
      if (String(url) === TOKEN_ENDPOINT) return jsonResponse({ error: 'invalid_client' }, 401);
      return jsonResponse(CREATE_CART_FIXTURE);
    };
    const client = createUcpBuyerAgentClient({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl,
    });
    let caught;
    try {
      await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: '111' }, quantity: 1 }] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.message).toMatch(/token-credential exchange failed \(status 401\)/);
    expect(caught.message).not.toContain(CLIENT_SECRET);
    expect(caught.message).not.toContain(CLIENT_ID);
  });

  test('a static UCP_AGENT_CREDENTIAL wins and short-circuits the exchange (existing path unchanged)', async () => {
    const fetchImpl = makeTokenFetch();
    const client = createUcpBuyerAgentClient({
      credential: 'static-jwt', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl,
    });
    await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: '111' }, quantity: 1 }] });
    // No token-endpoint hit — the static credential was used verbatim.
    expect(fetchImpl.tokenCalls().length).toBe(0);
    expect(fetchImpl.mcpCalls()[0].headers.authorization).toBe('Bearer static-jwt');
  });
});
