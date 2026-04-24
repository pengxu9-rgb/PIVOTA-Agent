const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('reco assistant rewrite prompt omits deterministic base text and carries request mode', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'GoalSkin Oil Control Serum',
            brand: 'GoalSkin',
            category: 'Serum',
            short_description: 'Helps reduce visible shine without feeling heavy.',
            price: { amount: 12, currency: 'USD', unknown: false },
          },
        ],
        roles: [
          {
            role_id: 'oil_control_treatment',
            label: 'Oil-control treatment',
            preferred_step: 'treatment',
            why_this_role: 'Reduce excess sebum.',
          },
          {
            role_id: 'lightweight_moisturizer',
            label: 'Lightweight moisturizer',
            preferred_step: 'moisturizer',
            why_this_role: 'Support barrier without heaviness.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Niacinamide',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Niacinamide',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    const prompt = __internal.buildRecoAssistantRewritePrompt({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'I am oily skin. What product should I buy?',
      baseText: 'Primary recommendation focus: keep this pass centered on Niacinamide.',
    });

    assert.match(prompt, /"request_mode":"buy"/);
    assert.match(prompt, /"user_request":"I am oily skin\. What product should I buy\?"/);
    assert.match(prompt, /If request_mode is "buy", use direct shopping advice tone\./);
    assert.match(prompt, /If request_mode is "buy", start the first sentence with the lead product name rather than a generic concern summary\./);
    assert.match(prompt, /If request_mode is "buy" and there is one selected product, the first sentence must directly recommend that product by name\./);
    assert.match(prompt, /If selected_product_role_mix is "single_product", stay on one clear recommendation and do not frame the answer as a routine or a comparison set\./);
    assert.match(prompt, /If selected_product_role_mix is "single_product", sentence 2 must explain why that one product matches the concern using concrete evidence from Context\./);
    assert.match(prompt, /If request_mode is "buy" and selected_product_role_mix is "same_role_comparison", the first sentence must name the lead product and signal that the remaining picks are same-slot comparison options\./);
    assert.match(prompt, /If request_mode is "buy" and selected_product_role_mix is "routine_mix", the first sentence must name the lead product and frame the remaining picks as routine add-ons from other roles; only same-role products may be same-slot alternatives\./);
    assert.match(prompt, /If selected_product_role_mix is "routine_mix", make it clear these are different routine steps, not interchangeable substitutes, and do not use the phrase "selected products"\./);
    assert.match(prompt, /If selected_product_role_mix is "same_role_comparison", present a concise horizontal comparison and name each selected product exactly once if space allows\./);
    assert.match(prompt, /If selected_product_role_mix is "routine_mix", present a basic routine by role or step, and do not imply products from different roles are interchangeable\./);
    assert.match(prompt, /If selected_product_role_mix is "same_role_comparison", omit price, affordability, or ROI language unless the user explicitly asked about price, budget, value, or ROI\./);
    assert.match(prompt, /If known_price_count is 2 or more and selected_product_role_mix is "routine_mix", prices may be stated as per-step costs only; do not compare affordability across different routine roles\./);
    assert.match(prompt, /Price may support a recommendation, but price alone is not enough; pair it with at least one concrete fit, formula, texture, ingredient, or use-case reason from Context\./);
    assert.match(prompt, /Use selected_product_details\.compare_highlights and selected_product_details\.pivota_insights when available; do not invent highlights that are absent from Context\./);
    assert.match(prompt, /Use selected_product_details\.description_snippet and selected_product_details\.evidence_points as the primary concrete reason layer when available\./);
    assert.match(prompt, /Do not call a product, routine, or bundle the top, best, strongest, perfect, or ideal choice\. Give concrete evidence instead\./);
    assert.match(prompt, /Never write ungrammatical fragments like "because a serum\.\.\."/);
    assert.match(prompt, /If selected_product_details\.fit_assessment is "soft_match" or comparison_fill_reason is present, frame that product as a softer or broader alternative instead of an equally direct match\./);
    assert.match(prompt, /Prefer product-specific evidence over generic role language when both are available\./);
    assert.match(prompt, /If Context\.refinement_question exists, include exactly one follow-up question as the final sentence after the recommendation/);
    assert.match(prompt, /Do not ask for fields already present in Context\.profile_summary; use only Context\.refinement_question for follow-up\./);
    assert.match(prompt, /If request_mode is "buy" and there is one selected product with no secondary targets, use exactly 2 recommendation sentences; if Context\.refinement_question exists, add one short final question\./);
    assert.match(prompt, /If selected_target_ids has length 1, secondary_targets is empty, and selected_product_role_mix is not "routine_mix", do not add future routine-building suggestions or extra steps\./);
    assert.match(prompt, /Use plain shopper-facing skincare language\. Avoid vague phrases like "surface activity"\./);
    assert.match(prompt, /Avoid generic filler like "great choice", "balanced complexion", or "solution for oiliness"\./);
    assert.match(prompt, /Use selected_product_details\.why_this_one, selected_product_details\.best_for, and selected_product_details\.key_features as supporting context when available\./);
    assert.match(prompt, /If request_mode is "use_first", use starting-point advice tone\./);
    assert.match(prompt, /"short_description":"Helps reduce visible shine without feeling heavy\."/);
    assert.match(prompt, /"description_snippet":"Helps reduce visible shine without feeling heavy\."/);
    assert.match(prompt, /"evidence_points":\["Helps reduce visible shine without feeling heavy\."\]/);
    assert.match(prompt, /"key_features":\[\]/);
    assert.match(prompt, /"price":\{"amount":12,"currency":"USD","unknown":false\}/);
    assert.match(prompt, /"selected_product_role_mix":"single_product"/);
    assert.match(prompt, /"refinement_question":\{"field":"location_climate"/);
    assert.match(prompt, /What city or climate are you usually in/);
    assert.match(prompt, /"known_price_count":1/);
    assert.match(prompt, /"role_id":"oil_control_treatment"/);
    assert.doesNotMatch(prompt, /"role_id":"lightweight_moisturizer"/);
    assert.doesNotMatch(prompt, /"base_text":/);
    assert.doesNotMatch(
      prompt,
      /Primary recommendation focus: keep this pass centered on Niacinamide\./,
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite prompt neutralizes absolute marketing copy in selected product evidence', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'round_lab_mild_up',
            display_name: 'Round Lab Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum',
            brand: 'Round Lab',
            category: 'Sunscreen',
            short_description: 'Effectively protects with superior UV coverage.',
            description: 'Gentle, Effective Physical UV Protection. Experience superior sun protection with a lightweight mineral sunscreen.',
            why_this_one: 'Experience superior sun protection with highly effective mineral filters.',
            best_for: 'Best for daily UV protection.',
            key_features: ['Highly effective UV protection', 'Superior mineral filter feel'],
            compare_highlights: ['Most effective option for daily SPF in this set.'],
            price: { amount: 25, currency: 'USD', unknown: false },
            matched_role_id: 'daily_sunscreen',
            matched_role_label: 'Daily sunscreen',
          },
        ],
        roles: [
          {
            role_id: 'daily_sunscreen',
            label: 'Daily sunscreen',
            preferred_step: 'sunscreen',
            why_this_role: 'Daily UV protection.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        primary_target_id: 'daily_sunscreen',
        ranked_targets: [{ target_id: 'daily_sunscreen', resolved_target_step: 'sunscreen' }],
        selected_target_ids: ['daily_sunscreen'],
        resolved_target_step: 'sunscreen',
      },
    );
    const prompt = __internal.buildRecoAssistantRewritePrompt({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['daily sunscreen'] },
      userRequestText: 'I have oily skin. What sunscreen should I buy?',
    });
    const context = JSON.parse(prompt.match(/Context: (\{[\s\S]*\})$/)[1]);
    const [detail] = context.selected_product_details;
    const evidenceText = JSON.stringify({
      short_description: detail.short_description,
      description_snippet: detail.description_snippet,
      best_for: detail.best_for,
      why_this_one: detail.why_this_one,
      key_features: detail.key_features,
      compare_highlights: detail.compare_highlights,
      evidence_points: detail.evidence_points,
    });

    assert.doesNotMatch(evidenceText, /\b(?:best|most|effective|effectively|superior|highly effective|ideal|strongest)\b/i);
    assert.match(evidenceText, /uv protection|daily SPF|mineral filter|daily sunscreen step/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite prompt carries finish-fit same-slot tradeoff notes before price-only compare', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_unseen',
            display_name: 'Unseen Sunscreen SPF 50',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A daily sunscreen built around soft-focus powders for comfortable daytime layering under makeup.',
            why_this_one: 'it points to lighter, smoother daytime layering instead of a richer cream finish',
            price: { amount: 19, currency: 'USD', unknown: false },
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_mineral_unseen',
            display_name: 'Mineral Unseen Sunscreen SPF 40',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A sheer, weightless, scentless mineral sunscreen recommended for sensitive skin.',
            why_this_one: 'it keeps the wear sheer and weightless while staying simpler for sensitive-skin daytime use',
            price: { amount: 40, currency: 'USD', unknown: false },
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_superscreen',
            display_name: 'Superscreen Hydrating Daily Cream SPF 40',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A hydrating daily cream SPF with moisturizer-style hydration cues.',
            why_this_one: 'it gives more daytime moisture from a creamier SPF texture, not just the lightest finish',
            price: { amount: 48, currency: 'USD', unknown: false },
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_mineral',
            display_name: 'Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
            brand: 'First Aid Beauty',
            category: 'Sunscreen',
            short_description: 'A sheer, weightless mineral sunscreen option for sensitive skin.',
            why_this_one: 'it gives a more mineral, sensitive-skin-oriented option while keeping the finish sheer and weightless',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_rich',
            display_name: 'Hydrating Sunscreen Milk with Colloidal Oatmeal Broad Spectrum SPF 45',
            brand: 'First Aid Beauty',
            category: 'Sunscreen',
            short_description: 'A daily sunscreen built around humectants and soft-focus powders for AM UV protection and comfortable daytime layering.',
            why_this_one: 'it keeps the feel lighter and more invisible if you want less weight under makeup',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
            why_this_role: 'Use a daily sunscreen that layers cleanly under makeup.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [{ target_id: 'daily_sunscreen_finish_fit', resolved_target_step: 'sunscreen' }],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
        resolved_target_step: 'sunscreen',
      },
    );
    const prompt = __internal.buildRecoAssistantRewritePrompt({
      payload,
      language: 'EN',
      profile: { skinType: 'combination', goals: ['smooth layering'] },
      userRequestText: 'My daytime routine pills under makeup. What sunscreen should I buy?',
      allowLockedSelectionRewrite: true,
    });
    const context = JSON.parse(prompt.match(/Context: (\{[\s\S]*\})$/)[1]);

    assert.match(prompt, /If assistant_write_plan\.same_role_options is non-empty, use their tradeoff_note or reason_points to explain how they differ from the lead pick\./);
    assert.match(prompt, /If target_label or selected_target_ids indicates daily_sunscreen_finish_fit, explain under-makeup wear, pilling risk, white-cast, fluid versus cream texture, or weightless versus richer finish before defaulting to UV-filter identity\./);
    assert.match(prompt, /default to wear, texture, finish, and formula tradeoffs; do not mention price, affordability, or higher\/lower-priced language unless the user explicitly asked for it\./);
    assert.match(prompt, /Do not say a sunscreen doubles as, acts as, works as, or serves as a primer\./);
    assert.match(
      JSON.stringify(context.assistant_write_plan.same_role_options),
      /(?:more mineral, sensitive-skin-oriented option while keeping a sheer, weightless finish|leans more mineral and sensitive-skin-friendly if you want a sheer, weightless finish)/,
    );
    assert.match(
      JSON.stringify(context.assistant_write_plan.same_role_options),
      /richer, more moisturizing cream-SPF option|leans richer and more moisturizing if you want more cushion under makeup/,
    );
    assert.equal(context.price_compare_requested, false);
    assert.deepEqual(context.price_order_summary, []);
    assert.doesNotMatch(
      JSON.stringify(context.assistant_write_plan.same_role_options),
      /"price_note":"\\$40"|\"price_note\":\"\\$48\"/,
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite prompt keeps matte finish-fit tradeoff distinct from mineral cues', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_lead',
            display_name: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
            brand: 'Beauty of Joseon',
            category: 'Sunscreen',
            short_description: 'A lightweight sunscreen fluid that layers smoothly under makeup with no white cast.',
            why_this_one: 'it keeps the finish lighter and smoother under makeup if you want a less heavy daytime layer',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_matte_fit',
            display_name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
            brand: 'SKINTIFIC',
            category: 'Sunscreen',
            short_description: 'Protect your skin from UVA, UVB, and blue light with Matte Fit Serum Sunscreen SPF 50+ PA++++.',
            description: 'This oil-controlling, non-greasy formula with Oat Extract and Zinc PCA is perfect for oily and acne-prone skin. Fast-absorbing, smooth finish with 8-hour shine control.',
            key_features: ['Zinc PCA'],
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [{ target_id: 'daily_sunscreen_finish_fit', resolved_target_step: 'sunscreen' }],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
        resolved_target_step: 'sunscreen',
      },
    );

    const prompt = __internal.buildRecoAssistantRewritePrompt({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['smooth layering'] },
      userRequestText: 'My makeup pills. What sunscreen should I buy?',
      allowLockedSelectionRewrite: true,
    });
    const context = JSON.parse(prompt.match(/Context: (\{[\s\S]*\})$/)[1]);
    const tradeoffNotes = JSON.stringify(context.assistant_write_plan.same_role_options || []);

    assert.match(tradeoffNotes, /matte and shine-controlling if you want less slip under makeup/i);
    assert.doesNotMatch(tradeoffNotes, /mineral and sensitive-skin-friendly/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite prompt carries dewy finish-fit tradeoff for Day Dew style options', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_lead',
            display_name: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
            brand: 'Beauty of Joseon',
            category: 'Sunscreen',
            short_description: 'A lightweight sunscreen fluid that layers smoothly under makeup with no white cast.',
            why_this_one: 'it keeps the finish lighter and smoother under makeup if you want a less heavy daytime layer',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_day_dew',
            display_name: 'Day Dew Sunscreen',
            brand: 'Beauty of Joseon',
            category: 'Sunscreen',
            short_description: 'Fresh-dewy SPF for daily wear and makeup-friendly layering.',
            description: 'Pairs niacinamide, hyaluronic acid, and glycerin with makeup-friendly layering for cleaner daytime layering.',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [{ target_id: 'daily_sunscreen_finish_fit', resolved_target_step: 'sunscreen' }],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
        resolved_target_step: 'sunscreen',
      },
    );

    const prompt = __internal.buildRecoAssistantRewritePrompt({
      payload,
      language: 'EN',
      profile: { skinType: 'combination', goals: ['smooth layering'] },
      userRequestText: 'My makeup pills. What sunscreen should I buy?',
      allowLockedSelectionRewrite: true,
    });
    const context = JSON.parse(prompt.match(/Context: (\{[\s\S]*\})$/)[1]);
    const tradeoffNotes = JSON.stringify(context.assistant_write_plan.same_role_options || []);

    assert.match(tradeoffNotes, /leans fresher and dewier if you want a bit more hydration without a heavier cream feel/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite prompt keeps same-role price context only when user explicitly asks for value comparison', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_unseen',
            display_name: 'Supergoop Unseen Sunscreen SPF 50',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A lighter finish sunscreen for smoother daytime layering.',
            price: { amount: 19, currency: 'USD', unknown: false },
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
          },
          {
            product_id: 'spf_mineral_unseen',
            display_name: 'Supergoop Mineral Unseen Sunscreen SPF 40',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A sheer, weightless mineral sunscreen for sensitive skin.',
            price: { amount: 40, currency: 'USD', unknown: false },
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
          },
          {
            product_id: 'spf_superscreen',
            display_name: 'Supergoop Superscreen Hydrating Daily Cream SPF 40',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A richer hydrating cream-SPF.',
            price: { amount: 48, currency: 'USD', unknown: false },
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
          },
        ],
        roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
            why_this_role: 'Use a daily sunscreen that layers cleanly under makeup.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [{ target_id: 'daily_sunscreen_finish_fit', resolved_target_step: 'sunscreen' }],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
        resolved_target_step: 'sunscreen',
      },
    );
    const prompt = __internal.buildRecoAssistantRewritePrompt({
      payload,
      language: 'EN',
      profile: { skinType: 'combination', goals: ['smooth layering'] },
      userRequestText: 'My sunscreen pills under makeup. Which one is worth paying more for?',
      allowLockedSelectionRewrite: true,
    });
    const context = JSON.parse(prompt.match(/Context: (\{[\s\S]*\})$/)[1]);

    assert.equal(context.price_compare_requested, true);
    assert.equal(context.known_price_count, 3);
    assert.match(JSON.stringify(context.price_order_summary), /\$19/);
    assert.match(JSON.stringify(context.price_order_summary), /\$48/);
    assert.match(prompt, /compare lower-priced versus higher-priced options only inside the same role/);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco rows prefer role-grounded sunscreen copy over marketing-heavy seed narrative', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rows = __internal.buildRecoRowsFromMainlineProducts(
      [
        {
          product_id: 'round_lab_mild_up',
          merchant_id: 'external_seed',
          brand: 'Round Lab',
          display_name: 'Round Lab Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum',
          category: 'Sunscreen',
          product_type: 'Sunscreen',
          short_description:
            'Korea’s #1 sunscreen 10M+ sold worldwide. Broad-Spectrum Physical Protection: Formulated with Zinc Oxide and Titanium Dioxide to reflect and',
          description:
            'Korea’s #1 sunscreen 10M+ sold worldwide. Featured in Allure. Broad-Spectrum Physical Protection: Formulated with Zinc Oxide and Titanium Dioxide to reflect and scatter UVA and UVB rays. Experience superior sun protection with Round Lab’s lightweight mineral sunscreen. Why Choose Round Lab Birch Mild-Up Sunscreen? Perfect for Daily Use.',
          why_this_one:
            'Clinically shown to deliver visible improvements in sun protection. Experience superior sun protection with highly effective physical UV filters.',
          product_intel: {
            product_intel_core: {
              why_it_stands_out: [
                {
                  body: 'Keeps the sunscreen evaluation tied to AM UV protection and reapplication expectations, not just moisturizer-style claims.',
                },
                {
                  body: 'Uses mineral UV-filter cues for shoppers who need a daily sunscreen step with clear filter identity.',
                },
              ],
            },
            shopping_card: {
              intro: 'Korea’s #1 sunscreen 10M+ sold worldwide.',
            },
          },
          key_features: ['UV filters', 'Zinc PCA'],
          matched_role_id: 'daily_sunscreen',
          matched_role_label: 'Daily sunscreen',
          price: { amount: 25, currency: 'USD', unknown: false },
        },
      ],
      {
        targetContext: {
          resolved_target_step: 'sunscreen',
          primary_role_id: 'daily_sunscreen',
          framework_roles: [
            {
              role_id: 'daily_sunscreen',
              label: 'Daily sunscreen',
              rank: 3,
              preferred_step: 'sunscreen',
              why_this_role: 'Provide daily UV protection with a wearable finish.',
            },
          ],
        },
        language: 'EN',
      },
    );

    assert.equal(rows.length, 1);
    assert.doesNotMatch(
      String(rows[0].why_this_one || ''),
      /physical uv protection sun protection|experience superior|why choose|perfect for daily use|effective|superior|clinically shown|visible improvements|korea|#1|10m|sold worldwide|featured in|evaluation tied|filter cues|clear filter identity|moisturizer-style claims/i,
    );
    assert.doesNotMatch(
      String(rows[0].short_description || ''),
      /physical uv protection sun protection|experience superior|why choose|perfect for daily use|effective|superior|clinically shown|visible improvements|korea|#1|10m|sold worldwide|featured in|evaluation tied|filter cues|clear filter identity|moisturizer-style claims/i,
    );
    assert.doesNotMatch(
      String(rows[0].short_description || ''),
      /\b(?:and|or|to|with|for)\s+for the daily sunscreen step\b|to reflect for the daily sunscreen step/i,
    );
    assert.match(
      String(rows[0].why_this_one || ''),
      /it is formulated with Zinc Oxide and Titanium Dioxide.+daily sunscreen step/i,
    );
    assert.match(
      String(rows[0].short_description || ''),
      /it is formulated with Zinc Oxide and Titanium Dioxide.+daily sunscreen step/i,
    );
    assert.match(String(rows[0].short_description || ''), /daily sunscreen step/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco rows remove off-context drier-skin tail copy from oily moisturizer cards', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rows = __internal.buildRecoRowsFromMainlineProducts(
      [
        {
          product_id: 'dieux_air_angel',
          merchant_id: 'external_seed',
          brand: 'Dieux',
          display_name: 'Dieux Air Angel Peptide Plumping Gel Cream',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          why_this_one:
            'Finish is slightly matte and good under makeup or a richer cream as a more hydrating step for those with drier...',
          short_description:
            'Finish is slightly matte and good under makeup or a richer cream as a more hydrating step for those with drier...',
          matched_role_id: 'lightweight_moisturizer',
          matched_role_label: 'Lightweight moisturizer',
          price: { amount: 34, currency: 'USD', unknown: false },
        },
      ],
      {
        targetContext: {
          resolved_target_step: 'treatment',
          primary_role_id: 'oil_control_treatment',
          framework_roles: [
            {
              role_id: 'lightweight_moisturizer',
              label: 'Lightweight moisturizer',
              rank: 2,
              preferred_step: 'moisturizer',
              why_this_role: 'Add a light moisturizer step that does not feel greasy for oily skin.',
            },
          ],
        },
        language: 'EN',
      },
    );

    assert.equal(rows.length, 1);
    assert.match(String(rows[0].why_this_one || ''), /slightly matte and good under makeup/i);
    assert.doesNotMatch(String(rows[0].why_this_one || ''), /drier skin types|richer cream/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco rows rewrite finish-fit sunscreen copy toward under-makeup wear cues', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rows = __internal.buildRecoRowsFromMainlineProducts(
      [
        {
          product_id: 'supergoop_unseen_finish_fit',
          merchant_id: 'external_seed',
          brand: 'Supergoop',
          display_name: 'Unseen Sunscreen SPF 50',
          category: 'Sunscreen',
          product_type: 'Sunscreen',
          short_description: 'A daily sunscreen built around modern organic UV filters, ectoin/bisabolol-style soothing support plus soft-focus powders for AM UV protection and comfortable daytime layering.',
          why_this_one: 'Uses modern organic UV-filter cues for a daily sunscreen step while keeping reapplication expectations explicit.',
          key_features: ['UV filters'],
          matched_role_id: 'daily_sunscreen_finish_fit',
          matched_role_label: 'Daily sunscreen with finish fit',
          preferred_step: 'sunscreen',
        },
      ],
      {
        targetContext: {
          resolved_target_step: 'sunscreen',
          primary_role_id: 'daily_sunscreen_finish_fit',
          framework_roles: [
            {
              role_id: 'daily_sunscreen_finish_fit',
              label: 'Daily sunscreen with finish fit',
              rank: 1,
              preferred_step: 'sunscreen',
              why_this_role: 'Use a daily sunscreen that layers cleanly under makeup.',
            },
          ],
        },
        language: 'EN',
      },
    );

    assert.equal(rows.length, 1);
    assert.match(String(rows[0].best_for || ''), /under makeup|sits more smoothly/i);
    assert.match(String(rows[0].why_this_one || ''), /under-makeup sunscreen ask|keeps the finish lighter and smoother under makeup|lighter, smoother daytime layering/i);
    assert.doesNotMatch(String(rows[0].why_this_one || ''), /uv-filter cues|filter identity|reapplication expectations explicit/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco rows keep finish-fit same-slot cards differentiated by mineral and cream tradeoffs', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rows = __internal.buildRecoRowsFromMainlineProducts(
      [
        {
          product_id: 'spf_unseen',
          merchant_id: 'external_seed',
          brand: 'Supergoop',
          display_name: 'Unseen Sunscreen SPF 50',
          category: 'Sunscreen',
          product_type: 'Sunscreen',
          short_description: 'A daily sunscreen built around soft-focus powders for comfortable daytime layering under makeup.',
          why_this_one: 'it points to lighter, smoother daytime layering instead of a richer cream finish',
          matched_role_id: 'daily_sunscreen_finish_fit',
          matched_role_label: 'Daily sunscreen with finish fit',
          preferred_step: 'sunscreen',
        },
        {
          product_id: 'spf_mineral_unseen',
          merchant_id: 'external_seed',
          brand: 'Supergoop',
          display_name: 'Mineral Unseen Sunscreen SPF 40',
          category: 'Sunscreen',
          product_type: 'Sunscreen',
          short_description: 'Sheer, weightless, scentless mineral sunscreen that’s recommended for sensitive skin.',
          description: 'An invisible, weightless mineral sunscreen that layers under makeup while staying simpler for sensitive skin.',
          why_this_one: 'it points to lighter, smoother daytime layering instead of a richer cream finish',
          compare_highlights: [
            'Uses mineral UV-filter cues for shoppers who need a daily sunscreen step with clear filter identity.',
            'Suited for Daily SPF wear',
            'Suited for Mineral-filter preference',
          ],
          matched_role_id: 'daily_sunscreen_finish_fit',
          matched_role_label: 'Daily sunscreen with finish fit',
          preferred_step: 'sunscreen',
        },
        {
          product_id: 'spf_superscreen',
          merchant_id: 'external_seed',
          brand: 'Supergoop',
          display_name: 'Superscreen Hydrating Daily Cream SPF 40',
          category: 'Sunscreen',
          product_type: 'Sunscreen',
          short_description: 'A hydrating daily cream SPF with moisturizer-style hydration cues.',
          description: 'A richer hydrating daily cream SPF for shoppers who want more moisture from the sunscreen step.',
          why_this_one: 'Daily SPF cream with moisturizer-style hydration cues.',
          compare_highlights: [
            'Combines daily SPF use with moisturizer-style hydration cues, so it should be judged on both sun-care use and daytime skin comfort.',
          ],
          matched_role_id: 'daily_sunscreen_finish_fit',
          matched_role_label: 'Daily sunscreen with finish fit',
          preferred_step: 'sunscreen',
        },
      ],
      {
        targetContext: {
          resolved_target_step: 'sunscreen',
          primary_role_id: 'daily_sunscreen_finish_fit',
          framework_roles: [
            {
              role_id: 'daily_sunscreen_finish_fit',
              label: 'Daily sunscreen with finish fit',
              rank: 1,
              preferred_step: 'sunscreen',
              why_this_role: 'Use a daily sunscreen that layers cleanly under makeup.',
            },
          ],
        },
        language: 'EN',
      },
    );

    assert.equal(rows.length, 3);
    assert.match(String(rows[0].why_this_one || ''), /keeps the finish lighter and smoother under makeup|lighter, smoother daytime layering/i);
    assert.match(String(rows[0].short_description || ''), /soft-focus|under makeup|daytime layering/i);
    assert.match(String(rows[1].why_this_one || ''), /leans more mineral|sensitive-skin-friendly|sheer, weightless finish/i);
    assert.match(String(rows[2].why_this_one || ''), /leans richer and more moisturizing|more cushion under makeup/i);
    assert.match(String(rows[1].short_description || ''), /sheer|weightless|sensitive skin|mineral/i);
    assert.match(String(rows[2].short_description || ''), /leans richer and more moisturizing|more cushion under makeup|moisturizing/i);
    assert.notEqual(rows[1].why_this_one, rows[0].why_this_one);
    assert.notEqual(rows[2].why_this_one, rows[0].why_this_one);
    assert.doesNotMatch(String(rows[1].why_this_one || ''), /^Sheer, weightless, scentless mineral sunscreen/i);
    assert.doesNotMatch(String(rows[2].short_description || ''), /moisturizer-style hydration cues/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant refinement question prioritizes missing skin type before climate and lifestyle', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const missingSkinType = __internal.buildRecoAssistantRefinementQuestionPlan({
      language: 'EN',
      profile: { goals: ['oil control'] },
      userRequestText: 'What product should I use?',
    });
    assert.equal(missingSkinType.field, 'skin_type');
    assert.match(missingSkinType.question, /oily, combo-oily, combo-dry, or dry/i);

    const climateNext = __internal.buildRecoAssistantRefinementQuestionPlan({
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'im oily skin. what product should i buy?',
    });
    assert.equal(climateNext.field, 'location_climate');
    assert.match(climateNext.question, /city or climate/i);

    const lifestyleNext = __internal.buildRecoAssistantRefinementQuestionPlan({
      language: 'EN',
      profile: { skinType: 'combination', region: 'San Francisco', goals: ['makeup layering'] },
      userRequestText: 'My sunscreen pills under makeup. What product should I buy?',
    });
    assert.equal(lifestyleNext.field, 'lifestyle_sleep');
    assert.match(lifestyleNext.question, /late nights|outdoor commuting|gym/i);

    const contextTuning = __internal.buildRecoAssistantRefinementQuestionPlan({
      language: 'EN',
      profile: {
        skinType: 'oily',
        region: 'San Francisco',
        currentRoutine: 'cleanser, moisturizer, sunscreen',
        lifestyle: { sleep: 'regular', commute: 'indoors' },
      },
      userRequestText: 'What product should I buy?',
    });
    assert.equal(contextTuning.field, 'context_tuning');
    assert.match(contextTuning.question, /city\/climate, current AM\/PM routine, or lifestyle/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite prompt frames multi-role selections as routine mix with price ROI guard', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            brand: 'The Ordinary',
            category: 'Serum',
            short_description: 'A lightweight oil-control serum for visible shine.',
            price: { amount: 12, currency: 'USD', unknown: false },
            matched_role_id: 'oil_control_treatment',
            matched_role_label: 'Oil-control treatment',
          },
          {
            product_id: 'routine_support_1',
            display_name: 'LightLab Oil-Free Gel Cream',
            brand: 'LightLab',
            category: 'Moisturizer',
            short_description: 'A lightweight gel cream moisturizer for oily skin.',
            price: { amount: 28, currency: 'USD', unknown: false },
            matched_role_id: 'lightweight_moisturizer',
            matched_role_label: 'Lightweight moisturizer',
          },
        ],
        roles: [
          {
            role_id: 'oil_control_treatment',
            label: 'Oil-control treatment',
            preferred_step: 'treatment',
            why_this_role: 'Reduce excess sebum.',
          },
          {
            role_id: 'lightweight_moisturizer',
            label: 'Lightweight moisturizer',
            preferred_step: 'moisturizer',
            why_this_role: 'Support barrier without heaviness.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Niacinamide',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Niacinamide',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    payload.recommendation_meta.ranked_targets[0].product_candidates = [
      { product_id: 'dry_pick_1', name: 'KraveBeauty Great Barrier Relief' },
      { product_id: 'blocked_pick', brand: 'Kylie Cosmetics', name: 'Hyaluronic Acid Serum' },
    ];
    const prompt = __internal.buildRecoAssistantRewritePrompt({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'im oily skin. what product should i buy?',
    });

    assert.match(prompt, /"selected_products":\["The Ordinary Niacinamide 10% \+ Zinc 1%","LightLab Oil-Free Gel Cream"\]/);
    assert.match(prompt, /"selected_product_role_ids":\["oil_control_treatment","lightweight_moisturizer"\]/);
    assert.match(prompt, /"selected_product_role_mix":"routine_mix"/);
    assert.match(prompt, /"known_price_count":0/);
    assert.doesNotMatch(prompt, /"price":\{"amount":12,"currency":"USD","unknown":false\}/);
    assert.doesNotMatch(prompt, /"price":\{"amount":28,"currency":"USD","unknown":false\}/);
    assert.match(prompt, /"assistant_write_plan":\{"request_mode":"buy","selected_product_role_mix":"routine_mix"/);
    assert.match(prompt, /"lead_product":\{"name":"The Ordinary Niacinamide 10% \+ Zinc 1%"/);
    assert.match(prompt, /"support_steps":\[\{"name":"LightLab Oil-Free Gel Cream"/);
    assert.match(prompt, /"fit_assessment":"direct_match"/);
    assert.match(prompt, /"fit_assessment":"support_step"/);
    assert.match(prompt, /the remaining picks as routine add-ons from other roles; only same-role products may be same-slot alternatives/);
    assert.match(prompt, /present a basic routine by role or step, and do not imply products from different roles are interchangeable/);
    assert.match(prompt, /Use assistant_write_plan\.lead_product\.must_use_reason_points as the preferred reason list for the lead recommendation when available\./);
    assert.match(prompt, /If assistant_write_plan\.support_steps is non-empty, justify each support step with its own reason_points instead of using a generic closing summary\./);
    assert.match(prompt, /Do not end with a generic closing sentence like "these steps support your skin" or "together they help balance the routine"\./);
    assert.match(prompt, /Allowed product names are exactly Context\.selected_products\./);
    assert.match(prompt, /Do not name brands\/products outside Context\.selected_products\./);
    assert.match(prompt, /If user_relevant_concern_families does not include tone_brightening, do not mention glow, radiance, dark spots, uneven tone, brightening, or dullness\./);
    assert.match(prompt, /If user_relevant_concern_families does not include aging_texture, do not mention wrinkles, fine lines, aging, anti-aging, or texture repair\./);
    assert.doesNotMatch(prompt, /compare price\/value or ROI in plain shopper terms using only listed prices/);
    assert.match(prompt, /If known_price_count is 2 or more and selected_product_role_mix is "routine_mix", prices may be stated as per-step costs only; do not compare affordability across different routine roles\./);
  } finally {
    delete require.cache[moduleId];
  }
});

test('concern selector race keeps routine support slots on highest authority role-fit candidates', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rows = [
      {
        product_id: 'oil_lead',
        display_name: 'Oil Control Serum',
        matched_role_id: 'oil_control_treatment',
        framework_score: 0.94,
      },
      {
        product_id: 'night_cream_lower_fit',
        display_name: 'Brightening Overnight Recovery Gel-Cream',
        matched_role_id: 'lightweight_moisturizer',
        framework_score: 0.62,
      },
      {
        product_id: 'spf_generic_lower_fit',
        display_name: 'Generic Daily Sunscreen',
        matched_role_id: 'daily_sunscreen',
        framework_score: 0.64,
      },
      {
        product_id: 'day_gel_higher_fit',
        display_name: 'Oil-Free Day Gel Cream',
        matched_role_id: 'lightweight_moisturizer',
        framework_score: 0.86,
      },
      {
        product_id: 'matte_spf_higher_fit',
        display_name: 'Matte Fit Serum Sunscreen SPF 50',
        matched_role_id: 'daily_sunscreen',
        framework_score: 0.88,
      },
    ];
    const applied = __internal.applyConcernSelectorRaceOrdering(rows, {
      top_pick_product_id: 'oil_lead',
      primary_role_id: 'oil_control_treatment',
      comparison_mode: 'routine_mix',
      ordered_product_ids: [
        'oil_lead',
        'night_cream_lower_fit',
        'spf_generic_lower_fit',
        'day_gel_higher_fit',
        'matte_spf_higher_fit',
      ],
    });

    assert.deepEqual(
      applied.recommendations.slice(0, 3).map((item) => item.product_id),
      ['oil_lead', 'day_gel_higher_fit', 'matte_spf_higher_fit'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('concern selector race preserves same-role LLM ordering for comparison sets', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rows = [
      {
        product_id: 'spf_a',
        display_name: 'SPF A',
        matched_role_id: 'daily_sunscreen_finish_fit',
        framework_score: 0.91,
      },
      {
        product_id: 'spf_b',
        display_name: 'SPF B',
        matched_role_id: 'daily_sunscreen_finish_fit',
        framework_score: 0.72,
      },
      {
        product_id: 'spf_c',
        display_name: 'SPF C',
        matched_role_id: 'daily_sunscreen_finish_fit',
        framework_score: 0.88,
      },
    ];
    const applied = __internal.applyConcernSelectorRaceOrdering(rows, {
      top_pick_product_id: 'spf_b',
      primary_role_id: 'daily_sunscreen_finish_fit',
      comparison_mode: 'same_role_comparison',
      ordered_product_ids: ['spf_b', 'spf_c', 'spf_a'],
    });

    assert.deepEqual(
      applied.recommendations.map((item) => item.product_id),
      ['spf_b', 'spf_c', 'spf_a'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant compact prompt keeps same-role comparison payloads under a tight size budget', () => {
  const { moduleId, __internal } = loadRouteInternals();
  const longDetail =
    'A barrier-support formula with tamanu oil, ceramides, niacinamide, soothing hydration, redness support, and lightweight comfort for sensitized skin. '.repeat(18);
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'barrier_pick_1',
            display_name: 'KraveBeauty Great Barrier Relief',
            brand: 'KraveBeauty',
            category: 'Moisturizer',
            short_description: longDetail,
            description: longDetail,
            why_this_one: longDetail,
            key_features: ['Tamanu oil', 'Ceramides', 'Niacinamide', 'Barrier support'],
            price: { amount: 28, currency: 'USD', unknown: false },
            matched_role_id: 'barrier_moisturizer',
            matched_role_label: 'Barrier-support moisturizer',
          },
          {
            product_id: 'barrier_pick_2',
            display_name: 'Haruharu Wonder Soothing Serum',
            brand: 'Haruharu Wonder',
            category: 'Serum',
            short_description: longDetail,
            description: longDetail,
            why_this_one: longDetail,
            key_features: ['Azelaic acid', 'Ceramide NP', 'Panthenol', 'Squalane'],
            price: { amount: 22, currency: 'USD', unknown: false },
            matched_role_id: 'barrier_moisturizer',
            matched_role_label: 'Barrier-support moisturizer',
          },
          {
            product_id: 'barrier_pick_3',
            display_name: 'Olehenriksen Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
            brand: 'Olehenriksen',
            category: 'Moisturizer',
            short_description: longDetail,
            description: longDetail,
            why_this_one: longDetail,
            key_features: ['Ceramide NP', 'Panthenol', 'Niacinamide', 'Hyaluronic acid'],
            price: { amount: 48, currency: 'USD', unknown: false },
            matched_role_id: 'barrier_moisturizer',
            matched_role_label: 'Barrier-support moisturizer',
          },
        ],
        roles: [
          {
            role_id: 'barrier_moisturizer',
            label: 'Barrier-support moisturizer',
            preferred_step: 'moisturizer',
            why_this_role: 'Support a stripped, irritated barrier.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'moisturizer',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Barrier moisturizer',
        resolved_target_step: 'moisturizer',
        primary_target_id: 'barrier_moisturizer',
        ranked_targets: [
          {
            target_id: 'barrier_moisturizer',
            ingredient_query: 'Barrier moisturizer',
            resolved_target_step: 'moisturizer',
          },
        ],
        selected_target_ids: ['barrier_moisturizer'],
      },
    );
    const prompt = __internal.buildRecoAssistantRewritePrompt({
      payload,
      language: 'EN',
      profile: { skinType: 'sensitive', goals: ['barrier support'] },
      userRequestText: 'My skin gets red easily and stings with strong products. What should I buy first?',
      compactContext: true,
    });

    assert.match(prompt, /"prompt_profile":"compact_timeout_retry"/);
    assert.match(prompt, /Treat the products as same-slot comparison options, not a routine\./);
    assert.match(prompt, /Pick one lead product, then compare the other options with one short tradeoff each\./);
    assert.match(prompt, /Allowed product names are exactly Context\.selected_products\./);
    assert.match(prompt, /Do not name brands\/products outside Context\.selected_products\./);
    assert.match(prompt, /If user_relevant_concern_families does not include tone_brightening, do not mention glow, radiance, dark spots, uneven tone, brightening, or dullness\./);
    assert.match(prompt, /If user_relevant_concern_families does not include aging_texture, do not mention wrinkles, fine lines, aging, anti-aging, or texture repair\./);
    assert.ok(prompt.length < 7000);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant strict selected-only retry prompt drops expanded framework context', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'dry_pick_1',
            display_name: 'KraveBeauty Great Barrier Relief',
            brand: 'KraveBeauty',
            category: 'Moisturizer',
            short_description: 'Barrier-support moisturizer with tamanu oil, ceramides, and niacinamide.',
            price: { amount: 28, currency: 'USD', unknown: false },
            matched_role_id: 'hydrating_barrier_moisturizer',
            matched_role_label: 'Hydrating barrier moisturizer',
          },
          {
            product_id: 'dry_pick_2',
            display_name: 'UV Filters SPF 45 Serum',
            brand: 'The Ordinary',
            category: 'Sunscreen',
            short_description: 'Lightweight SPF 45 serum for daily UV protection.',
            price: { amount: 19, currency: 'USD', unknown: false },
            matched_role_id: 'daily_sunscreen',
            matched_role_label: 'Daily sunscreen',
          },
        ],
        roles: [
          {
            role_id: 'hydrating_barrier_moisturizer',
            label: 'Hydrating barrier moisturizer',
            preferred_step: 'moisturizer',
            why_this_role: 'Repair a dry-feeling barrier.',
          },
          {
            role_id: 'daily_sunscreen',
            label: 'Daily sunscreen',
            preferred_step: 'sunscreen',
            why_this_role: 'Protect the barrier during the day.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'moisturizer',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Hydrating barrier moisturizer',
        resolved_target_step: 'moisturizer',
        primary_target_id: 'hydrating_barrier_moisturizer',
        ranked_targets: [
          {
            target_id: 'hydrating_barrier_moisturizer',
            ingredient_query: 'Hydrating barrier moisturizer',
            resolved_target_step: 'moisturizer',
            product_candidates: [
              { product_id: 'dry_pick_1', name: 'KraveBeauty Great Barrier Relief' },
              { product_id: 'blocked_pick', brand: 'Kylie Cosmetics', name: 'Hyaluronic Acid Serum' },
            ],
          },
        ],
        selected_target_ids: ['hydrating_barrier_moisturizer', 'daily_sunscreen'],
      },
    );
    payload.recommendation_meta.ranked_targets[0].product_candidates = [
      { product_id: 'dry_pick_1', name: 'KraveBeauty Great Barrier Relief' },
      { product_id: 'blocked_pick', brand: 'Kylie Cosmetics', name: 'Hyaluronic Acid Serum' },
    ];
    const prompt = __internal.buildRecoAssistantRewritePrompt({
      payload,
      language: 'EN',
      profile: { skinType: 'dry', goals: ['barrier support'] },
      userRequestText: 'My face feels dry and tight in winter. What should I buy?',
      retryReason: 'rewrite_mentions_unselected_product',
      compactContext: true,
      strictSelectedOnlyContext: true,
    });

    assert.match(prompt, /"prompt_profile":"strict_selected_only_retry"/);
    assert.match(prompt, /Strict selected-only retry: only Context\.selected_products may be named\./);
    assert.match(prompt, /Use no outside product memory; copy every named product exactly from Context\.selected_products\./);
    assert.match(prompt, /Never output Context\.forbidden_product_names or their partial names\/brands\./);
    assert.match(prompt, /"selected_products":\["KraveBeauty Great Barrier Relief","The Ordinary UV Filters SPF 45 Serum"\]/);
    assert.match(prompt, /"forbidden_product_names":\["Kylie Cosmetics Hyaluronic Acid Serum"\]/);
    assert.doesNotMatch(prompt, /framework_roles/);
    assert.doesNotMatch(prompt, /ranked_target_ids/);
    assert.ok(prompt.length < 5200);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite helper no longer requires base text before availability checks', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'GoalSkin Oil Control Serum',
            brand: 'GoalSkin',
            category: 'Serum',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Niacinamide',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Niacinamide',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'What product should I use first?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(rewrite.llm_used, false);
    assert.equal(rewrite.reason, 'rewrite_disabled');
    assert.equal(rewrite.text, '');
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite uses minimal thinking for gemini 3 structured output', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'GoalSkin Oil Control Serum',
            brand: 'GoalSkin',
            category: 'Serum',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    let capturedArgs = null;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      capturedArgs = args;
      return {
        ok: true,
        json: {
          assistant_text: 'GoalSkin Oil Control Serum is the product to buy first for oily skin as your oil-control treatment.',
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: args.model,
      };
    });

    assert.equal(
      __internal.normalizeRecoAssistantReasonFragment('it is the strongest choice for redness and sensitive skin', {
        fallback: 'it is a lightweight serum for redness and sensitive skin',
      }),
      'it is a lightweight serum for redness and sensitive skin',
    );
    assert.equal(
      __internal.normalizeRecoAssistantReasonFragment('it is the top pick because it supports barrier repair', {
        fallback: 'it supports barrier repair with tamanu oil and niacinamide',
      }),
      'it supports barrier repair',
    );

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'What product should I buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(capturedArgs?.thinkingLevel, 'minimal');
    assert.ok(capturedArgs?.queueTimeoutMs > 0);
    assert.ok(capturedArgs?.queueTimeoutMs < capturedArgs?.timeoutMs);
    assert.equal(capturedArgs?.upstreamTimeoutMs, capturedArgs.timeoutMs - capturedArgs.queueTimeoutMs);
    assert.equal(rewrite.llm_used, true);
    assert.match(String(rewrite.text || ''), /GoalSkin Oil Control Serum/);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite keeps minimal thinking for same-role use comparisons', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'barrier_pick_1',
            display_name: 'KraveBeauty Great Barrier Relief',
            brand: 'KraveBeauty',
            category: 'Serum',
            matched_role_id: 'barrier_moisturizer',
            role_scope: 'barrier_moisturizer',
          },
          {
            product_id: 'barrier_pick_2',
            display_name: 'Soothing Serum',
            brand: 'Haruharu Wonder',
            category: 'Serum',
            matched_role_id: 'barrier_moisturizer',
            role_scope: 'barrier_moisturizer',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'moisturizer',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Barrier moisturizer',
        resolved_target_step: 'moisturizer',
        primary_target_id: 'barrier_moisturizer',
        ranked_targets: [
          {
            target_id: 'barrier_moisturizer',
            ingredient_query: 'Barrier moisturizer',
            resolved_target_step: 'moisturizer',
          },
        ],
        selected_target_ids: ['barrier_moisturizer'],
      },
    );
    let capturedArgs = null;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      capturedArgs = args;
      return {
        ok: true,
        json: {
          assistant_text:
            'Start with KraveBeauty Great Barrier Relief because it gives barrier support without a heavy finish, while Soothing Serum is a lighter alternative.',
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: args.model,
      };
    });

    assert.equal(
      __internal.normalizeRecoAssistantReasonFragment('it gives the strongest choice signal for redness support'),
      'it gives the fit signal for redness support',
    );

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'sensitive', goals: ['barrier support'] },
      userRequestText: 'What should I use first for retinoid dryness?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(capturedArgs?.thinkingLevel, 'minimal');
    assert.ok(capturedArgs?.queueTimeoutMs > 0);
    assert.ok(capturedArgs?.upstreamTimeoutMs > 0);
    assert.equal(capturedArgs?.maxOutputTokens, 260);
    assert.equal(rewrite.llm_used, true);
    assert.match(String(rewrite.text || ''), /KraveBeauty Great Barrier Relief/);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite uses REST executor for same-role use comparisons with minimal thinking', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  const prevGeminiKey = process.env.AURORA_VISION_GEMINI_API_KEY;
  const prevAuroraSkinGeminiKey = process.env.AURORA_SKIN_GEMINI_API_KEY;
  const prevGlobalGeminiKey = process.env.GEMINI_API_KEY;
  const originalLoad = Module._load;
  let capturedUrl = '';
  let capturedBody = null;
  let capturedConfig = null;

  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  process.env.AURORA_VISION_GEMINI_API_KEY = 'test-gemini-key';
  process.env.AURORA_SKIN_GEMINI_API_KEY = 'test-gemini-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@google/genai') {
      throw new Error('Reco assistant rewrite should not use the Gemini SDK executor');
    }
    if (request === 'https') {
      return {
        request: (options = {}, onResponse) => {
          capturedUrl = `${options.protocol || 'https:'}//${options.hostname || ''}${options.path || ''}`;
          capturedConfig = options;
          const req = new EventEmitter();
          req.write = (chunk) => {
            capturedBody = JSON.parse(String(chunk || '{}'));
          };
          req.end = () => {
            process.nextTick(() => {
              const res = new EventEmitter();
              res.statusCode = 200;
              res.statusMessage = 'OK';
              res.setEncoding = () => {};
              onResponse(res);
              res.emit('data', JSON.stringify({
                candidates: [
                  {
                    finishReason: 'STOP',
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            assistant_text:
                              'Start with KraveBeauty Great Barrier Relief because it supports your barrier without a heavy finish, while Soothing Serum is a lighter same-step option.',
                          }),
                        },
                      ],
                    },
                  },
                ],
              }));
              res.emit('end');
            });
          };
          req.setTimeout = () => req;
          req.destroy = (err) => {
            if (err) req.emit('error', err);
          };
          return req;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'barrier_pick_1',
            display_name: 'KraveBeauty Great Barrier Relief',
            brand: 'KraveBeauty',
            category: 'Serum',
            matched_role_id: 'barrier_moisturizer',
            role_scope: 'barrier_moisturizer',
          },
          {
            product_id: 'barrier_pick_2',
            display_name: 'Soothing Serum',
            brand: 'Haruharu Wonder',
            category: 'Serum',
            matched_role_id: 'barrier_moisturizer',
            role_scope: 'barrier_moisturizer',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'moisturizer',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Barrier moisturizer',
        resolved_target_step: 'moisturizer',
        primary_target_id: 'barrier_moisturizer',
        ranked_targets: [
          {
            target_id: 'barrier_moisturizer',
            ingredient_query: 'Barrier moisturizer',
            resolved_target_step: 'moisturizer',
          },
        ],
        selected_target_ids: ['barrier_moisturizer'],
      },
    );

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'sensitive', goals: ['barrier support'] },
      userRequestText: 'What should I use first for retinoid dryness?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(rewrite.llm_used, true);
    assert.match(capturedUrl, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3-flash-preview:generateContent/);
    assert.equal(capturedConfig?.method, 'POST');
    assert.equal(capturedConfig?.headers?.['x-goog-api-key'], 'test-gemini-key');
    assert.equal(capturedConfig?.headers?.['content-type'], 'application/json');
    assert.ok(Number(capturedConfig?.timeout) > 0, 'REST executor should carry a native request timeout');
    assert.equal(capturedBody?.generationConfig?.thinkingConfig?.thinkingLevel, 'minimal');
    assert.equal(rewrite.attempts?.[0]?.thinking_level, 'minimal');
    assert.equal(rewrite.attempts?.[0]?.selection_source, 'local_gemini_rest_direct');
    assert.equal(rewrite.attempts?.[0]?.max_output_tokens, 260);
  } finally {
    Module._load = originalLoad;
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    if (prevGeminiKey === undefined) delete process.env.AURORA_VISION_GEMINI_API_KEY;
    else process.env.AURORA_VISION_GEMINI_API_KEY = prevGeminiKey;
    if (prevAuroraSkinGeminiKey === undefined) delete process.env.AURORA_SKIN_GEMINI_API_KEY;
    else process.env.AURORA_SKIN_GEMINI_API_KEY = prevAuroraSkinGeminiKey;
    if (prevGlobalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGlobalGeminiKey;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite recovers truncated raw json when assistant_text is recoverable', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'GoalSkin Oil Control Serum',
            brand: 'GoalSkin',
            category: 'Serum',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    __internal.__setCallGeminiJsonObjectForTest(async () => ({
      ok: false,
      reason: 'PARSE_TRUNCATED_JSON',
      raw_text:
        'Here is the JSON requested:\n{"assistant_text":"GoalSkin Oil Control Serum is the product to buy first for oily skin as your oil-control treatment to keep shine in check',
      parse_status: 'parse_truncated',
      provider: 'gemini',
      effective_model: 'gemini-3-flash-preview',
    }));

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'What product should I buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.equal(rewrite.parse_status, 'recovered_parse_truncated');
    assert.match(String(rewrite.text || ''), /GoalSkin Oil Control Serum/);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite accepts direct buy copy even when concern framing comes first', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'GoalSkin Oil Control Serum',
            brand: 'GoalSkin',
            category: 'Serum',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    __internal.__setCallGeminiJsonObjectForTest(async () => ({
      ok: true,
      json: {
        assistant_text:
          'For oily skin, I recommend buying GoalSkin Oil Control Serum because it helps manage visible shine without feeling heavy.',
      },
      parse_status: 'parsed',
      provider: 'gemini',
      effective_model: 'gemini-3-flash-preview',
    }));

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'What product should I buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.match(rewrite.text, /GoalSkin Oil Control Serum/);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite rejects candidate-pool product names that are not final visible cards', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'dark_spot_1',
            display_name: 'First Aid Beauty Dark Spot Serum with Niacinamide',
            brand: 'First Aid Beauty',
            category: 'Serum',
            short_description: 'A niacinamide serum for post-breakout dark spots and uneven tone.',
          },
          {
            product_id: 'dark_spot_2',
            display_name: 'Jurlique Brightening Serum',
            brand: 'Jurlique',
            category: 'Serum',
            short_description: 'A brightening serum for uneven tone support.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Tone and post-breakout mark treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'tone_mark_treatment',
        ranked_targets: [
          {
            target_id: 'tone_mark_treatment',
            ingredient_query: 'Tone and post-breakout mark treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['tone_mark_treatment'],
      },
    );
    payload.recommendation_meta.ranked_targets[0].product_candidates = [
      {
        product_id: 'dark_spot_1',
        brand: 'First Aid Beauty',
        name: 'Dark Spot Serum with Niacinamide',
      },
      {
        product_id: 'dark_spot_refill',
        brand: 'Fenty Beauty',
        name: 'Watch Ya Tone Niacinamide Dark Spot Serum Refill',
      },
      {
        product_id: 'dark_spot_2',
        brand: 'Jurlique',
        name: 'Brightening Serum',
      },
    ];
    const prompts = [];
    const schemas = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      schemas.push(args.responseSchema || null);
      if (callCount === 1) {
        return {
          ok: true,
          json: {
            assistant_text:
              'First Aid Beauty Dark Spot Serum with Niacinamide fits this request because it targets post-breakout marks. You could instead pick the Fenty Beauty Watch Ya Tone Refill for a lower-priced targeted treatment.',
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          lead_reason: 'Vitamin C (Ascorbic acid)',
          support_reasons: ['Oil-control support'],
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { goals: ['post-breakout marks'] },
      userRequestText: 'What should I buy for post-breakout marks?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.match(rewrite.text, /First Aid Beauty Dark Spot Serum with Niacinamide fits this request/);
    assert.match(rewrite.text, /because it is a niacinamide serum/);
    assert.doesNotMatch(rewrite.text, /because (A|An|The)\b/);
    assert.doesNotMatch(rewrite.text, /because (niacinamide|brightening|vitamin c|oil-control support|oil control support)\b/i);
    assert.match(rewrite.text, /Jurlique Brightening Serum/);
    assert.doesNotMatch(rewrite.text, /Fenty Beauty|Watch Ya Tone/);
    assert.match(prompts[1], /Do not write the final assistant message\./);
    assert.match(prompts[1], /Return evidence-grounded reason fragments only; the service will insert the final product names in card order\./);
    assert.match(prompts[1], /Schema: \{ "lead_reason": string, "support_reasons": string\[\] \}/);
    assert.equal(schemas[1]?.required?.includes('lead_reason'), true);
    assert.equal(schemas[1]?.required?.includes('support_reasons'), true);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant reason fragment strips duplicated renderer scaffolding', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const leadReason = __internal.normalizeRecoAssistantReasonFragment(
      'is your best first buy because it provides essential daily UV protection in a lightweight serum formula',
      { selectedNames: ['The Ordinary UV Filters SPF 45 Serum'] },
    );
    const supportReason = __internal.normalizeRecoAssistantReasonFragment(
      'follow with this multi-benefit serum designed to soothe, hydrate, and renew your skin barrier',
      { selectedNames: ['Haruharu Wonder Soothing Serum'] },
    );

    assert.equal(leadReason, 'it provides essential daily UV protection in a lightweight serum formula');
    assert.equal(supportReason, 'multi-benefit serum designed to soothe, hydrate, and renew your skin barrier');
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite uses structured retry for generic routine wrap-up', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'fab_gel_cream',
            display_name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
            brand: 'First Aid Beauty',
            category: 'Moisturizer',
            matched_role_id: 'layering_compatible_moisturizer_or_spf',
            matched_role_label: 'Layering-compatible moisturizer or SPF',
            short_description: 'An ultra-sheer, non-comedogenic gel cream that layers cleanly under makeup.',
          },
          {
            product_id: 'naturium_ha',
            display_name: 'Quadruple Hyaluronic Acid Serum 5% - Jumbo',
            brand: 'Naturium',
            category: 'Serum',
            matched_role_id: 'hydrating_serum_or_essence',
            matched_role_label: 'Hydrating serum or essence',
            short_description: 'A lightweight hyaluronic acid serum for dehydration support.',
          },
          {
            product_id: 'skintific_spf',
            display_name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
            brand: 'SKINTIFIC',
            category: 'Sunscreen',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            short_description: 'A matte SPF 50+ serum sunscreen for under-makeup daytime wear.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'moisturizer',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Layering-compatible moisturizer or SPF',
        resolved_target_step: 'moisturizer',
        primary_target_id: 'layering_compatible_moisturizer_or_spf',
        ranked_targets: [
          {
            target_id: 'layering_compatible_moisturizer_or_spf',
            ingredient_query: 'Layering-compatible moisturizer or SPF',
            resolved_target_step: 'moisturizer',
          },
          {
            target_id: 'hydrating_serum_or_essence',
            ingredient_query: 'Hydrating serum or essence',
            resolved_target_step: 'serum',
          },
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: [
          'layering_compatible_moisturizer_or_spf',
          'hydrating_serum_or_essence',
          'daily_sunscreen_finish_fit',
        ],
      },
    );
    const schemas = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      schemas.push(args.responseSchema || null);
      if (callCount === 1) {
        return {
          ok: true,
          json: {
            assistant_text: [
              'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides is a practical option for layering compatibility because it has an ultra-sheer, non-comedogenic gel-cream texture.',
              'Quadruple Hyaluronic Acid Serum 5% - Jumbo covers the hydrating serum step because it adds lightweight hydration.',
              'Matte Fit Serum Sunscreen SPF 50+ PA++++ covers daytime sunscreen because it protects with SPF 50.',
              'Together, these products support the routine and keep skin breathable.',
            ].join(' '),
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          lead_reason: 'features an ultra-sheer, non-comedogenic gel-cream texture for smoother layering',
          support_reasons: [
            'provides lightweight hyaluronic-acid hydration without changing the routine into a heavy layer',
            'gives matte SPF 50+ daytime protection for under-makeup wear',
          ],
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { goals: ['smooth layering'] },
      userRequestText: 'My makeup pills. What should I use?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.equal(schemas[1]?.required?.includes('lead_reason'), true);
    assert.match(rewrite.text, /Hydrating Dewy Gel Cream Moisturizer/);
    assert.match(rewrite.text, /because it (?:features|is) an ultra-sheer/);
    assert.match(rewrite.text, /because it (?:provides|is a) lightweight/);
    assert.match(rewrite.text, /because it (?:gives|is a matte SPF 50\+|leans more matte and shine-controlling if you want less slip under makeup)/);
    assert.match(rewrite.text, /Matte Fit Serum Sunscreen SPF 50\+ PA\+\+\+\+/);
    assert.doesNotMatch(rewrite.text, /because (features|provides|gives)\b/i);
    assert.doesNotMatch(rewrite.text, /Together, these products support/);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant structured retry normalizes function-as support grammar', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_pick',
            display_name: 'Daily Tinted Fluid Sunscreen DY300',
            brand: 'Beauty of Joseon',
            category: 'Sunscreen',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            short_description: 'SPF 40 protection in a tinted fluid for the final daytime step.',
          },
          {
            product_id: 'cream_pick',
            display_name: 'Dynasty Cream 10ml',
            brand: 'Beauty of Joseon',
            category: 'Moisturizer',
            matched_role_id: 'lightweight_moisturizer',
            matched_role_label: 'Lightweight moisturizer',
            short_description: 'A cream that sinks in for long-lasting hydration before sunscreen.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
          {
            target_id: 'lightweight_moisturizer',
            ingredient_query: 'Lightweight moisturizer',
            resolved_target_step: 'moisturizer',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit', 'lightweight_moisturizer'],
      },
    );
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          json: {
            assistant_text: [
              'Daily Tinted Fluid Sunscreen DY300 fits this request because it provides SPF 40 protection in a tinted fluid.',
              'Together, these products support the routine and keep skin breathable.',
            ].join(' '),
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          lead_reason: 'provides SPF 40 protection in a tinted fluid for the final daytime step',
          support_reasons: [
            'functions as a hydrating moisturizer step before sunscreen application before sunscreen application',
          ],
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['daily sunscreen'] },
      userRequestText: 'I need sunscreen under makeup in humid weather. What should I buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, true);
    assert.match(rewrite.text, /Dynasty Cream 10ml covers the moisturizer step because it functions as a hydrating moisturizer step before sunscreen application\./);
    assert.doesNotMatch(rewrite.text, /because functions\b/i);
    assert.doesNotMatch(rewrite.text, /before sunscreen application before sunscreen application/i);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant structured retry does not render without valid JSON', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'fab_gel_cream',
            display_name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
            brand: 'First Aid Beauty',
            category: 'Moisturizer',
            matched_role_id: 'layering_compatible_moisturizer_or_spf',
            matched_role_label: 'Layering-compatible moisturizer or SPF',
            short_description: 'An ultra-sheer, non-comedogenic gel cream that layers cleanly under makeup.',
          },
          {
            product_id: 'skintific_spf',
            display_name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
            brand: 'SKINTIFIC',
            category: 'Sunscreen',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            short_description: 'A matte SPF 50+ serum sunscreen for under-makeup daytime wear.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'moisturizer',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Layering-compatible moisturizer or SPF',
        resolved_target_step: 'moisturizer',
        primary_target_id: 'layering_compatible_moisturizer_or_spf',
        ranked_targets: [
          {
            target_id: 'layering_compatible_moisturizer_or_spf',
            ingredient_query: 'Layering-compatible moisturizer or SPF',
            resolved_target_step: 'moisturizer',
          },
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: ['layering_compatible_moisturizer_or_spf', 'daily_sunscreen_finish_fit'],
      },
    );
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          json: {
            assistant_text: [
              'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides is a practical option for layering compatibility because it has an ultra-sheer gel-cream texture.',
              'Together, these products support the routine and keep skin breathable.',
            ].join(' '),
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: false,
        reason: 'GEMINI_JSON_TIMEOUT',
        json: null,
        parse_status: null,
        timeout_stage: 'upstream',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { goals: ['smooth layering'] },
      userRequestText: 'My makeup pills. What should I use?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, false);
    assert.equal(rewrite.reason, 'GEMINI_JSON_TIMEOUT');
    assert.equal(rewrite.text, '');
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant structured retry does not treat selected product-name substrings as unselected aliases', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'naturium_ha_jumbo',
            display_name: 'Naturium Quadruple Hyaluronic Acid Serum 5% - Jumbo',
            brand: 'Naturium',
            category: 'Serum',
            short_description: 'A hydrating hyaluronic acid serum for dehydration support.',
            matched_role_id: 'hydrating_serum_or_essence',
            matched_role_label: 'Hydrating serum or essence',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'serum',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Hydrating serum or essence',
        resolved_target_step: 'serum',
        primary_target_id: 'hydrating_serum_or_essence',
        ranked_targets: [
          {
            target_id: 'hydrating_serum_or_essence',
            ingredient_query: 'Hydrating serum or essence',
            resolved_target_step: 'serum',
          },
        ],
        selected_target_ids: ['hydrating_serum_or_essence'],
      },
    );
    payload.recommendation_meta.ranked_targets[0].product_candidates = [
      {
        product_id: 'naturium_ha_jumbo',
        brand: 'Naturium',
        name: 'Quadruple Hyaluronic Acid Serum 5% - Jumbo',
      },
      {
        product_id: 'kylie_ha_serum',
        brand: 'Kylie Cosmetics',
        name: 'Hyaluronic Acid Serum',
      },
    ];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          json: {
            assistant_text:
              'Naturium Quadruple Hyaluronic Acid Serum 5% - Jumbo fits this request for hydration, while Kylie Cosmetics Hyaluronic Acid Serum is the backup option.',
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          lead_reason: 'hydration support from the selected hyaluronic acid serum evidence',
          support_reasons: [],
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'dry', goals: ['hydration'] },
      userRequestText: 'My skin is dehydrated. What serum should I buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.match(rewrite.text, /Naturium Quadruple Hyaluronic Acid Serum 5% - Jumbo/);
    assert.doesNotMatch(rewrite.text, /Kylie Cosmetics/);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite rejects single-direction buy copy that adds future routine filler', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'GoalSkin Oil Control Serum',
            brand: 'GoalSkin',
            category: 'Serum',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    __internal.__setCallGeminiJsonObjectForTest(async () => ({
      ok: true,
      json: {
        assistant_text:
          'Buy GoalSkin Oil Control Serum for oily skin. You may eventually want to look for a lightweight moisturizer and a daily sunscreen later on.',
      },
      parse_status: 'parsed',
      provider: 'gemini',
      effective_model: 'gemini-3-flash-preview',
    }));

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'What product should I buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(rewrite.llm_used, false);
    assert.equal(rewrite.reason, 'rewrite_buy_addon_filler');
    assert.equal(rewrite.text, '');
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite accepts direct buy copy with shopper-facing oil-control semantics', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'GoalSkin Oil Control Serum',
            brand: 'GoalSkin',
            category: 'Serum',
            short_description: 'Helps reduce visible shine without feeling heavy.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    __internal.__setCallGeminiJsonObjectForTest(async () => ({
      ok: true,
      json: {
        assistant_text:
          'Buy GoalSkin Oil Control Serum for oily skin. It targets excess shine without adding heaviness.',
      },
      parse_status: 'parsed',
      provider: 'gemini',
      effective_model: 'gemini-3-flash-preview',
    }));

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'What product should I buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.equal(
      rewrite.text,
      'Buy GoalSkin Oil Control Serum for oily skin. It targets excess shine without adding heaviness. What city or climate are you usually in (humid, dry, cold, or high-UV)?',
    );
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite accepts product-first buy copy with recommendation semantics', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'GoalSkin Oil Control Serum',
            brand: 'GoalSkin',
            category: 'Serum',
            short_description: 'Helps reduce visible shine without feeling heavy.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    __internal.__setCallGeminiJsonObjectForTest(async () => ({
      ok: true,
      json: {
        assistant_text:
          'GoalSkin Oil Control Serum fits this request for oily skin. It targets excess shine without adding heaviness.',
      },
      parse_status: 'parsed',
      provider: 'gemini',
      effective_model: 'gemini-3-flash-preview',
    }));

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'What product should I buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.equal(
      rewrite.text,
      'GoalSkin Oil Control Serum fits this request for oily skin. It targets excess shine without adding heaviness. What city or climate are you usually in (humid, dry, cold, or high-UV)?',
    );
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite accepts buy drafts that directly name the product after a concern opener', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'GoalSkin Oil Control Serum',
            brand: 'GoalSkin',
            category: 'Serum',
            short_description: 'Helps reduce visible shine without feeling heavy.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    const prompts = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      if (callCount === 1) {
        return {
          ok: true,
          json: {
            assistant_text:
              'To manage oily skin and shine, buy GoalSkin Oil Control Serum first. It helps reduce visible shine without feeling heavy.',
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          assistant_text:
            'GoalSkin Oil Control Serum is the product to buy first for oily skin. It helps reduce visible shine without feeling heavy.',
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'What product should I buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 1);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.equal(
      rewrite.text,
      'To manage oily skin and shine, buy GoalSkin Oil Control Serum first. It helps reduce visible shine without feeling heavy. What city or climate are you usually in (humid, dry, cold, or high-UV)?',
    );
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite accepts routine-mix buy copy when the first sentence directly names the lead product', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            brand: 'The Ordinary',
            category: 'Serum',
            short_description: 'A lightweight oil-control serum for visible shine.',
            price: { amount: 12, currency: 'USD', unknown: false },
            matched_role_id: 'oil_control_treatment',
            matched_role_label: 'Oil-control treatment',
          },
          {
            product_id: 'routine_support_1',
            display_name: 'LightLab Oil-Free Gel Cream',
            brand: 'LightLab',
            category: 'Moisturizer',
            short_description: 'A lightweight gel cream moisturizer for oily skin.',
            price: { amount: 28, currency: 'USD', unknown: false },
            matched_role_id: 'lightweight_moisturizer',
            matched_role_label: 'Lightweight moisturizer',
          },
        ],
        roles: [
          {
            role_id: 'oil_control_treatment',
            label: 'Oil-control treatment',
            preferred_step: 'treatment',
            why_this_role: 'Reduce excess sebum.',
          },
          {
            role_id: 'lightweight_moisturizer',
            label: 'Lightweight moisturizer',
            preferred_step: 'moisturizer',
            why_this_role: 'Support barrier without heaviness.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment', 'lightweight_moisturizer'],
      },
    );
    const prompts = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      if (callCount === 1) {
        return {
          ok: true,
          json: {
            assistant_text:
              'For oily, acne-prone skin, buy The Ordinary Niacinamide 10% + Zinc 1% first. Then add LightLab Oil-Free Gel Cream for lightweight hydration.',
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          assistant_text:
            'The Ordinary Niacinamide 10% + Zinc 1% fits this request for oily, acne-prone skin because it directly targets excess oil and visible shine at a $12 price point. LightLab Oil-Free Gel Cream is the lightweight moisturizer step that adds breathable hydration without heaviness.',
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'What product should I buy for oily, acne-prone skin?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 1);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.match(prompts[0], /"prompt_profile":"strict_selected_only_retry"/);
    assert.match(rewrite.text, /The Ordinary Niacinamide 10% \+ Zinc 1%/);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite retries single-product drafts that drift into routine framing', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'barrier_pick_1',
            display_name: 'KraveBeauty Great Barrier Relief',
            brand: 'KraveBeauty',
            category: 'Serum',
            short_description: 'Barrier-support serum with tamanu oil, niacinamide, and ceramides.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'moisturizer',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Barrier moisturizer',
        resolved_target_step: 'moisturizer',
        primary_target_id: 'barrier_moisturizer',
        ranked_targets: [
          {
            target_id: 'barrier_moisturizer',
            ingredient_query: 'Barrier moisturizer',
            resolved_target_step: 'moisturizer',
          },
        ],
        selected_target_ids: ['barrier_moisturizer'],
      },
    );
    const prompts = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      if (callCount === 1) {
        return {
          ok: true,
          json: {
          assistant_text:
              'KraveBeauty Great Barrier Relief fits this request for barrier repair. To build out a full routine later, add a soothing serum and a daily sunscreen.',
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          assistant_text:
            'KraveBeauty Great Barrier Relief is the one product to buy first for barrier support. Its tamanu oil, niacinamide, and ceramides directly target a stripped, irritated barrier without turning this into a multi-step routine.',
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'sensitive', goals: ['barrier support'] },
      userRequestText: 'What should I buy first for redness and barrier support?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.match(prompts[1], /Fix required: Do not turn a single-product answer into a routine or multi-step plan\./);
    assert.doesNotMatch(String(rewrite.text || ''), /build out a full routine/i);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite retries routine drafts that use stiff selected-products framing', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            brand: 'The Ordinary',
            category: 'Serum',
            short_description: 'A lightweight oil-control serum for visible shine.',
            price: { amount: 12, currency: 'USD', unknown: false },
            matched_role_id: 'oil_control_treatment',
            matched_role_label: 'Oil-control treatment',
            key_features: ['Niacinamide 10%', 'Zinc 1%'],
          },
          {
            product_id: 'routine_support_1',
            display_name: 'LightLab Oil-Free Gel Cream',
            brand: 'LightLab',
            category: 'Moisturizer',
            short_description: 'A breathable gel moisturizer for oily skin.',
            price: { amount: 28, currency: 'USD', unknown: false },
            matched_role_id: 'lightweight_moisturizer',
            matched_role_label: 'Lightweight moisturizer',
          },
        ],
        roles: [
          {
            role_id: 'oil_control_treatment',
            label: 'Oil-control treatment',
            preferred_step: 'treatment',
            why_this_role: 'Reduce excess sebum.',
          },
          {
            role_id: 'lightweight_moisturizer',
            label: 'Lightweight moisturizer',
            preferred_step: 'moisturizer',
            why_this_role: 'Support barrier without heaviness.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment', 'lightweight_moisturizer'],
      },
    );
    const prompts = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      if (callCount === 1) {
        return {
          ok: true,
          json: {
          assistant_text:
            'The Ordinary Niacinamide 10% + Zinc 1% fits this request because it pairs niacinamide with zinc and costs $12. These selected products are different steps in a basic routine and not the same type of product. LightLab Oil-Free Gel Cream is your lightweight moisturizer step for breathable hydration.',
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          assistant_text:
            'The Ordinary Niacinamide 10% + Zinc 1% fits this request because it pairs niacinamide with zinc and costs $12. These are different routine steps, not substitutes: LightLab Oil-Free Gel Cream is the lightweight moisturizer step for breathable hydration.',
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'im oily skin. what product should i buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.match(prompts[1], /Fix required: Replace stiff meta phrasing like "selected products"/);
    assert.doesNotMatch(String(rewrite.text || ''), /these selected products/i);
    assert.match(String(rewrite.text || ''), /These are different routine steps, not substitutes/i);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite uses structured reason retry for repeated buy framing in routine mix', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'layering_pick_1',
            display_name: 'Beauty of Joseon Dynasty Cream 10ml',
            brand: 'Beauty of Joseon',
            category: 'Moisturizer',
            short_description: 'A lightweight moisturizer cream for comfortable layering under makeup.',
            price: { amount: 3.75, currency: 'USD', unknown: false },
            matched_role_id: 'layering_compatible_moisturizer_or_spf',
            matched_role_label: 'Layering-compatible moisturizer or SPF',
          },
          {
            product_id: 'soothing_pick_1',
            display_name: 'Winona Soothing Repair Serum',
            brand: 'Winona',
            category: 'Serum',
            short_description: 'A lightweight soothing serum for redness and sensitive skin.',
            price: { amount: 1.69, currency: 'USD', unknown: false },
            matched_role_id: 'soothing_treatment',
            matched_role_label: 'Soothing treatment',
          },
          {
            product_id: 'barrier_pick_1',
            display_name: 'KraveBeauty Great Barrier Relief',
            brand: 'KraveBeauty',
            category: 'Moisturizer',
            short_description: 'A barrier-support moisturizer with tamanu oil and niacinamide.',
            price: { amount: 28, currency: 'USD', unknown: false },
            matched_role_id: 'barrier_moisturizer',
            matched_role_label: 'Barrier-support moisturizer',
          },
        ],
        roles: [
          {
            role_id: 'layering_compatible_moisturizer_or_spf',
            label: 'Layering-compatible moisturizer or SPF',
            preferred_step: 'moisturizer',
            why_this_role: 'Reduce makeup pilling with a lighter daytime layer.',
          },
          {
            role_id: 'soothing_treatment',
            label: 'Soothing treatment',
            preferred_step: 'serum',
            why_this_role: 'Calm redness and sensitivity.',
          },
          {
            role_id: 'barrier_moisturizer',
            label: 'Barrier-support moisturizer',
            preferred_step: 'moisturizer',
            why_this_role: 'Support an impaired barrier without retinoid-active moisturizer drift.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'moisturizer',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Layering-compatible moisturizer',
        resolved_target_step: 'moisturizer',
        primary_target_id: 'layering_compatible_moisturizer_or_spf',
        ranked_targets: [
          {
            target_id: 'layering_compatible_moisturizer_or_spf',
            ingredient_query: 'Layering-compatible moisturizer',
            resolved_target_step: 'moisturizer',
          },
        ],
        selected_target_ids: [
          'layering_compatible_moisturizer_or_spf',
          'soothing_treatment',
          'barrier_moisturizer',
        ],
      },
    );
    const prompts = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      if (callCount === 1) {
        return {
          ok: true,
          json: {
            assistant_text:
              'Beauty of Joseon Dynasty Cream 10ml is the most direct fit because it is lightweight under makeup. Winona Soothing Repair Serum is the top pick for calming redness, while KraveBeauty Great Barrier Relief is the strongest choice for barrier support.',
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          lead_reason: 'it is the top pick because it is a lightweight moisturizer for comfortable makeup layering',
          support_reasons: [
            'it is the strongest choice for redness and sensitive skin',
            'it is the top option because it supports barrier repair with tamanu oil and niacinamide',
          ],
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'combination', sensitivity: 'high', goals: ['smooth layering', 'barrier support'] },
      userRequestText: 'My daytime routine pills under makeup. What product should I buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.match(prompts[1], /Return evidence-grounded reason fragments only/i);
    assert.match(prompts[1], /Fix required: Use calibrated wording/i);
    assert.match(String(rewrite.text || ''), /Beauty of Joseon Dynasty Cream 10ml fits this request/i);
    assert.match(String(rewrite.text || ''), /Winona Soothing Repair Serum covers the serum step/i);
    assert.match(String(rewrite.text || ''), /KraveBeauty Great Barrier Relief covers the moisturizer step/i);
    assert.match(String(rewrite.text || ''), /What city or climate are you usually in \(humid, dry, cold, or high-UV\)\?/i);
    assert.equal(rewrite.refinement_question?.field, 'location_climate');
    assert.doesNotMatch(String(rewrite.text || ''), /top pick|strongest choice|most direct fit/i);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant structured retry keeps support reasons on support roles', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_pick_1',
            display_name: 'Daily Layering SPF 50',
            brand: 'Murad',
            category: 'Sunscreen',
            short_description: 'A daily SPF 50 moisturizer format that can reduce heavy layering.',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
          },
          {
            product_id: 'serum_pick_1',
            display_name: 'Truth Serum',
            brand: 'Olehenriksen',
            category: 'Serum',
            short_description: 'A lightweight hydrating serum to use before SPF.',
            matched_role_id: 'hydrating_serum_or_essence',
            matched_role_label: 'Hydrating serum or essence',
          },
        ],
        roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            role_id: 'hydrating_serum_or_essence',
            label: 'Hydrating serum or essence',
            preferred_step: 'serum',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
          {
            target_id: 'hydrating_serum_or_essence',
            ingredient_query: 'Hydrating serum or essence',
            resolved_target_step: 'serum',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit', 'hydrating_serum_or_essence'],
      },
    );
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          json: {
            assistant_text:
              'Daily Layering SPF 50 fits this request because it simplifies the morning SPF step. Together these different steps support your routine.',
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          lead_reason: 'it provides SPF 50 protection in a moisturizer format that reduces heavy layering',
          support_reasons: ['it directly fits the daily sunscreen with finish fit request'],
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'combination', goals: ['makeup layering'] },
      userRequestText: 'My daytime routine pills under makeup. What product should I use?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, true);
    assert.doesNotMatch(String(rewrite.text || ''), /Truth Serum[^.]+directly fits the daily sunscreen/i);
    assert.match(String(rewrite.text || ''), /Truth Serum covers the serum step because it is a lightweight hydrating serum to use before SPF/i);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant structured renderer treats product texture as product evidence', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_pick_1',
            display_name: 'Superactive Moisturizer SPF 50: Hydrating',
            brand: 'Murad',
            category: 'Sunscreen',
            short_description: 'Daily moisturizer with SPF 50 and a hydration-first angle.',
            why_this_one: 'Frames this as a moisturizer-and-SPF step rather than a standalone sunscreen texture.',
            best_for: 'Best for Daily SPF routines',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
      },
    );
    const names = ['Superactive Moisturizer SPF 50: Hydrating'];
    const primaryTarget = payload.recommendation_meta.ranked_targets[0];
    const text = __internal.renderRecoAssistantStructuredReasonRewrite({
      structuredReason: { lead_reason: '', support_reasons: [] },
      payload,
      language: 'EN',
      primaryTarget,
      names,
      requestMode: 'buy',
      selectedProductRoleMix: 'single_product',
    });
    const validation = __internal.validateRecoAssistantRewriteCandidate({
      candidateText: text,
      payload,
      language: 'EN',
      primaryTarget,
      secondaryTargets: [],
      names,
      requestMode: 'buy',
    });

    assert.match(text, /because it frames this as a moisturizer-and-SPF step rather than a standalone sunscreen texture/i);
    assert.doesNotMatch(text, /because frames/i);
    assert.equal(validation.ok, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant structured renderer replaces tautological lead reasons with product evidence', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'fenty_spf_pick',
            display_name: 'Hydra Vizor Invisible Moisturizer SPF 30',
            brand: 'Fenty Beauty',
            category: 'Sunscreen',
            short_description: 'A daily invisible moisturizer with SPF 30 that layers under makeup.',
            why_this_one: 'Uses SPF 30, niacinamide, hyaluronic acid, and an invisible finish designed for all skin tones.',
            key_features: ['SPF 30', 'Niacinamide', 'Hyaluronic acid'],
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
      },
    );
    const names = ['Hydra Vizor Invisible Moisturizer SPF 30'];
    const primaryTarget = payload.recommendation_meta.ranked_targets[0];
    const text = __internal.renderRecoAssistantStructuredReasonRewrite({
      structuredReason: {
        lead_reason: 'it directly fits the daily sunscreen with finish fit request',
        support_reasons: [],
      },
      payload,
      language: 'EN',
      primaryTarget,
      names,
      requestMode: 'buy',
      selectedProductRoleMix: 'single_product',
    });
    const validation = __internal.validateRecoAssistantRewriteCandidate({
      candidateText: text,
      payload,
      language: 'EN',
      primaryTarget,
      secondaryTargets: [],
      names,
      requestMode: 'buy',
    });

    assert.doesNotMatch(text, /directly fits[^.]+request/i);
    assert.doesNotMatch(text, /matches the selected card evidence/i);
    assert.match(text, /SPF 30/i);
    assert.match(text, /niacinamide|hyaluronic acid|invisible|makeup/i);
    assert.equal(validation.ok, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant structured renderer compares finish-fit sunscreen options with wear and texture tradeoffs', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_unseen',
            display_name: 'Unseen Sunscreen SPF 50',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A daily sunscreen built around soft-focus powders for comfortable daytime layering under makeup.',
            why_this_one: 'Uses modern organic UV-filter cues for a daily sunscreen step while keeping reapplication expectations explicit.',
            key_features: ['SPF 50'],
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_mineral_unseen',
            display_name: 'Mineral Unseen Sunscreen SPF 40',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A sheer, weightless, scentless mineral sunscreen recommended for sensitive skin.',
            why_this_one: 'Uses mineral UV-filter cues for shoppers who need a daily sunscreen step with clear filter identity.',
            key_features: ['Zinc PCA', 'Glycerin'],
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_superscreen',
            display_name: 'Superscreen Hydrating Daily Cream SPF 40',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A hydrating daily cream SPF with moisturizer-style hydration cues.',
            why_this_one: 'Combines daily SPF use with moisturizer-style hydration cues, so it should be judged on both sun-care use and daytime skin comfort.',
            key_features: ['Ceramide NP', 'Glycerin'],
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
            why_this_role: 'Use a daily sunscreen that layers cleanly under makeup.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
      },
    );
    const names = [
      'Unseen Sunscreen SPF 50',
      'Mineral Unseen Sunscreen SPF 40',
      'Superscreen Hydrating Daily Cream SPF 40',
    ];
    const primaryTarget = payload.recommendation_meta.ranked_targets[0];
    const text = __internal.renderRecoAssistantStructuredReasonRewrite({
      structuredReason: { lead_reason: '', support_reasons: [] },
      payload,
      language: 'EN',
      primaryTarget,
      names,
      requestMode: 'buy',
      selectedProductRoleMix: 'same_role_comparison',
    });
    const validation = __internal.validateRecoAssistantRewriteCandidate({
      candidateText: text,
      payload,
      language: 'EN',
      primaryTarget,
      secondaryTargets: [],
      names,
      requestMode: 'buy',
    });

    assert.match(text, /lighter, smoother daytime layering instead of a richer cream finish|keeps the finish lighter and smoother under makeup if you want a less heavy daytime layer|keeps the finish lighter and smoother under makeup for easier daytime wear/i);
    assert.match(text, /(?:so it stays between the (?:more mineral-leaning|richer, more moisturizing) option and the (?:more mineral-leaning|richer, more moisturizing) option|instead of leaning toward the (?:more mineral-leaning|richer, more moisturizing) option)/i);
    assert.match(text, /(?:makes more sense if you want a more mineral, sensitive-skin-friendly option with a sheer, weightless finish|leans more mineral and sensitive-skin-friendly if you want a sheer, weightless finish|gives a more mineral, sensitive-skin-oriented option)/i);
    assert.match(text, /(?:makes more sense if you want a richer, more moisturizing feel with more cushion under makeup|richer, more moisturizing cream-spf option|leans richer and more moisturizing if you want more cushion under makeup)/i);
    assert.doesNotMatch(text, /uv-filter cues|filter identity|reapplication expectations explicit/i);
    assert.doesNotMatch(text, /sheer, weightless, scentless mineral sunscreen recommended/i);
    assert.doesNotMatch(text, /hydrating daily cream spf with moisturizer-style hydration cues/i);
    assert.doesNotMatch(text, /daily sunscreen with finish fit/i);
    assert.doesNotMatch(text, /(?:doubles?|acts?|works?|serves?) as (?:an? )?primer/i);
    assert.match(text, /wears more smoothly under makeup|under makeup/i);
    assert.equal(validation.ok, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant structured renderer strips legacy uv-protection fragments and comma-tail uv residue from finish-fit compare copy', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_matte',
            display_name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
            brand: 'SKINTIFIC',
            category: 'Sunscreen',
            short_description: 'Protect your skin from UVA, UVB, and blue light with Matte Fit Serum Sunscreen SPF 50+ PA++++.',
            why_this_one: 'it leans more matte and shine-controlling if you want less slip under makeup, UVB, and blue light',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
      },
    );
    const names = ['Matte Fit Serum Sunscreen SPF 50+ PA++++'];
    const primaryTarget = payload.recommendation_meta.ranked_targets[0];
    const text = __internal.renderRecoAssistantStructuredReasonRewrite({
      structuredReason: { lead_reason: '', support_reasons: [] },
      payload,
      language: 'EN',
      primaryTarget,
      names,
      requestMode: 'buy',
      selectedProductRoleMix: 'single_product',
    });

    assert.match(text, /less slip under makeup/i);
    assert.doesNotMatch(text, /under makeupagainst/i);
    assert.doesNotMatch(text, /UVA, UVB, and blue light/i);
    assert.doesNotMatch(text, /under makeup,\s*UVB/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant visible-text sanitizer rewrites leaked same-slot finish-fit phrasing and fixes token glue', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const text = __internal.sanitizeRecoAssistantVisibleText(
      'Beauty of Joseon Day Dew Sunscreen is the same-slot comparison option because it leans fresher and dewier if you want a bit more hydration without a heavier cream feel. SKINTIFIC Light Serum Sunscreen SPF 50+ PA++++ is the same-slot comparison option because it keeps the feel lighter and more invisible if you want less weight under makeupa serum texture.',
    );

    assert.match(text, /Beauty of Joseon Day Dew Sunscreen makes more sense if you want a fresher, dewier finish/i);
    assert.match(text, /SKINTIFIC Light Serum Sunscreen SPF 50\+ PA\+\+\+\+ makes more sense if you want the lightest, least noticeable sunscreen layer/i);
    assert.doesNotMatch(text, /same-slot comparison option because/i);
    assert.doesNotMatch(text, /under makeupa/i);
    assert.doesNotMatch(text, /under makeup a serum texture/i);

    const finishFitText = __internal.sanitizeRecoAssistantVisibleText(
      'SKINTIFIC Matte Fit Serum Sunscreen SPF 50+ PA++++ makes more sense if you want a more matte, shine-controlling finish with less slip under makeup a serum texture that helps manage excess oil throughout the day. Beauty of Joseon Day Dew Sunscreen gives less slip under makeup protection.',
    );
    assert.match(finishFitText, /less slip under makeup\./i);
    assert.doesNotMatch(finishFitText, /under makeup a serum texture/i);
    assert.doesNotMatch(finishFitText, /under makeup protection/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty expert v1 v1-chat attach preserves incoming exact-product beauty context', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const options = __internal.buildBeautyExpertV1ChatAttachOptions({
      req: {
        body: {
          message: 'I use tretinoin. Is Ultra Repair Face Lotion a better next moisturizer than a peptide cream?',
          context: {
            normalized_need: {
              existing_marker: 'keep-me',
              beauty_request: {
                user_goal: 'compare Ultra Repair Face Lotion for tretinoin routine',
                skin_context: { skin_type: 'dry' },
                routine_context: { current_active: 'tretinoin' },
                product_context: {
                  canonical_product_ref: 'First Aid Beauty Ultra Repair Face Lotion',
                  anchor_product_id: 'fab-ultra-repair-face-lotion',
                },
              },
            },
          },
        },
      },
      profile: { skinType: 'dry sensitive', goals: ['barrier support'] },
    });

    const normalizedNeed = options.context.normalized_need;
    const beautyRequest = normalizedNeed.beauty_request;
    assert.equal(normalizedNeed.existing_marker, 'keep-me');
    assert.equal(beautyRequest.domain, 'beauty');
    assert.equal(beautyRequest.user_goal, 'compare Ultra Repair Face Lotion for tretinoin routine');
    assert.equal(beautyRequest.product_context.canonical_product_ref, 'First Aid Beauty Ultra Repair Face Lotion');
    assert.equal(beautyRequest.product_context.anchor_product_id, 'fab-ultra-repair-face-lotion');
    assert.equal(beautyRequest.routine_context.current_active, 'tretinoin');
    assert.equal(beautyRequest.skin_context.skin_type, 'dry sensitive');
    assert.deepEqual(beautyRequest.skin_context.goals, ['barrier support']);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant validator rejects unsupported primer-equivalence claims for finish-fit sunscreen copy', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_unseen',
            display_name: 'Unseen Sunscreen SPF 50',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A weightless sunscreen with soft-focus wear for smoother daytime layering under makeup.',
            why_this_one: 'it points to lighter, smoother daytime layering instead of a richer cream finish',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
            why_this_role: 'Use a daily sunscreen that layers cleanly under makeup.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
      },
    );
    const primaryTarget = payload.recommendation_meta.ranked_targets[0];
    const validation = __internal.validateRecoAssistantRewriteCandidate({
      candidateText: 'Unseen Sunscreen SPF 50 fits this request because it is a weightless, scentless formula that doubles as a primer to support smoother daytime layering under makeup.',
      payload,
      language: 'EN',
      primaryTarget,
      secondaryTargets: [],
      names: ['Unseen Sunscreen SPF 50'],
      requestMode: 'buy',
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.reason, 'rewrite_unsupported_primer_equivalence');
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant structured renderer downgrades primer-equivalence wording into under-makeup wear language', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_unseen',
            display_name: 'Unseen Sunscreen SPF 50',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A weightless sunscreen with soft-focus wear for smoother daytime layering under makeup.',
            why_this_one: 'it points to lighter, smoother daytime layering instead of a richer cream finish',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
            why_this_role: 'Use a daily sunscreen that layers cleanly under makeup.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
      },
    );
    const primaryTarget = payload.recommendation_meta.ranked_targets[0];
    const text = __internal.renderRecoAssistantStructuredReasonRewrite({
      structuredReason: {
        lead_reason: 'it is a weightless, scentless formula that doubles as a primer to support smoother daytime layering under makeup',
        support_reasons: [],
      },
      payload,
      language: 'EN',
      primaryTarget,
      names: ['Unseen Sunscreen SPF 50'],
      requestMode: 'buy',
      selectedProductRoleMix: 'single_product',
    });
    const validation = __internal.validateRecoAssistantRewriteCandidate({
      candidateText: text,
      payload,
      language: 'EN',
      primaryTarget,
      secondaryTargets: [],
      names: ['Unseen Sunscreen SPF 50'],
      requestMode: 'buy',
    });

    assert.doesNotMatch(text, /(?:doubles?|acts?|works?|serves?) as (?:an? )?primer/i);
    assert.match(text, /smoother (?:daytime )?layering under makeup|under-makeup wear|under makeup/i);
    assert.equal(validation.ok, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant structured renderer removes generic SPF utility tails from finish-fit tradeoff copy', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_unseen',
            display_name: 'Unseen Sunscreen SPF 50',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A weightless sunscreen with soft-focus wear for smoother daytime layering under makeup.',
            why_this_one: 'it points to lighter, smoother daytime layering instead of a richer cream finish',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_milk',
            display_name: 'Hydrating Sunscreen Milk with Colloidal Oatmeal Broad Spectrum SPF 45',
            brand: 'First Aid Beauty',
            category: 'Sunscreen',
            short_description: 'Leans richer and more moisturizing if you want more cushion under makeup.',
            why_this_one: 'it leans richer and more moisturizing if you want more cushion under makeup',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
            why_this_role: 'Use a daily sunscreen that layers cleanly under makeup.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
      },
    );
    const primaryTarget = payload.recommendation_meta.ranked_targets[0];
    const text = __internal.renderRecoAssistantStructuredReasonRewrite({
      structuredReason: {
        lead_reason: 'it features a weightless, invisible finish and is specifically suited for lighter daytime layering to prevent pilling',
        support_reasons: ['it provides a richer, more moisturizing cream-based option for those needing extra hydration during AM UV protection'],
      },
      payload,
      language: 'EN',
      primaryTarget,
      names: [
        'Unseen Sunscreen SPF 50',
        'Hydrating Sunscreen Milk with Colloidal Oatmeal Broad Spectrum SPF 45',
      ],
      requestMode: 'buy',
      selectedProductRoleMix: 'same_role_comparison',
    });

    assert.doesNotMatch(text, /AM UV protection|daily protection/i);
    assert.match(text, /help reduce pilling|lighter for daytime layering/i);
    assert.match(text, /(?:if you want a richer, more moisturizing feel with more cushion under makeup|if you want more (?:moisture|cushion) under makeup)/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite uses structured primary attempt for compact single-product cases', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_pick_1',
            display_name: 'Daily Layering SPF 50',
            brand: 'Murad',
            category: 'Sunscreen',
            short_description: 'A daily SPF 50 moisturizer format that reduces heavy layering.',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
      },
    );
    const prompts = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      return {
        ok: true,
        json: {
          lead_reason: 'it gives SPF 50 coverage in a moisturizer format that reduces heavy morning layering',
          support_reasons: [],
        },
        parse_status: 'parsed',
        meta: { gate_wait_ms: 0, upstream_ms: 120, total_ms: 120 },
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'combination', goals: ['makeup layering'] },
      userRequestText: 'My daytime routine pills under makeup. What sunscreen should I buy?',
      allowLockedSelectionRewrite: true,
      deadlineAtMs: Date.now() + 5000,
    });

    assert.equal(callCount, 1);
    assert.match(prompts[0], /Do not write the final assistant message/);
    assert.match(prompts[0], /Schema: \{ "lead_reason": string, "support_reasons": string\[\] \}/);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.attempts?.[0]?.structured_reason_only, true);
    assert.equal(rewrite.attempts?.[0]?.strict_selected_only_context, true);
    assert.equal(rewrite.attempts?.[0]?.max_output_tokens, 140);
    assert.match(rewrite.text, /Daily Layering SPF 50 fits this request/i);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite uses structured primary attempt for compact routine mixes', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oil_pick',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            brand: 'The Ordinary',
            category: 'Serum',
            short_description: 'A niacinamide and zinc serum for oily skin and visible shine.',
            matched_role_id: 'oil_control_treatment',
            matched_role_label: 'Oil-control treatment',
            preferred_step: 'treatment',
          },
          {
            product_id: 'moisturizer_pick',
            display_name: 'Hydrating Dewy Gel Cream',
            brand: 'First Aid Beauty',
            category: 'Moisturizer',
            short_description: 'A lightweight gel cream with hyaluronic acid and ceramides.',
            matched_role_id: 'lightweight_moisturizer',
            matched_role_label: 'Lightweight moisturizer',
            preferred_step: 'moisturizer',
          },
          {
            product_id: 'spf_pick',
            display_name: 'Birch Mild-Up Sunscreen SPF 50',
            brand: 'Round Lab',
            category: 'Sunscreen',
            short_description: 'A daily sunscreen with lightweight, non-greasy wear.',
            matched_role_id: 'daily_sunscreen',
            matched_role_label: 'Daily sunscreen',
            preferred_step: 'sunscreen',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
          comparison_mode: 'routine_mix',
        },
      },
      {
        ingredient_query: 'oil control',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          { target_id: 'oil_control_treatment', ingredient_query: 'oil control', resolved_target_step: 'treatment' },
          { target_id: 'lightweight_moisturizer', ingredient_query: 'lightweight moisturizer', resolved_target_step: 'moisturizer' },
          { target_id: 'daily_sunscreen', ingredient_query: 'daily sunscreen', resolved_target_step: 'sunscreen' },
        ],
        selected_target_ids: ['oil_control_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
      },
    );
    let callCount = 0;
    const prompts = [];
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      return {
        ok: true,
        json: {
          lead_reason: 'it pairs niacinamide with zinc to address visible shine and oil-control concerns',
          support_reasons: [
            'it adds lightweight hydration with gel-cream texture and barrier-supporting ceramides',
            'it completes the daytime routine with lightweight daily sunscreen coverage',
          ],
        },
        parse_status: 'parsed',
        meta: { gate_wait_ms: 0, upstream_ms: 130, total_ms: 130 },
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'im oily skin. what product should i buy?',
      allowLockedSelectionRewrite: true,
      deadlineAtMs: Date.now() + 5000,
    });

    assert.equal(callCount, 1);
    assert.match(prompts[0], /Do not write the final assistant message/);
    assert.match(prompts[0], /do not stop at generic SPF or broad-spectrum utility/i);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.attempts?.[0]?.structured_reason_only, true);
    assert.equal(rewrite.attempts?.[0]?.strict_selected_only_context, true);
    assert.equal(rewrite.attempts?.[0]?.max_output_tokens, 220);
    assert.match(rewrite.text, /The Ordinary Niacinamide 10% \+ Zinc 1% fits this request/i);
    assert.match(rewrite.text, /Hydrating Dewy Gel Cream covers the moisturizer step/i);
    assert.match(rewrite.text, /Birch Mild-Up Sunscreen SPF 50 covers the sunscreen step/i);
    assert.match(rewrite.text, /lightweight, non-greasy wear/i);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite uses structured primary attempt for finish-fit same-role comparisons', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_unseen',
            display_name: 'Unseen Sunscreen SPF 50',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'A weightless sunscreen with soft-focus wear for smoother daytime layering under makeup.',
            why_this_one: 'it points to lighter, smoother daytime layering instead of a richer cream finish',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_mineral',
            display_name: 'Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
            brand: 'First Aid Beauty',
            category: 'Sunscreen',
            short_description: 'Leans more mineral and sensitive-skin-friendly with a sheer, weightless finish.',
            why_this_one: 'it leans more mineral and sensitive-skin-friendly if you want a sheer, weightless finish',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_milk',
            display_name: 'Hydrating Sunscreen Milk with Colloidal Oatmeal Broad Spectrum SPF 45',
            brand: 'First Aid Beauty',
            category: 'Sunscreen',
            short_description: 'Leans richer and more moisturizing if you want more cushion under makeup.',
            why_this_one: 'it leans richer and more moisturizing if you want more cushion under makeup',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
      },
    );
    const prompts = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      return {
        ok: true,
        json: {
          lead_reason: 'it supports lighter, smoother daytime layering under makeup',
          support_reasons: [
            'it leans more mineral and sensitive-skin-friendly if you want a sheer, weightless finish',
            'it leans richer and more moisturizing if you want more cushion under makeup',
          ],
        },
        parse_status: 'parsed',
        meta: { gate_wait_ms: 0, upstream_ms: 180, total_ms: 180 },
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'combination', goals: ['smooth layering'] },
      userRequestText: 'My daytime routine pills under makeup. What sunscreen should I buy?',
      allowLockedSelectionRewrite: true,
      deadlineAtMs: Date.now() + 5000,
    });

    assert.equal(callCount, 1);
    assert.match(prompts[0], /Do not write the final assistant message/);
    assert.match(prompts[0], /Schema: \{ "lead_reason": string, "support_reasons": string\[\] \}/);
    assert.match(prompts[0], /avoid generic SPF utility phrasing like "for AM UV protection" or "for daily protection"/);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.attempts?.[0]?.structured_reason_only, true);
    assert.equal(rewrite.attempts?.[0]?.strict_selected_only_context, true);
    assert.equal(rewrite.attempts?.[0]?.max_output_tokens, 180);
    assert.match(
      rewrite.text,
      /Unseen Sunscreen SPF 50 keeps the finish lighter and smoother under makeup(?:, which helps reduce pilling during the day| for easier daytime wear)(?: so it stays between the (?:more mineral-leaning|richer, more moisturizing) option and the (?:more mineral-leaning|richer, more moisturizing) option| instead of leaning toward the (?:more mineral-leaning|richer, more moisturizing) option)?/i,
    );
    assert.doesNotMatch(rewrite.text, /fits this request for sunscreen that wears more smoothly under makeup because/i);
    assert.doesNotMatch(rewrite.text, /Unseen Sunscreen SPF 50 fits this request because/i);
    assert.match(
      rewrite.text,
      /Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30 (?:makes more sense if you want a more mineral, sensitive-skin-friendly option with a sheer, weightless finish|leans more mineral and sensitive-skin-friendly if you want a sheer, weightless finish|gives a more mineral, sensitive-skin-oriented option)/i,
    );
    assert.match(
      rewrite.text,
      /Hydrating Sunscreen Milk with Colloidal Oatmeal Broad Spectrum SPF 45 (?:makes more sense if you want a richer, more moisturizing feel with more cushion under makeup|leans richer and more moisturizing if you want more cushion under makeup|gives a richer cream-spf base)/i,
    );
    assert.doesNotMatch(rewrite.text, /same-slot comparison option because/i);
    assert.doesNotMatch(rewrite.text, /What city or climate are you usually in/i);
    assert.equal(rewrite.refinement_question?.field || null, null);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite uses normalized recommendation card authority when raw finish-fit rows are still generic', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_aqua_fresh',
            display_name: 'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
            brand: 'Beauty of Joseon',
            category: 'Sunscreen',
            description: 'This ultra-lightweight fluid sunscreen is made with rice seed water and panthenol (B5) for a fresh, weightless feel that layers cleanly under makeup.',
            key_features: ['Panthenol (B5)', 'Ceramide NP', 'Glycerin', 'Hyaluronic acid'],
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_day_dew',
            display_name: 'Beauty of Joseon Day Dew Sunscreen',
            brand: 'Beauty of Joseon',
            category: 'Sunscreen',
            description: 'A lightweight, makeup-friendly sunscreen that leaves a fresh, dewy finish with a bit more hydration.',
            key_features: ['Niacinamide', 'Hyaluronic acid', 'Glycerin'],
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_matte_fit',
            display_name: 'SKINTIFIC Matte Fit Serum Sunscreen SPF 50+ PA++++',
            brand: 'SKINTIFIC',
            category: 'Sunscreen',
            description: 'An oil-controlling, non-greasy sunscreen with Zinc PCA and oat extract that stays smooth with 8-hour shine control.',
            key_features: ['Zinc PCA', 'Oat Extract'],
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
      },
    );
    const prompts = [];
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      prompts.push(String(args.userPrompt || ''));
      return {
        ok: true,
        json: {
          lead_reason: 'it uses hyaluronic acid, glycerin, and ceramides in the formula',
          support_reasons: [
            'it uses niacinamide, hyaluronic acid, and glycerin with makeup-friendly layering',
            'it uses zinc pca and oat extract in the formula',
          ],
        },
        parse_status: 'parsed',
        meta: { gate_wait_ms: 0, upstream_ms: 140, total_ms: 140 },
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['smooth layering under makeup'] },
      userRequestText: 'My daytime routine pills under makeup. What sunscreen should I buy?',
      allowLockedSelectionRewrite: true,
      deadlineAtMs: Date.now() + 5000,
    });

    const prompt = prompts[0] || '';
    const context = JSON.parse(prompt.match(/Context: (\{[\s\S]*\})$/)[1]);
    assert.match(
      String(context.assistant_write_plan?.lead_product?.must_use_reason_points?.[0] || ''),
      /it keeps the finish lighter and smoother under makeup if you want a less heavy daytime layer|it keeps the feel lighter and more invisible if you want less weight under makeup/i,
    );
    assert.equal(
      context.assistant_write_plan?.same_role_options?.[0]?.tradeoff_note,
      'it leans fresher and dewier if you want a bit more hydration without a heavier cream feel',
    );
    assert.equal(
      context.assistant_write_plan?.same_role_options?.[1]?.tradeoff_note,
      'it leans more matte and shine-controlling if you want less slip under makeup',
    );
    assert.match(
      rewrite.text,
      /Beauty of Joseon Relief Sun Aqua-Fresh : Rice \+ B5 \(SPF50\+ PA\+\+\+\+\) keeps the finish lighter and smoother under makeup(?:, which helps reduce pilling during the day| for easier daytime wear) so it stays between the (?:fresher, dewier|more matte, shine-controlling) option and the (?:fresher, dewier|more matte, shine-controlling) option/i,
    );
    assert.match(
      rewrite.text,
      /Beauty of Joseon Day Dew Sunscreen makes more sense if you want a fresher, dewier finish with a bit more hydration without a heavier cream feel/i,
    );
    assert.match(
      rewrite.text,
      /SKINTIFIC Matte Fit Serum Sunscreen SPF 50\+ PA\+\+\+\+ makes more sense if you want a more matte, shine-controlling finish with less slip under makeup/i,
    );
    assert.doesNotMatch(rewrite.text, /because it uses hyaluronic acid, glycerin, and ceramides in the formula/i);
    assert.doesNotMatch(rewrite.text, /because it uses zinc pca and oat extract in the formula/i);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant structured renderer pins finish-fit same-slot support sentences to canonical row tradeoffs', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'spf_unseen',
            display_name: 'Supergoop Unseen Sunscreen SPF 50',
            brand: 'Supergoop',
            category: 'Sunscreen',
            short_description: 'Keeps the sunscreen feel lighter and smoother under makeup.',
            why_this_one: 'it keeps the finish lighter and smoother under makeup if you want a less heavy daytime layer',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_mineral',
            display_name: 'First Aid Beauty Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
            brand: 'First Aid Beauty',
            category: 'Sunscreen',
            short_description: 'Leans more mineral and sensitive-skin-friendly with a sheer, weightless finish.',
            why_this_one: 'it leans more mineral and sensitive-skin-friendly if you want a sheer, weightless finish',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
          {
            product_id: 'spf_milk',
            display_name: 'First Aid Beauty Hydrating Sunscreen Milk with Colloidal Oatmeal Broad Spectrum SPF 45',
            brand: 'First Aid Beauty',
            category: 'Sunscreen',
            short_description: 'Leans richer and more moisturizing if you want more cushion under makeup.',
            why_this_one: 'it leans richer and more moisturizing if you want more cushion under makeup',
            matched_role_id: 'daily_sunscreen_finish_fit',
            matched_role_label: 'Daily sunscreen with finish fit',
            preferred_step: 'sunscreen',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'sunscreen',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Daily sunscreen with finish fit',
        resolved_target_step: 'sunscreen',
        primary_target_id: 'daily_sunscreen_finish_fit',
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen with finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
        selected_target_ids: ['daily_sunscreen_finish_fit'],
      },
    );
    const primaryTarget = payload.recommendation_meta.ranked_targets[0];
    const text = __internal.renderRecoAssistantStructuredReasonRewrite({
      structuredReason: {
        lead_reason: 'it supports lighter, smoother daytime layering under makeup',
        support_reasons: [
          'it offers a mineral-based alternative for sensitive skin while maintaining a sheer, silky, and weightless feel',
          'it features a lightweight milk texture designed to remain invisible and less heavy under makeup',
        ],
      },
      payload,
      language: 'EN',
      primaryTarget,
      names: [
        'Supergoop Unseen Sunscreen SPF 50',
        'First Aid Beauty Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
        'First Aid Beauty Hydrating Sunscreen Milk with Colloidal Oatmeal Broad Spectrum SPF 45',
      ],
      requestMode: 'buy',
      selectedProductRoleMix: 'same_role_comparison',
    });

    assert.match(
      text,
      /Supergoop Unseen Sunscreen SPF 50 keeps the finish lighter and smoother under makeup(?:, which helps reduce pilling during the day| for easier daytime wear)?/i,
    );
    assert.match(
      text,
      /First Aid Beauty Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30 (?:makes more sense if you want a more mineral, sensitive-skin-friendly option with a sheer, weightless finish|leans more mineral and sensitive-skin-friendly if you want a sheer, weightless finish)/i,
    );
    assert.match(
      text,
      /First Aid Beauty Hydrating Sunscreen Milk with Colloidal Oatmeal Broad Spectrum SPF 45 (?:makes more sense if you want a richer, more moisturizing feel with more cushion under makeup|leans richer and more moisturizing if you want more cushion under makeup)/i,
    );
    assert.doesNotMatch(text, /Supergoop Unseen Sunscreen SPF 50 supports lighter, smoother daytime layering under makeup/i);
    assert.doesNotMatch(text, /same-slot comparison option because/i);
    assert.doesNotMatch(text, /less heavy under makeup/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite retries gemini timeout with structured reason prompt context', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'barrier_pick_1',
            display_name: 'KraveBeauty Great Barrier Relief',
            brand: 'KraveBeauty',
            category: 'Serum',
            short_description: 'Barrier-support serum with tamanu oil, niacinamide, and ceramides.',
            key_features: ['Tamanu oil', 'Niacinamide', 'Ceramides'],
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'moisturizer',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Barrier moisturizer',
        resolved_target_step: 'moisturizer',
        primary_target_id: 'barrier_moisturizer',
        ranked_targets: [
          {
            target_id: 'barrier_moisturizer',
            ingredient_query: 'Barrier moisturizer',
            resolved_target_step: 'moisturizer',
          },
        ],
        selected_target_ids: ['barrier_moisturizer'],
      },
    );
    const prompts = [];
    const maxTokens = [];
    const timeouts = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      maxTokens.push(Number(args.maxOutputTokens || 0));
      timeouts.push(Number(args.timeoutMs || 0));
      if (callCount === 1) {
        return {
          ok: false,
          reason: 'GEMINI_JSON_TIMEOUT',
          timeout_stage: 'upstream',
          meta: { gate_wait_ms: 23, upstream_ms: 1800, total_ms: 1823 },
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          lead_reason:
            'it uses tamanu oil, niacinamide, and ceramides for barrier support without adding extra routine filler',
          support_reasons: [],
        },
        parse_status: 'parsed',
        meta: { gate_wait_ms: 5, upstream_ms: 640, total_ms: 645 },
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'sensitive', goals: ['barrier support'] },
      userRequestText: 'What should I buy first for redness and barrier support?',
      allowLockedSelectionRewrite: true,
      deadlineAtMs: Date.now() + 5000,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.equal(maxTokens[0], 140);
    assert.equal(maxTokens[1], 140);
    assert.ok(timeouts[0] > 0 && timeouts[0] < 4500);
    assert.ok(timeouts[1] >= 1400);
    assert.ok(timeouts[1] <= 2400);
    assert.ok(timeouts[1] >= timeouts[0]);
    assert.match(prompts[0], /"prompt_profile":"strict_selected_only_retry"/);
    assert.match(prompts[0], /Do not write the final assistant message\./);
    assert.match(prompts[1], /"prompt_profile":"strict_selected_only_retry"/);
    assert.match(prompts[1], /Do not write the final assistant message\./);
    assert.equal(rewrite.attempt_count, 2);
    assert.equal(rewrite.attempts?.length, 2);
    assert.equal(rewrite.attempts?.[0]?.ok, false);
    assert.equal(rewrite.attempts?.[0]?.reason, 'GEMINI_JSON_TIMEOUT');
    assert.equal(rewrite.attempts?.[0]?.timeout_stage, 'upstream');
    assert.equal(rewrite.attempts?.[0]?.compact_context, true);
    assert.equal(rewrite.attempts?.[0]?.strict_selected_only_context, true);
    assert.equal(rewrite.attempts?.[0]?.structured_reason_only, true);
    assert.equal(rewrite.attempts?.[0]?.effective_timeout_ms, timeouts[0]);
    assert.equal(rewrite.attempts?.[0]?.max_output_tokens, maxTokens[0]);
    assert.equal(rewrite.attempts?.[0]?.upstream_ms, 1800);
    assert.ok(rewrite.attempts?.[0]?.prompt_bytes > 0);
    assert.equal(rewrite.attempts?.[1]?.ok, true);
    assert.equal(rewrite.attempts?.[1]?.reason, null);
    assert.equal(rewrite.attempts?.[1]?.upstream_ms, 640);
    assert.doesNotMatch(rewrite.text, /That keeps the recommendation focused/i);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite attempt deadline returns timeout before slow provider resolves', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const slowProvider = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: true, json: { assistant_text: 'too late' } }), 500);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const startedAt = Date.now();
    const result = await __internal.enforceRecoAssistantRewriteAttemptDeadline(slowProvider, {
      timeoutMs: 50,
      timeoutBudget: { queue_timeout_ms: 10, upstream_timeout_ms: 40 },
      startedAtMs: startedAt,
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
    });
    const durationMs = Date.now() - startedAt;

    assert.ok(durationMs < 250, `deadline helper waited for slow provider (${durationMs}ms)`);
    assert.equal(result.ok, false);
    assert.equal(result.failure_reason, 'GEMINI_JSON_TIMEOUT');
    assert.equal(result.timeout_stage, 'upstream');
    assert.equal(result.selection_source, 'reco_assistant_attempt_deadline');
    assert.equal(result.provider, 'gemini');
    assert.equal(result.model, 'gemini-3-flash-preview');
    assert.ok(result.meta.total_ms >= 45);
    assert.ok(result.meta.total_ms < 250);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite retries routine-mix drafts that use a templated full-routine bridge', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            brand: 'The Ordinary',
            category: 'Serum',
            short_description: 'A lightweight oil-control serum for visible shine.',
            price: { amount: 12, currency: 'USD', unknown: false },
            matched_role_id: 'oil_control_treatment',
            matched_role_label: 'Oil-control treatment',
          },
          {
            product_id: 'routine_support_1',
            display_name: 'LightLab Oil-Free Gel Cream',
            brand: 'LightLab',
            category: 'Moisturizer',
            short_description: 'A breathable gel moisturizer for oily skin.',
            price: { amount: 28, currency: 'USD', unknown: false },
            matched_role_id: 'lightweight_moisturizer',
            matched_role_label: 'Lightweight moisturizer',
          },
          {
            product_id: 'routine_support_2',
            display_name: 'SunLab Daily SPF 50 Fluid',
            brand: 'SunLab',
            category: 'Sunscreen',
            short_description: 'A lightweight daily sunscreen fluid with no white cast.',
            price: { amount: 24, currency: 'USD', unknown: false },
            matched_role_id: 'daily_sunscreen',
            matched_role_label: 'Daily sunscreen',
          },
        ],
        roles: [
          { role_id: 'oil_control_treatment', label: 'Oil-control treatment', preferred_step: 'treatment', why_this_role: 'Reduce excess sebum.' },
          { role_id: 'lightweight_moisturizer', label: 'Lightweight moisturizer', preferred_step: 'moisturizer', why_this_role: 'Support barrier without heaviness.' },
          { role_id: 'daily_sunscreen', label: 'Daily sunscreen', preferred_step: 'sunscreen', why_this_role: 'Protect skin during the day.' },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
      },
    );
    const prompts = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      if (callCount === 1) {
        return {
          ok: true,
          json: {
            assistant_text:
              'The Ordinary Niacinamide 10% + Zinc 1% fits this request for oily skin because it pairs niacinamide with zinc and costs $12. To build out a full routine, add LightLab Oil-Free Gel Cream as your moisturizer step and SunLab Daily SPF 50 Fluid as your sunscreen step.',
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          assistant_text:
            'The Ordinary Niacinamide 10% + Zinc 1% fits this request for oily skin because it pairs niacinamide with zinc and costs $12. LightLab Oil-Free Gel Cream is the lightweight moisturizer step for breathable hydration, and SunLab Daily SPF 50 Fluid is the sunscreen step for daily UV protection without a heavy finish.',
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'im oily skin. what product should i buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.match(prompts[1], /Fix required: Replace templated routine bridge lines like "To build out a full routine"/);
    assert.doesNotMatch(String(rewrite.text || ''), /To build out a full routine/i);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite retries routine-mix drafts that end in a generic closing summary', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            brand: 'The Ordinary',
            category: 'Serum',
            short_description: 'A lightweight oil-control serum for visible shine.',
            price: { amount: 12, currency: 'USD', unknown: false },
            matched_role_id: 'oil_control_treatment',
            matched_role_label: 'Oil-control treatment',
            key_features: ['Niacinamide 10%', 'Zinc 1%'],
          },
          {
            product_id: 'routine_support_1',
            display_name: 'LightLab Oil-Free Gel Cream',
            brand: 'LightLab',
            category: 'Moisturizer',
            short_description: 'A breathable gel moisturizer for oily skin.',
            price: { amount: 28, currency: 'USD', unknown: false },
            matched_role_id: 'lightweight_moisturizer',
            matched_role_label: 'Lightweight moisturizer',
          },
          {
            product_id: 'routine_support_2',
            display_name: 'SunLab Daily SPF 50 Fluid',
            brand: 'SunLab',
            category: 'Sunscreen',
            short_description: 'A lightweight daily sunscreen fluid with no white cast.',
            price: { amount: 24, currency: 'USD', unknown: false },
            matched_role_id: 'daily_sunscreen',
            matched_role_label: 'Daily sunscreen',
          },
        ],
        roles: [
          {
            role_id: 'oil_control_treatment',
            label: 'Oil-control treatment',
            preferred_step: 'treatment',
            why_this_role: 'Reduce excess sebum.',
          },
          {
            role_id: 'lightweight_moisturizer',
            label: 'Lightweight moisturizer',
            preferred_step: 'moisturizer',
            why_this_role: 'Support barrier without heaviness.',
          },
          {
            role_id: 'daily_sunscreen',
            label: 'Daily sunscreen',
            preferred_step: 'sunscreen',
            why_this_role: 'Protect skin during the day.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
      },
    );
    const prompts = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      if (callCount === 1) {
        return {
          ok: true,
          json: {
            assistant_text:
              'The Ordinary Niacinamide 10% + Zinc 1% fits this request for oily skin because it pairs niacinamide with zinc and costs $12. LightLab Oil-Free Gel Cream is your moisturizer step, and SunLab Daily SPF 50 Fluid is your sunscreen step. These secondary steps support your oily skin by keeping hydration breathable and protecting against UV damage.',
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          lead_reason:
            'it is the direct oil-control step, pairs niacinamide with zinc, and costs $12',
          support_reasons: [
            'it is a breathable gel moisturizer for oily skin',
            'it is a lightweight daily sunscreen fluid with no white cast',
          ],
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'im oily skin. what product should i buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.match(prompts[1], /Previous draft failed the quality gate\./);
    assert.match(prompts[1], /Fix required: Do not end with a generic routine wrap-up\./);
    assert.match(String(rewrite.text || ''), /The Ordinary Niacinamide 10% \+ Zinc 1% fits this request/);
    assert.match(prompts[1], /Do not write the final assistant message\./);
    assert.doesNotMatch(String(rewrite.text || ''), /These secondary steps support your oily skin/i);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('reco assistant rewrite retries oily buy drafts that use off-target tone claims', async () => {
  const prevMock = process.env.AURORA_BFF_USE_MOCK;
  const prevProvider = process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
  const prevModel = process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
  process.env.AURORA_BFF_USE_MOCK = 'false';
  process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = 'gemini';
  process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = 'gemini-3-flash-preview';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'GoalSkin Oil Control Serum',
            brand: 'GoalSkin',
            category: 'Serum',
            short_description: 'A lightweight oil-control serum for visible shine.',
            why_this_one: 'Direct oil-control support for visible shine.',
            price: { amount: 12, currency: 'USD', unknown: false },
            matched_role_id: 'oil_control_treatment',
            matched_role_label: 'Oil-control treatment',
          },
        ],
        roles: [
          {
            role_id: 'oil_control_treatment',
            label: 'Oil-control treatment',
            preferred_step: 'treatment',
            why_this_role: 'Reduce excess sebum and visible shine.',
          },
        ],
        recommendation_meta: {
          resolved_target_step: 'treatment',
          mainline_status: 'grounded_success',
        },
      },
      {
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    const prompts = [];
    let callCount = 0;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      callCount += 1;
      prompts.push(String(args.userPrompt || ''));
      if (callCount === 1) {
        return {
          ok: true,
          json: {
            assistant_text:
              'GoalSkin Oil Control Serum fits this request because it targets brightening and dark spots while helping oily skin.',
          },
          parse_status: 'parsed',
          provider: 'gemini',
          effective_model: 'gemini-3-flash-preview',
        };
      }
      return {
        ok: true,
        json: {
          lead_reason:
            'it is the direct oil-control step for visible shine and costs $12',
          support_reasons: [],
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: 'gemini-3-flash-preview',
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'im oily skin. what product should i buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(callCount, 2);
    assert.equal(rewrite.llm_used, true);
    assert.equal(rewrite.reason, null);
    assert.match(prompts[1], /Fix required: Remove extra concern claims/);
    assert.doesNotMatch(String(rewrite.text || ''), /dullness|uneven tone/i);
    assert.match(String(rewrite.text || ''), /visible shine|oil-control/i);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    if (prevMock === undefined) delete process.env.AURORA_BFF_USE_MOCK;
    else process.env.AURORA_BFF_USE_MOCK = prevMock;
    if (prevProvider === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER;
    else process.env.AURORA_PRODUCT_INTEL_LLM_PROVIDER = prevProvider;
    if (prevModel === undefined) delete process.env.AURORA_PRODUCT_INTEL_LLM_MODEL;
    else process.env.AURORA_PRODUCT_INTEL_LLM_MODEL = prevModel;
    delete require.cache[moduleId];
  }
});

test('beauty mainline routine support fill keeps one card per support role', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const targetContext = {
      primary_role_id: 'hydrating_barrier_moisturizer',
      mainline_fallback_policy: 'strict_no_runtime_fallback',
      semantic_planner_required: true,
      framework_roles: [
        {
          role_id: 'hydrating_barrier_moisturizer',
          label: 'Hydrating barrier moisturizer',
          preferred_step: 'moisturizer',
          rank: 1,
          query_terms: ['hydrating', 'barrier', 'moisturizer'],
          fit_keywords: ['barrier', 'ceramide', 'moisturizer'],
        },
        {
          role_id: 'hydrating_serum_or_essence',
          label: 'Hydrating serum or essence',
          preferred_step: 'serum',
          rank: 2,
          query_terms: ['hydrating', 'serum', 'essence'],
          fit_keywords: ['hyaluronic', 'serum'],
        },
        {
          role_id: 'daily_sunscreen',
          label: 'Daily sunscreen',
          preferred_step: 'sunscreen',
          rank: 3,
          query_terms: ['sunscreen', 'spf'],
          fit_keywords: ['spf', 'sunscreen'],
        },
      ],
    };
    const out = __internal.finalizeConcernFrameworkCandidatePools(
      [
        {
          product_id: 'barrier_1',
          merchant_id: 'external_seed',
          display_name: 'Barrier Ceramide Moisturizer',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          description: 'Hydrating barrier moisturizer with ceramides for dry skin.',
        },
        {
          product_id: 'spf_1',
          merchant_id: 'external_seed',
          display_name: 'SPF 45 Sunscreen Serum',
          category: 'Sunscreen',
          product_type: 'Sunscreen',
          description: 'Daily sunscreen SPF protection.',
        },
        {
          product_id: 'spf_2',
          merchant_id: 'external_seed',
          display_name: 'Tinted SPF Moisturizer Sunscreen',
          category: 'Sunscreen',
          product_type: 'Sunscreen',
          description: 'Tinted sunscreen SPF for daytime.',
        },
      ],
      { targetContext },
    );

    assert.deepEqual(
      out.selected_recommendations.map((row) => row.product_id),
      ['barrier_1', 'spf_1'],
    );
    assert.deepEqual(
      out.selected_recommendations.map((row) => row.matched_role_id),
      ['hydrating_barrier_moisturizer', 'daily_sunscreen'],
    );
    assert.equal(out.role_pool_stats.daily_sunscreen.viable_count, 1);
  } finally {
    delete require.cache[moduleId];
  }
});

test('concern selector race prompt carries finish-fit tradeoff evidence and diversity guidance', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  const prompts = [];
  try {
    __internal.__setCallGeminiTextResponseForTest(async (args = {}) => {
      prompts.push(String(args.userPrompt || ''));
      return {
        text: JSON.stringify({
          top_pick_product_id: 'spf_lead',
          ordered_product_ids: ['spf_lead', 'spf_mineral', 'spf_rich'],
          support_roles_surfaced: [],
          selection_notes: [],
          open_world_candidate_expansion_needed: false,
        }),
        provider: 'gemini',
        requested_model: 'gemini-3-flash-preview',
        effective_model: 'gemini-3-flash-preview',
        selection_source: 'local_gemini_rest_direct',
      };
    });

    await __internal.runConcernSelectorRace({
      ctx: { lang: 'EN' },
      logger: null,
      requestText: 'My daytime routine pills under makeup. What sunscreen should I buy?',
      semanticPlan: {
        comparison_mode: 'same_role_comparison',
        core_roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            label: 'Daily sunscreen with finish fit',
            why_this_role: 'Use a daily sunscreen that layers cleanly under makeup.',
            preferred_step: 'sunscreen',
          },
        ],
        support_roles: [],
      },
      recommendations: [
        {
          product_id: 'spf_lead',
          display_name: 'Unseen Sunscreen SPF 50',
          matched_role_id: 'daily_sunscreen_finish_fit',
          matched_role_label: 'Daily sunscreen with finish fit',
          short_description: 'Keeps the sunscreen feel lighter and smoother under makeup.',
          why_this_one: 'it keeps the finish lighter and smoother under makeup if you want a less heavy daytime layer',
        },
        {
          product_id: 'spf_mineral',
          display_name: 'Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
          matched_role_id: 'daily_sunscreen_finish_fit',
          matched_role_label: 'Daily sunscreen with finish fit',
          short_description: 'Leans more mineral and sensitive-skin-friendly with a sheer, weightless finish.',
          why_this_one: 'it leans more mineral and sensitive-skin-friendly if you want a sheer, weightless finish',
        },
        {
          product_id: 'spf_rich',
          display_name: 'Hydrating Sunscreen Milk with Colloidal Oatmeal Broad Spectrum SPF 45',
          matched_role_id: 'daily_sunscreen_finish_fit',
          matched_role_label: 'Daily sunscreen with finish fit',
          short_description: 'Leans richer and more moisturizing if you want more cushion under makeup.',
          why_this_one: 'it leans richer and more moisturizing if you want more cushion under makeup',
        },
      ],
      deadlineAtMs: Date.now() + 5000,
    });

    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /"comparison_mode":"same_role_comparison"/);
    assert.match(prompts[0], /"tradeoff_note":"it leans more mineral and sensitive-skin-friendly if you want a sheer, weightless finish"/);
    assert.match(prompts[0], /"tradeoff_note":"it leans richer and more moisturizing if you want more cushion under makeup"/);
    assert.match(prompts[0], /maximize real tradeoff spread when authoritative options exist/i);
    assert.match(prompts[0], /Do not rank multiple near-duplicate lightweight under-makeup sunscreens ahead of a clearly differentiated richer option/i);
  } finally {
    __internal.__resetCallGeminiTextResponseForTest();
    delete require.cache[moduleId];
  }
});

test('concern selector ordering diversifies finish-fit same-role comparisons across lighter mineral and richer options', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const applied = __internal.applyConcernSelectorRaceOrdering(
      [
        {
          product_id: 'spf_lead',
          display_name: 'Unseen Sunscreen SPF 50',
          matched_role_id: 'daily_sunscreen_finish_fit',
          why_this_one: 'it keeps the finish lighter and smoother under makeup if you want a less heavy daytime layer',
          short_description: 'Keeps the sunscreen feel lighter and smoother under makeup.',
        },
        {
          product_id: 'spf_mineral',
          display_name: 'Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
          matched_role_id: 'daily_sunscreen_finish_fit',
          why_this_one: 'it leans more mineral and sensitive-skin-friendly if you want a sheer, weightless finish',
          short_description: 'Leans more mineral and sensitive-skin-friendly with a sheer, weightless finish.',
        },
        {
          product_id: 'spf_light_alt',
          display_name: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
          matched_role_id: 'daily_sunscreen_finish_fit',
          why_this_one: 'it keeps the finish lighter and smoother under makeup if you want a less heavy daytime layer',
          short_description: 'Keeps the sunscreen feel lighter and smoother under makeup.',
        },
        {
          product_id: 'spf_rich',
          display_name: 'Hydrating Sunscreen Milk with Colloidal Oatmeal Broad Spectrum SPF 45',
          matched_role_id: 'daily_sunscreen_finish_fit',
          why_this_one: 'it leans richer and more moisturizing if you want more cushion under makeup',
          short_description: 'Leans richer and more moisturizing if you want more cushion under makeup.',
        },
      ],
      {
        top_pick_product_id: 'spf_lead',
        ordered_product_ids: ['spf_lead', 'spf_mineral', 'spf_light_alt', 'spf_rich'],
        comparison_mode: 'same_role_comparison',
        primary_role_id: 'daily_sunscreen_finish_fit',
      },
    );

    assert.deepEqual(
      applied.recommendations.map((row) => row.product_id),
      ['spf_lead', 'spf_mineral', 'spf_rich', 'spf_light_alt'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline routine selection covers support roles before same-role refill variants', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const targetContext = {
      primary_role_id: 'tone_mark_treatment',
      semantic_plan: {
        routine_mode: 'routine_mix',
        comparison_mode: 'routine_mix',
        selection_constraints: {
          comparison_mode: 'routine_mix',
        },
      },
      framework_roles: [
        {
          role_id: 'tone_mark_treatment',
          label: 'Tone and post-breakout mark treatment',
          preferred_step: 'treatment',
          rank: 50,
          query_terms: ['post acne marks serum', 'dark spot serum', 'brightening serum'],
          fit_keywords: ['post acne marks', 'dark spots', 'brightening', 'uneven tone'],
        },
        {
          role_id: 'lightweight_moisturizer',
          label: 'Lightweight moisturizer',
          preferred_step: 'moisturizer',
          rank: 20,
          query_terms: ['lightweight moisturizer oily skin', 'gel cream oily skin'],
          fit_keywords: ['lightweight', 'gel cream', 'non-greasy'],
        },
        {
          role_id: 'daily_sunscreen',
          label: 'Daily sunscreen',
          preferred_step: 'sunscreen',
          rank: 30,
          query_terms: ['daily sunscreen skincare', 'broad spectrum sunscreen'],
          fit_keywords: ['spf', 'uv filters', 'broad spectrum'],
        },
      ],
    };
    const out = __internal.finalizeConcernFrameworkCandidatePools(
      [
        {
          product_id: 'fab_dark_spot',
          merchant_id: 'external_seed',
          display_name: 'Dark Spot Serum with Niacinamide',
          brand: 'First Aid Beauty',
          category: 'Serum',
          product_type: 'Serum',
          description: 'A dark spot serum for post acne marks and uneven tone with niacinamide.',
          retrieval_source: 'external_seed',
        },
        {
          product_id: 'fenty_refill',
          merchant_id: 'external_seed',
          display_name: 'Watch Ya Tone Niacinamide Dark Spot Serum Refill',
          brand: 'Fenty Beauty',
          category: 'Serum',
          product_type: 'Serum',
          description: 'Refill format for a niacinamide dark spot serum.',
          retrieval_source: 'external_seed',
        },
        {
          product_id: 'jurlique_brightening',
          merchant_id: 'external_seed',
          display_name: 'Brightening Serum',
          brand: 'Jurlique',
          category: 'Serum',
          product_type: 'Serum',
          description: 'A brightening serum for uneven tone and post breakout marks.',
          retrieval_source: 'external_seed',
        },
        {
          product_id: 'fab_gel_cream',
          merchant_id: 'external_seed',
          display_name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
          brand: 'First Aid Beauty',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          description: 'A lightweight gel cream moisturizer with a non-greasy feel.',
          retrieval_source: 'external_seed',
        },
        {
          product_id: 'ordinary_spf',
          merchant_id: 'external_seed',
          display_name: 'UV Filters SPF 45 Serum',
          brand: 'The Ordinary',
          category: 'Sunscreen',
          product_type: 'Sunscreen',
          description: 'A daily sunscreen with SPF and UV filters for daytime protection.',
          retrieval_source: 'external_seed',
        },
      ],
      { targetContext },
    );

    assert.equal(out.selected_recommendations[0]?.matched_role_id, 'tone_mark_treatment');
    assert.equal(out.selected_recommendations.some((row) => row.product_id === 'fenty_refill'), false);
    assert.deepEqual(
      out.selected_recommendations.map((row) => row.matched_role_id),
      ['tone_mark_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
    );
    assert.equal(out.hard_reject.some((entry) => entry.reason === 'framework_refill_only_variant'), true);
    assert.equal(out.routine_support_fill_count, 2);
    assert.equal(out.comparison_fill_applied, false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline routine selection rejects coming-soon support products', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const targetContext = {
      primary_role_id: 'hydrating_barrier_moisturizer',
      semantic_plan: {
        routine_mode: 'routine_mix',
        comparison_mode: 'routine_mix',
      },
      framework_roles: [
        {
          role_id: 'hydrating_barrier_moisturizer',
          label: 'Hydrating barrier moisturizer',
          preferred_step: 'moisturizer',
          rank: 40,
          query_terms: ['barrier repair moisturizer'],
          fit_keywords: ['hydrating', 'barrier repair', 'ceramide'],
          product_type_hypotheses: ['moisturizer'],
        },
        {
          role_id: 'hydrating_serum_or_essence',
          label: 'Hydrating serum or essence',
          preferred_step: 'serum',
          rank: 42,
          query_terms: ['hyaluronic acid serum', 'hydrating serum dehydrated skin'],
          fit_keywords: ['hydrating', 'hyaluronic acid', 'plumping'],
          ingredient_hypotheses: ['Hyaluronic acid', 'Glycerin'],
          product_type_hypotheses: ['serum', 'essence'],
        },
        {
          role_id: 'daily_sunscreen',
          label: 'Daily sunscreen',
          preferred_step: 'sunscreen',
          rank: 30,
          query_terms: ['daily sunscreen skincare'],
          fit_keywords: ['spf', 'uv filters', 'broad spectrum'],
          product_type_hypotheses: ['sunscreen'],
        },
      ],
    };
    const out = __internal.finalizeConcernFrameworkCandidatePools(
      [
        {
          product_id: 'barrier_primary',
          merchant_id: 'shopify',
          display_name: 'Barrier Repair Cream',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          short_description: 'A hydrating barrier repair moisturizer with ceramides.',
          retrieval_role_id: 'hydrating_barrier_moisturizer',
          retrieval_source: 'catalog',
        },
        {
          product_id: 'coming_soon_ampoule',
          merchant_id: 'external_seed',
          display_name: 'Hyalu-Teca Plumping Ampoule - Coming Soon',
          category: 'Serum',
          product_type: 'Serum',
          key_features: ['Hyaluronic acid', 'Centella asiatica'],
          retrieval_role_id: 'hydrating_serum_or_essence',
          retrieval_source: 'external_seed',
        },
        {
          product_id: 'available_hydrating_serum',
          merchant_id: 'external_seed',
          display_name: 'Hydra B5 Hyaluronic Acid Serum',
          category: 'Serum',
          product_type: 'Serum',
          key_features: ['Hyaluronic acid', 'Glycerin'],
          short_description: 'A hydrating serum with hyaluronic acid for plumping support.',
          retrieval_role_id: 'hydrating_serum_or_essence',
          retrieval_source: 'external_seed',
        },
        {
          product_id: 'daily_spf',
          merchant_id: 'external_seed',
          display_name: 'Daily UV Filters SPF 45',
          category: 'Sunscreen',
          product_type: 'Sunscreen',
          key_features: ['UV filters'],
          retrieval_role_id: 'daily_sunscreen',
          retrieval_source: 'external_seed',
        },
      ],
      { targetContext },
    );

    assert.deepEqual(
      out.selected_recommendations.map((row) => row.product_id),
      ['barrier_primary', 'available_hydrating_serum', 'daily_spf'],
    );
    assert.equal(out.selected_recommendations.some((row) => row.product_id === 'coming_soon_ampoule'), false);
    assert.equal(out.hard_reject.some((entry) => entry.reason === 'framework_unavailable_variant'), true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline same-role moisturizer compare promotes non-active barrier lotion when the user rejects another active', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const targetContext = {
      primary_role_id: 'hydrating_barrier_moisturizer',
      routine_mode: 'same_role_comparison',
      comparison_mode: 'same_role_comparison',
      semantic_plan: {
        routine_mode: 'same_role_comparison',
        comparison_mode: 'same_role_comparison',
        must_satisfy_constraints: ['must not contain active treatment ingredients', 'moisturizer-only same-slot comparison'],
      },
      mainline_fallback_policy: 'strict_no_runtime_fallback',
      semantic_planner_required: true,
      request_text: 'What moisturizer product should I buy next? I do not want another active.',
      framework_roles: [
        {
          role_id: 'hydrating_barrier_moisturizer',
          label: 'Hydrating barrier moisturizer',
          preferred_step: 'moisturizer',
          rank: 40,
          query_terms: ['barrier repair moisturizer', 'ceramide moisturizer'],
          fit_keywords: ['hydrating', 'barrier repair', 'ceramide', 'dry skin', 'soothing'],
          ingredient_hypotheses: ['Ceramide NP', 'Panthenol', 'Glycerin'],
          product_type_hypotheses: ['moisturizer', 'cream', 'lotion'],
        },
      ],
    };
    const out = __internal.finalizeConcernFrameworkCandidatePools(
      [
        {
          product_id: 'fab_firming_day_cream',
          merchant_id: 'external_seed',
          display_name: 'Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen',
          brand: 'First Aid Beauty',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          retrieval_role_id: 'hydrating_barrier_moisturizer',
          retrieval_source: 'external_seed',
          local_external_seed_role_fit_score: 0.92,
          description: 'A firming day cream with peptides, niacinamide, and collagen for dryness-focused barrier support.',
        },
        {
          product_id: 'fab_face_lotion',
          merchant_id: 'external_seed',
          display_name: 'Ultra Repair Face Lotion with Colloidal Oatmeal',
          brand: 'First Aid Beauty',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          retrieval_role_id: 'hydrating_barrier_moisturizer',
          retrieval_source: 'external_seed',
          description: 'A lightweight face lotion with colloidal oatmeal and glycerin for dry, tight, or easily irritated skin comfort.',
        },
        {
          product_id: 'krave_great_barrier_relief',
          merchant_id: 'merchant_internal',
          display_name: 'KraveBeauty Great Barrier Relief',
          brand: 'KraveBeauty',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          retrieval_role_id: 'hydrating_barrier_moisturizer',
          retrieval_source: 'catalog',
          description: 'A barrier-repair formula with tamanu oil, niacinamide, and ceramides for over-sensitized skin.',
        },
        {
          product_id: 'fab_hydrating_dewy_gel',
          merchant_id: 'external_seed',
          display_name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
          brand: 'First Aid Beauty',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          retrieval_role_id: 'hydrating_barrier_moisturizer',
          retrieval_source: 'external_seed',
          description: 'A lightweight gel-cream with hyaluronic acid and ceramides for oily or combination skin.',
        },
      ],
      { targetContext },
    );

    assert.equal(out.primary_role_matched, true);
    assert.equal(out.selected_recommendations.length, 2);
    assert.equal(out.selected_recommendations[0]?.product_id, 'fab_face_lotion');
    assert.deepEqual(
      out.selected_recommendations.map((row) => row.product_id),
      ['fab_face_lotion', 'fab_hydrating_dewy_gel'],
    );
    assert.equal(out.selected_recommendations.some((row) => row.product_id === 'fab_firming_day_cream'), false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline same-role moisturizer compare for dry tight use-first keeps barrier-first lotion ahead of firming cream', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const targetContext = {
      primary_role_id: 'hydrating_barrier_moisturizer',
      routine_mode: 'same_role_comparison',
      comparison_mode: 'same_role_comparison',
      request_text: 'My skin feels dry and tight after washing. What product should I use first?',
      semantic_plan: {
        primary_concern: 'dryness and tightness after washing with impaired barrier',
        routine_mode: 'same_role_comparison',
        comparison_mode: 'same_role_comparison',
        must_satisfy_constraints: [
          'Must be suitable for dry skin type',
          'Must address impaired barrier status',
          'moisturizer-only same-slot comparison',
        ],
        selection_constraints: {
          narrowing_reason: 'use_first_or_buy_next_focus',
          comparison_mode: 'same_role_comparison',
        },
      },
      framework_roles: [
        {
          role_id: 'hydrating_barrier_moisturizer',
          label: 'Hydrating barrier moisturizer',
          preferred_step: 'moisturizer',
          rank: 40,
          query_terms: ['hydrating moisturizer dry skin', 'barrier repair moisturizer', 'ceramide cream sensitive skin'],
          fit_keywords: ['hydrating', 'barrier repair', 'ceramide', 'soothing', 'dry skin'],
          ingredient_hypotheses: ['Ceramide NP', 'Panthenol', 'Glycerin', 'Squalane'],
          product_type_hypotheses: ['moisturizer', 'cream', 'lotion'],
        },
      ],
    };
    const out = __internal.finalizeConcernFrameworkCandidatePools(
      [
        {
          product_id: 'fab_firming_day_cream',
          merchant_id: 'external_seed',
          display_name: 'Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen',
          brand: 'First Aid Beauty',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          retrieval_role_id: 'hydrating_barrier_moisturizer',
          retrieval_source: 'external_seed',
          description: 'A firming day cream with peptides, niacinamide, and collagen for dryness-focused barrier support.',
        },
        {
          product_id: 'fab_face_lotion',
          merchant_id: 'external_seed',
          display_name: 'Ultra Repair Face Lotion with Colloidal Oatmeal',
          brand: 'First Aid Beauty',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          retrieval_role_id: 'hydrating_barrier_moisturizer',
          retrieval_source: 'external_seed',
          local_external_seed_role_fit_score: 0.91,
          description: 'A daily facial lotion with colloidal oatmeal, immediate hydration, quick-absorbing comfort, and dry, tight skin support.',
        },
        {
          product_id: 'krave_great_barrier_relief',
          merchant_id: 'merchant_internal',
          display_name: 'KraveBeauty Great Barrier Relief',
          brand: 'KraveBeauty',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          retrieval_role_id: 'hydrating_barrier_moisturizer',
          retrieval_source: 'catalog',
          description: 'A barrier-repair serum for over-sensitized or irritated skin, built around tamanu oil, niacinamide, and ceramides.',
        },
        {
          product_id: 'fab_hydrating_dewy_gel',
          merchant_id: 'external_seed',
          display_name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
          brand: 'First Aid Beauty',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          retrieval_role_id: 'hydrating_barrier_moisturizer',
          retrieval_source: 'external_seed',
          local_external_seed_role_fit_score: 0.89,
          description: 'A hydrating gel cream with hyaluronic acid and ceramides for lighter barrier support.',
        },
      ],
      { targetContext },
    );

    assert.equal(out.primary_role_matched, true);
    assert.equal(out.selected_recommendations[0]?.product_id, 'fab_face_lotion');
    assert.equal(out.selected_recommendations.some((row) => row.product_id === 'fab_firming_day_cream'), false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco rows prune active moisturizer compare rows even when the active cue only survives in the title', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const targetContext = {
      primary_role_id: 'hydrating_barrier_moisturizer',
      routine_mode: 'same_role_comparison',
      comparison_mode: 'same_role_comparison',
      semantic_plan: {
        routine_mode: 'same_role_comparison',
        comparison_mode: 'same_role_comparison',
        must_satisfy_constraints: ['must not contain active treatment ingredients', 'moisturizer-only same-slot comparison'],
      },
      request_text: 'What moisturizer product should I buy next? I do not want another active.',
      framework_roles: [
        {
          role_id: 'hydrating_barrier_moisturizer',
          label: 'Hydrating barrier moisturizer',
          preferred_step: 'moisturizer',
          rank: 40,
        },
      ],
    };
    const rows = __internal.buildRecoRowsFromMainlineProducts(
      [
        {
          product_id: 'ext_9bc7ff02d709cc5383cc78ec',
          merchant_id: 'external_seed',
          display_name: 'Ultra Repair Face Lotion with Colloidal Oatmeal',
          brand: 'First Aid Beauty',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          retrieval_role_id: 'hydrating_barrier_moisturizer',
          matched_role_id: 'hydrating_barrier_moisturizer',
          retrieval_source: 'external_seed',
          why_this_one: 'Dryness or barrier support',
          short_description: 'Dryness or barrier support',
        },
        {
          product_id: 'ext_a29393bd005135c81f47dade',
          merchant_id: 'external_seed',
          display_name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
          brand: 'First Aid Beauty',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          retrieval_role_id: 'hydrating_barrier_moisturizer',
          matched_role_id: 'hydrating_barrier_moisturizer',
          retrieval_source: 'external_seed',
          why_this_one: 'Oily or combination skin needing hydration',
          short_description: 'Oily or combination skin needing hydration',
        },
        {
          product_id: 'ext_62685854dfc71d2634e828e6',
          merchant_id: 'external_seed',
          display_name: 'Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen',
          brand: 'First Aid Beauty',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          retrieval_role_id: 'hydrating_barrier_moisturizer',
          matched_role_id: 'hydrating_barrier_moisturizer',
          retrieval_source: 'external_seed',
          why_this_one: 'Dryness or barrier support',
          short_description: 'Dryness or barrier support',
        },
      ],
      {
        targetContext,
        selectionContract: {
          selected_product_ids: [
            'ext_9bc7ff02d709cc5383cc78ec',
            'ext_a29393bd005135c81f47dade',
            'ext_62685854dfc71d2634e828e6',
          ],
          selected_titles: [
            'Ultra Repair Face Lotion with Colloidal Oatmeal',
            'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
            'Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen',
          ],
        },
      },
    );

    assert.deepEqual(
      rows.map((row) => row.product_id),
      ['ext_9bc7ff02d709cc5383cc78ec', 'ext_a29393bd005135c81f47dade'],
    );
    assert.equal(rows.some((row) => row.product_id === 'ext_62685854dfc71d2634e828e6'), false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco rows promote visible nested product fields to top level', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const normalized = __internal.normalizeRecoCatalogProduct({
      product_id: 'fab_dark_spot_raw',
      merchant_id: 'merch_efbc46b4619cfbdf',
      brand: 'First Aid Beauty',
      display_name: 'Dark Spot Serum with Niacinamide',
      why_this_one: 'Glycerin',
      key_ingredients: ['Glycerin', 'Niacinamide'],
    });
    assert.equal(normalized?.why_this_one, undefined);
    assert.ok(normalized?.key_features.includes('Glycerin'));

    const rows = __internal.buildRecoRowsFromMainlineProducts(
      [
        {
          product_id: '9886499864904',
          merchant_id: 'merch_efbc46b4619cfbdf',
          display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
          category: 'Serum',
          purchase_path: 'https://agent.pivota.cc/products/9886499864904?merchant_id=merch_efbc46b4619cfbdf&entry=creator_agent',
          sku: {
            brand: 'The Ordinary',
            image_url: 'https://cdn.shopify.com/s/files/1/0944/6998/0488/files/89K57102_S2.webp?v=1770439122',
            short_description: 'Helps reduce visible shine without feeling heavy.',
            description: 'Daily serum for oily skin that targets excess sebum.',
            price: { amount: 12, currency: 'USD', unknown: false },
            product_intel: {
              product_intel_core: {
                what_it_is: {
                  body: 'A lightweight niacinamide serum for visible shine and excess oil.',
                },
                why_it_stands_out: [
                  {
                    headline: 'Oil-control formula',
                    body: 'Pairs niacinamide with zinc for a focused oil-control serum step.',
                  },
                ],
                best_for: [
                  {
                    label: 'Oily or combination skin',
                  },
                ],
              },
              shopping_card: {
                contract_version: 'pivota.shopping_card.v1',
                title: 'The Ordinary Niacinamide 10% + Zinc 1%',
                subtitle: 'Oil-control serum',
                intro: 'A lightweight niacinamide serum for visible shine and excess oil.',
              },
            },
          },
        },
      ],
      {
        targetContext: {
          resolved_target_step: 'treatment',
          primary_role_id: 'oil_control_treatment',
          framework_roles: [
            {
              role_id: 'oil_control_treatment',
              label: 'Oil-control treatment',
              rank: 1,
              preferred_step: 'treatment',
            },
          ],
        },
        language: 'EN',
      },
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].brand, 'The Ordinary');
    assert.equal(rows[0].image_url, 'https://cdn.shopify.com/s/files/1/0944/6998/0488/files/89K57102_S2.webp?v=1770439122');
    assert.deepEqual(rows[0].price, { amount: 12, currency: 'USD', unknown: false });
    assert.equal(rows[0].short_description, 'Helps reduce visible shine without feeling heavy.');
    assert.equal(rows[0].description, 'Daily serum for oily skin that targets excess sebum.');
    assert.equal(rows[0].url, 'https://agent.pivota.cc/products/9886499864904?merchant_id=merch_efbc46b4619cfbdf&entry=creator_agent');
    assert.equal(rows[0].pdp_url, 'https://agent.pivota.cc/products/9886499864904?merchant_id=merch_efbc46b4619cfbdf&entry=creator_agent');
    assert.equal(rows[0].product_url, 'https://agent.pivota.cc/products/9886499864904?merchant_id=merch_efbc46b4619cfbdf&entry=creator_agent');
    assert.equal(rows[0].pivota_insights.what_it_is, 'A lightweight niacinamide serum for visible shine and excess oil.');
    assert.deepEqual(rows[0].pivota_insights.why_it_stands_out, [
      {
        headline: 'Oil-control formula',
        body: 'Pairs niacinamide with zinc for a focused oil-control serum step.',
      },
    ]);
    assert.deepEqual(rows[0].compare_highlights, [
      'Pairs niacinamide with zinc for a focused oil-control serum step.',
      'Suited for Oily or combination skin',
      'Oil-control serum',
    ]);
    assert.doesNotMatch(
      [
        rows[0].best_for,
        rows[0].why_this_one,
        ...(Array.isArray(rows[0].compare_highlights) ? rows[0].compare_highlights : []),
      ].join(' '),
      /\b(?:best|top|most|strongest|perfect|ideal)\b/i,
    );
    assert.equal(rows[0].shopping_card.title, 'The Ordinary Niacinamide 10% + Zinc 1%');
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco hydrates selected card evidence from product intel KB', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  const productIntelKbStore = require('../src/auroraBff/productIntelKbStore');
  try {
    productIntelKbStore.__internal.clearMemoryCacheForTest();
    await productIntelKbStore.upsertProductIntelKbEntry({
      kb_key: 'product:hydrated_reco_pick',
      analysis: {
        product_intel_v1: {
          contract_version: 'pivota.product_intel.v1',
          product_intel_core: {
            what_it_is: {
              body: 'A seller-grounded serum for visible shine and excess oil.',
            },
            why_it_stands_out: [
              {
                headline: 'Niacinamide + zinc pairing',
                body: 'Pairs niacinamide with zinc PCA for oily-skin shine and visible pore concerns.',
              },
            ],
            best_for: [
              {
                label: 'Excess oil or midday shine',
              },
            ],
          },
          shopping_card: {
            title: 'Hydrated Reco Pick',
            subtitle: 'Oil-control serum',
            intro: 'A focused serum for excess oil and visible pores.',
          },
        },
      },
      source_meta: {
        review_tier: 'assistant_reviewed',
      },
      last_success_at: new Date().toISOString(),
    });

    const hydrated = await __internal.hydrateRecoCandidatesProductIntelFromKb([
      {
        product_id: 'hydrated_reco_pick',
        merchant_id: 'merchant_demo',
        display_name: 'Hydrated Reco Pick',
        category: 'Serum',
      },
    ]);
    const rows = __internal.buildRecoRowsFromMainlineProducts(hydrated, {
      targetContext: {
        resolved_target_step: 'treatment',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            label: 'Oil-control treatment',
            rank: 1,
            preferred_step: 'treatment',
          },
        ],
      },
      language: 'EN',
    });

    assert.equal(hydrated[0].metadata.product_intel_kb_used, true);
    assert.equal(rows[0].product_intel.contract_version, 'pivota.product_intel.v1');
    assert.equal(rows[0].pivota_insights.what_it_is, 'A seller-grounded serum for visible shine and excess oil.');
    assert.deepEqual(rows[0].compare_highlights, [
      'Pairs niacinamide with zinc PCA for oily-skin shine and visible pore concerns.',
      'Suited for Excess oil or midday shine',
      'Oil-control serum',
    ]);
    assert.equal(rows[0].why_this_one, 'Pairs niacinamide with zinc PCA for oily-skin shine and visible pore concerns.');
  } finally {
    productIntelKbStore.__internal.clearMemoryCacheForTest();
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco skips product intel hydration when remaining budget is already exhausted', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const row = {
      product_id: 'budget_exhausted_hydration_pick',
      merchant_id: 'merchant_demo',
      display_name: 'Budget Exhausted Hydration Pick',
      category: 'Serum',
    };
    const hydrated = await __internal.hydrateRecoCandidatesProductIntelFromKb(
      [row],
      { deadlineAtMs: Date.now() + 10 },
    );

    assert.deepEqual(hydrated, [row]);
    assert.equal(hydrated[0]?.metadata?.product_intel_kb_used, undefined);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco rows derive stable brand and shopper fields when source row is sparse', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rows = __internal.buildRecoRowsFromMainlineProducts(
      [
        {
          product_id: '9886499864904',
          merchant_id: 'merch_efbc46b4619cfbdf',
          display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
          category: 'Serum',
        },
      ],
      {
        targetContext: {
          resolved_target_step: 'treatment',
          primary_role_id: 'oil_control_treatment',
          framework_roles: [
            {
              role_id: 'oil_control_treatment',
              label: 'Oil-control treatment',
              rank: 1,
              preferred_step: 'treatment',
              why_this_role: 'Reduce excess sebum and visible shine first.',
            },
          ],
        },
        language: 'EN',
      },
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].brand, 'The Ordinary');
    assert.equal(rows[0].name, 'The Ordinary Niacinamide 10% + Zinc 1%');
    assert.match(String(rows[0].best_for || ''), /excess oil|mid-day shine/i);
    assert.match(String(rows[0].why_this_one || ''), /lightweight|shine/i);
    assert.deepEqual(rows[0].key_features, ['Niacinamide 10%', 'Zinc 1%', 'Oil-control support', 'Lightweight serum']);
    assert.equal(rows[0].short_description, rows[0].why_this_one);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco rows use reviewed barrier best-for copy instead of generic hydration copy', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rows = __internal.buildRecoRowsFromMainlineProducts(
      [
        {
          product_id: 'haruharu_barrier_cream',
          merchant_id: 'external_seed',
          brand: 'Haruharu Wonder',
          display_name: '5 Ceramide Barrier Moisturizing Cream / Unscented',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          key_ingredients: ['Ceramide NP'],
          product_intel: {
            product_intel_core: {
              best_for: [
                { tag: 'barrier_support', label: 'Barrier-supportive moisturizer routines' },
                { tag: 'rich_moisture', label: 'Richer cream preferences' },
              ],
              why_it_stands_out: [
                {
                  headline: 'Ceramide-capsule cream format',
                  body: 'The visible ceramide-capsule concept makes this more of a barrier-focused cream than a simple lightweight daily moisturizer.',
                },
              ],
              what_it_is: {
                body: 'A richer moisturizing cream built around ceramide capsules and barrier-focused hydration.',
              },
            },
          },
        },
      ],
      {
        targetContext: {
          resolved_target_step: 'moisturizer',
          primary_role_id: 'barrier_moisturizer',
          framework_roles: [
            {
              role_id: 'barrier_moisturizer',
              label: 'Barrier-support moisturizer',
              rank: 1,
              preferred_step: 'moisturizer',
              why_this_role: 'Support impaired barrier comfort with a repair moisturizer.',
            },
          ],
        },
        language: 'EN',
      },
    );

    assert.equal(rows.length, 1);
    assert.match(String(rows[0].best_for || ''), /barrier-supportive|richer cream/i);
    assert.doesNotMatch(String(rows[0].best_for || ''), /lightweight hydration without a greasy finish/i);
    assert.match(String(rows[0].why_this_one || ''), /ceramide|barrier-focused|barrier/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco rows do not promote standalone ingredients into why copy', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rows = __internal.buildRecoRowsFromMainlineProducts(
      [
        {
          product_id: 'fab_dark_spot_sparse',
          merchant_id: 'merch_efbc46b4619cfbdf',
          brand: 'First Aid Beauty',
          display_name: 'Dark Spot Serum with Niacinamide',
          category: 'Serum',
          product_type: 'Serum',
          matched_role_id: 'tone_mark_treatment',
          matched_role_label: 'Tone and post-breakout mark treatment',
          key_ingredients: ['Glycerin', 'Niacinamide', 'Panthenol (B5)'],
        },
      ],
      {
        targetContext: {
          resolved_target_step: 'treatment',
          primary_role_id: 'tone_mark_treatment',
          framework_roles: [
            {
              role_id: 'tone_mark_treatment',
              label: 'Tone and post-breakout mark treatment',
              rank: 11,
              preferred_step: 'treatment',
              why_this_role: 'Target post-breakout marks, uneven tone, and dark spots.',
            },
          ],
        },
        language: 'EN',
      },
    );

    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].why_this_one, 'Glycerin');
    assert.doesNotMatch(String(rows[0].why_this_one || ''), /^Glycerin$/i);
    assert.match(String(rows[0].why_this_one || ''), /post-breakout|tone|dark spot|Niacinamide/i);
    assert.match(String(rows[0].short_description || ''), /post-breakout|tone|dark spot|Niacinamide/i);
    assert.ok(rows[0].key_features.includes('Glycerin'));

    const payload = __internal.applyRecoContentSpineToPayload(
      {
        recommendations: rows,
        roles: [
          {
            role_id: 'tone_mark_treatment',
            label: 'Tone and post-breakout mark treatment',
            preferred_step: 'treatment',
            why_this_role: 'Target post-breakout marks, uneven tone, and dark spots.',
          },
        ],
        recommendation_meta: {
          selected_target_ids: ['tone_mark_treatment'],
          ranked_targets: [{ target_id: 'tone_mark_treatment' }],
          primary_target_id: 'tone_mark_treatment',
        },
      },
      {
        primary_target_id: 'tone_mark_treatment',
        selected_target_ids: ['tone_mark_treatment'],
        ranked_targets: [{ target_id: 'tone_mark_treatment' }],
        resolved_target_step: 'treatment',
      },
    );
    const prompt = __internal.buildRecoAssistantRewritePrompt({
      payload,
      language: 'EN',
      profile: {},
      userRequestText: 'I have post-breakout marks. What should I buy?',
    });
    const context = JSON.parse(prompt.match(/Context: (\{[\s\S]*\})$/)[1]);
    const [detail] = context.selected_product_details;
    assert.ok(detail.evidence_points.some((item) => /post-breakout|tone|dark spot|Niacinamide/i.test(item)));
    assert.equal(detail.evidence_points.includes('Glycerin'), false);
    assert.equal(detail.evidence_points.includes('Lightweight serum'), false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco rows filter off-role active features for hydrating support cards', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rows = __internal.buildRecoRowsFromMainlineProducts(
      [
        {
          product_id: 'naturium_hydra_ha_1',
          merchant_id: 'external_seed',
          brand: 'Naturium',
          display_name: 'Quadruple Hyaluronic Acid Serum 5% - Jumbo',
          category: 'Serum',
          product_type: 'Serum',
          matched_role_id: 'hydrating_serum_or_essence',
          matched_role_label: 'Hydrating serum or essence',
          matched_role_rank: 42,
          retrieval_source: 'external_seed',
          key_ingredients: ['Hyaluronic acid', 'Niacinamide', 'Salicylic acid', 'Azelaic acid', 'Alpha Arbutin'],
          short_description: 'A hydrating serum with hyaluronic acid and glycerin for dehydrated skin.',
        },
      ],
      {
        targetContext: {
          resolved_target_step: 'serum',
          primary_role_id: 'hydrating_barrier_moisturizer',
          framework_roles: [
            {
              role_id: 'hydrating_barrier_moisturizer',
              label: 'Hydrating barrier moisturizer',
              rank: 40,
              preferred_step: 'moisturizer',
            },
            {
              role_id: 'hydrating_serum_or_essence',
              label: 'Hydrating serum or essence',
              rank: 42,
              preferred_step: 'serum',
              why_this_role: 'Use a hydration layer when skin feels dehydrated, dull, tight, or water-deficient.',
            },
          ],
        },
        language: 'EN',
      },
    );

    assert.equal(rows.length, 1);
    assert.ok(rows[0].key_features.includes('Hyaluronic acid'));
    assert.ok(rows[0].key_features.includes('Niacinamide'));
    assert.ok(rows[0].key_features.includes('Quadruple Hyaluronic Acid Serum 5%'));
    assert.equal(rows[0].key_features.includes('Salicylic acid'), false);
    assert.equal(rows[0].key_features.includes('Azelaic acid'), false);
    assert.equal(rows[0].key_features.includes('Alpha Arbutin'), false);
    assert.equal(rows[0].key_features.includes('Quadruple Hyaluronic Acid Serum 5% - Jumbo'), false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco rows prefer product-specific description snippets over generic role copy when raw row is sparse', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rows = __internal.buildRecoRowsFromMainlineProducts(
      [
        {
          product_id: '10008793153864',
          merchant_id: 'merch_efbc46b4619cfbdf',
          display_name: 'KraveBeauty Great Barrier Relief',
          category: 'treatment',
          sku: {
            description: '<p>A barrier-repair serum for over-sensitized or irritated skin, built around tamanu oil, niacinamide, and ceramides to calm the look of redness.</p>',
            framework_score: 0.44,
            framework_semantic_fit: true,
            comparison_fill_reason: 'same_role_soft_mismatch',
          },
        },
      ],
      {
        targetContext: {
          resolved_target_step: 'treatment',
          primary_role_id: 'oil_control_treatment',
          framework_roles: [
            {
              role_id: 'oil_control_treatment',
              label: 'Oil-control treatment',
              rank: 1,
              preferred_step: 'treatment',
              why_this_role: 'Reduce excess sebum and visible shine first.',
            },
          ],
        },
        language: 'EN',
      },
    );

    assert.equal(rows.length, 1);
    assert.match(String(rows[0].short_description || ''), /barrier-repair serum/i);
    assert.match(String(rows[0].why_this_one || ''), /barrier-repair serum/i);
    assert.doesNotMatch(String(rows[0].short_description || ''), /take down excess shine without making the routine feel heavier/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline reco rows surface support retrieval stage and preserve sunscreen display step', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rows = __internal.buildRecoRowsFromMainlineProducts(
      [
        {
          product_id: 'ext_support_spf_1',
          merchant_id: 'external_seed',
          display_name: 'UV Filters SPF 45 Serum',
          category: 'Serum',
          product_type: 'Serum',
          matched_role_id: 'daily_sunscreen',
          matched_role_label: 'Daily sunscreen',
          matched_role_rank: 3,
          retrieval_source: 'external_seed',
          retrieval_reason: 'external_seed_local_search:support_recall_title',
          retrieval_match_stage: 'support_recall_title',
          retrieval_match_score: 48,
          sku: {
            brand: 'The Ordinary',
            price: { amount: 19, currency: 'USD', unknown: false },
            retrieval_match_stage: 'support_recall_title',
          },
        },
      ],
      {
        targetContext: {
          resolved_target_step: 'treatment',
          primary_role_id: 'oil_control_treatment',
          framework_roles: [
            {
              role_id: 'oil_control_treatment',
              label: 'Oil-control treatment',
              rank: 1,
              preferred_step: 'treatment',
            },
            {
              role_id: 'daily_sunscreen',
              label: 'Daily sunscreen',
              rank: 3,
              preferred_step: 'sunscreen',
            },
          ],
        },
        language: 'EN',
      },
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].matched_role_id, 'daily_sunscreen');
    assert.equal(rows[0].retrieval_match_stage, 'support_recall_title');
    assert.equal(rows[0].retrieval_match_score, 48);
    assert.equal(rows[0].category, 'sunscreen');
    assert.equal(rows[0].product_type, 'sunscreen');
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty mainline final selection titles stay de-duplicated when display name already includes brand', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const selection = __internal.buildRecoFinalSelectionContract({
      payload: {
        recommendations: [
          {
            product_id: '9886499864904',
            merchant_id: 'merch_efbc46b4619cfbdf',
            brand: 'The Ordinary',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            category: 'Serum',
          },
        ],
      },
    });

    assert.deepEqual(selection.selected_titles, ['The Ordinary Niacinamide 10% + Zinc 1%']);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty canonical ownership recomputes final selection from surfaced recommendations', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const pollutedSelection = {
      selection_owner: 'shopping_agent_beauty_mainline',
      selected_product_ids: [
        '9886499864904',
        '9886500749640',
        '9859782246728',
        '9859793420616',
        '9859789455688',
      ],
      selected_titles: [
        'The Ordinary Niacinamide 10% + Zinc 1%',
        'Winona Soothing Repair Serum',
        'Small Foundation Brush',
        'Small Eyeshadow Brush',
        'Small Eyeshadow Brush 2',
      ],
      selection_signature: 'legacy_polluted_sig',
      mainline_status: 'grounded_success',
      source_tier_counts: { fresh_internal: 2, cache_fresh: 4 },
      top_candidate_provenance: { source_owner: 'cache_all_platforms' },
    };

    const envelope = {
      assistant_message: {
        role: 'assistant',
        content: 'Products actually selected this time: Small Foundation Brush, Small Eyeshadow Brush.',
      },
      cards: [
        {
          card_id: 'reco_test',
          type: 'recommendations',
          payload: {
            intent: 'reco_products',
            mainline_status: 'grounded_success',
            recommendations: [
              {
                product_id: '9886499864904',
                display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
                category: 'Serum',
                matched_role_id: 'oil_control_treatment',
              },
              {
                product_id: '9886500749640',
                display_name: 'Winona Soothing Repair Serum',
                category: 'Serum',
                matched_role_id: 'oil_control_treatment',
              },
            ],
            recommendation_meta: {
              mainline_status: 'needs_more_context',
              beauty_mainline_handoff_applied: true,
              beauty_mainline_handoff_owner: 'shopping_agent_beauty_mainline',
              final_selection: pollutedSelection,
            },
            metadata: {
              mainline_status: 'grounded_success',
              final_selection: pollutedSelection,
            },
          },
        },
      ],
    };

    const out = __internal.applyBeautyCanonicalOwnershipToEnvelope({
      envelope,
      route: 'reco',
      assistantText: envelope.assistant_message.content,
      profile: { skinType: 'oily', goals: ['oil control'] },
    });

    const recoCard = out.cards[0];
    const payload = recoCard.payload;
    const finalSelection = payload.metadata.final_selection;

    assert.deepEqual(
      finalSelection.selected_product_ids,
      ['9886499864904', '9886500749640'],
    );
    assert.deepEqual(
      payload.recommendation_meta.final_selection.selected_product_ids,
      ['9886499864904', '9886500749640'],
    );
    assert.equal(payload.metadata.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta.mainline_status, 'grounded_success');
    assert.equal(out.mainline_status, 'grounded_success');
    assert.equal(out.recommendation_meta.mainline_status, 'grounded_success');
    assert.equal(
      payload.recommendation_meta.assistant_text_selection_signature,
      finalSelection.selection_signature,
    );
    assert.match(String(out.assistant_message.content || ''), /Niacinamide|Winona/i);
    assert.doesNotMatch(String(out.assistant_message.content || ''), /Brush/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty canonical ownership keeps beauty mainline reco card-only when assistant rewrite fails', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        query_source: 'beauty_mainline_local_handoff',
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner: 'shopping_agent_beauty_mainline',
        recommendations: [
          {
            product_id: '9886499864904',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            category: 'Serum',
            matched_role_id: 'oil_control_treatment',
          },
        ],
        recommendation_meta: {
          source_mode: 'framework_mainline',
          resolved_contract: 'agent_v1_search_beauty_mainline',
          mainline_status: 'grounded_success',
          assistant_rewrite_llm_used: false,
          assistant_rewrite_reason: 'PARSE_TRUNCATED_JSON',
        },
        metadata: {
          resolved_contract: 'agent_v1_search_beauty_mainline',
        },
      },
      {
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );

    const out = __internal.applyBeautyCanonicalOwnershipToEnvelope({
      envelope: {
        assistant_message: null,
        cards: [
          {
            card_id: 'reco_test',
            type: 'recommendations',
            payload,
          },
        ],
        session_patch: {
          state: {
            latest_reco_context: {
              primary_target_id: 'oil_control_treatment',
              ranked_targets: [
                {
                  target_id: 'oil_control_treatment',
                  ingredient_query: 'Oil-control treatment',
                  resolved_target_step: 'treatment',
                },
              ],
              selected_target_ids: ['oil_control_treatment'],
            },
          },
        },
      },
      route: 'chat',
      assistantText: '',
      profile: { skinType: 'oily', goals: ['oil control'] },
    });

    assert.equal(out.assistant_message, null);
    assert.equal(out.meta?.canonical_ownership?.audit?.assistant_copy_strategy, 'card_only');
    assert.equal(out.meta?.canonical_ownership?.drift?.assistant_payload_mismatch, false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty canonical ownership preserves successful beauty mainline rewrite text', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = __internal.applyRecoContentSpineToPayload(
      {
        query_source: 'beauty_mainline_local_handoff',
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner: 'shopping_agent_beauty_mainline',
        recommendations: [
          {
            product_id: '9886499864904',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            category: 'Serum',
            matched_role_id: 'oil_control_treatment',
          },
        ],
        recommendation_meta: {
          source_mode: 'framework_mainline',
          resolved_contract: 'agent_v1_search_beauty_mainline',
          mainline_status: 'grounded_success',
          assistant_rewrite_llm_used: true,
          assistant_rewrite_reason: 'ok',
        },
        metadata: {
          resolved_contract: 'agent_v1_search_beauty_mainline',
        },
      },
      {
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    const assistantText =
      'For oily skin, buy The Ordinary Niacinamide 10% + Zinc 1% first. Start with one serum and keep the rest of your routine stable.';

    const out = __internal.applyBeautyCanonicalOwnershipToEnvelope({
      envelope: {
        assistant_message: {
          role: 'assistant',
          content: assistantText,
          format: 'text',
        },
        cards: [
          {
            card_id: 'reco_test',
            type: 'recommendations',
            payload,
          },
        ],
      },
      route: 'chat',
      assistantText,
      profile: { skinType: 'oily', goals: ['oil control'] },
    });

    assert.equal(out.assistant_message?.content, assistantText);
    assert.equal(out.meta?.canonical_ownership?.audit?.assistant_copy_strategy, 'llm_rewrite');
    assert.equal(out.meta?.canonical_ownership?.drift?.assistant_payload_mismatch, false);
    assert.doesNotMatch(String(out.assistant_message?.content || ''), /Primary recommendation focus|Products actually selected this time/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty canonical ownership does not let stale mainline final selection suppress selected rewrite text', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const staleSelection = {
      selection_owner: 'shopping_agent_beauty_mainline',
      selected_product_ids: ['dark_spot_serum'],
      selected_titles: ['First Aid Beauty Dark Spot Serum with Niacinamide'],
      selection_signature: 'stale_dark_spot_only',
      mainline_status: 'grounded_success',
    };
    const assistantText =
      'First Aid Beauty Dark Spot Serum with Niacinamide fits this request for post-breakout marks. Jurlique Brightening Serum is the supporting brightening option if you want a second serum comparison.';
    const payload = {
      query_source: 'beauty_mainline_local_handoff',
      decision_owner: 'shopping_agent_beauty_mainline',
      semantic_owner: 'shopping_agent_beauty_mainline',
      recommendations: [
        {
          product_id: 'dark_spot_serum',
          brand: 'First Aid Beauty',
          display_name: 'Dark Spot Serum with Niacinamide',
          category: 'Serum',
          matched_role_id: 'tone_mark_treatment',
        },
        {
          product_id: 'jurlique_brightening',
          brand: 'Jurlique',
          display_name: 'Brightening Serum',
          category: 'Serum',
          matched_role_id: 'tone_mark_treatment',
        },
      ],
      recommendation_meta: {
        source_mode: 'framework_mainline',
        resolved_contract: 'agent_v1_search_beauty_mainline',
        mainline_status: 'grounded_success',
        assistant_rewrite_llm_used: true,
        assistant_rewrite_reason: 'ok',
        final_selection: staleSelection,
        ranked_targets: [
          {
            target_id: 'tone_mark_treatment',
            product_candidates: [
              {
                product_id: 'jurlique_brightening',
                brand: 'Jurlique',
                display_name: 'Brightening Serum',
              },
            ],
          },
        ],
      },
      metadata: {
        resolved_contract: 'agent_v1_search_beauty_mainline',
        final_selection: staleSelection,
      },
    };

    const out = __internal.applyBeautyCanonicalOwnershipToEnvelope({
      envelope: {
        assistant_message: {
          role: 'assistant',
          content: assistantText,
          format: 'text',
        },
        cards: [
          {
            card_id: 'reco_test',
            type: 'recommendations',
            payload,
          },
        ],
      },
      route: 'chat',
      assistantText,
      profile: { skinType: 'oily', goals: ['post-breakout marks'] },
    });

    const recoPayload = out.cards[0].payload;
    assert.equal(out.assistant_message?.content, assistantText);
    assert.deepEqual(
      recoPayload.recommendations.map((row) => row.product_id),
      ['dark_spot_serum', 'jurlique_brightening'],
    );
    assert.deepEqual(
      recoPayload.recommendation_meta.final_selection.selected_product_ids,
      ['dark_spot_serum', 'jurlique_brightening'],
    );
    assert.deepEqual(
      recoPayload.metadata.final_selection.selected_product_ids,
      ['dark_spot_serum', 'jurlique_brightening'],
    );
    assert.equal(
      recoPayload.recommendation_meta.assistant_text_selection_signature,
      recoPayload.recommendation_meta.final_selection.selection_signature,
    );
    assert.equal(recoPayload.recommendation_meta.assistant_visible_suppressed_reason, undefined);
  } finally {
    delete require.cache[moduleId];
  }
});

test('canonical search result mirror keeps payload-bound assistant text when canonical target bundle is present', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = {
      recommendations: [
        {
          product_id: 'generic_plain_text_1',
          display_name: 'GoalSkin Oil Control Serum',
          category: 'Serum',
          matched_role_id: 'oil_control_treatment',
        },
      ],
      roles: [
        {
          role_id: 'oil_control_treatment',
          label: 'Oil-control treatment',
          rank: 1,
          why_this_role: 'Reduce excess sebum.',
        },
      ],
      framework_summary: {
        concern_text: 'oily skin',
        primary_role_id: 'oil_control_treatment',
      },
      recommendation_meta: {
        beauty_mainline_handoff_applied: true,
      },
      metadata: {},
    };
    const searchResult = {
      decision_owner: 'shopping_agent_beauty_mainline',
      semantic_owner: 'shopping_agent_beauty_mainline',
      query_source: 'agent_products_search',
      metadata: {
        contract_bridge: {
          attempted_contract: 'agent_v1_search_beauty_mainline',
          resolved_contract: 'agent_v1_search_beauty_mainline',
        },
        source_breakdown: {
          source_tier_counts: { fresh_internal: 1 },
          top_candidate_provenance: { source_owner: 'internal_search' },
        },
        search_stage_ledger: {
          primary_search: {
            query_pack_attempts: [
              { query: 'oil control treatment', adopted: true, result_count: 1 },
            ],
          },
          final_selection: {
            selection_owner: 'shopping_agent_beauty_mainline',
            selected_product_ids: ['generic_plain_text_1'],
            selected_titles: ['GoalSkin Oil Control Serum'],
            selection_signature: 'selection_sig_payload_bound',
            mainline_status: 'grounded_success',
            source_tier_counts: { fresh_internal: 1 },
            top_candidate_provenance: { source_owner: 'internal_search' },
          },
        },
      },
    };

    const mirrored = __internal.applyRecoContentSpineToPayload(
      __internal.applyRecoCanonicalSearchResultToPayload(payload, searchResult, {
        selectionOwner: 'shopping_agent_beauty_mainline',
      }),
      {
        resolved_target_step: 'treatment',
        primary_target_id: 'oil_control_treatment',
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            target_role: 'primary',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
            product_candidates: [
              {
                product_id: 'generic_plain_text_1',
                display_name: 'GoalSkin Oil Control Serum',
              },
            ],
          },
        ],
        selected_target_ids: ['oil_control_treatment'],
      },
    );
    const assistantText = __internal.buildPayloadBoundRecoAssistantText({
      payload: mirrored,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
    });
    const routeAwareText = __internal.buildRouteAwareAssistantText({
      route: 'reco',
      payload: mirrored,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
    });

    assert.equal(mirrored.metadata?.contract_bridge?.resolved_contract, 'agent_v1_search_beauty_mainline');
    assert.deepEqual(mirrored.metadata?.search_stage_ledger?.final_selection?.selected_product_ids, ['generic_plain_text_1']);
    assert.equal(mirrored.recommendation_meta?.assistant_text_selection_signature, undefined);
    assert.equal(mirrored.recommendation_meta?.primary_target_id, 'oil_control_treatment');
    assert.deepEqual(mirrored.recommendation_meta?.selected_target_ids, ['oil_control_treatment']);
    assert.match(String(assistantText || ''), /Products actually selected this time: GoalSkin Oil Control Serum\./i);
    assert.equal(routeAwareText, assistantText);
    assert.match(String(routeAwareText || ''), /Primary recommendation focus: keep this pass centered on Oil-control treatment\./i);
    assert.doesNotMatch(String(routeAwareText || ''), /Priority order:|care framework|Top pick for that first role/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('payload-bound assistant text does not reconstruct target labels from framework summary when canonical targets are missing', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = {
        recommendations: [
          {
            product_id: 'generic_plain_text_1',
            display_name: 'GoalSkin Oil Control Serum',
            category: 'Serum',
            matched_role_id: 'oil_control_treatment',
          },
        ],
        roles: [
          {
            role_id: 'oil_control_treatment',
            label: 'Oil-control treatment',
            rank: 1,
            why_this_role: 'Reduce excess sebum.',
            preferred_step: 'treatment',
          },
        ],
        framework_summary: {
          concern_text: 'oily skin',
          primary_role_id: 'oil_control_treatment',
          primary_role_label: 'Oil-control treatment',
        },
        recommendation_meta: {
          beauty_mainline_handoff_applied: true,
        },
      };
    const assistantText = __internal.buildPayloadBoundRecoAssistantText({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
    });
    const routeAwareText = __internal.buildRouteAwareAssistantText({
      route: 'reco',
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
    });

    assert.match(String(assistantText || ''), /Products actually selected this time: GoalSkin Oil Control Serum\./i);
    assert.doesNotMatch(String(assistantText || ''), /Oil-control treatment/i);
    assert.match(String(assistantText || ''), /skincare product/i);
    assert.equal(routeAwareText, assistantText);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty handoff payload builder replaces mixed planner rows with canonical selected set', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.buildRecoPayloadFromBeautyMainlineHandoff({
      handoff: {
        recommendations: [
          {
            product_id: '9886499864904',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            category: 'Serum',
          },
          {
            product_id: '9886500749640',
            display_name: 'Winona Soothing Repair Serum',
            category: 'Serum',
          },
        ],
        searchResult: {
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
          query_source: 'agent_products_search',
          metadata: {
            contract_bridge: {
              attempted_contract: 'agent_v1_search_beauty_mainline',
              resolved_contract: 'agent_v1_search_beauty_mainline',
            },
            source_breakdown: {
              source_tier_counts: { fresh_internal: 1, fresh_external: 1 },
              top_candidate_provenance: { source_owner: 'internal_search' },
            },
            search_stage_ledger: {
              final_selection: {
                selection_owner: 'shopping_agent_beauty_mainline',
                selected_product_ids: ['9886499864904'],
                selected_titles: ['The Ordinary Niacinamide 10% + Zinc 1%'],
                selection_signature: 'sel_niacinamide_only',
                mainline_status: 'grounded_success',
                source_tier_counts: { fresh_internal: 1, fresh_external: 1 },
                top_candidate_provenance: { source_owner: 'internal_search' },
              },
            },
          },
        },
      },
      profile: { skinType: 'oily', goals: ['oil control'] },
      targetContext: {
        resolved_target_step: 'treatment',
        resolved_target_step_confidence: 'high',
        resolved_target_step_source: 'analysis_ingredient_plan',
      },
      recoContext: {
        resolved_target_step: 'treatment',
      },
      taskMode: 'goal_based_products',
      triggerSource: 'text_freeform',
      sourceMode: 'step_aware_mainline',
      basePayload: {
        recommendation_confidence_score: 0.73,
        recommendation_confidence_level: 'medium',
        recommendation_meta: {
          used_recent_logs: true,
        },
      },
      selectionOwner: 'shopping_agent_beauty_mainline',
      entryType: 'chat',
    });

    assert.deepEqual(
      out?.payload?.recommendations?.map((item) => item.product_id),
      ['9886499864904'],
    );
    assert.deepEqual(
      out?.payload?.metadata?.final_selection?.selected_product_ids,
      ['9886499864904'],
    );
    assert.equal(out?.payload?.recommendation_meta?.resolved_contract, 'agent_v1_search_beauty_mainline');
    assert.equal(out?.payload?.recommendation_meta?.semantic_owner, 'shopping_agent_beauty_mainline');
    assert.deepEqual(
      out?.payload?.recommendation_meta?.source_tier_counts,
      { fresh_internal: 1, fresh_external: 1 },
    );
    assert.equal(out?.recoContext?.owner_source, 'shopping_agent_beauty_mainline');
    assert.equal(out?.recoContext?.final_outcome_owner, 'shopping_agent_beauty_mainline');
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty handoff payload builder keeps non-active gel moisturizers when no-additional-active compare prunes active-forward options', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.buildRecoPayloadFromBeautyMainlineHandoff({
      handoff: {
        recommendations: [
          {
            product_id: 'ext_9bc7ff02d709cc5383cc78ec',
            merchant_id: 'external_seed',
            display_name: 'Ultra Repair Face Lotion with Colloidal Oatmeal',
            brand: 'First Aid Beauty',
            matched_role_id: 'hydrating_barrier_moisturizer',
            why_this_one: 'Dryness or barrier support',
          },
          {
            product_id: 'ext_a29393bd005135c81f47dade',
            merchant_id: 'external_seed',
            display_name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
            brand: 'First Aid Beauty',
            matched_role_id: 'hydrating_barrier_moisturizer',
            why_this_one: 'Oily or combination skin needing hydration',
            description: 'Perfect for oily and combo skin, the ultra-sheer formula uses hyaluronic acid, ceramides, squalane and niacinamide to support the moisture barrier.',
          },
          {
            product_id: 'ext_62685854dfc71d2634e828e6',
            merchant_id: 'external_seed',
            display_name: 'Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen',
            brand: 'First Aid Beauty',
            matched_role_id: 'hydrating_barrier_moisturizer',
            why_this_one: 'Dryness or barrier support',
            product_intel: {
              shopping_card: {
                highlight: 'With peptides + niacinamide',
              },
            },
          },
        ],
        searchResult: {
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
          query_source: 'agent_products_search',
          contract_bridge: {
            resolved_contract: 'agent_v1_search_beauty_mainline',
          },
          source_breakdown: {
            source_tier_counts: { fresh_external: 3 },
            top_candidate_provenance: { source_owner: 'external_seed' },
          },
          final_selection: {
            selection_owner: 'shopping_agent_beauty_mainline',
            selected_product_ids: [
              'ext_9bc7ff02d709cc5383cc78ec',
              'ext_a29393bd005135c81f47dade',
              'ext_62685854dfc71d2634e828e6',
            ],
            selected_titles: [
              'Ultra Repair Face Lotion with Colloidal Oatmeal',
              'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
              'Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen',
            ],
            mainline_status: 'grounded_success',
            source_tier_counts: { fresh_external: 3 },
          },
        },
      },
      profile: { skinType: 'dry', goals: ['barrier support'] },
      targetContext: {
        primary_role_id: 'hydrating_barrier_moisturizer',
        comparison_mode: 'same_role_comparison',
        routine_mode: 'same_role_comparison',
        request_text: 'What moisturizer product should I buy next? I do not want another active.',
        semantic_plan: {
          comparison_mode: 'same_role_comparison',
          routine_mode: 'same_role_comparison',
          must_satisfy_constraints: [
            'must not contain active treatment ingredients',
            'moisturizer-only same-slot comparison',
          ],
        },
        framework_roles: [
          {
            role_id: 'hydrating_barrier_moisturizer',
            label: 'Hydrating barrier moisturizer',
            rank: 1,
            preferred_step: 'moisturizer',
          },
        ],
      },
      recoContext: {
        resolved_target_step: 'moisturizer',
      },
      taskMode: 'goal_based_products',
      triggerSource: 'analysis_handoff',
      sourceMode: 'framework_mainline',
      selectionOwner: 'shopping_agent_beauty_mainline',
      entryType: 'chat',
    });

    assert.deepEqual(
      out?.payload?.recommendations?.map((item) => item.product_id),
      [
        'ext_9bc7ff02d709cc5383cc78ec',
        'ext_a29393bd005135c81f47dade',
      ],
    );
    assert.deepEqual(
      out?.payload?.recommendation_meta?.final_selection?.selected_product_ids,
      [
        'ext_9bc7ff02d709cc5383cc78ec',
        'ext_a29393bd005135c81f47dade',
      ],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty handoff payload builder fails closed when framework roles cannot materialize a canonical target bundle', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.buildRecoPayloadFromBeautyMainlineHandoff({
      handoff: {
        recommendations: [
          {
            product_id: 'generic_plain_text_1',
            display_name: 'GoalSkin Oil Control Serum',
            category: 'Serum',
          },
        ],
        searchResult: {
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
          query_source: 'agent_products_search',
          metadata: {
            contract_bridge: {
              attempted_contract: 'agent_v1_search_beauty_mainline',
              resolved_contract: 'agent_v1_search_beauty_mainline',
            },
            source_breakdown: {
              source_tier_counts: { fresh_internal: 1 },
              top_candidate_provenance: { source_owner: 'internal_search' },
            },
            search_stage_ledger: {
              final_selection: {
                selection_owner: 'shopping_agent_beauty_mainline',
                selected_product_ids: ['generic_plain_text_1'],
                selected_titles: ['GoalSkin Oil Control Serum'],
                selection_signature: 'selection_sig_missing_bundle',
                mainline_status: 'grounded_success',
                source_tier_counts: { fresh_internal: 1 },
                top_candidate_provenance: { source_owner: 'internal_search' },
              },
            },
          },
        },
      },
      profile: { skinType: 'oily', goals: ['oil control'] },
      targetContext: {
        intent_mode: 'generic_concern',
        primary_role_id: 'daily_sunscreen',
        framework_roles: [
          {
            role_id: 'daily_sunscreen',
            label: 'Daily sunscreen',
            rank: 1,
            preferred_step: 'sunscreen',
          },
        ],
      },
      recoContext: {
        resolved_target_step: 'sunscreen',
      },
      taskMode: 'goal_based_products',
      triggerSource: 'text_freeform',
      sourceMode: 'framework_mainline',
      selectionOwner: 'shopping_agent_beauty_mainline',
      entryType: 'chat',
    });

    assert.equal(out, null);
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty handoff payload builder fails closed when canonical authority is missing', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.buildRecoPayloadFromBeautyMainlineHandoff({
      handoff: {
        recommendations: [
          {
            product_id: '9886499864904',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            category: 'Serum',
          },
          {
            product_id: '9886500749640',
            display_name: 'Winona Soothing Repair Serum',
            category: 'Serum',
          },
        ],
        searchResult: {
          products: [
            {
              product_id: '9886499864904',
              display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            },
            {
              product_id: '9886500749640',
              display_name: 'Winona Soothing Repair Serum',
            },
          ],
          metadata: {
            search_stage_ledger: {
              final_selection: {
                selection_owner: 'shopping_agent_beauty_mainline',
                selected_product_ids: ['9886499864904'],
                selected_titles: ['The Ordinary Niacinamide 10% + Zinc 1%'],
                selection_signature: 'sel_missing_canonical_authority',
                mainline_status: 'grounded_success',
              },
            },
          },
        },
      },
      profile: { skinType: 'oily', goals: ['oil control'] },
      selectionOwner: 'shopping_agent_beauty_mainline',
      entryType: 'chat',
    });

    assert.equal(out, null);
  } finally {
    delete require.cache[moduleId];
  }
});
