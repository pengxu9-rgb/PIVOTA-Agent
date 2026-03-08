const test = require('node:test');
const assert = require('node:assert/strict');

const TravelApplyModeSkill = require('../src/auroraBff/skills/travel_apply_mode');
const IngredientReportSkill = require('../src/auroraBff/skills/ingredient_report');

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
