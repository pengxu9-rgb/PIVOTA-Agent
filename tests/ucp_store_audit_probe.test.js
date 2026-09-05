'use strict';

const {
  createUcpStoreAuditProbe,
  EVIDENCE_LEVEL_DETECTED,
  EVIDENCE_LEVEL_TESTED,
} = require('../src/services/ucpStoreAuditProbe');
const { createUcpBuyerAgentClient } = require('../src/services/ucpBuyerAgentClient');

describe('Store Audit UCP probe', () => {
  test('is anonymous even when the process has token and signing configuration', () => {
    const oldCredential = process.env.UCP_AGENT_CREDENTIAL;
    const oldClientId = process.env.UCP_AGENT_CLIENT_ID;
    const oldClientSecret = process.env.UCP_AGENT_CLIENT_SECRET;
    const oldSigningKey = process.env.UCP_AGENT_SIGNING_PRIVATE_KEY;
    process.env.UCP_AGENT_CREDENTIAL = 'must-not-be-used';
    process.env.UCP_AGENT_CLIENT_ID = 'must-not-be-used';
    process.env.UCP_AGENT_CLIENT_SECRET = 'must-not-be-used';
    process.env.UCP_AGENT_SIGNING_PRIVATE_KEY = 'must-not-be-used';
    try {
      const client = createUcpBuyerAgentClient({ forceAnonymous: true });
      expect(client.tier).toBe('anonymous');
    } finally {
      for (const [name, value] of Object.entries({
        UCP_AGENT_CREDENTIAL: oldCredential,
        UCP_AGENT_CLIENT_ID: oldClientId,
        UCP_AGENT_CLIENT_SECRET: oldClientSecret,
        UCP_AGENT_SIGNING_PRIVATE_KEY: oldSigningKey,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('records a tested, redacted checkout signal without a payment path', async () => {
    const client = {
      tier: 'anonymous',
      discoverEndpoint: jest.fn().mockResolvedValue({
        mcpEndpoint: 'https://shop.example.myshopify.com/api/ucp/mcp',
        wellKnownUrl: 'https://shop.example.com/.well-known/ucp',
        status: 200,
      }),
      listTools: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        response: { result: { tools: [{ name: 'create_checkout' }, { name: 'get_checkout' }] } },
      }),
      createCheckoutPreview: jest.fn().mockResolvedValue({
        ok: true,
        requires_escalation: true,
        priced: {
          item: { id: 'gid://shopify/ProductVariant/1', title: 'Example', price: '12.00' },
          subtotal: '12.00', shipping: null, tax: null, total: '12.00', currency: 'USD',
          shipping_options: [], continue_url: 'https://merchant.example/secret-session',
        },
      }),
    };
    const probe = createUcpStoreAuditProbe({ client, now: () => new Date('2026-08-23T00:00:00.000Z') });
    const result = await probe.probe({ brandDomain: 'shop.example.com', variantGid: 'gid://shopify/ProductVariant/1' });

    expect(result.verification_status).toBe('succeeded');
    expect(result.acceptance_signal.evidence_level).toBe(EVIDENCE_LEVEL_TESTED);
    expect(result.acceptance_signal.payload.priced_facts).toMatchObject({ total: '12.00', currency: 'USD' });
    expect(JSON.stringify(result)).not.toContain('secret-session');
    expect(client.createCheckoutPreview).toHaveBeenCalledTimes(1);
  });

  test('persists detected rather than tested when no variant is available', async () => {
    const client = {
      tier: 'anonymous',
      discoverEndpoint: jest.fn().mockResolvedValue({
        mcpEndpoint: 'https://shop.example.myshopify.com/api/ucp/mcp',
        wellKnownUrl: 'https://shop.example.com/.well-known/ucp', status: 200,
      }),
      listTools: jest.fn().mockResolvedValue({
        ok: true, status: 200, response: { result: { tools: [{ name: 'create_checkout' }] } },
      }),
      createCheckoutPreview: jest.fn(),
    };
    const result = await createUcpStoreAuditProbe({ client }).probe({ brandDomain: 'shop.example.com' });
    expect(result.verification_status).toBe('succeeded');
    expect(result.acceptance_signal.evidence_level).toBe(EVIDENCE_LEVEL_DETECTED);
    expect(result.reason).toBe('variant_required_for_checkout_test');
    expect(client.createCheckoutPreview).not.toHaveBeenCalled();
  });

  test('does not emit acceptance evidence when checkout preview throws', async () => {
    const client = {
      tier: 'anonymous',
      discoverEndpoint: jest.fn().mockResolvedValue({
        mcpEndpoint: 'https://shop.example.myshopify.com/api/ucp/mcp', status: 200,
      }),
      listTools: jest.fn().mockResolvedValue({
        ok: true, status: 200, response: { result: { tools: [{ name: 'create_checkout' }] } },
      }),
      createCheckoutPreview: jest.fn().mockRejectedValue(new Error('network reset')),
    };
    const result = await createUcpStoreAuditProbe({ client }).probe({
      brandDomain: 'shop.example.com', variantGid: 'gid://shopify/ProductVariant/1',
    });
    expect(result.verification_status).toBe('failed');
    expect(result.acceptance_signal).toBeNull();
  });

  test('rejects an injected non-anonymous client', () => {
    expect(() => createUcpStoreAuditProbe({ client: { tier: 'token' } }))
      .toThrow('requires an anonymous UCP client');
  });

  describe('endpoint-less discovery must not buy a delisting on an upstream refusal', () => {
    function endpointlessClient(status) {
      return {
        tier: 'anonymous',
        discoverEndpoint: jest.fn().mockResolvedValue({
          mcpEndpoint: undefined,
          businessProfile: null,
          wellKnownUrl: 'https://shop.example.com/.well-known/ucp',
          status,
        }),
        listTools: jest.fn(),
        createCheckoutPreview: jest.fn(),
      };
    }

    test.each([200, 404])('clean absence (status %s) reports succeeded/not_ucp_reachable', async (status) => {
      const client = endpointlessClient(status);
      const result = await createUcpStoreAuditProbe({ client }).probe({ brandDomain: 'shop.example.com' });
      expect(result.verification_status).toBe('succeeded');
      expect(result.reason).toBe('not_ucp_reachable');
      expect(client.listTools).not.toHaveBeenCalled();
    });

    test.each([403, 429, 500, 0, undefined])(
      'upstream condition (status %s) reports blocked, never not_ucp_reachable',
      async (status) => {
        const client = endpointlessClient(status);
        const result = await createUcpStoreAuditProbe({ client }).probe({ brandDomain: 'shop.example.com' });
        expect(result.verification_status).toBe('blocked');
        // The BASE reason, which is what the backend and every other consumer
        // match on; the ':status=' qualifier that follows says which upstream
        // condition it was, and is asserted separately below. This test's point
        // is that an upstream refusal never becomes not_ucp_reachable, because
        // that is the string the backend deactivates a route on.
        expect(result.reason.split(':')[0]).toBe('profile_unreachable');
        expect(result.reason).not.toBe('not_ucp_reachable');
        expect(client.listTools).not.toHaveBeenCalled();
      },
    );

    test('a refused redirect (301) reports blocked/profile_redirected', async () => {
      const client = endpointlessClient(301);
      const result = await createUcpStoreAuditProbe({ client }).probe({ brandDomain: 'shop.example.com' });
      expect(result.verification_status).toBe('blocked');
      expect(result.reason.split(':')[0]).toBe('profile_redirected');
    });
  });

  describe('tools/list upstream mapping', () => {
    function clientWithToolsStatus(status) {
      return {
        tier: 'anonymous',
        discoverEndpoint: jest.fn().mockResolvedValue({
          mcpEndpoint: 'https://shop.example.myshopify.com/api/ucp/mcp',
          wellKnownUrl: 'https://shop.example.com/.well-known/ucp',
          status: 200,
        }),
        listTools: jest.fn().mockResolvedValue({ ok: false, status, response: null }),
        createCheckoutPreview: jest.fn(),
      };
    }

    test.each([403, 429, 500])('tools/list status %s reports blocked', async (status) => {
      const result = await createUcpStoreAuditProbe({ client: clientWithToolsStatus(status) })
        .probe({ brandDomain: 'shop.example.com' });
      expect(result.verification_status).toBe('blocked');
      expect(result.acceptance_signal).toBeNull();
    });

    test('tools/list status 400 reports failed, not blocked', async () => {
      const result = await createUcpStoreAuditProbe({ client: clientWithToolsStatus(400) })
        .probe({ brandDomain: 'shop.example.com' });
      expect(result.verification_status).toBe('failed');
      expect(result.acceptance_signal).toBeNull();
    });
  });

  test('scrubs URL substrings from merchant strings before the receipt payload', async () => {
    const client = {
      tier: 'anonymous',
      discoverEndpoint: jest.fn().mockResolvedValue({
        mcpEndpoint: 'https://shop.example.myshopify.com/api/ucp/mcp',
        wellKnownUrl: 'https://shop.example.com/.well-known/ucp',
        status: 200,
      }),
      listTools: jest.fn().mockResolvedValue({
        ok: true, status: 200, response: { result: { tools: [{ name: 'create_checkout' }] } },
      }),
      createCheckoutPreview: jest.fn().mockResolvedValue({
        ok: true,
        requires_escalation: false,
        priced: {
          item: { id: 'variant-1', title: 'Serum — see https://evil.example/track?buyer=1 today' },
          subtotal: '12.00', total: '12.00', currency: 'USD',
          status: 'open HTTP://evil.example/x',
          shipping_options: [],
        },
      }),
    };
    const result = await createUcpStoreAuditProbe({ client }).probe({
      brandDomain: 'shop.example.com', variantGid: 'gid://shopify/ProductVariant/1',
    });
    expect(result.verification_status).toBe('succeeded');
    const facts = result.acceptance_signal.payload.priced_facts;
    expect(facts.item_title).toBe('Serum — see today');
    expect(facts.checkout_status).toBe('open');
    expect(JSON.stringify(facts).toLowerCase()).not.toContain('http');
  });
});

describe('Store Audit UCP probe — the reason names WHICH cause fired', () => {
  // PROFILE_UNREACHABLE is produced by four unrelated things: a thrown fetch
  // (DNS/TLS/connect/abort/SSRF refusal) and any 403, 429 or 5xx. Stored as one
  // identical string they are indistinguishable, and a whole day was spent on
  // two merchants stuck on it without being able to say which had happened.
  const fakeClient = (behaviour) => ({
    tier: 'anonymous',
    discoverEndpoint: behaviour,
    listTools: async () => ({ ok: true, status: 200, response: { result: { tools: [] } } }),
  });

  const reasonFor = async (behaviour) => {
    const probe = createUcpStoreAuditProbe({ client: fakeClient(behaviour) });
    const out = await probe.probe({ brandDomain: 'shop.example' });
    return out.reason;
  };

  test('a thrown fetch carries the cause code, not the generic message', async () => {
    const err = new Error('fetch failed');
    err.cause = { code: 'ENETUNREACH' };
    const reason = await reasonFor(async () => { throw err; });

    // The base string is unchanged and FIRST, so existing consumers still match.
    expect(reason.startsWith('profile_unreachable')).toBe(true);
    // ...and the qualifier says it was the network, not a WAF.
    expect(reason).toBe('profile_unreachable:threw=ENETUNREACH');
  });

  test('an SSRF refusal is distinguishable from a network failure', async () => {
    const reason = await reasonFor(async () => {
      throw new Error('merchant endpoint resolved to a non-public address');
    });

    // No cause code on this one, so it falls back to the name rather than
    // collapsing into the same string a timeout produces.
    expect(reason).toBe('profile_unreachable:threw=unknown');
  });

  test('a 403 is reported as a status, never as a throw', async () => {
    const reason = await reasonFor(async () => ({ mcpEndpoint: undefined, status: 403 }));

    expect(reason).toBe('profile_unreachable:status=403');
  });

  test('a 429 and a 503 are told apart from each other', async () => {
    expect(await reasonFor(async () => ({ mcpEndpoint: undefined, status: 429 })))
      .toBe('profile_unreachable:status=429');
    expect(await reasonFor(async () => ({ mcpEndpoint: undefined, status: 503 })))
      .toBe('profile_unreachable:status=503');
  });

  test('a refused redirect keeps its own reason and gains the status', async () => {
    const reason = await reasonFor(async () => ({ mcpEndpoint: undefined, status: 301 }));

    expect(reason).toBe('profile_redirected:status=301');
  });

  test('a clean absence is untouched — it must stay exactly not_ucp_reachable', async () => {
    // The backend DEACTIVATES a route on succeeded + not_ucp_reachable, so a
    // qualifier here would change what an existing consumer does.
    const probe = createUcpStoreAuditProbe({
      client: fakeClient(async () => ({ mcpEndpoint: undefined, status: 200 })),
    });
    const out = await probe.probe({ brandDomain: 'shop.example' });

    expect(out.verification_status).toBe('succeeded');
    expect(out.reason).toBe('not_ucp_reachable');
  });

  test('a merchant-controlled cause cannot fill the reason field', async () => {
    // reason is capped at 500 chars by the receipt; an unbounded error string
    // would wedge the claim in a lease-expiry loop it can never complete.
    const err = new Error('fetch failed');
    err.cause = { code: 'X'.repeat(5000) };
    const reason = await reasonFor(async () => { throw err; });

    expect(reason.length).toBeLessThan(120);
  });
});
