const request = require('supertest');
const nock = require('nock');
const legacy = require('../fixtures/judydoll_product_intel_legacy_review_copy.json');

jest.setTimeout(30000);

describe('real public PDP Insights transport boundary', () => {
  let app;
  const previousEnv = { ...process.env };
  const base = 'http://insight-adversary.test';
  const sentinel = 'PRIVATE_OPERATOR_SENTINEL';
  beforeAll(() => {
    jest.resetModules();
    process.env.API_MODE = 'REAL';
    process.env.PIVOTA_API_BASE = base;
    process.env.PIVOTA_BACKEND_BASE_URL = base;
    process.env.PIVOTA_API_KEY = 'test-token';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.PDP_SELF_OFFER_FALLBACK_ENABLED = 'true';
    delete process.env.DATABASE_URL;
    app = require('../../src/server');
  });
  afterEach(() => nock.cleanAll());
  afterAll(() => { process.env = previousEnv; });

  test('canonical helper strips nested variant dossiers without mutating typed product, selector or state fields', () => {
    const states = { product_intel: 'ready', media_gallery: 'ready', variant_selector: 'ready' };
    const variant = {
      variant_id: 'v07', sku_id: 'JUDY07', title: '07 Burgundy',
      options: [{ name: 'Shade', value: '07 Burgundy', raw: { standard: sentinel } }],
      price: { current: { amount: 12, currency: 'USD', provenance: { standard: sentinel } } },
      availability: { in_stock: true, available_quantity: 3, agentContext: { standard: sentinel } },
      raw: { product_intel: legacy },
      nested: [{ raw_detail: { standard: sentinel }, safe_label: 'Burgundy' }],
    };
    const input = {
      schema_version: '1.0.0', x_content_module_states: states,
      product: { product_id: 'p07', default_variant_id: 'v07', variants: [variant],
        x_content_module_states: states, provenance: { standard: sentinel } },
      modules: [
        { type: 'variant_selector', data: { selected_variant_id: 'v07', variants: [variant],
          options: [{ name: 'Shade', values: ['07 Burgundy'] }], x_content_module_states: states } },
        { type: 'product_intel', data: legacy },
        { type: 'media_gallery', data: { items: [{ url: 'https://cdn.example.test/lip.png' }] } },
      ],
    };
    const before = JSON.stringify(input);
    const result = app._debug.stripResponseOwnedPdpModulesFromCanonicalPayload(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.product.variants[0]).toEqual({
      variant_id: 'v07', sku_id: 'JUDY07', title: '07 Burgundy',
      options: [{ name: 'Shade', value: '07 Burgundy' }],
      price: { current: { amount: 12, currency: 'USD' } },
      availability: { in_stock: true, available_quantity: 3 },
      nested: [{ safe_label: 'Burgundy' }],
    });
    expect(result.product.default_variant_id).toBe('v07');
    expect(result.x_content_module_states).toEqual(states);
    expect(result.product.x_content_module_states).toEqual(states);
    expect(result.modules[0].data).toEqual({ selected_variant_id: 'v07',
      variants: [result.product.variants[0]], options: [{ name: 'Shade', values: ['07 Burgundy'] }],
      x_content_module_states: states });
    expect(result.modules.map((m) => m.type)).toEqual(['variant_selector', 'media_gallery']);
  });

  test('state dictionary module names survive but nested private values do not bypass wire redaction', () => {
    const input = {
      product: { product_id: 'p07', variants: [{ variant_id: 'v07', x_content_module_states: {
        product_intel: { state: 'ready', raw: { review_standard: sentinel }, provenance: { generator: sentinel } },
        media_gallery: 'ready',
      } }] },
      modules: [{ type: 'variant_selector', data: { selected_variant_id: 'v07', x_content_module_states: {
        product_intel: { state: 'ready', agent_context: { review_standard: sentinel } },
        media_gallery: 'ready',
      } } }],
    };
    const before = JSON.stringify(input);
    const projected = app._debug.stripResponseOwnedPdpModulesFromCanonicalPayload(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(projected)).not.toContain(sentinel);
    expect(projected.product.variants[0].x_content_module_states).toEqual({ product_intel: { state: 'ready' }, media_gallery: 'ready' });
    expect(projected.modules[0].data.x_content_module_states).toEqual({ product_intel: { state: 'ready' }, media_gallery: 'ready' });
  });

  test.each(['root', 'product', 'variant', 'selector'])(
    'direct operator metadata in %s state dictionary cannot reach the public transport', (placement) => {
      const states = {
        product_intel: {
          state: 'ready',
          field_sources: { body: 'human_standard' },
          freshness: { source_version: 'official_pdp_manual_review_v1' },
          source_coverage: { seller: true },
          confidence: { rationale: 'PRIVATE_DIRECT_REVIEW_SENTINEL' },
        },
        media_gallery: 'ready',
      };
      const input = { product: { product_id: 'p07', variants: [{ variant_id: 'v07' }] },
        modules: [{ type: 'variant_selector', data: { selected_variant_id: 'v07' } }] };
      const target = placement === 'root' ? input
        : placement === 'product' ? input.product
        : placement === 'variant' ? input.product.variants[0]
        : input.modules[0].data;
      target.x_content_module_states = states;
      const before = JSON.stringify(input);
      const projected = app._debug.stripResponseOwnedPdpModulesFromCanonicalPayload(input);
      const publicTarget = placement === 'root' ? projected
        : placement === 'product' ? projected.product
        : placement === 'variant' ? projected.product.variants[0]
        : projected.modules[0].data;
      expect(JSON.stringify(input)).toBe(before);
      expect(publicTarget.x_content_module_states).toEqual({ product_intel: { state: 'ready' }, media_gallery: 'ready' });
      expect(JSON.stringify(projected)).not.toMatch(/human_standard|official_pdp_manual_review_v1|PRIVATE_DIRECT_REVIEW_SENTINEL|field_sources|source_coverage|confidence/);
    },
  );

  test('state value projection preserves supported scalars and typed state/status only', () => {
    const states = {
      product_intel: 'ready', media_gallery: 'READY', pending: 'loading', absent: 'absent',
      empty: 'empty', error: 'error', missing: 'missing', unavailable: 'unavailable', blocked: 'blocked',
      ingredients_inci: 'not_fetched', recommendations: 'withheld', variant_selector: 'not_applicable',
      boolean_on: true, boolean_off: false, numeric: 2,
      structured: { state: 'ready', status: 'empty', source_version: 'official_pdp_manual_review_v1' },
      unsupported_text: 'human_standard', malformed: ['ready', { field_sources: sentinel }],
      invalid_state: { state: sentinel }, bad_number: Infinity,
    };
    const input = { product: { product_id: 'p07' }, x_content_module_states: states, modules: [] };
    const before = JSON.stringify(input);
    const projected = app._debug.stripResponseOwnedPdpModulesFromCanonicalPayload(input);
    expect(projected.x_content_module_states).toEqual({
      product_intel: 'ready', media_gallery: 'READY', pending: 'loading', absent: 'absent',
      empty: 'empty', error: 'error', missing: 'missing', unavailable: 'unavailable', blocked: 'blocked',
      ingredients_inci: 'not_fetched', recommendations: 'withheld', variant_selector: 'not_applicable',
      boolean_on: true, boolean_off: false, numeric: 2,
      structured: { state: 'ready', status: 'empty' },
      unsupported_text: null, malformed: null, invalid_state: {}, bad_number: null,
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(input.x_content_module_states.bad_number).toBe(Infinity);
    expect(JSON.stringify(projected)).not.toContain(sentinel);
  });

  test.each([
    ['raw', []], ['raw_detail', ['product_intel', 'variant_selector']], ['raw_payload', ['product_intel', 'product_overview', 'variant_selector']],
  ])('public request excludes internal Insights in canonical %s with include=%j', async (alias, include) => {
    const intel = JSON.parse(JSON.stringify(legacy));
    intel.provenance.generator = sentinel;
    intel.agent_context = { guardrails: { review_standard: sentinel } };
    const product = {
      merchant_id: 'merchant_insight_test', product_id: `insight_${alias}`,
      title: 'Judydoll Silky Matte Lip Ink', brand: 'Judydoll',
      description: 'A lightweight matte lip color.', category: 'Beauty', product_type: 'Lip color',
      price: 12, currency: 'USD', in_stock: true,
      image_url: 'https://cdn.example.test/lip.png',
      product_intel: intel,
      [alias]: { product_intel: intel, productIntel: intel, nested: { agent_context: { review_standard: sentinel } } },
      variants: [
        { variant_id: `v_${alias}_07`, sku_id: 'JUDY07', title: '07 Burgundy',
          options: [{ name: 'Shade', value: '07 Burgundy', raw: { standard: sentinel } }],
          price: 12, available_quantity: 3, in_stock: true, swatch_color: '#772233',
          image_url: 'https://cdn.example.test/lip07.png', raw: { product_intel: intel } },
        { variant_id: `v_${alias}_08`, sku_id: 'JUDY08', title: '08 Peach',
          options: [{ name: 'Shade', value: '08 Peach', agent_context: { standard: sentinel } }],
          price: 14, available_quantity: 5, in_stock: true, swatch_color: '#bb7755',
          image_url: 'https://cdn.example.test/lip08.png', raw_detail: { product_intel: intel } },
      ],
    };
    nock(base).persist().post('/agent/shop/v1/invoke', (b) => b.operation === 'get_product_detail')
      .reply(200, { status: 'success', success: true, product });
    nock(base).persist().get(`/agent/v1/products/${product.merchant_id}/${product.product_id}`)
      .reply(200, { product });
    nock(base).persist().get('/agent/v1/product-groups/resolve').query(true)
      .reply(404, { error: 'PRODUCT_GROUP_NOT_FOUND' });
    nock(base).persist().post('/agent/shop/v1/invoke', (b) => b.operation === 'find_similar_products')
      .reply(200, { status: 'success', products: [] });
    const response = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'get_pdp_v2',
      payload: { product_ref: { merchant_id: product.merchant_id, product_id: product.product_id }, include,
        options: { allow_ineligible: true } },
    });
    expect(response.status).toBe(200);
    const canonical = response.body.modules.find((m) => m.type === 'canonical');
    expect(canonical.data.pdp_payload.product.title).toContain('Judydoll');
    const publicProduct = canonical.data.pdp_payload.product;
    expect(publicProduct.variants.map((v) => v.variant_id)).toEqual([`v_${alias}_07`, `v_${alias}_08`]);
    expect(publicProduct.default_variant_id).toBe(`v_${alias}_07`);
    expect(publicProduct.variants[0].options).toEqual([{ name: 'Shade', value: '07 Burgundy' }]);
    expect(publicProduct.variants[0].price.current).toEqual({ amount: 12, currency: 'USD' });
    expect(publicProduct.variants[0].availability).toEqual({ in_stock: true, available_quantity: 3 });
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(JSON.stringify(response.body)).not.toContain('Reviewed lip cues');
    expect(JSON.stringify(response.body)).not.toContain('reducing ambiguity');
    if (include.includes('product_intel')) {
      const module = response.body.modules.find((m) => m.type === 'product_intel');
      expect(module.data.public_display_eligible).toBe(true);
      expect(module.data).not.toHaveProperty('provenance');
      expect(module.data).not.toHaveProperty('agent_context');
    }
    if (include.includes('variant_selector')) {
      const selector = response.body.modules.find((m) => m.type === 'variant_selector');
      expect(selector.data.selected_variant_id).toBe(publicProduct.default_variant_id);
      expect(selector.data.variants.map((v) => v.variant_id)).toEqual(publicProduct.variants.map((v) => v.variant_id));
      expect(selector.data.variants[0].price.current).toEqual({ amount: 12, currency: 'USD' });
      expect(selector.data.variants[0].availability).toEqual({ in_stock: true, available_quantity: 3 });
    }
  });
});
