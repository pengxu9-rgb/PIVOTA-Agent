const {
  labelStatePriority,
  planConflictResolution,
} = require('../scripts/rekey-relationship-labels-to-sig');

function extRow(overrides = {}) {
  return {
    id: 'ext_1',
    kind: 'ext',
    market: 'US',
    anchor_type: 'product',
    anchor_ref: 'product:ext_anchor',
    candidate_product_ref: 'product:ext_candidate',
    new_anchor_ref: 'product:sig_anchor',
    new_candidate_ref: 'product:sig_candidate',
    relation_type: 'competitive_alternative',
    label_state: 'generated',
    review_priority: 0.2,
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function existingRow(overrides = {}) {
  return {
    id: 'sig_existing',
    kind: 'existing',
    market: 'US',
    anchor_type: 'product',
    anchor_ref: 'product:sig_anchor',
    candidate_product_ref: 'product:sig_candidate',
    new_anchor_ref: 'product:sig_anchor',
    new_candidate_ref: 'product:sig_candidate',
    relation_type: 'competitive_alternative',
    label_state: 'generated',
    review_priority: 0.1,
    updated_at: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('rekey-relationship-labels-to-sig conflict planning', () => {
  test('label state priority preserves reviewed decisions over generated rows', () => {
    expect(labelStatePriority('human_approved')).toBeGreaterThan(labelStatePriority('ai_approved'));
    expect(labelStatePriority('ai_approved')).toBeGreaterThan(labelStatePriority('generated'));
    expect(labelStatePriority('human_rejected')).toBeGreaterThan(labelStatePriority('needs_evidence'));
    expect(labelStatePriority('needs_evidence')).toBeGreaterThan(labelStatePriority('generated'));
  });

  test('keeps an existing human_approved sig row over a generated ext row', () => {
    const plan = planConflictResolution(
      [extRow({ id: 'generated_ext', label_state: 'generated' })],
      [existingRow({ id: 'approved_sig', label_state: 'human_approved' })],
    );

    expect(Array.from(plan.toDelete)).toEqual(['generated_ext']);
    expect(plan.toUpdate).toHaveLength(0);
    expect(plan.conflictsMerged).toBe(1);
  });

  test('updates the higher-priority ext row and deletes a lower-priority existing sig row', () => {
    const plan = planConflictResolution(
      [extRow({ id: 'needs_evidence_ext', label_state: 'needs_evidence' })],
      [existingRow({ id: 'generated_sig', label_state: 'generated' })],
    );

    expect(Array.from(plan.toDelete)).toEqual(['generated_sig']);
    expect(plan.toUpdate.map((row) => row.id)).toEqual(['needs_evidence_ext']);
  });

  test('deduplicates multiple ext rows by review_priority within the same state', () => {
    const plan = planConflictResolution(
      [
        extRow({ id: 'low_ext', review_priority: 0.2 }),
        extRow({ id: 'high_ext', review_priority: 0.9 }),
      ],
      [],
    );

    expect(Array.from(plan.toDelete)).toEqual(['low_ext']);
    expect(plan.toUpdate.map((row) => row.id)).toEqual(['high_ext']);
  });
});
