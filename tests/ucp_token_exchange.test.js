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

// ---- credential-carrying requests NEVER follow a redirect ---------------------------------------
//
// A 307/308 REPLAYS the request body verbatim at the redirect target. Measured on node 24: undici strips
// the `Authorization` header cross-origin, but the JSON body and every other header (including an RFC 9421
// `signature`) go through untouched. The token exchange body holds the client secret; callTool/listTools
// carry the tier credential and the cart/buyer payload. So a redirecting endpoint — compromised,
// misconfigured, or behind a catch-all rewrite — would hand that material to whatever origin it names.
//
// The stub below HONOURS `redirect` for the two values this code can produce, which is the only shape
// that can tell the behaviours apart: on 'error' the fetch REJECTS; on 'follow' the caller never sees the
// 3xx and is handed the redirect TARGET's 200 — and the target records what it received. A stub that merely
// returned a 302 would prove nothing (302 is already !ok, so the unfixed code fails there too). It does NOT
// model 'manual' (real undici returns the 3xx itself, which `!res.ok` already refuses safely); anything
// other than 'error' takes the follow branch, so a mutation to 'manual' reports a kill it has not earned.
describe('credential-carrying requests refuse redirects', () => {
  const LEAK_TARGET = 'https://attacker.example/collect';

  /** Every request 307s to LEAK_TARGET; the target records the exact body + headers it would receive. */
  function makeRedirectingFetch({ leakedTokenResponse } = {}) {
    const inits = [];
    const receivedAtTarget = [];
    const impl = async (url, init = {}) => {
      inits.push({ url: String(url), redirect: init.redirect, method: init.method });
      if (init.redirect === 'error') throw new TypeError('fetch failed');
      // 'follow' (or unset): what a 307 replay actually delivers to the redirect target.
      // Records headers verbatim; real undici would strip `Authorization` cross-origin (measured), so the
      // Bearer assertions below are conservative -- the load-bearing leak is the BODY, which does replay.
      receivedAtTarget.push({ url: LEAK_TARGET, body: init.body, headers: init.headers || {} });
      const resp = leakedTokenResponse || CREATE_CART_FIXTURE;
      return jsonResponse(resp);
    };
    impl.inits = inits;
    impl.receivedAtTarget = receivedAtTarget;
    return impl;
  }

  test('token exchange: a redirecting token endpoint receives NOTHING — the secret never leaves', async () => {
    const fetchImpl = makeRedirectingFetch({
      leakedTokenResponse: { access_token: 'jwt-from-attacker', token_type: 'bearer', expires_in: 3600 },
    });
    const client = createUcpBuyerAgentClient({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokenEndpoint: TOKEN_ENDPOINT, fetchImpl,
      retryAttempts: 0,
    });
    // The exchange happens lazily on the first credentialed call.
    const result = await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: '111' }, quantity: 1 }] })
      .catch((e) => ({ threw: e }));

    // The redirect target got NOTHING. Under the mutant (redirect dropped) it gets the secret verbatim —
    // this is deliberately the FIRST assertion of all, so the failure diff prints the secret sitting at
    // the attacker rather than a missing init option or a missing throw. Holds for the single-site and
    // the all-three-sites revert alike.
    const leaked = fetchImpl.receivedAtTarget.map((r) => String(r.body)).join('\n');
    expect(leaked).not.toContain(CLIENT_SECRET);
    expect(fetchImpl.receivedAtTarget).toHaveLength(0);
    // Refused, and refused OPAQUELY: the thrown error carries no credential material.
    expect(result.threw).toBeInstanceOf(Error);
    expect(String(result.threw && result.threw.message)).not.toContain(CLIENT_SECRET);
    // And the request went out with the refusal actually set (catches a stub-shaped false pass).
    const tokenInit = fetchImpl.inits.find((i) => i.url === TOKEN_ENDPOINT);
    expect(tokenInit).toBeDefined();
    expect(tokenInit.redirect).toBe('error');
  });

  test('callTool and listTools: a redirecting MCP endpoint receives neither the Bearer nor the payload', async () => {
    const fetchImpl = makeRedirectingFetch();
    const client = createUcpBuyerAgentClient({
      credential: 'static-bearer-DO-NOT-LEAK', fetchImpl, retryAttempts: 0,
    });
    const cart = await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: 'variant-DO-NOT-LEAK' }, quantity: 1 }] })
      .catch((e) => ({ threw: e }));
    const list = await client.listTools(MCP_ENDPOINT).catch((e) => ({ threw: e }));

    expect(cart.threw).toBeInstanceOf(Error);
    expect(list.threw).toBeInstanceOf(Error);
    for (const i of fetchImpl.inits) expect(i.redirect).toBe('error');
    expect(fetchImpl.inits.length).toBeGreaterThanOrEqual(2);

    const leaked = JSON.stringify(fetchImpl.receivedAtTarget);
    expect(leaked).not.toContain('static-bearer-DO-NOT-LEAK');
    expect(leaked).not.toContain('variant-DO-NOT-LEAK');
    expect(fetchImpl.receivedAtTarget).toHaveLength(0);
  });

  test('ANONYMOUS tier too: no credential is not a licence to follow — the cart payload still must not travel', async () => {
    // The live warm-handoff lane is built from env only; with no credential, no client credentials and no
    // signing key it runs at ANONYMOUS tier, and createCart is explicitly the unauthenticated path. A future
    // "there is nothing to protect at anonymous" exemption would still ship variant ids / attribution /
    // buyer context to the redirect target -- and without this case, every other test here stays green.
    const fetchImpl = makeRedirectingFetch();
    const client = createUcpBuyerAgentClient({ fetchImpl, retryAttempts: 0 });
    expect(client.describeTier().tier).toBe('anonymous');
    const cart = await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: 'variant-ANON-DO-NOT-LEAK' }, quantity: 1 }] })
      .catch((e) => ({ threw: e }));
    expect(JSON.stringify(fetchImpl.receivedAtTarget)).not.toContain('variant-ANON-DO-NOT-LEAK');
    expect(fetchImpl.receivedAtTarget).toHaveLength(0);
    expect(cart.threw).toBeInstanceOf(Error);
    for (const i of fetchImpl.inits) expect(i.redirect).toBe('error');
  });

  test('control: the same fixtures are accepted when no redirect is involved', async () => {
    // Pins that the two refusals above fail on the REFUSAL, not on an unusable fixture: with a plain fetch
    // the exchange mints and the cart call succeeds end to end.
    const fetchImpl = makeTokenFetch();
    const client = createUcpBuyerAgentClient({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokenEndpoint: TOKEN_ENDPOINT, fetchImpl,
    });
    const cart = await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: '111' }, quantity: 1 }] });
    expect(cart.ok).toBe(true);
    expect(fetchImpl.tokenCalls()).toHaveLength(1);
  });
});
