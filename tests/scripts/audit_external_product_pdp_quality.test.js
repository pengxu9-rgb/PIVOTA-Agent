jest.mock('../../src/db', () => ({
  query: jest.fn(),
  closePool: jest.fn(),
}));
jest.mock('axios', () => ({
  head: jest.fn(),
  get: jest.fn(),
}));

const { query } = require('../../src/db');
const axios = require('axios');
const {
  fetchRows,
  resolveGatewayUrl,
  buildAuthoritativePayload,
  buildPublicGatewayPayload,
  buildExtractorProbeFailure,
  buildProbeFailureResponse,
  isTransientProbeFailureResponse,
  resolveProbeMaxAttempts,
  isTransientExtractorProbeResult,
  resolveExtractorProbeMaxAttempts,
  isTransientImageProbeResult,
  resolveImageProbeMaxAttempts,
  mergePdpProbeResponses,
  unwrapLivePdpPayload,
  resolveExpectedLivePdpPrice,
  probeImageHealth,
  writeOutput,
} = require('../../scripts/audit-external-product-pdp-quality');
const {
  buildIdentityGate,
  buildProductIntelGate,
  buildLivePdpGate,
  buildSimilarGate,
  buildVariantGate,
  buildExternalSeedQualityResult,
} = require('../../src/services/externalSeedPdpQuality');

describe('audit-external-product-pdp-quality helpers', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    axios.head.mockReset();
    axios.get.mockReset();
  });

  test('defaults to the public PDP gateway instead of production backend env', () => {
    expect(resolveGatewayUrl('')).toBe('https://agent.pivota.cc/api/gateway');
  });

  test('uses focused row lookup without updated_at ordering for external product QA', async () => {
    await fetchRows({
      market: 'US',
      externalProductId: 'ext_123',
      limit: 1,
      offset: 0,
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('external_product_id = $2');
    expect(sql).not.toContain('ORDER BY updated_at');
    expect(params).toEqual(['US', 'ext_123', 1, 0]);
  });

  test('keeps deterministic ordering for broad PDP QA scans', async () => {
    await fetchRows({
      market: 'US',
      domain: 'kravebeauty.com',
      limit: 20,
      offset: 5,
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('domain = $2');
    expect(sql).toContain('ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST');
    expect(params).toEqual(['US', 'kravebeauty.com', 20, 5]);
  });

  test('exports report output writer for CLI artifact mode', () => {
    expect(typeof writeOutput).toBe('function');
  });

  test('uses reviewed seed row price as live PDP audit reference for parent rows', () => {
    expect(resolveExpectedLivePdpPrice({ price_amount: '25.95', seed_data: { snapshot: {} } })).toBe('25.95');
    expect(resolveExpectedLivePdpPrice({ price_amount: 19.9 })).toBe(19.9);
    expect(resolveExpectedLivePdpPrice({ price_amount: null })).toBeNull();
    expect(resolveExpectedLivePdpPrice({ price_amount: '0' })).toBeNull();
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

  test('classifies stream abort probe failures as transient retry candidates', () => {
    const response = buildProbeFailureResponse(
      new Error('stream has been aborted'),
      { operation: 'get_pdp_v2', probe: 'pdp_core' },
    );

    expect(response.error.code).toBe('PROBE_ABORTED');
    expect(isTransientProbeFailureResponse(response)).toBe(true);
    expect(isTransientProbeFailureResponse({ status: 'error', error: { code: 'NOT_FOUND', message: 'missing product' } })).toBe(false);
  });

  test('caps PDP quality probe retry attempts to a small bounded value', () => {
    expect(resolveProbeMaxAttempts({ maxAttempts: 3 })).toBe(3);
    expect(resolveProbeMaxAttempts({ maxAttempts: 99 })).toBe(4);
    expect(resolveProbeMaxAttempts({ maxAttempts: 0 })).toBe(1);
  });

  test('classifies image probe timeouts as retryable without hiding real bad statuses', () => {
    expect(isTransientImageProbeResult({ ok: false, error: 'ECONNABORTED' })).toBe(true);
    expect(isTransientImageProbeResult({ ok: false, error: 'bad_status', status: 404 })).toBe(false);
    expect(resolveImageProbeMaxAttempts({ maxAttempts: 3 })).toBe(3);
    expect(resolveImageProbeMaxAttempts({ maxAttempts: 12 })).toBe(4);
  });

  test('does not count transient image probe timeouts as broken gallery images', async () => {
    axios.head.mockRejectedValue(
      Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }),
    );

    const imageHealth = await probeImageHealth(['https://cdn.example.com/product.jpg'], {
      maxAttempts: 1,
    });
    const livePdpGate = buildLivePdpGate({
      livePayload: {
        modules: [
          {
            type: 'media_gallery',
            data: {
              items: [{ type: 'image', url: 'https://cdn.example.com/product.jpg' }],
            },
          },
        ],
      },
      imageHealth,
    });

    expect(imageHealth.broken_count).toBe(0);
    expect(imageHealth.transient_error_count).toBe(1);
    expect(livePdpGate.failure_reasons).not.toContain('broken_gallery_image');
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

  test('retries extractor probe transport failures but not source-unavailable blockers', () => {
    expect(isTransientExtractorProbeResult({
      response: { diagnostics: { failure_category: 'extractor_probe_failed', error_code: 'ECONNRESET' } },
    })).toBe(true);
    expect(isTransientExtractorProbeResult({
      response: { diagnostics: { failure_category: 'source_unavailable_404' } },
    })).toBe(false);
    expect(resolveExtractorProbeMaxAttempts({ maxAttempts: 3 })).toBe(3);
    expect(resolveExtractorProbeMaxAttempts({ maxAttempts: 10 })).toBe(4);
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

  test('does not require single-formula active ingredients on set PDPs', () => {
    const seedData = {
      active_ingredients: ['Hyaluronic Acid'],
      snapshot: { active_ingredients: ['Hyaluronic Acid'] },
    };
    const livePayload = {
      product: {
        product_id: 'ext_power_plush_duo',
        merchant_id: 'external_seed',
        title: 'Power Plush Foundation & Concealer Duo',
      },
      modules: [
        {
          type: 'product_overview',
          data: { sections: [{ heading: 'Overview', content: 'A complexion duo with foundation and concealer.' }] },
        },
      ],
    };

    const gate = buildLivePdpGate({
      livePayload,
      liveResponse: { modules: [{ type: 'canonical', data: { pdp_payload: livePayload } }] },
      seedData,
      productFamily: 'set_or_collection',
    });

    expect(gate.active_ingredients_status.expected).toBe(false);
    expect(gate.active_ingredients_status.suppressed_for_product_family).toBe('set_or_collection');
    expect(gate.failure_reasons).not.toContain('active_ingredients_expected_but_hidden');
  });

  test('flags set PDPs that render component actives as a single formula', () => {
    const seedData = {
      active_ingredients: ['Hyaluronic Acid'],
      snapshot: { active_ingredients: ['Hyaluronic Acid'] },
    };
    const livePayload = {
      product: { product_id: 'ext_power_plush_duo', merchant_id: 'external_seed' },
      modules: [
        {
          type: 'active_ingredients',
          data: { items: [{ name: 'Hyaluronic Acid' }] },
        },
      ],
    };

    const gate = buildLivePdpGate({
      livePayload,
      liveResponse: { modules: [{ type: 'canonical', data: { pdp_payload: livePayload } }] },
      seedData,
      productFamily: 'set_or_collection',
    });

    expect(gate.failure_reasons).toContain('set_active_ingredients_rendered_as_single_formula');
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

  test('allows shade axis for tinted lip treatment products', () => {
    const livePayload = {
      product: {
        product_id: 'ext_pout_preserve',
        merchant_id: 'external_seed',
        title: 'Pout Preserve Peptide Lip Treatment',
        category: 'Skincare',
        product_type: 'Lip Treatment',
        variants: [
          {
            variant_id: 'v_grape',
            title: 'Grape Fizz',
            swatch_image_url: 'https://example.com/grape-swatch.png',
            options: [{ name: 'Shade', value: 'Grape Fizz' }],
          },
        ],
      },
      modules: [{ type: 'variant_selector', data: { selected_variant_id: 'v_grape' } }],
    };

    const gate = buildVariantGate({
      seedData: {
        category: 'Skincare',
        product_type: 'Lip Treatment',
        snapshot: { title: 'Pout Preserve Peptide Lip Treatment' },
      },
      livePayload,
      liveResponse: { modules: [{ type: 'canonical', data: { pdp_payload: livePayload } }] },
    });

    expect(gate.failure_reasons).not.toContain('wrong_axis_for_category');
  });

  test('allows shade axis for dewy balm stick color cosmetics', () => {
    const livePayload = {
      product: {
        product_id: 'ext_dewy_balm_stick',
        merchant_id: 'external_seed',
        title: 'Dewy Balm Stick',
        category: 'Skincare',
        product_type: 'Balm',
        variants: [
          {
            variant_id: 'solar-glow',
            title: 'Solar Glow',
            swatch_image_url: 'https://example.com/solar-glow-swatch.png',
            options: [{ name: 'Shade', value: 'Solar Glow', axis_kind: 'shade' }],
          },
        ],
      },
      modules: [{ type: 'variant_selector', data: { selected_variant_id: 'solar-glow' } }],
    };

    const gate = buildVariantGate({
      seedData: {
        category: 'Skincare',
        product_type: 'Balm',
        snapshot: { title: 'Dewy Balm Stick' },
      },
      livePayload,
      liveResponse: { modules: [{ type: 'canonical', data: { pdp_payload: livePayload } }] },
    });

    expect(gate.failure_reasons).not.toContain('wrong_axis_for_category');
    expect(gate.failure_reasons).not.toContain('makeup_shade_missing_visual');
  });

  test('allows visual shade axis for shimmer body-care variants', () => {
    const livePayload = {
      product: {
        product_id: 'ext_butta_drop_shimmer',
        merchant_id: 'external_seed',
        title: 'Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter - Fenty Fresh Shimmering',
        category: 'Skincare',
        product_type: 'Body Cream',
        variants: [
          {
            variant_id: 'v_fenty_fresh_shimmering',
            title: 'Fenty Fresh Shimmering',
            swatch_image_url: 'https://example.com/fenty-fresh-shimmering.png',
            options: [{ name: 'Shade', value: 'Fenty Fresh Shimmering', axis_kind: 'shade' }],
          },
        ],
      },
      modules: [{ type: 'variant_selector', data: { selected_variant_id: 'v_fenty_fresh_shimmering' } }],
    };

    const gate = buildVariantGate({
      seedData: {
        category: 'Skincare',
        product_type: 'Body Cream',
        snapshot: { title: 'Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter - Fenty Fresh Shimmering' },
      },
      livePayload,
      liveResponse: { modules: [{ type: 'canonical', data: { pdp_payload: livePayload } }] },
    });

    expect(gate.failure_reasons).not.toContain('wrong_axis_for_category');
    expect(gate.failure_reasons).not.toContain('makeup_shade_missing_visual');
  });

  test('allows shade axis when category path identifies complexion makeup', () => {
    const livePayload = {
      product: {
        product_id: 'ext_beauty_balm',
        merchant_id: 'external_seed',
        title: 'Beauty Balm',
        category: 'Skincare',
        product_type: 'Balm',
        category_path: 'beauty/makeup/face/foundation',
        variants: [
          {
            variant_id: 'v_cream',
            title: 'Cream',
            swatch: { hex: '#e6c5a7' },
            options: [{ name: 'Shade', value: 'Cream', axis_kind: 'shade' }],
          },
        ],
      },
      modules: [{ type: 'variant_selector', data: { selected_variant_id: 'v_cream' } }],
    };

    const gate = buildVariantGate({
      seedData: {
        title: 'Beauty Balm',
        category_path: 'beauty/makeup/face/foundation',
        snapshot: { title: 'Beauty Balm' },
      },
      livePayload,
      liveResponse: { modules: [{ type: 'canonical', data: { pdp_payload: livePayload } }] },
    });

    expect(gate.failure_reasons).not.toContain('wrong_axis_for_category');
    expect(gate.failure_reasons).not.toContain('makeup_shade_missing_visual');
  });

  test('allows shade axis for color-correcting brightener products', () => {
    const livePayload = {
      product: {
        product_id: 'ext_correction_concentrate',
        merchant_id: 'external_seed',
        title: 'Correction Concentrate',
        category: 'Skincare',
        product_type: 'Brightener',
        variants: [
          {
            variant_id: 'v_brightening_peach',
            title: 'Brightening Peach',
            swatch_image_url: 'https://example.com/brightening-peach.png',
            options: [{ name: 'Shade', value: 'Brightening Peach', axis_kind: 'shade' }],
          },
          {
            variant_id: 'v_awakening_apricot',
            title: 'Awakening Apricot',
            swatch_image_url: 'https://example.com/awakening-apricot.png',
            options: [{ name: 'Shade', value: 'Awakening Apricot', axis_kind: 'shade' }],
          },
        ],
      },
      modules: [{ type: 'variant_selector', data: { selected_variant_id: 'v_brightening_peach' } }],
    };

    const gate = buildVariantGate({
      seedData: {
        title: 'Correction Concentrate',
        category: 'Skincare',
        product_type: 'Brightener',
        tags: ['complexion', 'concealer', 'makeup'],
        snapshot: { title: 'Correction Concentrate' },
      },
      livePayload,
      liveResponse: { modules: [{ type: 'canonical', data: { pdp_payload: livePayload } }] },
    });

    expect(gate.failure_reasons).not.toContain('wrong_axis_for_category');
    expect(gate.failure_reasons).not.toContain('makeup_shade_missing_visual');
  });

  test('exempts set and collection PDPs from single-product similar underfill', () => {
    const gate = buildSimilarGate({
      similarResponse: { products: [] },
      productFamily: 'set_or_collection',
    });

    expect(gate.status).toBe('exempt');
    expect(gate.failure_reasons).not.toContain('similar_underfill');
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

  test('does not treat Shopify files carousel product images as content leakage by path alone', () => {
    const livePayload = {
      product: {
        product_id: 'ext_glossier_super_pure',
        merchant_id: 'external_seed',
      },
      modules: [
        {
          type: 'media_gallery',
          data: {
            items: [
              {
                type: 'image',
                url: 'https://cdn.shopify.com/s/files/1/0627/9164/7477/products/glossier-super-pure-carousel-02.png?v=1718028644',
              },
              {
                type: 'image',
                url: 'https://cdn.shopify.com/s/files/1/0627/9164/7477/files/glossier-skincare-super-pure-carousel-01.png?v=1762200217',
              },
            ],
          },
        },
      ],
    };

    const gate = buildLivePdpGate({
      livePayload,
      liveResponse: { status: 'success', modules: [{ type: 'canonical', data: { pdp_payload: livePayload } }] },
      seedData: {
        external_seed_snapshot_contract: {
          authoritative: true,
          legacy_fields_quarantined: true,
          replace_strategy: 'replace_not_merge',
        },
      },
    });

    expect(gate.failure_reasons).not.toContain('content_media_leaked_into_gallery');
    expect(gate.gallery_status.content_leak_count).toBe(0);
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
