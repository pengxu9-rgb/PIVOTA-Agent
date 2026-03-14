const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRecommendationIntent,
  buildRecommendationRequestContext,
  runRecommendationSharedStack,
  REQUEST_CONTEXT_SIGNATURE_VERSION,
  CANDIDATE_POOL_SIGNATURE_VERSION,
  MIN_CONTEXT_RULE_VERSION,
} = require('../src/auroraBff/recommendationSharedStack');
const RecoStepBasedSkill = require('../src/auroraBff/skills/reco_step_based');
const { mapSkillResponseToStreamEnvelope } = require('../src/auroraBff/mappers/card_mapper');
const {
  buildSkillRequest,
  handleChatStream,
  __setRouterForTests,
  __resetRouterForTests,
  __setTravelPipelineForTests,
} = require('../src/auroraBff/routes/chat');

test('normalizeRecommendationIntent falls back to unknown exploratory contract', () => {
  const result = normalizeRecommendationIntent({ entryType: 'direct', message: '', directRequest: {} });
  assert.equal(result.need_id, 'unknown');
  assert.equal(result.need_type, 'exploratory');
  assert.equal(result.target_need, null);
  assert.equal(result.needs_clarification, true);
});

test('buildRecommendationRequestContext produces stable signature and explicit-first hard context', () => {
  const intent = normalizeRecommendationIntent({
    entryType: 'direct',
    directRequest: { focus: 'Recommend a gentle cleanser' },
  });
  const context = buildRecommendationRequestContext({
    intent,
    profile: {
      skinType: 'oily',
      sensitivity: 'high',
      goals: ['acne', 'pores'],
    },
    recentLogs: [],
    requestOverride: { goals: ['acne'] },
  });

  assert.equal(context.need_id, 'recommend_a_gentle_cleanser');
  assert.equal(context.strictness_mode, 'strict');
  assert.equal(context.strictness_source, 'entry_default');
  assert.ok(context.request_context_signature);
  assert.equal(context.request_context_signature_version, REQUEST_CONTEXT_SIGNATURE_VERSION);
  assert.equal(context.context_source_mode, 'explicit_only');
  assert.equal(context.analysis_context_available, true);
  assert.equal(context.minimum_recommendation_context_satisfied, true);
  assert.equal(context.context_usage.min_context_rule_version, MIN_CONTEXT_RULE_VERSION);
  assert.equal(context.context_usage.minimum_recommendation_context_satisfied, true);
  assert.deepEqual(context.snapshot_hard_context.active_goals, ['acne']);
  assert.equal(context.context_usage.explicit_override_applied, true);
});

test('buildRecommendationRequestContext marks profile.lastAnalysis as artifact_compat_fallback', () => {
  const intent = normalizeRecommendationIntent({
    entryType: 'direct',
    directRequest: { focus: 'Recommend a serum' },
  });
  const context = buildRecommendationRequestContext({
    intent,
    profile: {
      lastAnalysis: {
        skin_profile: {
          skin_type_tendency: 'combination',
          sensitivity_tendency: 'medium',
        },
        ingredient_plan: {
          targets: [{ ingredient_name: 'niacinamide' }],
        },
      },
    },
  });

  assert.equal(context.context_source_mode, 'artifact_compat_fallback');
  assert.equal(context.context_usage.snapshot_present, true);
  assert.equal(context.analysis_context_available, true);
  assert.equal(context.request_context_signature_version, REQUEST_CONTEXT_SIGNATURE_VERSION);
});

test('runRecommendationSharedStack clarifies generic chat reco when minimum context is unsatisfied', async () => {
  let coreRunnerCalled = false;
  const out = await runRecommendationSharedStack({
    entryType: 'chat',
    message: 'Recommend a few products',
    profile: { goals: ['hydration'] },
    coreRunner: async () => {
      coreRunnerCalled = true;
      throw new Error('coreRunner should not be called for clarify-first chat reco');
    },
    coreInput: {},
  });

  assert.equal(coreRunnerCalled, false);
  assert.equal(out.needs_more_context, true);
  assert.equal(out.request_context.context_source_mode, 'explicit_only');
  assert.equal(out.request_context.analysis_context_available, true);
  assert.equal(out.request_context.minimum_recommendation_context_satisfied, false);
  assert.ok(out.request_context.request_context_signature);
  assert.equal(out.request_context.request_context_signature_version, REQUEST_CONTEXT_SIGNATURE_VERSION);
  assert.ok(out.candidate_pool.candidate_pool_signature);
  assert.equal(out.candidate_pool.candidate_pool_signature_version, CANDIDATE_POOL_SIGNATURE_VERSION);
  assert.equal(out.core_result.fallback_mode, 'chat_clarify_needed_for_missing_target_need');
  assert.equal(out.core_result.debug_meta.mainline_status, 'needs_more_context');
});

test('runRecommendationSharedStack executes when explicit-only context satisfies readiness', async () => {
  const out = await runRecommendationSharedStack({
    entryType: 'chat',
    message: 'Recommend a few products',
    profile: {
      skinType: 'dry',
      sensitivity: 'high',
      goals: ['hydration'],
    },
    coreRunner: async (input) => {
      assert.equal(input.sharedRequestContext.minimum_recommendation_context_satisfied, true);
      return {
        norm: {
          payload: {
            recommendations: [{ brand: 'CeraVe', name: 'Hydrating Cleanser' }],
            recommendation_meta: {
              source_mode: 'catalog_grounded',
              analysis_context_usage: input.sharedRequestContext.context_usage,
            },
          },
        },
        mainlineStatus: 'grounded_success',
        candidatePool: [{ product_id: 'sku_1', brand: 'CeraVe', name: 'Hydrating Cleanser' }],
        poolSource: 'catalog_candidates',
      };
    },
    coreInput: {},
  });

  assert.equal(out.needs_more_context, false);
  assert.equal(out.request_context.context_source_mode, 'explicit_only');
  assert.equal(out.request_context.analysis_context_available, true);
  assert.equal(out.request_context.minimum_recommendation_context_satisfied, true);
  assert.equal(out.request_context.request_context_signature_version, REQUEST_CONTEXT_SIGNATURE_VERSION);
  assert.equal(out.candidate_pool.candidate_pool_signature_version, CANDIDATE_POOL_SIGNATURE_VERSION);
  assert.equal(out.core_result.debug_meta.mainline_status, 'grounded_success');
  assert.equal(
    out.raw.norm.payload.recommendation_meta.analysis_context_usage.minimum_recommendation_context_satisfied,
    true,
  );
});

test('RecoStepBasedSkill uses shared core and exposes shared-stack meta', async () => {
  RecoStepBasedSkill.__setSharedRecoCoreRunnerForTest(async (input) => ({
    norm: {
      payload: {
        recommendations: [{ brand: 'CeraVe', name: 'Hydrating Cleanser' }],
        recommendation_meta: {
          source_mode: 'catalog_grounded',
          grounding_status: 'grounded',
          analysis_context_usage: input.sharedRequestContext.context_usage,
          llm_trace: { prompt_hash: 'prompt_hash_123' },
        },
      },
    },
    mainlineStatus: 'grounded_success',
    candidatePool: [{ product_id: 'sku_1', brand: 'CeraVe', name: 'Hydrating Cleanser' }],
    poolSource: 'catalog_candidates',
  }));

  try {
    const skill = new RecoStepBasedSkill();
    const response = await skill.run({
      params: {
        entry_source: 'chip.start.reco_products',
        user_message: 'Recommend a few products',
      },
      context: {
        locale: 'en-US',
        profile: { goals: ['hydration'], sensitivity: 'high', skinType: 'dry' },
        recent_logs: [],
      },
      thread_state: {},
    }, null);

    const envelope = mapSkillResponseToStreamEnvelope(response, []);
    assert.equal(envelope.meta.skill_id, 'reco.step_based');
    assert.ok(envelope.meta.request_context_signature);
    assert.ok(envelope.meta.candidate_pool_signature);
    assert.equal(envelope.meta.request_context_signature_version, REQUEST_CONTEXT_SIGNATURE_VERSION);
    assert.equal(envelope.meta.candidate_pool_signature_version, CANDIDATE_POOL_SIGNATURE_VERSION);
    assert.equal(envelope.meta.mainline_status, 'grounded_success');
    assert.equal(envelope.meta.analysis_context_usage.context_mode, 'explicit_only');
    assert.equal(envelope.meta.analysis_context_usage.context_source_mode, 'explicit_only');
    assert.equal(envelope.meta.analysis_context_usage.analysis_context_available, true);
    assert.equal(envelope.meta.analysis_context_usage.minimum_recommendation_context_satisfied, true);
    const recoCard = envelope.cards.find((card) => card.card_type === 'recommendations');
    assert.ok(recoCard);
    assert.equal(recoCard.metadata.terminal_state, 'recommendation');
    assert.equal(recoCard.metadata.recommendations[0].name, 'Hydrating Cleanser');
  } finally {
    RecoStepBasedSkill.__resetSharedRecoCoreRunnerForTest();
  }
});

test('RecoStepBasedSkill clarifies when generic chat reco lacks minimum context', async () => {
  let coreRunnerCalled = false;
  RecoStepBasedSkill.__setSharedRecoCoreRunnerForTest(async () => {
    coreRunnerCalled = true;
    throw new Error('shared core should not run for clarify-first generic reco');
  });

  try {
    const skill = new RecoStepBasedSkill();
    const response = await skill.run({
      params: {
        entry_source: 'chip.start.reco_products',
        user_message: 'Recommend a few products',
      },
      context: {
        locale: 'en-US',
        profile: { goals: ['hydration'] },
        recent_logs: [],
      },
      thread_state: {},
    }, null);

    const envelope = mapSkillResponseToStreamEnvelope(response, []);
    assert.equal(coreRunnerCalled, false);
    assert.equal(envelope.meta.skill_id, 'reco.step_based');
    assert.equal(envelope.meta.mainline_status, 'needs_more_context');
    assert.equal(envelope.meta.fallback_mode, 'chat_clarify_needed_for_missing_target_need');
    assert.equal(envelope.meta.analysis_context_usage.minimum_recommendation_context_satisfied, false);
    const textCard = envelope.cards.find((card) => card.card_type === 'text_response');
    assert.ok(textCard);
    assert.equal(textCard.metadata.terminal_state, 'clarify');
    assert.equal(envelope.cards.some((card) => card.card_type === 'recommendations'), false);
  } finally {
    RecoStepBasedSkill.__resetSharedRecoCoreRunnerForTest();
  }
});

test('buildSkillRequest carries session analysis_context_snapshot into skill context', () => {
  const request = buildSkillRequest({
    body: {
      message: 'Recommend products',
      session: {
        profile: { goals: ['hydration'] },
        meta: {
          analysis_context_snapshot: {
            snapshot_id: 'snap_1',
          },
        },
      },
    },
    headers: {},
    _recentLogs: [],
    _userProfile: null,
  });

  assert.deepEqual(request.context.analysis_context_snapshot, { snapshot_id: 'snap_1' });
});

test('handleChatStream enriches reco requests with forwarded artifact-backed snapshot', async () => {
  const routesModuleId = require.resolve('../src/auroraBff/routes');
  const originalRoutesModule = require.cache[routesModuleId];
  require.cache[routesModuleId] = {
    id: routesModuleId,
    filename: routesModuleId,
    loaded: true,
    exports: {
      __internal: {
        resolveArtifactBackedSnapshotForRoute: async () => ({
          analysis_context_snapshot: {
            snapshot_id: 'snap_forwarded',
            derived_from_artifact_ids: ['da_forwarded'],
          },
          latest_artifact_id: 'da_forwarded',
          artifact_readback_source: 'request_snapshot',
          artifact_readback_hit: true,
        }),
      },
    },
  };

  const writes = [];
  __setTravelPipelineForTests(async () => null);
  __setRouterForTests({
    async routeStream(skillRequest, onEvent) {
      assert.deepEqual(skillRequest.context.artifact_analysis_context_snapshot, {
        snapshot_id: 'snap_forwarded',
        derived_from_artifact_ids: ['da_forwarded'],
      });
      assert.equal(skillRequest.context.analysis_context_artifact_meta.artifact_readback_source, 'request_snapshot');
      assert.equal(skillRequest.context.analysis_context_artifact_meta.artifact_readback_hit, true);
      onEvent({
        type: 'result',
        data: {
          cards: [],
          ops: { thread_ops: [], profile_patch: {}, routine_patch: {}, experiment_events: [] },
          quality: { schema_valid: true, quality_ok: true, issues: [], preconditions_met: true, precondition_failures: [] },
          telemetry: { skill_id: 'reco.step_based', task_mode: 'recommendation', elapsed_ms: 0, llm_calls: 0 },
          next_actions: [],
        },
      });
      return {
        cards: [],
        ops: { thread_ops: [], profile_patch: {}, routine_patch: {}, experiment_events: [] },
        quality: { schema_valid: true, quality_ok: true, issues: [], preconditions_met: true, precondition_failures: [] },
        telemetry: { skill_id: 'reco.step_based', task_mode: 'recommendation', elapsed_ms: 0, llm_calls: 0 },
        next_actions: [],
      };
    },
  });

  try {
    await handleChatStream(
      {
        body: {
          message: 'Recommend a few products',
          session: {
            profile: { goals: ['hydration'] },
            meta: {
              analysis_context_snapshot: { snapshot_id: 'ignored_raw' },
              artifact_persistence: {
                persisted: true,
                storage_mode: 'db',
                artifact_id: 'da_forwarded',
              },
            },
            state: { latest_artifact_id: 'da_forwarded' },
          },
          language: 'EN',
        },
        headers: {},
        get() { return null; },
      },
      {
        writeHead() {},
        write(chunk) { writes.push(String(chunk)); },
        end() {},
      },
    );
    assert.match(writes.join(''), /event: result/);
  } finally {
    __resetRouterForTests();
    __setTravelPipelineForTests(async () => null);
    if (originalRoutesModule) require.cache[routesModuleId] = originalRoutesModule;
    else delete require.cache[routesModuleId];
  }
});

test('handleChatStream loads stored profile and recent logs before artifact snapshot readback', async () => {
  const routesModuleId = require.resolve('../src/auroraBff/routes');
  const originalRoutesModule = require.cache[routesModuleId];
  let capturedProfile = null;
  let capturedRecentLogs = null;
  require.cache[routesModuleId] = {
    id: routesModuleId,
    filename: routesModuleId,
    loaded: true,
    exports: {
      __internal: {
        getProfileForIdentity: async () => ({
          skinType: 'dry',
          sensitivity: 'high',
          goals: ['hydration'],
        }),
        getRecentSkinLogsForIdentity: async () => ([
          { created_at: '2026-03-01T00:00:00.000Z', note: 'tightness after cleanser' },
        ]),
        resolveArtifactBackedSnapshotForRoute: async ({ profile, recentLogs }) => {
          capturedProfile = profile;
          capturedRecentLogs = recentLogs;
          return {
            analysis_context_snapshot: {
              snapshot_id: 'snap_db_latest',
              derived_from_artifact_ids: ['da_db_latest'],
            },
            latest_artifact_id: 'da_db_latest',
            artifact_readback_source: 'db_latest',
            artifact_readback_hit: true,
          };
        },
      },
    },
  };

  const writes = [];
  __setTravelPipelineForTests(async () => null);
  __setRouterForTests({
    async routeStream(skillRequest, onEvent) {
      assert.equal(skillRequest.context.profile.skinType, 'dry');
      assert.equal(skillRequest.context.profile.sensitivity, 'high');
      assert.deepEqual(skillRequest.context.profile.goals, ['hydration']);
      assert.equal(Array.isArray(skillRequest.context.recent_logs), true);
      assert.equal(skillRequest.context.recent_logs.length, 1);
      assert.equal(skillRequest.context.analysis_context_artifact_meta.artifact_readback_source, 'db_latest');
      assert.equal(skillRequest.context.analysis_context_artifact_meta.artifact_readback_hit, true);
      onEvent({
        type: 'result',
        data: {
          cards: [],
          ops: { thread_ops: [], profile_patch: {}, routine_patch: {}, experiment_events: [] },
          quality: { schema_valid: true, quality_ok: true, issues: [], preconditions_met: true, precondition_failures: [] },
          telemetry: { skill_id: 'reco.step_based', task_mode: 'recommendation', elapsed_ms: 0, llm_calls: 0 },
          next_actions: [],
        },
      });
      return {
        cards: [],
        ops: { thread_ops: [], profile_patch: {}, routine_patch: {}, experiment_events: [] },
        quality: { schema_valid: true, quality_ok: true, issues: [], preconditions_met: true, precondition_failures: [] },
        telemetry: { skill_id: 'reco.step_based', task_mode: 'recommendation', elapsed_ms: 0, llm_calls: 0 },
        next_actions: [],
      };
    },
  });

  try {
    await handleChatStream(
      {
        body: {
          message: 'Recommend a moisturizer for me',
          session: {},
          language: 'EN',
        },
        headers: { 'x-aurora-uid': 'uid_chat_db_context' },
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || null;
        },
      },
      {
        writeHead() {},
        write(chunk) { writes.push(String(chunk)); },
        end() {},
      },
    );

    assert.deepEqual(capturedProfile, {
      skinType: 'dry',
      skin_type: 'dry',
      sensitivity: 'high',
      goals: ['hydration'],
      concerns: ['hydration'],
    });
    assert.equal(Array.isArray(capturedRecentLogs), true);
    assert.equal(capturedRecentLogs.length, 1);
    assert.match(writes.join(''), /event: result/);
  } finally {
    __resetRouterForTests();
    __setTravelPipelineForTests(async () => null);
    if (originalRoutesModule) require.cache[routesModuleId] = originalRoutesModule;
    else delete require.cache[routesModuleId];
  }
});
