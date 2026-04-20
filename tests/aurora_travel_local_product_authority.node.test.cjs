const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadTravelLocalProductAuthorityCandidates,
  __internal,
} = require('../src/auroraBff/travelLocalProductAuthority');

function buildReadiness() {
  return {
    reco_bundle: [
      {
        trigger: 'Elevated UV',
        action: 'Face SPF50+ PA++++, reapply every 2h outdoors. Body: apply body sunscreen on exposed areas.',
        ingredient_logic: 'Photostable UVA filters and antioxidant film-formers.',
        product_types: ['Face SPF50+ PA++++ sunscreen', 'Portable reapply format (stick/cushion)'],
      },
      {
        trigger: 'Warmer / more humid',
        action: 'AM: switch to gel-cream/lotion texture. PM: keep medium repair cream.',
        product_types: ['Gel-cream moisturizer (AM)', 'Medium barrier repair cream (PM)'],
      },
      {
        trigger: 'Masks (scenario-based)',
        action: 'Flight day: 1x hydrating-soothing mask.',
        product_types: ['Hydrating-soothing mask (flight recovery)'],
      },
      {
        trigger: 'Eye care',
        action: 'For larger jet-lag gaps, pack eye cream and cooling eye patches.',
        product_types: ['Eye cream (caffeine / hyaluronic acid)', 'Cooling eye patches'],
      },
      {
        trigger: 'Emergency kit',
        action: 'Pack SPF lip balm and hand cream.',
        product_types: ['SPF lip balm', 'Hand cream'],
      },
    ],
  };
}

function seedRow(overrides = {}) {
  const productId = overrides.external_product_id || 'ext_cn_spf_1';
  return {
    id: overrides.id || 101,
    market: overrides.market || 'CN',
    tool: 'creator_agents',
    status: 'active',
    domain: 'example.cn',
    external_product_id: productId,
    canonical_url: overrides.canonical_url || `https://example.cn/products/${productId}`,
    destination_url: overrides.destination_url || `https://example.cn/products/${productId}`,
    title: overrides.title || 'Local SPF50 Sun Fluid',
    image_url: overrides.image_url || 'https://example.cn/spf.jpg',
    price_amount: overrides.price_amount || 128,
    price_currency: overrides.price_currency || 'CNY',
    availability: 'in_stock',
    attached_product_key: null,
    seed_data: {
      brand: overrides.brand || 'CN Sun Lab',
      snapshot: {
        title: overrides.title || 'Local SPF50 Sun Fluid',
        brand: overrides.brand || 'CN Sun Lab',
        canonical_url: overrides.canonical_url || `https://example.cn/products/${productId}`,
        destination_url: overrides.destination_url || `https://example.cn/products/${productId}`,
        image_url: overrides.image_url || 'https://example.cn/spf.jpg',
        price_amount: overrides.price_amount || 128,
        price_currency: overrides.price_currency || 'CNY',
      },
      derived: {
        recall: {
          retrieval_title: overrides.title || 'local spf50 sun fluid',
          retrieval_summary: overrides.summary || 'lightweight sunscreen fluid for face',
          category: overrides.category || 'sunscreen',
          vertical: 'skincare',
          brand: overrides.brand || 'CN Sun Lab',
        },
      },
    },
    match_score: overrides.match_score || 50,
  };
}

test('travel local product authority: resolves Shanghai and Seoul markets', () => {
  assert.deepEqual(
    __internal.resolveTravelLocalMarket({ destination: 'Shanghai' }),
    { market: 'CN', source: 'destination_text' },
  );
  assert.deepEqual(
    __internal.resolveTravelLocalMarket({ destination: 'Seoul, South Korea' }),
    { market: 'KR', source: 'destination_text' },
  );
  assert.deepEqual(
    __internal.resolveTravelLocalMarket({ destinationPlace: { country_code: 'JP' } }),
    { market: 'JP', source: 'destination_place_country_code' },
  );
});

test('travel local product authority: builds skincare query plan from travel kit', () => {
  const plan = __internal.buildTravelLocalProductQueryPlan({
    travelReadiness: buildReadiness(),
    message: 'What local brands and specific products can I buy in Shanghai?',
    limit: 6,
  });
  const roleIds = plan.map((row) => row.role_id);
  assert.equal(roleIds.includes('sun_protection'), true);
  assert.equal(roleIds.includes('lightweight_moisturizer'), true);
  assert.equal(roleIds.includes('recovery_mask'), true);
  assert.equal(roleIds.includes('eye_care'), true);
  assert.equal(roleIds.includes('body_lip_hand'), true);
  assert.ok(roleIds.length <= 6);
  assert.ok(plan.find((row) => row.role_id === 'sun_protection').terms.some((term) => /spf/i.test(term)));
});

test('travel local product authority: returns only external-seed authority rows from injected query', async () => {
  const sqlCalls = [];
  const result = await loadTravelLocalProductAuthorityCandidates({
    destination: 'Shanghai',
    travelReadiness: buildReadiness(),
    message: 'specific local products in Shanghai',
    limit: 3,
    queryFn: async (sql, params) => {
      sqlCalls.push({ sql, params });
      const categories = Array.isArray(params?.[3]) ? params[3] : [];
      if (categories.includes('sunscreen')) return { rows: [seedRow()] };
      if (categories.includes('moisturizer')) {
        return {
          rows: [
            seedRow({
              id: 102,
              external_product_id: 'ext_cn_gel_cream_1',
              title: 'Local Gel Cream',
              brand: 'CN Barrier Lab',
              category: 'moisturizer',
              summary: 'lightweight gel cream moisturizer',
              price_amount: 168,
            }),
          ],
        };
      }
      return { rows: [] };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'ok');
  assert.equal(result.meta.market, 'CN');
  assert.equal(result.meta.coverage_status, 'grounded');
  assert.equal(result.candidates.length >= 2, true);
  assert.equal(result.candidates[0].product_source, 'catalog');
  assert.equal(result.candidates[0].match_status, 'catalog_verified');
  assert.deepEqual(result.candidates[0].reasons, Array.from(new Set(result.candidates[0].reasons)));
  assert.equal(result.candidates.some((row) => row.currency === 'CNY'), true);
  assert.equal(sqlCalls.every((call) => call.params[0] === 'CN'), true);
});
