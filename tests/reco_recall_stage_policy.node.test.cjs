const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getRecoRecallSelectedCount,
  getRecoRecallFilledRoleIds,
  isRecoRecallFrameworkCoverageSatisfied,
  shouldRunRecoRecallStage,
} = require('../src/auroraBff/recoRecallStagePolicy');

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
