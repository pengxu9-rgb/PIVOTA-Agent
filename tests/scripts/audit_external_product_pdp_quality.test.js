const {
  resolveGatewayUrl,
  buildAuthoritativePayload,
  buildPublicGatewayPayload,
  buildExtractorProbeFailure,
  buildProbeFailureResponse,
  mergePdpProbeResponses,
  unwrapLivePdpPayload,
  writeOutput,
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

  test('exports report output writer for CLI artifact mode', () => {
    expect(typeof writeOutput).toBe('function');
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
          'reviews_preview',
          'similar',
          'variant_selector',
          'offers',
        ],
        options: {
          debug: true,
          no_cache: true,
          cache_bypass: true,
        },
      },
    });
  });

  test('merges core and details PDP probe modules while preserving details probe errors', () => {
    const merged = mergePdpProbeResponses(
      {
        status: 'success',
        modules: [
          { type: 'canonical', data: { product_group_id: 'pg_1' } },
          { type: 'product_intel', data: { product_intel_core: { what_it_is: { body: 'Primer.' } } } },
        ],
      },
      {
        status: 'error',
        error: { code: 'PROBE_TIMEOUT', message: 'timeout of 25000ms exceeded' },
      },
    );

    expect(merged.modules.map((module) => module.type)).toEqual(['canonical', 'product_intel']);
    expect(merged.error).toEqual({ code: 'PROBE_TIMEOUT', message: 'timeout of 25000ms exceeded' });
    expect(unwrapLivePdpPayload(merged).modules.map((module) => module.type)).toEqual(['canonical', 'product_intel']);
  });

  test('keeps authoritative get_pdp_v2 include override explicit for specialized probes', () => {
    expect(buildAuthoritativePayload('get_pdp_v2', {
      product_id: 'ext_123',
      include: ['similar'],
    })).toMatchObject({
      payload: {
        include: ['similar'],
      },
    });
  });

  test('wraps gateway timeouts as probe failure payloads instead of throwing out of audit rows', () => {
    const response = buildProbeFailureResponse(
      Object.assign(new Error('timeout of 12000ms exceeded'), { code: 'ECONNABORTED' }),
      { operation: 'find_similar_products', probe: 'similar_slow' },
    );

    expect(response).toEqual({
      status: 'error',
      error: {
        code: 'PROBE_TIMEOUT',
        message: 'timeout of 12000ms exceeded',
        details: {
          operation: 'find_similar_products',
          probe: 'similar_slow',
        },
      },
    });
  });

  test('wraps catalog extractor DNS failures as row-level extractor failures', () => {
    const response = buildExtractorProbeFailure(
      Object.assign(new Error('getaddrinfo ENOTFOUND pivota-catalog-intelligence-production.up.railway.app'), {
        code: 'ENOTFOUND',
      }),
      'https://example.com/products/a',
    );

    expect(response).toMatchObject({
      target_url: 'https://example.com/products/a',
      response: {
        diagnostics: {
          failure_category: 'extractor_probe_dns_failure',
          probe: 'catalog_intelligence_extract',
          error_code: 'ENOTFOUND',
        },
      },
      product: null,
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
          similar_cache_bypass: true,
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
          cache_bypass: true,
          similar_cache_bypass: true,
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
        'legacy_snapshot_not_quarantined',
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

  test('flags duplicate gallery images, mixed content media, and non-quarantined snapshots', () => {
    const livePayload = {
      product: {
        product_id: 'ext_rare_primer_mini',
        merchant_id: 'external_seed',
      },
      modules: [
        {
          type: 'media_gallery',
          data: {
            items: [
              {
                type: 'image',
                url: 'http://www.rarebeauty.com/cdn/shop/products/AlwaysAnOptimistPrimerMini_Primary_1024x1024.jpg?v=1720000000&width=1200',
              },
              {
                type: 'image',
                url: 'https://cdn.shopify.com/s/files/1/0317/8349/5241/products/AlwaysAnOptimistPrimerMini_Primary_1024x1024.jpg?v=1720000000',
              },
              {
                type: 'image',
                url: 'https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-PRIMER-MINI.jpg?v=1720000001',
              },
            ],
          },
        },
        {
          type: 'product_overview',
          data: {
            sections: [{ heading: 'Overview', content: 'Primer overview.' }],
          },
        },
      ],
    };

    const gate = buildLivePdpGate({
      livePayload,
      liveResponse: { status: 'success', modules: [{ type: 'canonical', data: { pdp_payload: livePayload } }] },
      seedData: {
        snapshot: {
          content_image_urls: ['https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-PRIMER-MINI.jpg?v=1720000001'],
        },
      },
    });

    expect(gate.failure_reasons).toEqual(
      expect.arrayContaining([
        'duplicate_gallery_images',
        'content_media_leaked_into_gallery',
        'legacy_snapshot_not_quarantined',
      ]),
    );
    expect(gate.gallery_status.duplicate_count).toBeGreaterThan(0);
    expect(gate.gallery_status.content_leak_count).toBeGreaterThan(0);
  });

  test('flags missing variant selector when named size evidence is trapped behind default-title identity pollution', () => {
    const livePayload = {
      product: {
        product_id: 'ext_rare_primer_mini',
        merchant_id: 'external_seed',
        title: 'Always An Optimist Pore Diffusing Primer Mini',
      },
      modules: [],
    };

    const gate = buildVariantGate({
      seedData: {
        title: 'Always An Optimist Pore Diffusing Primer Mini',
        snapshot: {
          variants: [
            {
              variant_id: 'v-mini',
              option_name: 'Title',
              option_value: 'Default Title',
            },
          ],
        },
      },
      livePayload,
      liveResponse: {
        status: 'success',
        modules: [
          {
            type: 'canonical',
            data: {
              pdp_payload: livePayload,
              variant_axes: { size: 'mini', shade: 'default title' },
              match_basis: ['brand:rare beauty', 'title_core:always an optimist pore diffusing primer', 'variant_axes:size:mini|shade:default title'],
            },
          },
        ],
      },
    });

    expect(gate.failure_reasons).toEqual(
      expect.arrayContaining([
        'missing_variant_selector_from_size_evidence',
        'identity_default_title_axis',
        'size_siblings_split_product_line',
      ]),
    );
  });
});
