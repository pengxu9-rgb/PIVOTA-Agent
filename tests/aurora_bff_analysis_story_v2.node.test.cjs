const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal: routeInternals } = require('../src/auroraBff/routes');

test('analysis_story_v2: fallback payload has required top-level schema keys', async () => {
  const payload = await routeInternals.buildAnalysisStoryV2({
    language: 'EN',
    profileSummary: {
      skinType: 'combination',
      sensitivity: 'low',
      barrierStatus: 'healthy',
      goals: ['tone', 'barrier'],
    },
    recentLogsSummary: [],
    analysis: {
      features: [
        { observation: 'Mild uneven tone around cheeks', confidence: 'somewhat_sure' },
        { observation: 'Low active acne signal', confidence: 'pretty_sure' },
      ],
      strategy: 'Stabilize barrier then treat tone.',
    },
    analysisSource: 'rule_based_with_photo_qc',
    hasRoutine: false,
    lowConfidence: false,
    photoModulesCard: null,
    logger: null,
  });

  assert.ok(payload && typeof payload === 'object');
  const required = [
    'schema_version',
    'confidence_overall',
    'skin_profile',
    'priority_findings',
    'target_state',
    'core_principles',
    'am_plan',
    'pm_plan',
    'routine_bridge',
    'existing_products_optimization',
    'timeline',
    'safety_notes',
    'disclaimer_non_medical',
  ];
  required.forEach((key) => assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `missing key: ${key}`));
  assert.equal(payload.schema_version, 'aurora.analysis_story.v2');
  assert.ok(Array.isArray(payload.priority_findings));
  assert.ok(Array.isArray(payload.core_principles));
  assert.ok(payload.routine_bridge && typeof payload.routine_bridge === 'object');
});

test('analysis_story_v2: wrapper cards are backward-compatible and routine prompt carries CTA', async () => {
  const payload = await routeInternals.buildAnalysisStoryV2({
    language: 'EN',
    profileSummary: {},
    recentLogsSummary: [],
    analysis: { features: [], strategy: '' },
    analysisSource: 'baseline_low_confidence',
    hasRoutine: false,
    lowConfidence: true,
    photoModulesCard: null,
    logger: null,
  });

  const storyCard = routeInternals.buildAnalysisStoryV2Card(payload, 'req_story_1');
  assert.equal(storyCard.type, 'analysis_story_v2');
  assert.equal(storyCard.card_id, 'analysis_story_req_story_1');
  assert.ok(storyCard.payload && typeof storyCard.payload === 'object');

  const promptCard = routeInternals.buildRoutinePromptCard({
    language: 'EN',
    requestId: 'req_story_1',
    missingFields: ['am.spf', 'pm.treatment'],
  });
  assert.equal(promptCard.type, 'routine_prompt');
  assert.equal(promptCard.payload.schema_version, 'aurora.routine_prompt.v1');
  assert.equal(promptCard.payload.action_id, 'chip.start.routine');
  assert.ok(Array.isArray(promptCard.payload.missing_fields));
  assert.equal(promptCard.payload.missing_fields.includes('am.spf'), true);
});
