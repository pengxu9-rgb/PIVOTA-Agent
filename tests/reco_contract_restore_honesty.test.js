'use strict';
/**
 * Restore-path honesty (fabrication-belt F4, 2026-08-11).
 *
 * applyVerifiedCandidateRestoreToRecoPayload used to DELETE eleven-plus failure
 * telemetry fields and stamp recommendation_confidence_score = 0.61 when no
 * score existed — a precise-looking number nothing computed, and a scrubbed
 * failure history for any dashboard aggregating those fields. The restore now
 * carries the original context under `restored_from_failure_context` and emits
 * null for an uncomputed confidence.
 */

const { applyVerifiedCandidateRestoreToRecoPayload } = require('../src/auroraBff/recoContract');

const RESTORED = [{ sku_id: 'sku_1', title: 'Restored product' }];

function payloadWithFailureMeta() {
  return {
    recommendations: [],
    recommendation_meta: {
      primary_failure_reason: 'catalog_timeout',
      failure_class: 'upstream_timeout',
      upstream_status: 'timeout',
      weak_viable_pool: true,
      selected_candidate_count: 0,
      unrelated_field: 'survives_in_place',
    },
  };
}

describe('verified-candidate restore is honest about its history', () => {
  test('original failure telemetry is preserved under restored_from_failure_context', () => {
    const { payload, applied } = destructure(
      applyVerifiedCandidateRestoreToRecoPayload(payloadWithFailureMeta(), RESTORED),
    );
    expect(applied).toBe(true);
    const meta = payload.recommendation_meta;
    // Superseded, not scrubbed:
    const ctx = meta.restored_from_failure_context;
    expect(ctx).toEqual({
      primary_failure_reason: 'catalog_timeout',
      failure_class: 'upstream_timeout',
      upstream_status: 'timeout',
      weak_viable_pool: true,
      selected_candidate_count: 0,
    });
    // The superseded fields no longer masquerade as current state:
    expect(meta.primary_failure_reason).toBeUndefined();
    expect(meta.upstream_status).toBe('ok'); // the restore's own (labeled) state
    // Untouched fields stay in place:
    expect(meta.unrelated_field).toBe('survives_in_place');
    // And the restore still self-labels as a degraded success:
    expect(meta.presentation_mode).toBe('deterministic_degraded');
  });

  test('no failure context -> no empty restored_from_failure_context key', () => {
    const { payload } = destructure(
      applyVerifiedCandidateRestoreToRecoPayload({ recommendations: [] }, RESTORED),
    );
    expect('restored_from_failure_context' in payload.recommendation_meta).toBe(false);
  });

  test('an uncomputed confidence is null, never an invented 0.61', () => {
    const { payload } = destructure(
      applyVerifiedCandidateRestoreToRecoPayload({ recommendations: [] }, RESTORED),
    );
    expect(payload.recommendation_confidence_score).toBeNull();
  });

  test('a real computed confidence is preserved verbatim', () => {
    const input = { recommendations: [], recommendation_confidence_score: 0.87 };
    const { payload } = destructure(applyVerifiedCandidateRestoreToRecoPayload(input, RESTORED));
    expect(payload.recommendation_confidence_score).toBe(0.87);
  });
});

function destructure(result) {
  // applyVerifiedCandidateRestoreToRecoPayload returns { payload, applied, count }.
  expect(result && typeof result).toBe('object');
  return result;
}
