const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getRecoRecallSelectedCount,
  shouldRunRecoRecallStage,
} = require('../src/auroraBff/recoRecallStagePolicy');

test('reco recall stage policy skips framework support stages until primary role is matched', () => {
  const decision = shouldRunRecoRecallStage(
    {
      stage_id: 'framework_stage_c_support_rank2_internal',
      run_if: 'if_surface_count_below_target',
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
      stage_id: 'framework_stage_c_support_rank2_internal',
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

test('reco recall stage policy still allows primary external stage after empty primary internal stage', () => {
  const decision = shouldRunRecoRecallStage(
    {
      stage_id: 'framework_stage_b_primary_external_seed',
      run_if: 'if_no_primary_viable_or_transient_only',
    },
    {
      stageResults: [
        {
          stage_id: 'framework_stage_a_primary_internal',
          skipped: false,
          transient_only: false,
          selected_count: 0,
          primary_role_matched: false,
        },
      ],
      candidateState: {
        primary_role_matched: false,
        selected_candidate_count: 0,
      },
    },
  );
  assert.deepEqual(decision, { run: true, reason: 'previous_stage_empty' });
});

test('reco recall selected count falls back to selected_recommendations length', () => {
  assert.equal(
    getRecoRecallSelectedCount({
      selected_recommendations: [{ product_id: 'a' }, { product_id: 'b' }],
    }),
    2,
  );
});
