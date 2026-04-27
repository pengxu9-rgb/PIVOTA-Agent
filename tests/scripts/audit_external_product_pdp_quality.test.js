const {
  resolveGatewayUrl,
  buildAuthoritativePayload,
  buildPublicGatewayPayload,
  unwrapLivePdpPayload,
} = require('../../scripts/audit-external-product-pdp-quality');
const {
  buildIdentityGate,
  buildProductIntelGate,
  buildLivePdpGate,
  buildVariantGate,
  buildExternalSeedQualityResult,
} = require('../../src/services/externalSeedPdpQuality');

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
        include: [
          'canonical',
          'product_intel',
          'product_details',
          'product_facts',
          'active_ingredients',
          'ingredients_inci',
          'how_to_use',
          'reviews_preview',
          'similar',
          'variant_selector',
          'offers',
        ],
        options: {
          debug: true,
          no_cache: true,
        },
      },
    });
  });

  test('builds public get_pdp_v2 payloads with audit-owned includes', () => {
    expect(buildPublicGatewayPayload('get_pdp_v2', { product_id: 'ext_123' })).toEqual({
      operation: 'get_pdp_v2',
      payload: {
        product_ref: {
          merchant_id: 'external_seed',
          product_id: 'ext_123',
        },
        include: ['product_intel', 'reviews_preview'],
        options: {
          debug: true,
          no_cache: true,
          cache_bypass: true,
        },
      },
      metadata: {
        scope: { catalog: 'global', region: 'US', language: 'en-US' },
        entry: 'pdp_quality_audit',
      },
    });
  });

  test('builds public find_similar_products payloads with nested similar request', () => {
    expect(
      buildPublicGatewayPayload('find_similar_products', {
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
          cache_bypass: true,
        },
      },
      metadata: {
        scope: { catalog: 'global', region: 'US', language: 'en-US' },
        entry: 'pdp_quality_audit',
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

  test('fails drift gates for canonical-only PDPs with soup details and stripped Tom Ford gallery URLs', () => {
    const livePayload = {
      product: {
        product_id: 'ext_e157ac1f095ba75edcff2a50',
        merchant_id: 'external_seed',
        description:
          'Details Full coverage concealer. Benefits 24H wear. Coverage Medium to full. Finish Natural matte. Ingredients Water, Dimethicone.',
      },
      modules: [
        {
          type: 'media_gallery',
          data: {
            items: [
              {
                type: 'image',
                url: 'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T92601_2000x2000_3.jpg',
              },
            ],
          },
        },
        {
          type: 'product_details',
          data: {
            sections: [
              {
                heading: 'Description',
                content:
                  'Details Full coverage concealer. Benefits 24H wear. Coverage Medium to full. Finish Natural matte. Ingredients Water, Dimethicone.',
              },
            ],
          },
        },
      ],
    };
    const liveResponse = {
      status: 'success',
      modules: [{ type: 'canonical', data: { pdp_payload: livePayload } }],
    };
    const livePdpGate = buildLivePdpGate({
      livePayload,
      liveResponse,
      imageHealth: {
        scanned_count: 1,
        broken_count: 1,
        broken_urls: [{ url: livePayload.modules[0].data.items[0].url, status: 404 }],
      },
    });
    const identityGate = buildIdentityGate({ livePayload, liveResponse });
    const productIntelGate = buildProductIntelGate({ livePayload, liveResponse });
    const result = buildExternalSeedQualityResult({
      seedId: 'seed_tom_ford',
      externalProductId: 'ext_e157ac1f095ba75edcff2a50',
      market: 'US',
      domain: 'www.tomfordbeauty.com',
      canonicalUrl: 'https://www.tomfordbeauty.com/products/shade-and-illuminate-concealer',
      identityGate,
      productIntelGate,
      livePdpGate,
    });

    expect(result.failure_reasons).toEqual(
      expect.arrayContaining([
        'missing_pdp_identity',
        'product_intel_module_empty_or_blocked',
        'product_details_section_soup',
        'legacy_overview_render_risk',
        'image_url_identity_stripped',
        'broken_gallery_image',
      ]),
    );
    expect(result.root_cause_classification).toEqual(
      expect.arrayContaining(['identity_graph_gap', 'product_intel_gap', 'image_asset_issue', 'pdp_shaping_issue']),
    );
    expect(result.live_pdp_gate.live_modules).toEqual(expect.arrayContaining(['canonical', 'media_gallery', 'product_details']));
  });

  test('does not treat formula support language as storefront support pollution', () => {
    const livePayload = {
      product: {
        product_id: 'ext_lash',
        merchant_id: 'external_seed',
        description:
          'A lightweight serum created to support thicker, fuller, and healthier-looking lashes and brows.',
      },
      modules: [
        {
          type: 'product_overview',
          data: {
            sections: [
              {
                heading: 'Description',
                content:
                  'A lightweight serum created to support thicker, fuller, and healthier-looking lashes and brows.',
              },
            ],
          },
        },
        {
          type: 'product_facts',
          data: {
            sections: [
              {
                heading: 'Key Ingredients',
                content: 'Peptide complexes and plant extracts support visible lash and brow density.',
              },
            ],
          },
        },
      ],
    };

    const livePdpGate = buildLivePdpGate({ livePayload, liveResponse: { modules: [] } });

    expect(livePdpGate.failure_reasons).not.toContain('polluted_product_description');
    expect(livePdpGate.failure_reasons).not.toContain('polluted_product_details');
    expect(livePdpGate.failure_reasons).not.toContain('polluted_product_facts');
  });

  test('flags variant drift for skincare color locale and generic size axis leaks', () => {
    const livePayload = {
      product: {
        product_id: 'ext_variant_polluted',
        merchant_id: 'external_seed',
        title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer Refill',
        category: 'Skincare',
        product_type: 'Moisturizer',
        product_line_options: [
          {
            option_name: 'Color',
            axis: 'color',
            value: 'US',
            image_url: 'https://example.com/us.png',
          },
        ],
        variants: [
          {
            variant_id: 'v100',
            title: '100.0 ml',
            options: [{ name: 'Variant', value: '100.0 ml' }],
          },
        ],
      },
      modules: [{ type: 'variant_selector', data: { selected_variant_id: 'v100' } }],
    };

    const gate = buildVariantGate({
      seedData: {
        category: 'Skincare',
        product_type: 'Moisturizer',
        snapshot: { title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer Refill' },
      },
      livePayload,
      liveResponse: { modules: [{ type: 'canonical', data: { pdp_payload: livePayload } }] },
    });

    expect(gate.failure_reasons).toEqual(
      expect.arrayContaining(['wrong_axis_for_category', 'size_value_generic_axis']),
    );
    expect(gate.wrong_axis_for_category_count).toBeGreaterThan(0);
    expect(gate.size_value_generic_axis_count).toBeGreaterThan(0);
  });
});
