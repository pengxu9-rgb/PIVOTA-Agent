const { _internals } = require('../../scripts/sync-external-seed-ingredient-fields.cjs');

describe('sync-external-seed-ingredient-fields', () => {
  test('Wave 1 kb_reviewed eligibility uses pre-write kb sync status', () => {
    const disposition = _internals.resolveWaveDisposition(
      {
        attached_product_key: '',
        domain: 'example.com',
        title: 'Niacinamide Serum',
        canonical_url: 'https://example.com/products/niacinamide-serum',
        destination_url: 'https://example.com/products/niacinamide-serum',
      },
      {
        enrichment_source: 'kb_reviewed',
        seed_structured_ingredient_status_before: 'missing',
        seed_structured_ingredient_status_after: 'present',
        seed_kb_sync_status_before: 'kb_only_unsynced',
        seed_kb_sync_status: 'synced',
        reviewed_kb_rows: [{
          sku_key: 'extseed:eps_demo:variant-1',
          product_name: 'Niacinamide Serum - 30 ml',
          source_ref: 'https://example.com/products/niacinamide-serum',
        }],
        seed_anchor_source_kind: 'kb_reviewed',
        seed_anchor_conflict_status: 'none',
        url_anchor_conflict: false,
        quarantine_reason: null,
        seed_quarantine_bucket: null,
        quarantined_from_wave1: false,
        contamination_signal_source: null,
      },
      {
        wave: 'kb_reviewed',
        missingOnly: true,
        attachedOnly: false,
        unattachedOnly: false,
        allowDomains: [],
      },
    );

    expect(disposition.eligible).toBe(true);
    expect(disposition.quarantineReason).toBeNull();
  });

  test('Wave 1 kb_reviewed rejects rows that were already synced before write', () => {
    const disposition = _internals.resolveWaveDisposition(
      {
        attached_product_key: '',
        domain: 'example.com',
        title: 'Niacinamide Serum',
        canonical_url: 'https://example.com/products/niacinamide-serum',
        destination_url: 'https://example.com/products/niacinamide-serum',
      },
      {
        enrichment_source: 'kb_reviewed',
        seed_structured_ingredient_status_before: 'present',
        seed_structured_ingredient_status_after: 'present',
        seed_kb_sync_status_before: 'synced',
        seed_kb_sync_status: 'synced',
        reviewed_kb_rows: [{
          sku_key: 'extseed:eps_demo:variant-1',
          product_name: 'Niacinamide Serum - 30 ml',
          source_ref: 'https://example.com/products/niacinamide-serum',
        }],
        seed_anchor_source_kind: 'kb_reviewed',
        seed_anchor_conflict_status: 'none',
        url_anchor_conflict: false,
        quarantine_reason: null,
        seed_quarantine_bucket: null,
        quarantined_from_wave1: false,
        contamination_signal_source: null,
      },
      {
        wave: 'kb_reviewed',
        missingOnly: false,
        attachedOnly: false,
        unattachedOnly: false,
        allowDomains: [],
      },
    );

    expect(disposition.eligible).toBe(false);
    expect(disposition.quarantineReason).toBe('not_kb_reviewed');
  });

  test('Wave 1 kb_reviewed rejects reviewed rows quarantined for manual upstream review', () => {
    const disposition = _internals.resolveWaveDisposition(
      {
        attached_product_key: '',
        domain: 'pixibeauty.com',
        title: 'Retinol Eye Cream',
        canonical_url: 'https://pixibeauty.com/products/retinol-eye-cream',
        destination_url: 'https://pixibeauty.com/products/retinol-eye-cream',
      },
      {
        enrichment_source: 'kb_reviewed',
        seed_structured_ingredient_status_before: 'missing',
        seed_structured_ingredient_status_after: 'present',
        seed_kb_sync_status_before: 'kb_only_unsynced',
        seed_kb_sync_status: 'synced',
        reviewed_kb_rows: [
          {
            sku_key: 'extseed:eps_demo:variant-1',
            product_name: 'Retinol Eye Cream - 25 ml',
            source_ref: 'https://www.pixibeauty.com/products/retinol-eye-cream',
          },
        ],
        seed_anchor_source_kind: 'kb_reviewed',
        seed_anchor_conflict_status: 'none',
        url_anchor_conflict: false,
        quarantine_reason: null,
        seed_quarantine_bucket: 'manual_upstream_required',
        quarantined_from_wave1: true,
        contamination_signal_source: 'row_scope_off_surface_signal',
      },
      {
        wave: 'kb_reviewed',
        missingOnly: true,
        attachedOnly: false,
        unattachedOnly: false,
        allowDomains: [],
      },
    );

    expect(disposition.eligible).toBe(false);
    expect(disposition.quarantineReason).toBe('manual_upstream_required');
    expect(disposition.quarantine.seed_quarantine_bucket).toBe('manual_upstream_required');
  });
});
