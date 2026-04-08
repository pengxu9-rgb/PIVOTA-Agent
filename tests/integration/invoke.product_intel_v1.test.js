const { once } = require('events');

function hasRuntimeDeps() {
  for (const dep of ['dotenv', 'express', 'axios']) {
    try {
      require.resolve(dep);
    } catch {
      return false;
    }
  }
  return true;
}

const describeIfRuntimeDeps = hasRuntimeDeps() ? describe : describe.skip;

describeIfRuntimeDeps('/agent/shop/v1/invoke product intel contracts', () => {
  let app;
  let server;
  let baseUrl;

  async function invoke(operation, payload) {
    const response = await fetch(`${baseUrl}/agent/shop/v1/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation, payload }),
    });
    const body = await response.json();
    return { status: response.status, body };
  }

  beforeAll(async () => {
    jest.resetModules();
    process.env.API_MODE = 'MOCK';
    delete process.env.PIVOTA_API_KEY;
    const { mockProducts } = require('../../src/mockProducts');
    const seeded = mockProducts.merch_208139f7600dbf42.find((item) => item.product_id === 'BOTTLE_001');
    Object.assign(seeded, {
      assessment: {
        summary: 'A double-wall insulated bottle designed for daily hydration.',
        best_for: ['Daily hydration'],
        formula_intent: ['Insulated bottle'],
        how_to_use: {
          when: 'Any time',
          order_in_routine: 'Use throughout the day.',
        },
      },
      evidence: {
        science: {
          key_ingredients: ['Stainless steel'],
          risk_notes: [],
        },
        social_signals: {
          typical_positive: [],
          typical_negative: [],
          risk_for_groups: [],
        },
        expert_notes: [],
      },
      pdp_ingredients_raw:
        'Tamanu Oil: Soothes visible redness and supports the skin barrier. Full Ingredients: Water, Glycerin, Caprylic/Capric Triglyceride, 1,2-Hexanediol, Niacinamide, Cetearyl Alcohol. Warning: For external use only.',
      pdp_active_ingredients_raw:
        'Active Ingredients: Niacinamide, Tamanu Oil. Can I use this with an active ingredient?',
    });
    app = require('../../src/server');
    server = app.listen(0);
    await once(server, 'listening');
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    delete process.env.API_MODE;
    jest.resetModules();
  });

  test('get_pdp_v2 returns normalized PDP metadata and Pivota Insights module', async () => {
    const res = await invoke('get_pdp_v2', {
      product: {
        merchant_id: 'merch_208139f7600dbf42',
        product_id: 'BOTTLE_001',
      },
      include: ['all'],
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    const productIntelModule = Array.isArray(res.body.modules)
      ? res.body.modules.find((module) => module?.type === 'product_intel')
      : null;
    const offersModule = Array.isArray(res.body.modules)
      ? res.body.modules.find((module) => module?.type === 'offers')
      : null;

    expect(productIntelModule).toBeTruthy();
    expect(productIntelModule.data.display_name).toBe('Pivota Insights');
    expect(productIntelModule.data.product_intel_core).toBeTruthy();
    expect(productIntelModule.data.quality_state).toBeTruthy();
    expect(offersModule.data.offers[0].commerce_mode).toBe('merchant_embedded_checkout');
    expect(offersModule.data.offers[0].seller_of_record).toBe('merchant');
    expect(res.body.metadata.normalized_pdp).toEqual(
      expect.objectContaining({
        surface: 'pivota_normalized_pdp',
        structured_data_mode: 'merchant_listing',
      }),
    );
  });

  test('get_product_intel_v1 returns structured product intel payload', async () => {
    const res = await invoke('get_product_intel_v1', {
      product_ref: {
        merchant_id: 'merch_208139f7600dbf42',
        product_id: 'BOTTLE_001',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.contract_version).toBe('pivota.product_intel.v1');
    expect(res.body.display_name).toBe('Pivota Insights');
    expect(res.body.offer_pointers.commerce_modes).toContain('merchant_embedded_checkout');
  });

  test('get_pdp_v2 exposes pure ingredient modules and suppresses polluted fragments', async () => {
    const res = await invoke('get_pdp_v2', {
      product: {
        merchant_id: 'merch_208139f7600dbf42',
        product_id: 'BOTTLE_001',
      },
      include: ['ingredients_inci', 'active_ingredients'],
    });

    expect(res.status).toBe(200);
    const inciModule = Array.isArray(res.body.modules)
      ? res.body.modules.find((module) => module?.type === 'ingredients_inci')
      : null;
    const activeModule = Array.isArray(res.body.modules)
      ? res.body.modules.find((module) => module?.type === 'active_ingredients')
      : null;

    expect(inciModule).toBeTruthy();
    expect(inciModule.data.items).toEqual(
      expect.arrayContaining([
        'Water',
        'Glycerin',
        'Caprylic/Capric Triglyceride',
        '1,2-Hexanediol',
        'Niacinamide',
      ]),
    );
    expect(inciModule.data.items).not.toEqual(expect.arrayContaining(['1']));
    expect(inciModule.data.items.some((item) => /Tamanu Oil:/i.test(item))).toBe(false);
    expect(inciModule.data.items.some((item) => /supports the skin barrier|soothes visible redness/i.test(item))).toBe(
      false,
    );
    expect(activeModule).toBeTruthy();
    expect(activeModule.data.items).toEqual(expect.arrayContaining(['Niacinamide', 'Tamanu Oil']));
  });

  test('get_product_feedback_v1 and get_product_recommendation_intents_v1 return stable v1 contracts', async () => {
    const feedback = await invoke('get_product_feedback_v1', {
      product_ref: {
        merchant_id: 'merch_208139f7600dbf42',
        product_id: 'BOTTLE_001',
      },
    });

    expect(feedback.status).toBe(200);
    expect(feedback.body.contract_version).toBe('pivota.product_feedback.v1');
    expect(feedback.body.community_signals.status).toBe('unavailable');
    expect(feedback.body.community_signals.unavailable_reason).toBe('insufficient_feedback');

    const intents = await invoke('get_product_recommendation_intents_v1', {
      product_ref: {
        merchant_id: 'merch_208139f7600dbf42',
        product_id: 'BOTTLE_001',
      },
    });

    expect(intents.status).toBe(200);
    expect(intents.body.contract_version).toBe('pivota.product_recommendation_intents.v1');
    expect(Array.isArray(intents.body.recommendation_intents.similar)).toBe(true);
    expect(Array.isArray(intents.body.recommendation_intents.complementary)).toBe(true);
    expect(Array.isArray(intents.body.recommendation_intents.routine_pairing)).toBe(true);
  });
});
