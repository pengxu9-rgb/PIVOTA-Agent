'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  runStage1,
  runStage2,
  runStage3,
  runDiagnosisV2,
  normalizeDiagnosisV2ResultPayload,
  detectColdStart,
  detectMissingDataDimensions,
} = require('../src/auroraBff/diagnosisV2Orchestrator');

const {
  extractJsonObject,
  extractJsonObjectByKeys,
  parseJsonOnlyObject,
} = require('../src/auroraBff/jsonExtract');

const { validateResultPayload } = require('../src/auroraBff/diagnosisV2Schema');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeMockProvider(responseText) {
  return {
    isAvailable: () => true,
    generate: async () => ({ provider: 'mock', text: responseText }),
  };
}

function makeFailingProvider(err) {
  return {
    isAvailable: () => true,
    generate: async () => { throw err || new Error('provider_boom'); },
  };
}

function makeCtx(overrides = {}) {
  return {
    auroraUid: null,
    accountUserId: null,
    authToken: null,
    language: 'EN',
    goals: ['barrier_repair'],
    skipLogin: true,
    profile: {},
    recentLogs: [],
    currentRoutine: 'none',
    travelPlans: [],
    hasPhoto: false,
    hasExistingArtifact: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// jsonExtract tests
// ---------------------------------------------------------------------------

describe('jsonExtract', () => {
  it('parseJsonOnlyObject parses clean JSON', () => {
    const result = parseJsonOnlyObject('{"a":1}');
    assert.deepStrictEqual(result, { a: 1 });
  });

  it('parseJsonOnlyObject returns null for non-JSON', () => {
    assert.strictEqual(parseJsonOnlyObject('hello world'), null);
    assert.strictEqual(parseJsonOnlyObject(''), null);
    assert.strictEqual(parseJsonOnlyObject(null), null);
  });

  it('extractJsonObject extracts JSON from prose', () => {
    const text = 'Here is the analysis:\n```json\n{"goal_profile":{"constraints":[]},"followup_questions":[]}\n```\nDone.';
    const result = extractJsonObject(text);
    assert.ok(result);
    assert.ok(result.goal_profile);
  });

  it('extractJsonObject handles nested braces', () => {
    const text = 'prefix {"a": {"b": 1}, "c": [{"d": 2}]} suffix';
    const result = extractJsonObject(text);
    assert.deepStrictEqual(result, { a: { b: 1 }, c: [{ d: 2 }] });
  });

  it('extractJsonObjectByKeys picks best match', () => {
    const text = '{"x":1} and also {"goal_profile":{},"followup_questions":[]}';
    const result = extractJsonObjectByKeys(text, ['goal_profile', 'followup_questions']);
    assert.ok(result.goal_profile !== undefined);
    assert.ok(result.followup_questions !== undefined);
  });

  it('returns null for completely broken text', () => {
    assert.strictEqual(extractJsonObject('no json here at all'), null);
    assert.strictEqual(extractJsonObjectByKeys('nope', ['a']), null);
  });
});

// ---------------------------------------------------------------------------
// runStage1 tests
// ---------------------------------------------------------------------------

describe('runStage1', () => {
  it('returns valid intro payload when LLM succeeds', async () => {
    const llmJson = JSON.stringify({
      goal_profile: { constraints: ['no retinoids'] },
      followup_questions: [
        {
          id: 'fq1',
          question: 'How is your skin?',
          options: [
            { id: 'opt1', label: 'Good', value: 'good' },
            { id: 'opt2', label: 'Bad', value: 'bad' },
          ],
        },
      ],
    });
    const provider = makeMockProvider(llmJson);
    const ctx = makeCtx();
    const result = await runStage1({ goals: ['barrier_repair'], customInput: '', ctx, llmProvider: provider });
    assert.ok(result.introPayload);
    assert.ok(result.introPayload.goal_profile);
    assert.deepStrictEqual(result.introPayload.goal_profile.constraints, ['no retinoids']);
    assert.strictEqual(result.introPayload.followup_questions.length, 1);
  });

  it('returns fallback questions when LLM fails', async () => {
    const provider = makeFailingProvider();
    const ctx = makeCtx();
    const result = await runStage1({ goals: ['barrier_repair'], customInput: '', ctx, llmProvider: provider });
    assert.ok(result.introPayload);
    assert.ok(result.introPayload.followup_questions.length >= 2, 'should have fallback questions');
  });

  it('extracts JSON from prose-wrapped LLM response', async () => {
    const text = 'Sure! Here is the JSON:\n\n{"goal_profile":{"constraints":["allergy to fragrance"]},"followup_questions":[{"id":"q1","question":"Sensitivity?","options":[{"id":"a","label":"Low"},{"id":"b","label":"High"}]}]}';
    const provider = makeMockProvider(text);
    const ctx = makeCtx();
    const result = await runStage1({ goals: ['brightening'], customInput: '', ctx, llmProvider: provider });
    assert.ok(result.introPayload);
    assert.deepStrictEqual(result.introPayload.goal_profile.constraints, ['allergy to fragrance']);
    assert.strictEqual(result.introPayload.followup_questions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// normalization tests
// ---------------------------------------------------------------------------

describe('normalizeDiagnosisV2ResultPayload', () => {
  it('normalizes string confidence to number', () => {
    const payload = {
      diagnosis_id: 'a0000000-0000-4000-a000-000000000001',
      diagnosis_seq: 1,
      goal_profile: { selected_goals: ['barrier_repair'], constraints: [] },
      is_cold_start: true,
      data_quality: { overall: 'low' },
      inferred_state: {
        axes: [
          { axis: 'barrier_irritation_risk', level: 'Moderate', confidence: '0.35', evidence: ['user reported redness'], trend: 'new' },
        ],
      },
      strategies: [{ title: 'Gentle', why: 'Limited data', timeline: '2 weeks', do_list: ['moisturize'], avoid_list: [] }],
      routine_blueprint: { am_steps: ['cleanser', 'spf'], pm_steps: ['cleanser', 'moisturizer'], conflict_rules: [] },
      next_actions: [{ type: 'direct_reco', label: 'See recs' }],
      improvement_path: [],
    };
    const ctx = makeCtx({ _followupAnswers: {}, _photoFindings: null });
    const result = normalizeDiagnosisV2ResultPayload(payload, ctx);

    assert.strictEqual(typeof result.inferred_state.axes[0].confidence, 'number');
    assert.strictEqual(result.inferred_state.axes[0].confidence, 0.35);
    assert.strictEqual(result.inferred_state.axes[0].level, 'moderate');
  });

  it('fills fallback evidence when empty', () => {
    const payload = {
      diagnosis_id: 'a0000000-0000-4000-a000-000000000002',
      diagnosis_seq: 1,
      goal_profile: { selected_goals: ['anti_aging_face'], constraints: [] },
      is_cold_start: true,
      data_quality: { overall: 'low' },
      inferred_state: {
        axes: [
          { axis: 'photoaging_risk', level: 'moderate', confidence: 0.3, evidence: [], trend: 'new' },
        ],
      },
      strategies: [],
      routine_blueprint: {},
      next_actions: [],
      improvement_path: [],
    };
    const ctx = makeCtx({ _followupAnswers: {}, _photoFindings: null });
    const result = normalizeDiagnosisV2ResultPayload(payload, ctx);

    assert.ok(result.inferred_state.axes[0].evidence.length > 0, 'should have fallback evidence');
  });

  it('provides fallback strategies when LLM returns empty', () => {
    const payload = {
      diagnosis_id: 'a0000000-0000-4000-a000-000000000003',
      diagnosis_seq: 1,
      goal_profile: { selected_goals: ['barrier_repair'], constraints: [] },
      is_cold_start: true,
      data_quality: { overall: 'low' },
      inferred_state: { axes: [] },
      strategies: [],
      routine_blueprint: {},
      next_actions: [],
      improvement_path: [],
    };
    const ctx = makeCtx({ _followupAnswers: {}, _photoFindings: null });
    const result = normalizeDiagnosisV2ResultPayload(payload, ctx);

    assert.ok(result.strategies.length >= 1, 'should have fallback strategy');
    assert.ok(result.next_actions.length >= 1, 'should have fallback next_actions');
    assert.ok(result.routine_blueprint.am_steps.length >= 1, 'should have fallback AM steps');
  });

  it('normalizes data_quality with fallback', () => {
    const payload = {
      diagnosis_id: 'a0000000-0000-4000-a000-000000000004',
      diagnosis_seq: 1,
      goal_profile: { selected_goals: ['brightening'], constraints: [] },
      is_cold_start: true,
      data_quality: null,
      inferred_state: { axes: [] },
      strategies: [],
      routine_blueprint: {},
      next_actions: [],
      improvement_path: [],
    };
    const ctx = makeCtx({ _followupAnswers: {}, _photoFindings: null });
    const result = normalizeDiagnosisV2ResultPayload(payload, ctx);

    assert.strictEqual(result.data_quality.overall, 'low');
    assert.ok(result.data_quality.limits_banner.length > 0);
  });
});

// ---------------------------------------------------------------------------
// runDiagnosisV2 with all stages failing
// ---------------------------------------------------------------------------

describe('runDiagnosisV2 full pipeline', () => {
  it('returns a valid payload even when all LLM calls fail', async () => {
    const provider = makeFailingProvider(new Error('network_error'));
    const ctx = makeCtx({ userId: null });
    const result = await runDiagnosisV2({
      goals: ['barrier_repair'],
      customInput: '',
      followupAnswers: {},
      photoFindings: null,
      ctx,
      llmProvider: provider,
      onThinkingStep: () => {},
    });

    assert.ok(result.resultPayload);
    assert.ok(result.resultPayload.diagnosis_id);

    const validation = validateResultPayload(result.resultPayload);
    assert.ok(validation.ok, `Validation should pass: ${JSON.stringify(validation.errors)}`);
    assert.ok(result.resultPayload.strategies.length >= 1);
    assert.ok(result.resultPayload.next_actions.length >= 1);
    assert.ok(result.resultPayload.inferred_state.axes.length >= 1);
  });

  it('returns valid payload when LLM returns good JSON', async () => {
    let callCount = 0;
    const responses = [
      JSON.stringify({
        goal_profile: { constraints: [] },
        followup_questions: [
          { id: 'q1', question: 'Skin state?', options: [{ id: 'a', label: 'Good' }, { id: 'b', label: 'Bad' }] },
        ],
      }),
      JSON.stringify({
        inferred_state: {
          axes: [
            { axis: 'barrier_irritation_risk', level: 'moderate', confidence: 0.4, evidence: ['user reports redness'], trend: 'new' },
            { axis: 'dryness_tightness', level: 'low', confidence: 0.35, evidence: ['no photo signal'], trend: 'new' },
          ],
        },
        data_quality: { overall: 'low', limits_banner: 'Limited data — conservative estimate.' },
        thinking_steps: [{ text: 'Analyzing barrier state' }],
      }),
      JSON.stringify({
        strategies: [
          {
            title: 'Gentle repair',
            why: 'Limited signals suggest conservative approach',
            timeline: '2-4 weeks',
            do_list: ['Use barrier cream'],
            avoid_list: ['Strong acids'],
          },
        ],
        routine_blueprint: {
          am_steps: ['Gentle cleanser', 'Moisturizer', 'SPF'],
          pm_steps: ['Gentle cleanser', 'Barrier serum', 'Moisturizer'],
          conflict_rules: [],
        },
        next_actions: [{ type: 'direct_reco', label: 'See recommendations' }],
        improvement_path: [{ tip: 'Add a photo', action_type: 'take_photo', action_label: 'Add photo' }],
        thinking_steps: [{ text: 'Building strategy' }],
      }),
    ];
    const provider = {
      isAvailable: () => true,
      generate: async () => ({ provider: 'mock', text: responses[callCount++] }),
    };
    const ctx = makeCtx({ userId: null });
    const thinkingSteps = [];
    const result = await runDiagnosisV2({
      goals: ['barrier_repair'],
      customInput: '',
      followupAnswers: {},
      photoFindings: null,
      ctx,
      llmProvider: provider,
      onThinkingStep: (step) => thinkingSteps.push(step),
    });

    assert.ok(result.resultPayload);
    const validation = validateResultPayload(result.resultPayload);
    assert.ok(validation.ok, `Validation should pass: ${JSON.stringify(validation.errors)}`);
    assert.strictEqual(result.resultPayload.strategies[0].title, 'Gentle repair');
    assert.ok(thinkingSteps.length >= 4, 'should have thinking steps from all stages');
  });

  it('persists guest diagnosis artifacts by auroraUid and exposes persistence metadata', async () => {
    const previousRetention = process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
    process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = '0';
    try {
      let callCount = 0;
      const responses = [
        JSON.stringify({
          goal_profile: { constraints: [] },
          followup_questions: [
            { id: 'q1', question: 'Skin state?', options: [{ id: 'a', label: 'Good' }, { id: 'b', label: 'Bad' }] },
          ],
        }),
        JSON.stringify({
          inferred_state: {
            axes: [
              { axis: 'barrier_irritation_risk', level: 'moderate', confidence: 0.4, evidence: ['user reports redness'], trend: 'new' },
            ],
          },
          data_quality: { overall: 'medium', limits_banner: 'Enough data.' },
        }),
        JSON.stringify({
          strategies: [
            {
              title: 'Gentle repair',
              why: 'Repair barrier',
              timeline: '2-4 weeks',
              do_list: ['Barrier cream'],
              avoid_list: ['Strong acids'],
            },
          ],
          routine_blueprint: {
            am_steps: ['Gentle cleanser', 'Moisturizer', 'SPF'],
            pm_steps: ['Gentle cleanser', 'Barrier serum', 'Moisturizer'],
            conflict_rules: [],
          },
          next_actions: [{ type: 'direct_reco', label: 'See recommendations' }],
          improvement_path: [{ tip: 'Add a photo', action_type: 'take_photo', action_label: 'Add photo' }],
        }),
      ];
      const provider = {
        isAvailable: () => true,
        generate: async () => ({ provider: 'mock', text: responses[callCount++] }),
      };
      const ctx = makeCtx({
        auroraUid: `uid_diag_guest_${Date.now()}`,
        userId: null,
      });
      const result = await runDiagnosisV2({
        goals: ['barrier_repair'],
        customInput: '',
        followupAnswers: {},
        photoFindings: null,
        ctx,
        llmProvider: provider,
        onThinkingStep: () => {},
      });

      assert.ok(String(result.latestArtifactId || '').trim());
      assert.equal(result.artifactPersistence && result.artifactPersistence.persisted, true);
      assert.equal(result.artifactPersistence && result.artifactPersistence.storage_mode, 'ephemeral');
      assert.equal(result.artifactPersistence && result.artifactPersistence.artifact_id, result.latestArtifactId);
      assert.ok(result.analysisContextSnapshot);
    } finally {
      if (previousRetention === undefined) delete process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
      else process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = previousRetention;
    }
  });
});

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe('validateResultPayload with relaxed evidence', () => {
  it('accepts axes with empty evidence', () => {
    const payload = {
      diagnosis_id: 'a0000000-0000-4000-a000-000000000010',
      diagnosis_seq: 1,
      goal_profile: { selected_goals: ['barrier_repair'], constraints: [] },
      is_cold_start: false,
      data_quality: { overall: 'medium' },
      inferred_state: {
        axes: [
          { axis: 'barrier_irritation_risk', level: 'moderate', confidence: 0.5, evidence: [], trend: 'new' },
        ],
      },
      strategies: [{ title: 'Test', why: 'Test', timeline: '2w', do_list: ['Step'], avoid_list: [] }],
      routine_blueprint: { am_steps: ['Cleanser'], pm_steps: ['Cleanser'], conflict_rules: [] },
      next_actions: [{ type: 'direct_reco', label: 'Recs' }],
      improvement_path: [],
    };
    const result = validateResultPayload(payload);
    assert.ok(result.ok, `Should accept empty evidence: ${JSON.stringify(result.errors)}`);
  });
});
