const {
  resolveGatewayUrl,
  buildAuthoritativePayload,
  unwrapLivePdpPayload,
} = require('../../scripts/audit-external-product-pdp-quality');

describe('audit-external-product-pdp-quality helpers', () => {
  test('defaults to the public PDP gateway instead of production backend env', () => {
    expect(resolveGatewayUrl('')).toBe('https://agent.pivota.cc/api/gateway');
  });

  test('normalizes gateway bases to the public api gateway endpoint', () => {
    expect(resolveGatewayUrl('https://agent.pivota.cc')).toBe('https://agent.pivota.cc/api/gateway');
    expect(resolveGatewayUrl('https://agent.pivota.cc/api/gateway')).toBe('https://agent.pivota.cc/api/gateway');
  });

  test('unwraps canonical PDP payload from get_pdp_v2 gateway envelope', () => {
    const payload = {
      modules: [
        { type: 'price_promo', data: { price: { amount: 25 } } },
        { type: 'product_details', data: { sections: [{ heading: 'Overview', content: 'Clean PDP.' }] } },
      ],
    };
    const envelope = {
      status: 'success',
      modules: [
        {
          type: 'canonical',
          data: {
            pdp_payload: payload,
          },
        },
      ],
    };

    expect(unwrapLivePdpPayload(envelope)).toBe(payload);
  });

  test('builds authoritative get_pdp_v2 payloads for invoke endpoint probes', () => {
    expect(buildAuthoritativePayload('get_pdp_v2', { product_id: 'ext_123' })).toEqual({
      operation: 'get_pdp_v2',
      payload: {
        product_ref: {
          merchant_id: 'external_seed',
          product_id: 'ext_123',
        },
        options: {
          debug: true,
        },
      },
    });
  });

  test('builds authoritative find_similar_products payloads for invoke endpoint probes', () => {
    expect(
      buildAuthoritativePayload('find_similar_products', {
        product_id: 'ext_123',
        limit: 4,
        exclude_items: ['a', 'b'],
        options: { trace: true },
      }),
    ).toEqual({
      operation: 'find_similar_products',
      payload: {
        similar: {
          merchant_id: 'external_seed',
          product_id: 'ext_123',
          limit: 4,
          exclude_items: ['a', 'b'],
        },
        options: {
          trace: true,
          debug: true,
          no_cache: true,
        },
      },
    });
  });
});
