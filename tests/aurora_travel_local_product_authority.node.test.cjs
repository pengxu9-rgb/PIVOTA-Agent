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

test('travel local product authority: rejects color cosmetics misclassified as travel skincare roles', async () => {
  const result = await loadTravelLocalProductAuthorityCandidates({
    destination: 'Seattle, United States',
    travelReadiness: buildReadiness(),
    message: 'What should I pack before my flight?',
    limit: 4,
    queryFn: async (sql, params) => {
      const categories = Array.isArray(params?.[3]) ? params[3] : [];
      if (categories.includes('sunscreen')) {
        return {
          rows: [
            seedRow({
              id: 201,
              market: 'US',
              external_product_id: 'ext_bad_correcting_stick',
              title: 'Match Stix Correcting Skinstick — Banana',
              brand: 'Fenty Beauty',
              category: 'sunscreen',
              summary: 'color correcting makeup stick for under-eye and discoloration',
              price_amount: 32,
              price_currency: 'USD',
              match_score: 50,
            }),
            seedRow({
              id: 202,
              market: 'US',
              external_product_id: 'ext_bad_refill_spf',
              title: 'Hydra Vizor Huez Tinted Moisturizer Broad Spectrum Mineral SPF 30 Sunscreen Refill',
              brand: 'Fenty Beauty',
              category: 'sunscreen',
              summary: 'sunscreen refill cartridge',
              price_amount: 44,
              price_currency: 'USD',
              match_score: 49,
            }),
            seedRow({
              id: 203,
              market: 'US',
              external_product_id: 'ext_bad_eur_spf',
              title: 'Relief Sun : Rice + Probiotics SPF50+ PA++++',
              brand: 'Beauty of Joseon',
              category: 'sunscreen',
              summary: 'daily sunscreen',
              price_amount: 23,
              price_currency: 'EUR',
              match_score: 48,
            }),
            seedRow({
              id: 204,
              market: 'US',
              external_product_id: 'ext_good_spf',
              title: 'Mineral SPF50 Sunscreen Fluid',
              brand: 'US Sun Lab',
              category: 'sunscreen',
              summary: 'lightweight face sunscreen fluid with broad spectrum SPF50',
              price_amount: 24,
              price_currency: 'USD',
              match_score: 46,
            }),
          ],
        };
      }
      if (categories.includes('moisturizer')) {
        return {
          rows: [
            seedRow({
              id: 205,
              market: 'US',
              external_product_id: 'ext_bad_bronzer',
              title: 'Cheeks Out Freestyle Cream Bronzer — Teddy',
              brand: 'Fenty Beauty',
              category: 'moisturizer',
              summary: 'cream bronzer makeup for cheeks',
              price_amount: 29,
              price_currency: 'USD',
              match_score: 50,
            }),
            seedRow({
              id: 206,
              market: 'US',
              external_product_id: 'ext_bad_sponge',
              title: "Showstopp'r Football Sponge",
              brand: 'Fenty Beauty',
              category: 'moisturizer',
              summary: 'makeup sponge applicator',
              price_amount: 16,
              price_currency: 'USD',
              match_score: 49,
            }),
            seedRow({
              id: 207,
              market: 'US',
              external_product_id: 'ext_good_lotion',
              title: 'Lightweight Barrier Lotion',
              brand: 'US Barrier Lab',
              category: 'moisturizer',
              summary: 'lightweight facial moisturizer lotion for barrier support',
              price_amount: 22,
              price_currency: 'USD',
              match_score: 48,
            }),
          ],
        };
      }
      if (categories.includes('lip balm')) {
        return {
          rows: [
            seedRow({
              id: 208,
              market: 'US',
              external_product_id: 'ext_bad_lip_scrub',
              title: "Pro Kiss'r Lip-Loving Scrubstick",
              brand: 'Fenty Beauty',
              category: 'lip balm',
              summary: 'lip scrub exfoliator',
              price_amount: 16,
              price_currency: 'USD',
              match_score: 50,
            }),
            seedRow({
              id: 209,
              market: 'US',
              external_product_id: 'ext_good_lip_balm',
              title: 'SPF Lip Balm',
              brand: 'US Lip Lab',
              category: 'lip balm',
              summary: 'spf lip balm for travel dryness',
              price_amount: 10,
              price_currency: 'USD',
              match_score: 48,
            }),
          ],
        };
      }
      if (categories.includes('hydrating mask') || categories.includes('mask') || categories.includes('treatment')) {
        return {
          rows: [
            seedRow({
              id: 210,
              market: 'US',
              external_product_id: 'ext_bad_mask_sampler',
              title: 'Round Lab Sheet Mask Sampler - 9pc',
              brand: 'Round Lab',
              category: 'hydrating mask',
              summary: 'sheet mask sampler pack',
              price_amount: 29.99,
              price_currency: 'USD',
              match_score: 50,
            }),
            seedRow({
              id: 211,
              market: 'US',
              external_product_id: 'ext_bad_recovery_duo',
              title: 'Nutri-Revitalizing Duo',
              brand: 'Embryolisse',
              category: 'hydrating mask',
              summary: 'two-piece recovery bundle',
              price_amount: 76.8,
              price_currency: 'USD',
              match_score: 49,
            }),
            seedRow({
              id: 212,
              market: 'US',
              external_product_id: 'ext_good_recovery_mask',
              title: 'Hydrating Recovery Sheet Mask',
              brand: 'US Mask Lab',
              category: 'hydrating mask',
              summary: 'single hydrating sheet mask for post-flight recovery',
              price_amount: 6,
              price_currency: 'USD',
              match_score: 47,
            }),
          ],
        };
      }
      return { rows: [] };
    },
  });

  assert.equal(result.ok, true);
  const ids = result.candidates.map((row) => row.product_id);
  assert.equal(ids.includes('ext_bad_correcting_stick'), false);
  assert.equal(ids.includes('ext_bad_refill_spf'), false);
  assert.equal(ids.includes('ext_bad_eur_spf'), false);
  assert.equal(ids.includes('ext_bad_bronzer'), false);
  assert.equal(ids.includes('ext_bad_sponge'), false);
  assert.equal(ids.includes('ext_bad_lip_scrub'), false);
  assert.equal(ids.includes('ext_bad_mask_sampler'), false);
  assert.equal(ids.includes('ext_bad_recovery_duo'), false);
  assert.equal(ids.includes('ext_good_spf'), true);
  assert.equal(ids.includes('ext_good_lotion'), true);
  assert.equal(ids.includes('ext_good_lip_balm'), true);
  assert.equal(ids.includes('ext_good_recovery_mask'), true);
  assert.equal(result.meta.stage_counts.some((row) => Number(row.raw_rows) > Number(row.viable_rows)), true);

  const allDropSamples = result.meta.stage_counts.flatMap((row) => row.drop_samples || []);
  const allDropReasons = new Set(allDropSamples.map((row) => row.reason));
  assert.equal(allDropReasons.has('color_cosmetic'), true);
  assert.equal(allDropReasons.has('refill_only'), true);
  assert.equal(allDropReasons.has('currency_EUR_expected_USD'), true);
  assert.equal(allDropReasons.has('beauty_tool_or_applicator'), true);
  assert.equal(allDropReasons.has('lip_scrub_or_exfoliator'), true);
  assert.equal(allDropReasons.has('bundle_or_set'), true);
  assert.equal(allDropSamples.some((row) => row.external_product_id === 'ext_bad_correcting_stick' && /Match Stix/i.test(row.title)), true);
  assert.equal(allDropSamples.some((row) => row.external_product_id === 'ext_bad_eur_spf' && row.currency === 'EUR'), true);
  assert.equal(allDropSamples.every((row) => row.title && row.reason), true);
  const sunscreenStage = result.meta.stage_counts.find((row) => row.role_id === 'sun_protection');
  assert.equal(sunscreenStage.drop_reason_counts.color_cosmetic, 1);
  assert.equal(sunscreenStage.drop_reason_counts.refill_only, 1);
  assert.equal(sunscreenStage.drop_reason_counts.currency_EUR_expected_USD, 1);
});

test('travel local product authority: returns coverage miss when only incompatible products match', async () => {
  const result = await loadTravelLocalProductAuthorityCandidates({
    destination: 'Seattle, United States',
    travelReadiness: buildReadiness(),
    message: 'What should I pack before my flight?',
    limit: 3,
    queryFn: async (sql, params) => {
      const categories = Array.isArray(params?.[3]) ? params[3] : [];
      if (categories.includes('sunscreen')) {
        return {
          rows: [
            seedRow({
              id: 301,
              market: 'US',
              external_product_id: 'ext_bad_correcting_stick_only',
              title: 'Match Stix Correcting Skinstick — Banana',
              brand: 'Fenty Beauty',
              category: 'sunscreen',
              summary: 'color correcting makeup stick',
              price_amount: 32,
              price_currency: 'USD',
            }),
          ],
        };
      }
      if (categories.includes('moisturizer')) {
        return {
          rows: [
            seedRow({
              id: 302,
              market: 'US',
              external_product_id: 'ext_bad_bronzer_only',
              title: 'Cheeks Out Freestyle Cream Bronzer — Teddy',
              brand: 'Fenty Beauty',
              category: 'moisturizer',
              summary: 'cream bronzer makeup',
              price_amount: 29,
              price_currency: 'USD',
            }),
          ],
        };
      }
      return { rows: [] };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'coverage_miss');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.meta.coverage_status, 'coverage_miss');
  const dropped = result.meta.stage_counts.flatMap((row) => row.drop_samples || []);
  assert.equal(dropped.some((row) => row.external_product_id === 'ext_bad_correcting_stick_only'), true);
  assert.equal(dropped.some((row) => row.reason === 'color_cosmetic'), true);
});
