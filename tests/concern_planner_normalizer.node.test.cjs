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

test('concern planner normalizer builds a plain-text planner prompt instead of JSON-only contract', () => {
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
  assert.match(prompt.systemPrompt, /Output plain text only/i);
  assert.match(prompt.systemPrompt, /CORE_ROLE_IDS:/);
  assert.doesNotMatch(prompt.systemPrompt, /Output minimum JSON only/i);
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
