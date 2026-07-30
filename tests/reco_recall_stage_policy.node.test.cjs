const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RECO_INTERNAL_RECALL_LANE_MODE_ENV,
  isRecoRecallInternalLaneEnabled,
  getRecoRecallSelectedCount,
  getRecoRecallFilledRoleIds,
  isRecoRecallFrameworkCoverageSatisfied,
  shouldRunRecoRecallStage,
} = require('../src/auroraBff/recoRecallStagePolicy');

function withInternalLaneMode(mode, fn) {
  const original = process.env[RECO_INTERNAL_RECALL_LANE_MODE_ENV];
  if (mode === undefined) delete process.env[RECO_INTERNAL_RECALL_LANE_MODE_ENV];
  else process.env[RECO_INTERNAL_RECALL_LANE_MODE_ENV] = mode;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[RECO_INTERNAL_RECALL_LANE_MODE_ENV];
    else process.env[RECO_INTERNAL_RECALL_LANE_MODE_ENV] = original;
  }
}

test('reco recall stage policy skips internal-lane stages by default while the backend internal lane has no real inventory', () => {
  withInternalLaneMode(undefined, () => {
    assert.equal(isRecoRecallInternalLaneEnabled(), false);
    const decision = shouldRunRecoRecallStage(
      {
        stage_id: 'framework_stage_a_primary_internal',
        source_scope: 'internal',
        run_if: 'always',
      },
      { candidateState: { selected_candidate_count: 0 } },
    );
    assert.deepEqual(decision, { run: false, reason: 'internal_lane_disabled' });
  });
});

test('reco recall stage policy skips framework support internal stages by default', () => {
  withInternalLaneMode(undefined, () => {
    const decision = shouldRunRecoRecallStage(
      {
        stage_id: 'framework_stage_c_support_lightweight_moisturizer',
        role_id: 'lightweight_moisturizer',
        source_scope: 'internal',
        run_if: 'if_role_unfilled_after_primary',
      },
      {
        candidateState: {
          primary_role_matched: true,
          selected_recommendations: [
            { matched_role_id: 'oil_control_treatment', retrieval_role_id: 'oil_control_treatment' },
          ],
        },
      },
    );
    assert.deepEqual(decision, { run: false, reason: 'internal_lane_disabled' });
  });
});

test('reco recall stage policy keeps external seed and hybrid stages running while the internal lane is disabled', () => {
  withInternalLaneMode(undefined, () => {
    assert.deepEqual(
      shouldRunRecoRecallStage(
        {
          stage_id: 'framework_stage_b_primary_external_seed',
          source_scope: 'external_seed',
          run_if: 'if_surface_count_below_target',
        },
        { candidateState: { selected_candidate_count: 0 } },
      ),
      { run: true, reason: 'surface_count_below_target' },
    );
    assert.deepEqual(
      shouldRunRecoRecallStage(
        {
          stage_id: 'beauty_mainline_query_1',
          source_scope: 'hybrid',
          run_if: 'always',
        },
        {},
      ),
      { run: true, reason: 'always' },
    );
  });
});

test('reco recall stage policy runs internal stages when the internal lane is explicitly enabled', () => {
  withInternalLaneMode('enabled', () => {
    assert.equal(isRecoRecallInternalLaneEnabled(), true);
    const decision = shouldRunRecoRecallStage(
      {
        stage_id: 'framework_stage_a_primary_internal',
        source_scope: 'internal',
        run_if: 'always',
      },
      {},
    );
    assert.deepEqual(decision, { run: true, reason: 'always' });
  });
});

test('reco recall stage policy skips framework support stages until primary role is matched', () => {
  const decision = shouldRunRecoRecallStage(
    {
      stage_id: 'framework_stage_c_support_lightweight_moisturizer',
      role_id: 'lightweight_moisturizer',
      run_if: 'if_role_unfilled_after_primary',
    },
    {
      candidateState: {
        primary_role_matched: false,
        selected_candidate_count: 0,
      },
    },
  );
  assert.deepEqual(decision, { run: false, reason: 'primary_role_unmatched' });
});

test('reco recall stage policy allows framework support stages after primary role match while surface is incomplete', () => {
  const decision = shouldRunRecoRecallStage(
    {
      stage_id: 'framework_stage_c_support_lightweight_moisturizer',
      role_id: 'lightweight_moisturizer',
      run_if: 'if_role_unfilled_after_primary',
    },
    {
      candidateState: {
        primary_role_matched: true,
        selected_recommendations: [
          {
            matched_role_id: 'oil_control_treatment',
            retrieval_role_id: 'oil_control_treatment',
          },
        ],
      },
    },
  );
  assert.deepEqual(decision, { run: true, reason: 'role_unfilled' });
});

test('reco recall stage policy skips support role stage when that role is already filled by a role-aligned candidate', () => {
  const decision = shouldRunRecoRecallStage(
    {
      stage_id: 'framework_stage_c_support_lightweight_moisturizer_external_seed',
      role_id: 'lightweight_moisturizer',
      run_if: 'if_role_unfilled_after_primary',
    },
    {
      candidateState: {
        primary_role_matched: true,
        selected_recommendations: [
          {
            matched_role_id: 'oil_control_treatment',
            retrieval_role_id: 'oil_control_treatment',
          },
          {
            matched_role_id: 'lightweight_moisturizer',
            retrieval_role_id: 'lightweight_moisturizer',
          },
        ],
      },
    },
  );
  assert.deepEqual(decision, { run: false, reason: 'role_already_filled' });
});

test('reco recall stage policy allows primary external supplement while primary surface count is still below target', () => {
  const decision = shouldRunRecoRecallStage(
    {
      stage_id: 'framework_stage_b_primary_external_seed',
      run_if: 'if_surface_count_below_target',
    },
    {
      candidateState: {
        primary_role_matched: true,
        selected_candidate_count: 1,
      },
    },
  );
  assert.deepEqual(decision, { run: true, reason: 'surface_count_below_target' });
});

test('reco recall selected count falls back to selected_recommendations length', () => {
  assert.equal(
    getRecoRecallSelectedCount({
      selected_recommendations: [{ product_id: 'a' }, { product_id: 'b' }],
    }),
    2,
  );
});

test('reco recall filled role ids ignore cross-role selections without aligned retrieval evidence', () => {
  assert.deepEqual(
    getRecoRecallFilledRoleIds(
      {
        selected_recommendations: [
          {
            matched_role_id: 'oil_control_treatment',
            retrieval_role_id: 'oil_control_treatment',
          },
          {
            matched_role_id: 'lightweight_moisturizer',
            retrieval_role_id: 'oil_control_treatment',
          },
          {
            matched_role_id: 'daily_sunscreen',
            retrieval_role_id: 'daily_sunscreen',
          },
        ],
      },
      { requireAlignedRetrieval: true },
    ),
    ['oil_control_treatment', 'daily_sunscreen'],
  );
});

test('reco recall framework coverage requires role-aligned coverage for the planned framework roles', () => {
  assert.equal(
    isRecoRecallFrameworkCoverageSatisfied(
      {
        primary_role_matched: true,
        selected_recommendations: [
          {
            matched_role_id: 'oil_control_treatment',
            retrieval_role_id: 'oil_control_treatment',
          },
          {
            matched_role_id: 'lightweight_moisturizer',
            retrieval_role_id: 'oil_control_treatment',
          },
          {
            matched_role_id: 'daily_sunscreen',
            retrieval_role_id: 'daily_sunscreen',
          },
        ],
      },
      {
        targetContext: {
          framework_roles: [
            { role_id: 'oil_control_treatment', rank: 1 },
            { role_id: 'lightweight_moisturizer', rank: 2 },
            { role_id: 'daily_sunscreen', rank: 3 },
          ],
        },
      },
    ),
    false,
  );
});
