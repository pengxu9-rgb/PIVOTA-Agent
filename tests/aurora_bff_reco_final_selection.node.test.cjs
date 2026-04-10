const test = require('node:test');
const assert = require('node:assert/strict');

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
    assert.match(prompt, /If request_mode is "buy", the first sentence must directly recommend the selected product by name\./);
    assert.match(prompt, /If request_mode is "buy" and there is one selected product with no secondary targets, use exactly 2 sentences\./);
    assert.match(prompt, /If selected_target_ids has length 1 and secondary_targets is empty, do not add future routine-building suggestions or extra steps\./);
    assert.match(prompt, /Use plain shopper-facing skincare language\. Avoid vague phrases like "surface activity"\./);
    assert.match(prompt, /Avoid generic filler like "great choice", "balanced complexion", or "solution for oiliness"\./);
    assert.match(prompt, /Use selected_product_details\.why_this_one, selected_product_details\.best_for, and selected_product_details\.key_features as the concrete reason layer when available\./);
    assert.match(prompt, /If request_mode is "use_first", use starting-point advice tone\./);
    assert.match(prompt, /"short_description":"Helps reduce visible shine without feeling heavy\."/);
    assert.match(prompt, /"key_features":\[\]/);
    assert.match(prompt, /"price":\{"amount":12,"currency":"USD","unknown":false\}/);
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
          assistant_text: 'For oily skin, buy GoalSkin GoalSkin Oil Control Serum first as your oil-control treatment.',
        },
        parse_status: 'parsed',
        provider: 'gemini',
        effective_model: args.model,
      };
    });

    const rewrite = await __internal.maybeRewriteRecoAssistantTextWithLlm({
      payload,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
      userRequestText: 'What product should I buy?',
      allowLockedSelectionRewrite: true,
    });

    assert.equal(capturedArgs?.thinkingLevel, 'minimal');
    assert.equal(rewrite.llm_used, true);
    assert.match(String(rewrite.text || ''), /GoalSkin GoalSkin Oil Control Serum/);
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
        'Here is the JSON requested:\n{"assistant_text":"For oily skin, buy GoalSkin GoalSkin Oil Control Serum first as your oil-control treatment to keep shine in check',
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
    assert.match(String(rewrite.text || ''), /GoalSkin GoalSkin Oil Control Serum/);
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

test('reco assistant rewrite rejects buy copy that opens without a direct product recommendation', async () => {
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
          'To address your oily skin and manage shine, you should start with a targeted oil-control treatment. I recommend buying GoalSkin Oil Control Serum.',
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
    assert.equal(rewrite.reason, 'rewrite_buy_lead_not_direct');
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

test('beauty mainline reco rows promote visible nested product fields to top level', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
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
