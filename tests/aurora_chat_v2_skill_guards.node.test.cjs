const test = require('node:test');
const assert = require('node:assert/strict');

const TravelApplyModeSkill = require('../src/auroraBff/skills/travel_apply_mode');
const IngredientReportSkill = require('../src/auroraBff/skills/ingredient_report');
const ProductAnalyzeSkill = require('../src/auroraBff/skills/product_analyze');
const RecoStepBasedSkill = require('../src/auroraBff/skills/reco_step_based');
const { __internal: skillRouterInternal } = require('../src/auroraBff/orchestrator/skill_router');
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

test('reco_step_based returns a recommendations card when grounded catalog recommendations exist', async () => {
  const originalResolve = recoHybridResolver.runRecoHybridResolveCandidates;
  recoHybridResolver.runRecoHybridResolveCandidates = async () => ({
    rows: [
      {
        product_id: 'prod_mask_1',
        merchant_id: 'merchant_mask_1',
        brand: 'Winona',
        name: 'Hydrating Repair Mask',
        reasons: ['Supports barrier comfort and hydration.'],
        match_state: 'exact',
      },
    ],
    recommendation_meta: {
      source_mode: 'llm_catalog_hybrid',
      llm_seed_count: 6,
      exact_match_count: 1,
      fuzzy_match_count: 0,
      unresolved_seed_count: 0,
    },
  });

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
    assert.equal(recoCard.metadata?.source_mode, 'llm_catalog_hybrid');
    assert.equal(response.cards.some((card) => card.card_type === 'effect_review'), false);
  } finally {
    recoHybridResolver.runRecoHybridResolveCandidates = originalResolve;
  }
});

test('reco_step_based returns text_response when grounded recommendation search yields no candidates', async () => {
  const originalResolve = recoHybridResolver.runRecoHybridResolveCandidates;
  recoHybridResolver.runRecoHybridResolveCandidates = async () => ({
    rows: [],
    recommendation_meta: {
      source_mode: 'llm_catalog_hybrid',
      llm_seed_count: 6,
      exact_match_count: 0,
      fuzzy_match_count: 0,
      unresolved_seed_count: 6,
    },
  });

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
    assert.match(String(textCard.sections?.[0]?.text_en || ''), /confident shortlist/i);
  } finally {
    recoHybridResolver.runRecoHybridResolveCandidates = originalResolve;
  }
});
