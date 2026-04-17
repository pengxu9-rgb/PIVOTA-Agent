const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildConcernSemanticPlanFallback,
} = require('../src/auroraBff/recommendationSharedStack');
const {
  CONCERN_PLANNER_PROMPT_VERSION,
  buildConcernSemanticPlanTextPromptBundle,
  normalizeConcernSemanticPlanFromText,
} = require('../src/auroraBff/concernPlannerNormalizer');
const {
  isConcernPrimaryRoleWinnerSafe,
} = require('../src/auroraBff/selectorWinnerPolicy');
const {
  resolveConcernMainlineFailure,
} = require('../src/auroraBff/failureClassifier');
const {
  buildSupportRoleQueryVariants,
} = require('../src/auroraBff/recoSupportRoleQueries');

test('concern planner normalizer builds a structured JSON planner prompt with full role ontology', () => {
  const fallbackPlan = buildConcernSemanticPlanFallback({
    text: 'im oily skin, what product should i use?',
    focus: '',
    profileSummary: { skinType: 'oily', goals: ['oil control'] },
  });
  const prompt = buildConcernSemanticPlanTextPromptBundle({
    requestText: 'im oily skin, what product should i use?',
    lang: 'EN',
    fallbackPlan,
  });

  assert.match(prompt.systemPrompt, new RegExp(`PROMPT_VERSION=${CONCERN_PLANNER_PROMPT_VERSION}`));
  assert.match(prompt.systemPrompt, /Output a JSON object only/i);
  assert.match(prompt.systemPrompt, /primary_role_id/);
  assert.match(prompt.systemPrompt, /support_role_ids/);
  assert.doesNotMatch(prompt.systemPrompt, /Output plain text only/i);
  const contextPayload = JSON.parse(String(prompt.userPrompt || '').replace(/^context=/, ''));
  assert.ok(
    contextPayload.canonical_role_ontology.some((role) => role.role_id === 'daily_sunscreen_finish_fit'),
  );
  assert.ok(
    contextPayload.allowed_role_ids.core.includes('tone_mark_treatment'),
  );
});

test('concern planner normalizer trusts JSON output selecting ontology roles outside fallback order', () => {
  const fallbackPlan = buildConcernSemanticPlanFallback({
    text: 'I have oily skin and wear makeup every day. What sunscreen should I buy?',
    profileSummary: { skinType: 'oily', goals: ['oil control'] },
  });
  const normalized = normalizeConcernSemanticPlanFromText(
    JSON.stringify({
      primary_concern: 'sunscreen finish and daytime fit',
      primary_role_id: 'daily_sunscreen_finish_fit',
      support_role_ids: ['lightweight_moisturizer'],
      routine_mode: 'routine_mix',
      query_intents: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          intent: 'sunscreen under makeup for oily skin',
          query_terms: ['sunscreen under makeup', 'lightweight sunscreen oily skin'],
        },
      ],
      must_satisfy_constraints: ['non-greasy finish', 'works under makeup'],
      comparison_mode: 'routine_mix',
      evidence_needed: ['finish', 'layering compatibility', 'price'],
      ingredient_hypotheses: ['UV filters'],
      product_type_hypotheses: ['sunscreen'],
    }),
    {
      fallbackPlan,
      requestText: 'I have oily skin and wear makeup every day. What sunscreen should I buy?',
    },
  );

  assert.equal(normalized.selection_owner_source, 'llm_concern_planner');
  assert.equal(normalized.selection_owner_state, 'trusted');
  assert.deepEqual(
    normalized.core_roles.map((role) => role.role_id),
    ['daily_sunscreen_finish_fit', 'layering_compatible_moisturizer_or_spf', 'lightweight_moisturizer'],
  );
  assert.equal(normalized.comparison_mode, 'routine_mix');
  assert.deepEqual(normalized.evidence_needed, ['finish', 'layering compatibility', 'price']);
});

test('concern semantic fallback makes finish-fit sunscreen primary for makeup layering asks', () => {
  const fallbackPlan = buildConcernSemanticPlanFallback({
    text: 'My daytime products pill under makeup. What skincare product should I use instead?',
    profileSummary: { skinType: 'combination', goals: ['smooth layering', 'lightweight hydration'] },
  });

  assert.deepEqual(
    fallbackPlan.core_roles.map((role) => role.role_id),
    [
      'daily_sunscreen_finish_fit',
      'layering_compatible_moisturizer_or_spf',
      'hydrating_serum_or_essence',
    ],
  );
  assert.match(String(fallbackPlan.primary_concern || ''), /sunscreen finish and layering compatibility/i);
});

test('concern planner normalizer repairs makeup layering sunscreen support to finish-fit role', () => {
  const fallbackPlan = buildConcernSemanticPlanFallback({
    text: 'My daytime products pill under makeup. What skincare product should I use instead?',
    profileSummary: { skinType: 'combination', goals: ['smooth layering', 'lightweight hydration'] },
  });
  const normalized = normalizeConcernSemanticPlanFromText(
    JSON.stringify({
      primary_concern: 'product pilling under makeup',
      primary_role_id: 'layering_compatible_moisturizer_or_spf',
      support_role_ids: ['daily_sunscreen', 'hydrating_serum_or_essence'],
      routine_mode: 'routine_mix',
      comparison_mode: 'routine_mix',
      query_intents: [
        {
          role_id: 'layering_compatible_moisturizer_or_spf',
          intent: 'non pilling moisturizer under makeup',
          query_terms: ['lightweight moisturizer under makeup'],
        },
      ],
      must_satisfy_constraints: ['works under makeup'],
      evidence_needed: ['layering compatibility', 'finish'],
      ingredient_hypotheses: ['Glycerin'],
      product_type_hypotheses: ['moisturizer', 'sunscreen'],
    }),
    {
      fallbackPlan,
      requestText: 'My daytime products pill under makeup. What skincare product should I use instead?',
    },
  );

  assert.deepEqual(
    normalized.core_roles.map((role) => role.role_id),
    [
      'daily_sunscreen_finish_fit',
      'layering_compatible_moisturizer_or_spf',
      'hydrating_serum_or_essence',
    ],
  );
  assert.deepEqual(
    normalized.selection_constraints.plan_invariants_applied,
    [
      'routine_mix_replaced_generic_sunscreen_with_finish_fit',
      'routine_mix_promoted_finish_fit_sunscreen_primary',
    ],
  );
});

test('concern planner normalizer keeps analysis-context makeup layering asks sunscreen-led under barrier stress', () => {
  const requestText = 'Based on my routine and the skin analysis, what should I buy for daytime so my makeup stops pilling?';
  const fallbackPlan = buildConcernSemanticPlanFallback({
    text: requestText,
    focus: 'sunscreen',
    profileSummary: {
      skinType: 'combination',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['smooth layering', 'barrier support', 'daily sunscreen'],
    },
  });
  const normalized = normalizeConcernSemanticPlanFromText(
    JSON.stringify({
      primary_concern: 'daytime layering with sensitivity',
      primary_role_id: 'soothing_treatment',
      support_role_ids: ['layering_compatible_moisturizer_or_spf', 'barrier_moisturizer'],
      routine_mode: 'routine_mix',
      comparison_mode: 'routine_mix',
      query_intents: [
        {
          role_id: 'soothing_treatment',
          intent: 'soothing serum sensitive skin',
          query_terms: ['soothing serum sensitive skin'],
        },
      ],
      must_satisfy_constraints: ['under makeup', 'daytime wear'],
      evidence_needed: ['layering compatibility', 'barrier support'],
      ingredient_hypotheses: ['Panthenol'],
      product_type_hypotheses: ['serum', 'moisturizer'],
    }),
    {
      fallbackPlan,
      requestText,
      focus: 'sunscreen',
    },
  );

  assert.deepEqual(
    normalized.core_roles.map((role) => role.role_id),
    [
      'daily_sunscreen_finish_fit',
      'layering_compatible_moisturizer_or_spf',
      'barrier_moisturizer',
    ],
  );
  assert.equal(
    normalized.selection_constraints.plan_invariants_applied.includes('routine_mix_removed_lowest_priority_role_for_finish_fit_coverage'),
    true,
  );
  assert.equal(
    normalized.selection_constraints.plan_invariants_applied.includes('routine_mix_added_finish_fit_sunscreen'),
    true,
  );
  assert.equal(
    normalized.selection_constraints.plan_invariants_applied.includes('routine_mix_added_hydrating_barrier_support_for_layering'),
    true,
  );
});

test('support role query variants prioritize dull-skin tone queries before post-acne aliases', () => {
  const queries = buildSupportRoleQueryVariants({
    roleId: 'tone_mark_treatment',
    roleLabel: 'Tone and post-breakout mark treatment',
    preferredStep: 'treatment',
    queryTerms: ['post acne marks serum', 'dark spot serum', 'tone correcting serum', 'brightening serum'],
    fitKeywords: ['post acne marks', 'dark spots', 'brightening', 'uneven tone', 'dull skin'],
    concernText: 'dullness and dehydration',
    maxQueries: 4,
  });

  assert.deepEqual(
    queries.slice(0, 3),
    ['brightening serum', 'tone correcting serum', 'uneven tone treatment'],
  );
  assert.equal(queries.includes('post acne marks serum'), false);
});

test('support role query variants keep catalog-grounded lightweight moisturizer ahead of layering phrasing', () => {
  const queries = buildSupportRoleQueryVariants({
    roleId: 'layering_compatible_moisturizer_or_spf',
    roleLabel: 'Layering-compatible moisturizer or SPF',
    preferredStep: 'moisturizer',
    queryTerms: [
      'lightweight moisturizer under makeup',
      'non pilling moisturizer',
      'sunscreen under makeup',
      'gel cream under makeup',
      'makeup compatible spf',
    ],
    fitKeywords: [
      'under makeup',
      'non-pilling',
      'pilling',
      'layering',
      'lightweight',
      'gel cream',
      'makeup compatible',
      'smooth finish',
    ],
    concernText: 'products pill under makeup',
    maxQueries: 4,
  });

  assert.deepEqual(queries.slice(0, 2), ['gel cream moisturizer', 'lightweight moisturizer']);
  assert.equal(queries.indexOf('makeup layering moisturizer') > queries.indexOf('lightweight moisturizer'), true);
  assert.equal(queries.includes('moisturizer'), false);
});

test('concern planner normalizer repairs routine_mix sensitivity plans that omit barrier support', () => {
  const fallbackPlan = buildConcernSemanticPlanFallback({
    text: 'My skin is sensitive and red. What product should I buy?',
    profileSummary: { skinType: 'sensitive', goals: ['redness'], barrierStatus: 'reactive' },
  });
  const normalized = normalizeConcernSemanticPlanFromText(
    JSON.stringify({
      primary_concern: 'sensitive redness support',
      primary_role_id: 'soothing_treatment',
      support_role_ids: ['daily_sunscreen'],
      routine_mode: 'routine_mix',
      query_intents: [
        {
          role_id: 'soothing_treatment',
          intent: 'soothing serum sensitive skin',
          query_terms: ['soothing serum sensitive skin'],
        },
        {
          role_id: 'daily_sunscreen',
          intent: 'daily sunscreen sensitive skin',
          query_terms: ['daily sunscreen sensitive skin'],
        },
      ],
      comparison_mode: 'routine_mix',
      evidence_needed: ['redness calming', 'barrier comfort', 'daily protection'],
    }),
    {
      fallbackPlan,
      requestText: 'My skin is sensitive and red. What product should I buy?',
    },
  );

  assert.equal(normalized.selection_owner_source, 'llm_concern_planner');
  assert.equal(normalized.selection_owner_state, 'trusted');
  assert.deepEqual(
    normalized.core_roles.map((role) => role.role_id),
    ['barrier_moisturizer', 'soothing_treatment', 'daily_sunscreen'],
  );
  assert.ok(
    normalized.selection_constraints.plan_invariants_applied.includes('routine_mix_added_barrier_moisturizer'),
  );
});

test('concern planner normalizer replaces redundant acne/oil treatment support with sunscreen coverage', () => {
  const fallbackPlan = buildConcernSemanticPlanFallback({
    text: 'I need a budget product for acne and clogged pores. What should I buy?',
    profileSummary: { skinType: 'oily', goals: ['acne-control'] },
  });
  const normalized = normalizeConcernSemanticPlanFromText(
    JSON.stringify({
      primary_concern: 'acne and clogged pore support',
      primary_role_id: 'acne_clogged_pore_treatment',
      support_role_ids: ['oil_control_treatment', 'lightweight_moisturizer'],
      routine_mode: 'routine_mix',
      query_intents: [
        {
          role_id: 'acne_clogged_pore_treatment',
          intent: 'salicylic acid serum clogged pores',
          query_terms: ['salicylic acid serum clogged pores'],
        },
        {
          role_id: 'oil_control_treatment',
          intent: 'niacinamide serum oily skin',
          query_terms: ['niacinamide serum oily skin'],
        },
        {
          role_id: 'lightweight_moisturizer',
          intent: 'lightweight moisturizer oily skin',
          query_terms: ['lightweight moisturizer oily skin'],
        },
      ],
      comparison_mode: 'routine_mix',
      evidence_needed: ['blemish support', 'oil control', 'light hydration'],
    }),
    {
      fallbackPlan,
      requestText: 'I need a budget product for acne and clogged pores. What should I buy?',
    },
  );

  assert.equal(normalized.selection_owner_source, 'llm_concern_planner');
  assert.equal(normalized.selection_owner_state, 'trusted');
  assert.deepEqual(
    normalized.core_roles.map((role) => role.role_id),
    ['acne_clogged_pore_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
  );
  assert.ok(
    normalized.selection_constraints.plan_invariants_applied.includes('routine_mix_removed_redundant_treatment_for_sunscreen_coverage'),
  );
});

test('concern planner normalizer trusts keyed plain-text output and produces a semantic plan', () => {
  const fallbackPlan = buildConcernSemanticPlanFallback({
    text: 'my oily skin also feels dehydrated, what product should i use?',
    profileSummary: { skinType: 'oily', goals: ['oil control', 'hydration'], barrierStatus: 'dry' },
  });
  const normalized = normalizeConcernSemanticPlanFromText(
    [
      'PRIMARY_CONCERN: oil control and congestion',
      'CORE_ROLE_IDS: oil_control_treatment | lightweight_moisturizer | daily_sunscreen',
      'SUPPORT_ROLE_IDS: hydrating_mask_support',
      'INGREDIENT_HYPOTHESES: niacinamide | zinc pca | ceramide',
      'PRODUCT_TYPE_HYPOTHESES: treatment | moisturizer | sunscreen',
      'ROUTINE_SHELL_HINTS: AM=oil_control_treatment,daily_sunscreen; PM=oil_control_treatment,lightweight_moisturizer; OPTIONAL=hydrating_mask_support',
    ].join('\n'),
    {
      fallbackPlan,
      requestText: 'my oily skin also feels dehydrated, what product should i use?',
    },
  );

  assert.equal(normalized.selection_owner_source, 'llm_concern_planner');
  assert.equal(normalized.selection_owner_state, 'trusted');
  assert.deepEqual(
    normalized.core_roles.map((role) => role.role_id),
    ['oil_control_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
  );
  assert.deepEqual(
    normalized.support_roles.map((role) => role.role_id),
    ['hydrating_mask_support'],
  );
  assert.ok(normalized.routine_shell.am_core_roles.includes('daily_sunscreen'));
});

test('concern planner normalizer trusts prose-only role ordering when semantics are explicit', () => {
  const fallbackPlan = buildConcernSemanticPlanFallback({
    text: 'im oily skin, what product should i use?',
    profileSummary: { skinType: 'oily', goals: ['oil control'] },
  });
  const normalized = normalizeConcernSemanticPlanFromText(
    'Start with an oil-control treatment to manage shine and congestion. Follow with a lightweight moisturizer to keep hydration breathable. During the day, finish with a daily sunscreen. Optional support: add a hydrating mask only if oily skin also feels dehydrated.',
    {
      fallbackPlan,
      requestText: 'im oily skin, what product should i use?',
    },
  );

  assert.equal(normalized.selection_owner_state, 'trusted');
  assert.equal(normalized.core_roles[0].role_id, 'oil_control_treatment');
  assert.equal(normalized.core_roles[1].role_id, 'lightweight_moisturizer');
  assert.equal(normalized.core_roles[2].role_id, 'daily_sunscreen');
});

test('concern planner normalizer trusts a single explicit core role when support semantics are also explicit', () => {
  const fallbackPlan = buildConcernSemanticPlanFallback({
    text: 'my oily skin also feels dehydrated, what product should i use?',
    profileSummary: { skinType: 'oily', goals: ['oil control', 'hydration'], barrierStatus: 'dry' },
  });
  const normalized = normalizeConcernSemanticPlanFromText(
    [
      'PRIMARY_CONCERN: excess oil and congestion',
      'CORE_ROLE_IDS: oil_control_treatment',
      'SUPPORT_ROLE_IDS: hydrating_mask_support',
      'INGREDIENT_HYPOTHESES: niacinamide | zinc pca',
      'PRODUCT_TYPE_HYPOTHESES: serum | gel moisturizer | sunscreen',
      'ROUTINE_SHELL_HINTS: PM=oil_control_treatment; OPTIONAL=hydrating_mask_support',
    ].join('\n'),
    {
      fallbackPlan,
      requestText: 'my oily skin also feels dehydrated, what product should i use?',
    },
  );

  assert.equal(normalized.selection_owner_source, 'llm_concern_planner');
  assert.equal(normalized.selection_owner_state, 'trusted');
  assert.equal(normalized.core_roles[0]?.role_id, 'oil_control_treatment');
  assert.deepEqual(
    normalized.support_roles.map((role) => role.role_id),
    ['hydrating_mask_support'],
  );
});

test('concern planner normalizer fail-closes junk text into fallback state', () => {
  const fallbackPlan = buildConcernSemanticPlanFallback({
    text: 'im oily skin, what product should i use?',
    profileSummary: { skinType: 'oily', goals: ['oil control'] },
  });
  const normalized = normalizeConcernSemanticPlanFromText(
    'maybe something helpful idk',
    {
      fallbackPlan,
      requestText: 'im oily skin, what product should i use?',
    },
  );

  assert.equal(normalized.selection_owner_source, 'rule_concern_planner_fallback');
  assert.equal(normalized.selection_owner_state, 'fallback');
});

test('selector winner policy blocks sunscreen-shaped products from winning oil-control primary slot', () => {
  const fallbackPlan = buildConcernSemanticPlanFallback({
    text: 'im oily skin, what product should i use?',
    profileSummary: { skinType: 'oily', goals: ['oil control'] },
  });
  const safe = isConcernPrimaryRoleWinnerSafe(
    {
      matched_role_id: 'oil_control_treatment',
      display_name: 'Matte Fit Serum Sunscreen SPF 50+',
      category: 'serum sunscreen',
      product_type: 'serum',
      benefit_tags: ['oil control'],
      search_aliases: ['oil control sunscreen'],
    },
    { semanticPlan: fallbackPlan },
  );

  assert.equal(safe, false);
});

test('failure classifier maps planner block to planner_untrusted instead of artifact_missing', () => {
  const failure = resolveConcernMainlineFailure({
    plannerBlocked: true,
    plannerFailureClass: 'planner_untrusted',
  });

  assert.equal(failure.effective_failure_class, 'planner_untrusted');
  assert.equal(failure.failure_origin, 'internal_contract');
});
