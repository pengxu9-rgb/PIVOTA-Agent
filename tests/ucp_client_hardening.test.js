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
