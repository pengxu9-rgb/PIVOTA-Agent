const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapLegacyCardToSpecCards,
  buildRecommendationCardContext,
  normalizeRecommendationProductCard,
} = require('../src/auroraBff/chatCardFactory');

test('finish-fit card mapper keeps airy sunscreen evidence over neutral cream-texture cue', () => {
  const roleId = 'daily_sunscreen_finish_fit';
  const airyfit = {
    product_id: 'ext_6caa0a0e7a6095fec92b93b6',
    display_name: 'Moisture Airyfit Daily Sunscreen SPF50+/PA++++ / Unscented',
    brand: 'Haruharu Wonder',
    selected_target_id: roleId,
    matched_role_id: roleId,
    matched_role_label: 'Daily sunscreen with finish fit',
    comparison_mode: 'same_role_comparison',
    short_description: 'SPF50+ sunscreen with a lightweight velvety finish for daily wear.',
    why_this_one: 'it has more direct airy, non-greasy texture evidence for oily skin under makeup while staying in a dedicated SPF50+ sunscreen lane',
    compare_highlights: [
      'The airy-fit, non-greasy finish is the clearest product cue here, making it more about wearable daytime texture than about glow-heavy sunscreen styling.',
    ],
    pivota_insights: {
      what_it_is: 'SPF50+ PA++++ daily sunscreen with a lightweight cream texture and a velvety finish.',
    },
  };
  const mineral = {
    product_id: 'ext_c72a4eb40e754beaa43a39d0',
    display_name: 'Moisture Pure Mineral Relief Sunscreen SPF50+/PA++++ /Unscented',
    brand: 'Haruharu Wonder',
    selected_target_id: roleId,
    matched_role_id: roleId,
    matched_role_label: 'Daily sunscreen with finish fit',
    short_description: 'Mineral SPF with sensitive-skin positioning.',
  };
  const moisturizerSpf = {
    product_id: 'ext_0fff03f61c59e019e5b8cccd',
    display_name: 'Dayscreen Moisturizer SPF 30',
    brand: 'Beauty of Joseon',
    selected_target_id: roleId,
    matched_role_id: roleId,
    matched_role_label: 'Daily sunscreen with finish fit',
    short_description: 'Moisturizer-SPF hybrid with light hydration.',
  };
  const recommendations = [airyfit, mineral, moisturizerSpf];
  const payload = {
    recommendations,
    roles: [
      {
        role_id: roleId,
        label: 'Daily sunscreen with finish fit',
        product_candidates: recommendations,
      },
    ],
    recommendation_meta: {
      selected_target_ids: [roleId],
      ranked_targets: [
        {
          target_id: roleId,
          target_label: 'Daily sunscreen with finish fit',
          product_candidates: recommendations,
        },
      ],
    },
  };

  const context = buildRecommendationCardContext(payload, recommendations);
  const normalized = normalizeRecommendationProductCard(airyfit, context);

  assert.match(normalized.why_this_one, /airy, non-greasy texture evidence/i);
  assert.match(normalized.why_this_one, /dedicated SPF50\+ sunscreen lane/i);
  assert.doesNotMatch(normalized.why_this_one, /richer|more moisturizing|cushion/i);
  assert.match(normalized.short_description, /lightweight velvety finish/i);
  assert.doesNotMatch(normalized.short_description, /richer|more moisturizing|cushion/i);
});

test('recommendations card renderer follows final_selection order for visible product cards', () => {
  const recommendations = [
    {
      product_id: 'spf_matte',
      display_name: 'Matte Fit Serum Sunscreen SPF 50+',
      brand: 'SKINTIFIC',
      matched_role_id: 'daily_sunscreen_finish_fit',
      why_this_one: 'direct matte and non-greasy evidence for oily skin under makeup',
    },
    {
      product_id: 'spf_light',
      display_name: 'Light Serum Sunscreen SPF 50+',
      brand: 'SKINTIFIC',
      matched_role_id: 'daily_sunscreen_finish_fit',
      why_this_one: 'lighter serum format for daily wear',
    },
    {
      product_id: 'spf_unseen',
      display_name: 'Unseen Sunscreen SPF 50',
      brand: 'Supergoop',
      matched_role_id: 'daily_sunscreen_finish_fit',
      why_this_one: 'invisible finish for daily SPF wear',
    },
  ];
  const [card] = mapLegacyCardToSpecCards(
    {
      card_id: 'reco_order_test',
      type: 'recommendations',
      payload: {
        recommendations,
        recommendation_meta: {
          final_selection: {
            selected_product_ids: ['spf_light', 'spf_unseen', 'spf_matte'],
            selected_titles: [
              'SKINTIFIC Light Serum Sunscreen SPF 50+',
              'Supergoop Unseen Sunscreen SPF 50',
              'SKINTIFIC Matte Fit Serum Sunscreen SPF 50+',
            ],
          },
        },
        metadata: {
          search_stage_ledger: {
            final_selection: {
              selected_product_ids: ['spf_light', 'spf_unseen', 'spf_matte'],
              selected_titles: [
                'SKINTIFIC Light Serum Sunscreen SPF 50+',
                'Supergoop Unseen Sunscreen SPF 50',
                'SKINTIFIC Matte Fit Serum Sunscreen SPF 50+',
              ],
            },
          },
        },
      },
    },
    { requestId: 'req_reco_order_test', language: 'EN' },
  );

  assert.deepEqual(
    card.payload.recommendations.map((item) => item.product_id),
    ['spf_light', 'spf_unseen', 'spf_matte'],
  );
  assert.deepEqual(
    card.payload.products.map((item) => item.product_id),
    ['spf_light', 'spf_unseen', 'spf_matte'],
  );
  assert.deepEqual(
    card.sections[0].products.map((item) => item.product_id),
    ['spf_light', 'spf_unseen', 'spf_matte'],
  );
});
