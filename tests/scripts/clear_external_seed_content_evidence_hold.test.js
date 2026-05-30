jest.mock('../../src/db', () => ({
  closePool: jest.fn(),
  query: jest.fn(),
  withClient: jest.fn(),
}));

const {
  HOLD_VERSION,
  clearSeedDataContentEvidenceHold,
  isContentEvidenceHold,
  summarizeHoldMarker,
} = require('../../scripts/clear-external-seed-content-evidence-hold.cjs');

describe('clear-external-seed-content-evidence-hold', () => {
  test('removes content evidence markers while preserving commerce and source fields', () => {
    const marker = {
      contract_version: HOLD_VERSION,
      status: 'hold_for_evidence',
      reason: 'post_sync_audit_failed_similar_gate',
      evidence: 'similar_underfill_after_official_source_recovery',
      updated_at: '2026-05-30T00:00:00.000Z',
    };
    const result = clearSeedDataContentEvidenceHold({
      brand: 'OILUJ',
      title: 'Life Oil',
      price_amount: 65,
      price_currency: 'USD',
      availability: 'in_stock',
      pdp_ingredients_raw: 'organic moringa oil and sandalwood essential oil',
      content_evidence_hold_v1: marker,
      snapshot: {
        brand: 'OILUJ',
        title: 'Life Oil',
        price_amount: 65,
        price_currency: 'USD',
        availability: 'in_stock',
        content_evidence_hold_v1: marker,
      },
    });

    expect(result.removed_top_level).toBe(true);
    expect(result.removed_snapshot).toBe(true);
    expect(result.top_level_marker).toEqual(
      expect.objectContaining({
        reason: 'post_sync_audit_failed_similar_gate',
        evidence: 'similar_underfill_after_official_source_recovery',
      }),
    );
    expect(result.seed_data.content_evidence_hold_v1).toBeUndefined();
    expect(result.seed_data.snapshot.content_evidence_hold_v1).toBeUndefined();
    expect(result.seed_data.price_amount).toBe(65);
    expect(result.seed_data.price_currency).toBe('USD');
    expect(result.seed_data.availability).toBe('in_stock');
    expect(result.seed_data.pdp_ingredients_raw).toContain('sandalwood');
    expect(result.seed_data.snapshot.price_amount).toBe(65);
  });

  test('recognizes legacy status markers and ignores unrelated objects', () => {
    expect(isContentEvidenceHold({ status: 'content_evidence_hold' })).toBe(true);
    expect(summarizeHoldMarker({ contract_version: HOLD_VERSION, reason: 'manual_review' })).toEqual(
      expect.objectContaining({ contract_version: HOLD_VERSION, reason: 'manual_review' }),
    );
    expect(isContentEvidenceHold({ contract_version: 'external_seed.source_unavailable.v1' })).toBe(false);
    expect(summarizeHoldMarker({ status: 'source_unavailable' })).toBeNull();
  });
});
