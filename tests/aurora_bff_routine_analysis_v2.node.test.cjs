const test = require('node:test');
const assert = require('node:assert/strict');

const {
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  parseCards,
  findCard,
} = require('./aurora_bff_test_harness.cjs');

test('/v1/analysis/skin: routine analysis v2 emits product-first cards with compatibility meta', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'true',
      AURORA_CHAT_V2_STUB_RESPONSES: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_analysis_v2');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: {
              am: {
                cleanser: 'CeraVe Hydrating Cleanser',
                treatment: 'Vitamin C serum',
                moisturizer: 'Light gel cream',
              },
              pm: {
                cleanser: 'CeraVe Hydrating Cleanser',
                treatment: 'Retinol serum',
                moisturizer: 'Barrier cream',
              },
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        assert.equal(cards[0] && cards[0].type, 'routine_product_audit_v1');
        assert.equal(cards[1] && cards[1].type, 'routine_adjustment_plan_v1');
        assert.equal(Boolean(findCard(cards, 'analysis_summary')), false);
        assert.equal(Boolean(findCard(cards, 'analysis_story_v2')), false);
        assert.equal(Boolean(findCard(cards, 'routine_fit_summary')), false);

        const auditCard = findCard(cards, 'routine_product_audit_v1');
        assert.ok(auditCard, 'routine_product_audit_v1 should exist');
        assert.ok(Array.isArray(auditCard.payload && auditCard.payload.products));
        assert.ok(auditCard.payload.products.length >= 1, 'audit card should include products');

        const adjustmentCard = findCard(cards, 'routine_adjustment_plan_v1');
        assert.ok(adjustmentCard, 'routine_adjustment_plan_v1 should exist');
        assert.ok(Array.isArray(adjustmentCard.payload && adjustmentCard.payload.top_3_adjustments));

        const sessionPatch = resp.body && resp.body.session_patch && typeof resp.body.session_patch === 'object'
          ? resp.body.session_patch
          : {};
        assert.equal(sessionPatch.next_state, 'ROUTINE_REVIEW');
        const meta = sessionPatch.meta && typeof sessionPatch.meta === 'object' ? sessionPatch.meta : {};
        assert.equal(Boolean(meta.routine_analysis_v2 && meta.routine_analysis_v2.enabled), true);
        assert.equal(meta.routine_analysis_legacy_compat && meta.routine_analysis_legacy_compat.source, 'routine_analysis_v2');
      } finally {
        harness.restore();
      }
    },
  );
});

test('routineAnalysisV2 recommendation groups: empty pool degrades to category guidance instead of empty products', async () => {
  const { resolveRecommendationGroups } = require('../src/auroraBff/routineAnalysisV2');
  const groups = await resolveRecommendationGroups({
    recommendationNeeds: [
      {
        adjustment_id: 'adj_gap_spf',
        need_state: 'fill_gap',
        target_step: 'sunscreen',
        why: 'AM protection is missing.',
        required_attributes: ['broad-spectrum daily UV protection'],
        avoid_attributes: ['unclear SPF claims'],
        timing: 'am',
        texture_or_format: 'fluid',
        priority: 'high',
      },
    ],
    recommendationQueries: [
      {
        adjustment_id: 'adj_gap_spf',
        query_en: 'sunscreen broad-spectrum daily UV protection fluid',
      },
    ],
    context: {
      language: 'EN',
      goals: ['wrinkles', 'dehydration'],
      skinType: 'combination',
      sensitivity: 'medium',
    },
    deps: {
      resolveProduct: async () => null,
      searchProducts: async () => ({ ok: true, transient: false, products: [], queryCount: 1 }),
    },
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].adjustment_id, 'adj_gap_spf');
  assert.equal(Array.isArray(groups[0].candidate_pool), true);
  assert.equal(groups[0].candidate_pool.length, 0);
  assert.equal(groups[0].unresolved_reason, 'no_grounded_candidates');
  assert.ok(groups[0].category_guidance, 'guidance should exist when candidate pool is empty');
});

test('coerceSynthesisOutput removes false cleanser gaps when cleanser exists in deferred inventory', async () => {
  const { coerceSynthesisOutput, buildRoutineInventory } = require('../src/auroraBff/routineAnalysisV2');
  const audit = {
    schema_version: 'aurora.routine_product_audit.v1',
    products: [
      {
        product_ref: 'routine_am_03',
        slot: 'am',
        input_label: 'Vitamin C serum',
        inferred_product_type: 'vitamin c serum',
        concise_reasoning_en: 'This is fine in AM.',
      },
      {
        product_ref: 'routine_pm_04',
        slot: 'pm',
        input_label: 'Retinol serum',
        inferred_product_type: 'retinoid serum',
        concise_reasoning_en: 'This is better kept in PM.',
      },
    ],
    additional_items_needing_verification: [],
    missing_info: [],
    confidence: 0.7,
  };
  const routineInventory = buildRoutineInventory([
    { slot: 'am', step: 'cleanser', product_text: 'Gentle cleanser' },
    { slot: 'pm', step: 'cleanser', product_text: 'Gentle cleanser' },
    { slot: 'am', step: 'treatment', product_text: 'Vitamin C serum' },
    { slot: 'pm', step: 'treatment', product_text: 'Retinol serum' },
  ]);
  const synthesis = coerceSynthesisOutput({
    schema_version: 'aurora.routine_synthesis.v1',
    current_routine_assessment: {
      summary: 'The routine needs cleansing support.',
      main_strengths: ['There is treatment coverage.'],
      main_issues: ['Add cleansing steps to AM and PM routines'],
    },
    per_step_order_am: [],
    per_step_order_pm: [],
    overlap_or_gaps: [
      {
        issue_type: 'gap',
        title: 'Cleansing looks missing',
        evidence: ['No cleanser was found in the current routine.'],
        affected_products: [],
      },
    ],
    top_3_adjustments: [
      {
        adjustment_id: 'adj_cleanser_gap',
        priority_rank: 1,
        title: 'Add cleansing steps to AM and PM routines',
        action_type: 'add_step',
        affected_products: [],
        why_this_first: 'No cleanser appears present right now.',
        expected_outcome: 'A cleaner baseline.',
      },
    ],
    improved_am_routine: [
      {
        step_order: 1,
        what_to_use: 'Add a cleanser',
        frequency: 'daily',
        note: 'Missing cleanser step.',
        source_type: 'step_placeholder',
      },
    ],
    improved_pm_routine: [],
    rationale_for_each_adjustment: [
      {
        adjustment_id: 'adj_cleanser_gap',
        reasoning: 'No cleanser appears present.',
        evidence: ['No cleanser was found in the routine.'],
        tradeoff_or_caution: 'Keep it simple.',
      },
    ],
    recommendation_needs: [
      {
        adjustment_id: 'adj_cleanser_gap',
        need_state: 'fill_gap',
        target_step: 'cleanser',
        why: 'Need a cleanser.',
        required_attributes: ['gentle cleanse'],
        avoid_attributes: ['stripping formula'],
        timing: 'either',
        texture_or_format: null,
        priority: 'high',
      },
    ],
    recommendation_queries: [
      {
        adjustment_id: 'adj_cleanser_gap',
        query_en: 'gentle cleanser',
      },
    ],
    confidence: 0.7,
    missing_info: [],
  }, audit, { routine_inventory: routineInventory });

  assert.equal(synthesis.top_3_adjustments.length, 0);
  assert.equal(synthesis.recommendation_needs.length, 0);
  assert.equal(synthesis.recommendation_queries.length, 0);
  assert.equal(synthesis.overlap_or_gaps.some((item) => /cleans/i.test(item.title)), false);
  assert.equal(synthesis.improved_am_routine.some((item) => /add a cleanser/i.test(item.what_to_use)), false);
});

test('guidance-only serum upgrades stay hidden while core-gap guidance stays visible', async () => {
  const { getVisibleRecommendationGroups } = require('../src/auroraBff/routineAnalysisV2');
  const synthesis = {
    top_3_adjustments: [
      {
        adjustment_id: 'adj_support_serum',
        action_type: 'add_step',
        title: 'Add a hydrating/soothing serum',
      },
      {
        adjustment_id: 'adj_gap_spf',
        action_type: 'add_step',
        title: 'Add a clear AM sunscreen step',
      },
    ],
  };
  const visible = getVisibleRecommendationGroups([
    {
      adjustment_id: 'adj_support_serum',
      need_state: 'fill_gap',
      target_step: 'serum',
      candidate_pool: [],
      category_guidance: { what_to_look_for: ['hydrating serum'] },
    },
    {
      adjustment_id: 'adj_gap_spf',
      need_state: 'fill_gap',
      target_step: 'sunscreen',
      candidate_pool: [],
      category_guidance: { what_to_look_for: ['daily sunscreen'] },
    },
  ], synthesis);

  assert.equal(visible.length, 1);
  assert.equal(visible[0].adjustment_id, 'adj_gap_spf');
});

test('coerceSynthesisOutput removes dedicated eye-product adjustments and linked needs', async () => {
  const { coerceSynthesisOutput } = require('../src/auroraBff/routineAnalysisV2');
  const audit = {
    schema_version: 'aurora.routine_product_audit.v1',
    products: [
      {
        product_ref: 'routine_am_01',
        slot: 'am',
        input_label: 'Gentle cleanser',
        inferred_product_type: 'cleanser',
        concise_reasoning_en: 'Core cleanser step is already present.',
      },
      {
        product_ref: 'routine_am_02',
        slot: 'am',
        input_label: 'Daily SPF 50',
        inferred_product_type: 'sunscreen',
        concise_reasoning_en: 'Daily sunscreen is already present.',
      },
    ],
    additional_items_needing_verification: [],
    missing_info: [],
    confidence: 0.78,
  };
  const synthesis = coerceSynthesisOutput({
    schema_version: 'aurora.routine_synthesis.v1',
    current_routine_assessment: {
      summary: 'The routine is fine but could use an eye product.',
      main_strengths: ['Has sunscreen and cleanser.'],
      main_issues: ['Incorporate a dedicated eye product'],
    },
    per_step_order_am: [],
    per_step_order_pm: [],
    overlap_or_gaps: [],
    top_3_adjustments: [
      {
        adjustment_id: 'adj_eye_product',
        priority_rank: 1,
        title: 'Incorporate a dedicated eye product',
        action_type: 'add_step',
        affected_products: [],
        why_this_first: 'A dedicated eye step could help with under-eye concerns.',
        expected_outcome: 'More targeted eye care.',
      },
    ],
    improved_am_routine: [],
    improved_pm_routine: [],
    rationale_for_each_adjustment: [
      {
        adjustment_id: 'adj_eye_product',
        reasoning: 'A dedicated eye product could help.',
        evidence: ['Optional eye support.'],
        tradeoff_or_caution: 'Extra step.',
      },
    ],
    recommendation_needs: [
      {
        adjustment_id: 'adj_eye_product',
        need_state: 'fill_gap',
        target_step: 'eye product',
        why: 'Need more targeted under-eye care.',
        required_attributes: ['gentle eye hydration'],
        avoid_attributes: ['irritating fragrance'],
        timing: 'either',
        texture_or_format: null,
        priority: 'low',
      },
    ],
    recommendation_queries: [
      {
        adjustment_id: 'adj_eye_product',
        query_en: 'gentle eye product',
      },
    ],
    confidence: 0.72,
    missing_info: [],
  }, audit, {});

  assert.equal(synthesis.top_3_adjustments.length, 0);
  assert.equal(synthesis.recommendation_needs.length, 0);
  assert.equal(synthesis.recommendation_queries.length, 0);
});

test('guidance-only secondary replace-current recommendations stay hidden', async () => {
  const { getVisibleRecommendationGroups } = require('../src/auroraBff/routineAnalysisV2');
  const synthesis = {
    top_3_adjustments: [
      {
        adjustment_id: 'adj_gap_spf',
        priority_rank: 1,
        action_type: 'add_step',
        title: 'Add Sunscreen to AM Routine',
      },
      {
        adjustment_id: 'adj_cleanser_replace',
        priority_rank: 2,
        action_type: 'replace',
        title: 'Consider a different cleanser for PM',
      },
    ],
  };
  const visible = getVisibleRecommendationGroups([
    {
      adjustment_id: 'adj_gap_spf',
      need_state: 'fill_gap',
      target_step: 'sunscreen',
      candidate_pool: [],
      category_guidance: { what_to_look_for: ['daily sunscreen'] },
      why: 'AM protection is missing.',
    },
    {
      adjustment_id: 'adj_cleanser_replace',
      need_state: 'replace_current',
      target_step: 'PM cleanser',
      candidate_pool: [],
      category_guidance: { what_to_look_for: ['gentler PM cleanser'] },
      why: 'A different PM cleanser may be more comfortable.',
    },
  ], synthesis);

  assert.equal(visible.length, 1);
  assert.equal(visible[0].adjustment_id, 'adj_gap_spf');
});

test('coerceSynthesisOutput filters weak secondary routine adjustments behind a core gap', async () => {
  const { coerceSynthesisOutput } = require('../src/auroraBff/routineAnalysisV2');
  const audit = {
    schema_version: 'aurora.routine_product_audit.v1',
    products: [
      {
        product_ref: 'routine_am_01',
        slot: 'am',
        input_label: 'CeraVe Hydrating Cleanser',
        inferred_product_type: 'cleanser',
        suggested_action: 'keep',
        concise_reasoning_en: 'This cleanser is directionally usable in both slots.',
      },
      {
        product_ref: 'routine_am_02',
        slot: 'am',
        input_label: 'Vitamin C serum',
        inferred_product_type: 'vitamin c serum',
        suggested_action: 'keep',
        concise_reasoning_en: 'This is a normal AM treatment step.',
      },
      {
        product_ref: 'routine_pm_04',
        slot: 'pm',
        input_label: 'Retinol serum',
        inferred_product_type: 'retinoid serum',
        suggested_action: 'keep',
        concise_reasoning_en: 'This is a valid PM treatment step.',
      },
    ],
    additional_items_needing_verification: [],
    missing_info: [],
    confidence: 0.75,
  };

  const synthesis = coerceSynthesisOutput({
    schema_version: 'aurora.routine_synthesis.v1',
    current_routine_assessment: {
      summary: 'AM sunscreen is missing.',
      main_strengths: ['There is already treatment coverage.'],
      main_issues: ['Missing Sunscreen', 'Consider a different PM cleanser', 'Monitor Vitamin C and Retinol'],
    },
    per_step_order_am: [],
    per_step_order_pm: [],
    overlap_or_gaps: [
      { issue_type: 'gap', title: 'Missing Sunscreen', evidence: ['No AM SPF found.'], affected_products: [] },
      { issue_type: 'overlap', title: 'CeraVe Hydrating Cleanser AM and PM', evidence: ['The same cleanser appears in AM and PM.'], affected_products: ['routine_am_01'] },
    ],
    top_3_adjustments: [
      {
        adjustment_id: 'add_sunscreen',
        priority_rank: 1,
        title: 'Add Sunscreen to AM Routine',
        action_type: 'add_step',
        affected_products: [],
        why_this_first: 'AM protection is missing.',
        expected_outcome: 'A more complete AM routine.',
      },
      {
        adjustment_id: 'consider_pm_cleanser',
        priority_rank: 2,
        title: 'Consider a different PM cleanser',
        action_type: 'replace',
        affected_products: ['routine_am_01'],
        why_this_first: 'A different PM cleanser may be more comfortable.',
        expected_outcome: 'Potentially less friction at night.',
      },
      {
        adjustment_id: 'monitor_actives',
        priority_rank: 3,
        title: 'Monitor Vitamin C and Retinol',
        action_type: 'keep',
        affected_products: ['routine_am_02', 'routine_pm_04'],
        why_this_first: 'These are already directionally fine.',
        expected_outcome: 'No major change needed.',
      },
    ],
    improved_am_routine: [],
    improved_pm_routine: [],
    rationale_for_each_adjustment: [],
    recommendation_needs: [
      {
        adjustment_id: 'add_sunscreen',
        need_state: 'fill_gap',
        target_step: 'sunscreen',
        why: 'Need AM protection.',
        required_attributes: ['daily UV protection'],
        avoid_attributes: ['unclear SPF claims'],
        timing: 'am',
        texture_or_format: null,
        priority: 'high',
      },
      {
        adjustment_id: 'consider_pm_cleanser',
        need_state: 'replace_current',
        target_step: 'PM cleanser',
        why: 'A different PM cleanser may be more comfortable.',
        required_attributes: ['gentler cleanse'],
        avoid_attributes: ['stripping finish'],
        timing: 'pm',
        texture_or_format: null,
        priority: 'medium',
      },
    ],
    recommendation_queries: [
      { adjustment_id: 'add_sunscreen', query_en: 'daily sunscreen' },
      { adjustment_id: 'consider_pm_cleanser', query_en: 'gentle pm cleanser' },
    ],
    confidence: 0.7,
    missing_info: [],
  }, audit, {});

  assert.deepEqual(
    synthesis.top_3_adjustments.map((item) => item.adjustment_id),
    ['add_sunscreen'],
  );
  assert.deepEqual(
    synthesis.recommendation_needs.map((item) => item.adjustment_id),
    ['add_sunscreen'],
  );
});

test('coerceSynthesisOutput filters ingredient-specific add-step noise', async () => {
  const { coerceSynthesisOutput } = require('../src/auroraBff/routineAnalysisV2');
  const audit = {
    schema_version: 'aurora.routine_product_audit.v1',
    products: [
      {
        product_ref: 'routine_pm_07',
        slot: 'pm',
        input_label: 'Tretinoin cream',
        inferred_product_type: 'retinoid serum',
        suggested_action: 'keep',
        concise_reasoning_en: 'Tretinoin is already present at night.',
      },
      {
        product_ref: 'routine_pm_08',
        slot: 'pm',
        input_label: 'Glycolic acid serum',
        inferred_product_type: 'exfoliant treatment',
        suggested_action: 'reduce_frequency',
        concise_reasoning_en: 'This looks strong enough to reduce frequency.',
      },
    ],
    additional_items_needing_verification: [],
    missing_info: [],
    confidence: 0.74,
  };
  const synthesis = coerceSynthesisOutput({
    schema_version: 'aurora.routine_synthesis.v1',
    current_routine_assessment: {
      summary: 'The routine may be irritating.',
      main_strengths: ['There is treatment coverage.'],
      main_issues: ['Potential irritation from combining Tretinoin and Glycolic Acid'],
    },
    per_step_order_am: [],
    per_step_order_pm: [],
    overlap_or_gaps: [
      {
        issue_type: 'too_irritating',
        title: 'Potential irritation from combining Tretinoin and Glycolic Acid',
        evidence: ['These steps may stack too aggressively.'],
        affected_products: ['routine_pm_07', 'routine_pm_08'],
      },
    ],
    top_3_adjustments: [
      {
        adjustment_id: 'reduce_glycolic',
        priority_rank: 1,
        title: 'Reduce the frequency of Glycolic Acid serum',
        action_type: 'reduce_frequency',
        affected_products: ['routine_pm_08'],
        why_this_first: 'This is the clearest irritation lever.',
        expected_outcome: 'Lower irritation risk.',
      },
      {
        adjustment_id: 'add_ceramide_np',
        priority_rank: 2,
        title: 'Add a Ceramide NP product',
        action_type: 'add_step',
        affected_products: [],
        why_this_first: 'Extra ceramide support may help.',
        expected_outcome: 'More barrier support.',
      },
    ],
    improved_am_routine: [],
    improved_pm_routine: [],
    rationale_for_each_adjustment: [],
    recommendation_needs: [
      {
        adjustment_id: 'add_ceramide_np',
        need_state: 'fill_gap',
        target_step: 'Ceramide NP product',
        why: 'Extra ceramide support may help.',
        required_attributes: ['ceramide support'],
        avoid_attributes: ['heavy residue'],
        timing: 'either',
        texture_or_format: null,
        priority: 'medium',
      },
    ],
    recommendation_queries: [
      { adjustment_id: 'add_ceramide_np', query_en: 'ceramide support product' },
    ],
    confidence: 0.72,
    missing_info: [],
  }, audit, {});

  assert.deepEqual(
    synthesis.top_3_adjustments.map((item) => item.adjustment_id),
    ['reduce_glycolic'],
  );
  assert.equal(synthesis.recommendation_needs.length, 0);
});

test('buildUnresolvedRecommendationNotes deduplicates repeated adjustment ids', async () => {
  const { buildUnresolvedRecommendationNotes } = require('../src/auroraBff/routineAnalysisV2');
  const notes = buildUnresolvedRecommendationNotes({
    recommendation_needs: [
      { adjustment_id: 'adj_one' },
      { adjustment_id: 'adj_one' },
      { adjustment_id: 'adj_two' },
    ],
  }, []);

  assert.deepEqual(notes, [
    { adjustment_id: 'adj_one', note: 'Need identified, but no grounded product candidates are available yet.' },
    { adjustment_id: 'adj_two', note: 'Need identified, but no grounded product candidates are available yet.' },
  ]);
});

test('coerceSynthesisOutput removes weak frequency adjustments without audit or conflict evidence', async () => {
  const { coerceSynthesisOutput } = require('../src/auroraBff/routineAnalysisV2');
  const audit = {
    schema_version: 'aurora.routine_product_audit.v1',
    products: [
      {
        product_ref: 'routine_am_02',
        slot: 'am',
        input_label: 'Vitamin C serum',
        inferred_product_type: 'vitamin c serum',
        suggested_action: 'keep',
        concise_reasoning_en: 'Normal AM antioxidant step.',
      },
      {
        product_ref: 'routine_pm_06',
        slot: 'pm',
        input_label: 'Retinal serum',
        inferred_product_type: 'retinoid serum',
        suggested_action: 'keep',
        concise_reasoning_en: 'Normal PM treatment step.',
      },
    ],
    additional_items_needing_verification: [],
    missing_info: [],
    confidence: 0.76,
  };
  const synthesis = coerceSynthesisOutput({
    schema_version: 'aurora.routine_synthesis.v1',
    current_routine_assessment: {
      summary: 'The routine is broadly fine.',
      main_strengths: ['Has sunscreen and moisturizer.'],
      main_issues: ['Monitor for irritation from Vitamin C and Retinal'],
    },
    per_step_order_am: [],
    per_step_order_pm: [],
    overlap_or_gaps: [
      {
        issue_type: 'overlap',
        title: 'Duplication of cleanser and moisturizer in AM and PM',
        evidence: ['Basics repeat in both slots.'],
        affected_products: ['routine_am_01'],
      },
    ],
    top_3_adjustments: [
      {
        adjustment_id: 'adj_monitor_vitc_retinal',
        priority_rank: 1,
        title: 'Reduce Retinal Serum Frequency',
        action_type: 'reduce_frequency',
        affected_products: ['Retinal serum'],
        why_this_first: 'Retinal can cause irritation, especially when starting.',
        expected_outcome: 'Potentially less irritation.',
      },
    ],
    improved_am_routine: [],
    improved_pm_routine: [],
    rationale_for_each_adjustment: [],
    recommendation_needs: [],
    recommendation_queries: [],
    confidence: 0.7,
    missing_info: [],
  }, audit, {});

  assert.equal(synthesis.top_3_adjustments.length, 0);
});
