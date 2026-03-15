const test = require('node:test');
const assert = require('node:assert/strict');

const TravelApplyModeSkill = require('../src/auroraBff/skills/travel_apply_mode');
const IngredientReportSkill = require('../src/auroraBff/skills/ingredient_report');
const ProductAnalyzeSkill = require('../src/auroraBff/skills/product_analyze');
const RecoStepBasedSkill = require('../src/auroraBff/skills/reco_step_based');
const { SkillRouter, __internal: skillRouterInternal } = require('../src/auroraBff/orchestrator/skill_router');
const recoHybridResolver = require('../src/auroraBff/usecases/recoHybridResolveCandidates');

test('travel_apply_mode adds reduce_actives when high-UV travel overlaps with retinoid routine', async () => {
  const skill = new TravelApplyModeSkill();
  const gateway = {
    async call() {
      return {
        parsed: {
          uv_level: 'high',
          humidity: 'high',
          reduce_irritation: false,
          packing_list: [],
          inferred_climate: 'tropical_humid_high_uv',
        },
        promptHash: 'stub_prompt_hash',
      };
    },
  };

  const response = await skill.run(
    {
      skill_id: 'travel.apply_mode',
      context: {
        profile: { skin_type: 'dry' },
        recent_logs: [],
        travel_plan: {
          destination: 'Bali, Indonesia',
          dates: { start: '2026-04-01', end: '2026-04-10' },
        },
        current_routine: {
          routine_id: 'routine_123',
          am_steps: [{ step_id: 'am_sunscreen', products: [{ name: 'SPF 50' }] }],
          pm_steps: [{ step_id: 'pm_treatment', products: [{ name: 'Retinol', concepts: ['RETINOID'] }] }],
        },
        inventory: [],
        locale: 'en',
        safety_flags: [],
      },
      params: { _climate_archetype: 'tropical_humid_high_uv' },
      thread_state: {},
    },
    gateway
  );

  const travelSection = response.cards[0].sections.find((section) => section.type === 'travel_structured');
  const adjustmentTypes = new Set((travelSection?.adjustments || []).map((item) => item.type));

  assert.equal(response.quality.quality_ok, true);
  assert.ok(adjustmentTypes.has('spf_reapply'));
  assert.ok(adjustmentTypes.has('reduce_actives'));
});

test('ingredient_report injects a cautious ingredient_claims section when LLM returns no claims', async () => {
  const skill = new IngredientReportSkill();
  const gateway = {
    async call() {
      return {
        parsed: {
          ingredient_name: 'SuperMagicExtract',
          inci_name: null,
          category: 'other',
          description_en: 'An unresolved ingredient query.',
          description_zh: null,
          benefits: [],
          claims: [],
          how_to_use: null,
          watchouts: [],
          interactions: [],
          related_ingredients: [],
        },
        promptHash: 'stub_prompt_hash',
      };
    },
  };

  const response = await skill.run(
    {
      skill_id: 'ingredient.report',
      context: {
        profile: {},
        recent_logs: [],
        travel_plan: null,
        current_routine: null,
        inventory: [],
        locale: 'en',
        safety_flags: [],
      },
      params: {
        ingredient_query: 'SuperMagicExtract',
        _resolved_ingredient: null,
      },
      thread_state: {},
    },
    gateway
  );

  const reportCard = response.cards.find((card) => card.card_type === 'aurora_ingredient_report');
  const claimsSection = reportCard.sections.find((section) => section.type === 'ingredient_claims');

  assert.equal(response.quality.quality_ok, true);
  assert.ok(claimsSection);
  assert.ok(Array.isArray(claimsSection.claims));
  assert.ok(claimsSection.claims.length >= 1);
  assert.ok(claimsSection.claims.every((claim) => claim.evidence_badge));
  assert.ok(claimsSection.claims.every((claim) => !String(claim.text_en || '').toLowerCase().includes('products containing')));
});

test('product_analyze carries product_anchor into add_to_routine next action params', async () => {
  const skill = new ProductAnalyzeSkill();
  const gateway = {
    async call() {
      return {
        parsed: {
          product_name: 'Defense Lotion SPF 35',
          brand: 'Lab Series',
          product_type: 'sunscreen',
          suitability: {
            verdict_en: 'Suitable for daytime use.',
            verdict_zh: '适合白天使用。',
          },
          usage: {
            time_of_day: 'am',
            frequency: 'daily',
          },
          key_ingredients: [],
          risk_flags: [],
        },
        promptHash: 'stub_prompt_hash',
      };
    },
  };

  const productAnchor = {
    brand: 'Lab Series',
    name: 'Defense Lotion SPF 35',
    product_type: 'sunscreen',
    product_id: 'prod_123',
  };

  const response = await skill.run(
    {
      skill_id: 'product.analyze',
      context: {
        profile: {},
        recent_logs: [],
        travel_plan: null,
        current_routine: {
          routine_id: 'routine_123',
          am_steps: [{ step_id: 'am_cleanser', products: [{ name: 'Gentle Cleanser' }] }],
          pm_steps: [],
        },
        inventory: [],
        locale: 'en',
        safety_flags: [],
      },
      params: {
        product_anchor: productAnchor,
      },
      thread_state: {},
    },
    gateway
  );

  const addToRoutine = response.next_actions.find((action) => action.target_skill_id === 'explore.add_to_routine');

  assert.ok(addToRoutine);
  assert.deepEqual(addToRoutine.params?.product_anchor, productAnchor);
});

test('skill_router derives target_step from a freeform mask request', () => {
  const targetStep = skillRouterInternal.deriveTargetStep(
    {
      params: {
        user_message: 'Recommend a facial mask that suits me.',
      },
    },
    null,
  );

  assert.equal(targetStep, 'mask');
});

test('skill_router deterministically appends oily-skin watchout when mismatch answer omits it', () => {
  const router = new SkillRouter({});
  const enforced = router._enforceProfileMismatchWatchoutOnTexts(
    {
      context: {
        locale: 'en',
        profile: { skin_type: 'oily' },
      },
    },
    'My skin feels dry and tight lately. What should I do?',
    'When skin feels dry and tight, focus on gentle hydration and barrier support.',
    null,
  );

  assert.equal(enforced.profileMismatchGuardApplied, true);
  assert.equal(enforced.enforced, true);
  assert.match(String(enforced.answerEn || ''), /oily|greasy|occlusive|congest/i);
});

test('skill_router does not duplicate watchout when answer already includes oily-skin caution', () => {
  const router = new SkillRouter({});
  const enforced = router._enforceProfileMismatchWatchoutOnTexts(
    {
      context: {
        locale: 'en',
        profile: { skin_type: 'oily' },
      },
    },
    'My skin feels dry and tight lately. What should I do?',
    'Focus on gentle hydration. Because your skin usually runs oily, keep hydration lightweight and avoid heavy occlusives if they feel greasy.',
    null,
  );

  assert.equal(enforced.profileMismatchGuardApplied, true);
  assert.equal(enforced.enforced, false);
  assert.equal((String(enforced.answerEn || '').match(/Because your skin usually runs oily/gi) || []).length, 1);
});

test('reco_step_based returns a recommendations card when grounded catalog recommendations exist', async () => {
  RecoStepBasedSkill.__setSharedRecoCoreRunnerForTest(async () => ({
    norm: {
      payload: {
        recommendations: [
          {
            product_id: 'prod_mask_1',
            merchant_id: 'merchant_mask_1',
            brand: 'Winona',
            name: 'Hydrating Repair Mask',
            product_type: 'mask',
          },
        ],
        recommendation_meta: {
          source_mode: 'catalog_grounded',
          llm_trace: { prompt_hash: 'stub_prompt_hash' },
        },
      },
    },
    mainlineStatus: 'grounded_success',
  }));

  try {
    const skill = new RecoStepBasedSkill();
    const gateway = {
      async call() {
        return {
          parsed: {
            answer_en: 'I would start with calming hydrating masks.',
            answer_zh: null,
            products: [
              {
                brand: 'Winona',
                name: 'Hydrating Repair Mask',
                product_type: 'mask',
                why: { en: 'Supports barrier comfort and hydration.', zh: null },
                suitability_score: 0.88,
                price_tier: 'mid',
                search_aliases: ['winona hydrating repair mask'],
              },
            ],
          },
          promptHash: 'stub_prompt_hash',
        };
      },
    };
    const response = await skill.run(
      {
        skill_id: 'reco.step_based',
        context: {
          profile: { skinType: 'dry', goals: ['hydration'] },
          recent_logs: [],
          travel_plan: null,
          current_routine: null,
          inventory: [],
          locale: 'en-US',
          safety_flags: [],
        },
        params: {
          user_message: 'Recommend a facial mask that suits me.',
          message: 'Recommend a facial mask that suits me.',
          text: 'Recommend a facial mask that suits me.',
          target_step: 'mask',
          entry_source: 'text',
        },
        thread_state: {},
      },
      gateway,
    );

    const textCard = response.cards.find((card) => card.card_type === 'text_response');
    const recoCard = response.cards.find((card) => card.card_type === 'recommendations');
    assert.ok(textCard);
    assert.ok(recoCard);
    assert.equal(Array.isArray(recoCard.metadata?.recommendations), true);
    assert.equal(recoCard.metadata?.recommendations?.[0]?.product_id, 'prod_mask_1');
    assert.equal(recoCard.metadata?.source_mode, 'catalog_grounded');
    assert.equal(response.cards.some((card) => card.card_type === 'effect_review'), false);
  } finally {
    RecoStepBasedSkill.__resetSharedRecoCoreRunnerForTest();
  }
});

test('reco_step_based returns text_response when grounded recommendation search yields no candidates', async () => {
  RecoStepBasedSkill.__setSharedRecoCoreRunnerForTest(async () => ({
    norm: {
      payload: {
        recommendations: [],
        products_empty_reason: 'no_valid_catalog_hit_for_target',
        recommendation_meta: {
          source_mode: 'catalog_grounded',
          surface_reason: 'no_valid_catalog_hit_for_target',
        },
      },
    },
    mainlineStatus: 'needs_more_context',
  }));

  try {
    const skill = new RecoStepBasedSkill();
    const gateway = {
      async call() {
        return {
          parsed: {
            answer_en: "I couldn't build a confident shortlist yet. Tell me if you want hydration, acne support, or barrier repair.",
            answer_zh: null,
            products: [],
          },
          promptHash: 'stub_prompt_hash',
        };
      },
    };
    const response = await skill.run(
      {
        skill_id: 'reco.step_based',
        context: {
          profile: { skinType: 'combination', goals: ['brightening'] },
          recent_logs: [],
          travel_plan: null,
          current_routine: null,
          inventory: [],
          locale: 'en-US',
          safety_flags: [],
        },
        params: {
          user_message: 'Recommend a facial mask that suits me.',
          message: 'Recommend a facial mask that suits me.',
          text: 'Recommend a facial mask that suits me.',
          target_step: 'mask',
          entry_source: 'text',
        },
        thread_state: {},
      },
      gateway,
    );

    const textCard = response.cards.find((card) => card.card_type === 'text_response');
    assert.ok(textCard);
    assert.equal(response.cards.some((card) => card.card_type === 'recommendations'), false);
    assert.match(String(textCard.sections?.[0]?.text_en || ''), /strong mask match|narrow it down/i);
  } finally {
    RecoStepBasedSkill.__resetSharedRecoCoreRunnerForTest();
  }
});

test('reco_step_based forwards latest_reco_context from thread_state and surfaces weak-context reason', async () => {
  let capturedCoreInput = null;
  RecoStepBasedSkill.__setSharedRecoCoreRunnerForTest(async (input) => {
    capturedCoreInput = input;
    return {
      norm: {
        payload: {
          recommendations: [],
          products_empty_reason: 'analysis_context_too_weak_for_step_reco',
          recommendation_meta: {
            source_mode: 'catalog_grounded',
            surface_reason: 'analysis_context_too_weak_for_step_reco',
            products_empty_reason: 'analysis_context_too_weak_for_step_reco',
          },
        },
      },
      mainlineStatus: 'needs_more_context',
    };
  });

  try {
    const skill = new RecoStepBasedSkill();
    const response = await skill.run(
      {
        skill_id: 'reco.step_based',
        context: {
          profile: {},
          recent_logs: [],
          travel_plan: null,
          current_routine: null,
          inventory: [],
          locale: 'en-US',
          safety_flags: [],
        },
        params: {
          user_message: 'Recommend a moisturizer for me.',
          message: 'Recommend a moisturizer for me.',
          text: 'Recommend a moisturizer for me.',
          target_step: 'moisturizer',
          entry_source: 'text',
        },
        thread_state: {
          latest_reco_context: {
            reco_context_version: 'aurora.reco_context.v2',
            reco_context_source: 'analysis_skin',
            diagnosis_goal: 'barrier_repair',
            target_step: 'moisturizer',
            reco_artifact_eligible: false,
            seed_terms: ['barrier_repair', 'ceramide', 'panthenol'],
          },
        },
      },
      {}
    );

    assert.ok(capturedCoreInput);
    assert.equal(capturedCoreInput.latestRecoContext?.diagnosis_goal, 'barrier_repair');
    assert.equal(capturedCoreInput.latestRecoContext?.target_step, 'moisturizer');
    assert.equal(capturedCoreInput.recoArtifactEligibleHint, false);
    assert.match(String(response.cards?.[0]?.sections?.[0]?.text_en || ''), /Add a clear photo|current routine\/sensitivity/i);
    assert.equal(response.meta?.surface_reason, 'analysis_context_too_weak_for_step_reco');
  } finally {
    RecoStepBasedSkill.__resetSharedRecoCoreRunnerForTest();
  }
});

test('product_analyze free-text precondition failures downgrade to text_response instead of empty_state', async () => {
  const skill = new ProductAnalyzeSkill();
  const response = await skill.run(
    {
      skill_id: 'product.analyze',
      context: {
        profile: {},
        recent_logs: [],
        travel_plan: null,
        current_routine: null,
        inventory: [],
        locale: 'en',
        safety_flags: [],
      },
      params: {
        message: 'Can you analyze this sunscreen for me?',
      },
      thread_state: {},
    },
    {},
  );

  assert.equal(response.cards?.[0]?.card_type, 'text_response');
  assert.match(String(response.cards?.[0]?.sections?.[0]?.text_en || ''), /share a product link or name/i);
  assert.ok(Array.isArray(response.next_actions));
  assert.equal(response.next_actions?.[0]?.action_type, 'request_input');
  assert.equal(response.quality?.preconditions_met, false);
});
