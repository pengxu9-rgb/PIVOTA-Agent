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
});
