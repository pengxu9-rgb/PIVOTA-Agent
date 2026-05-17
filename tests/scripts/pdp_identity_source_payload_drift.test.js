const {
  applySigAudit,
  buildCursor: buildAuditCursor,
  buildRowAudit,
  parseCursor: parseAuditCursor,
} = require('../../scripts/audit-pdp-identity-source-payload-drift.cjs');
const {
  buildCursor: buildSyncCursor,
  parseCursor: parseSyncCursor,
} = require('../../scripts/sync-external-seed-identity-source-payloads.cjs');
const {
  hasActiveIngredientExpectation,
} = require('../../src/services/pdpIdentityPayloadDrift');

describe('pdp identity source payload drift scripts', () => {
  test('cursor helpers support timestamp and id paging', () => {
    const row = { updated_at: new Date('2026-05-16T10:00:00.000Z'), id: 'eps_1' };

    expect(buildAuditCursor(row)).toBe('2026-05-16T10:00:00.000Z|eps_1');
    expect(parseAuditCursor('2026-05-16T10:00:00.000Z|eps_1')).toEqual({
      updatedAt: '2026-05-16T10:00:00.000Z',
      id: 'eps_1',
    });
    expect(buildSyncCursor(row)).toBe('2026-05-16T10:00:00.000Z|eps_1');
    expect(parseSyncCursor('2026-05-16T10:00:00.000Z|eps_1')).toEqual({
      updatedAt: '2026-05-16T10:00:00.000Z',
      id: 'eps_1',
    });
  });

  test('sig audit flags canonical selection gap when identity canonical is stale', () => {
    const staleSeedRow = {
      external_product_id: 'ext_stale',
      domain: 'olehenriksen.com',
      market: 'US',
      title: 'Balance+ Clarifying Serum',
      canonical_url: 'https://olehenriksen.com/products/balance-clarifying-serum',
      updated_at: '2026-05-14T00:00:00.000Z',
    };
    const richSeedRow = {
      ...staleSeedRow,
      external_product_id: 'ext_rich',
    };
    const staleIdentity = {
      source_listing_ref: 'external_seed:ext_stale',
      source_tier: 'brand',
      live_read_enabled: true,
      identity_status: 'approved',
      review_required: false,
      identity_confidence: 0.92,
      sellable_item_group_id: 'sig_balance',
      product_line_id: 'pl_balance',
      updated_at: '2026-04-12T00:00:00.000Z',
      source_payload: {
        title: 'Balance+ Clarifying Serum',
        images: ['https://cdn.example.com/stale.jpg'],
      },
    };
    const richIdentity = {
      ...staleIdentity,
      source_listing_ref: 'external_seed:ext_rich',
      product_id: 'ext_rich',
      source_payload: {
        title: 'Balance+ Bundle',
        images: ['https://cdn.example.com/rich.jpg'],
      },
    };
    const staleFreshPayload = {
      title: 'Balance+ Clarifying Serum',
      images: ['https://cdn.example.com/stale.jpg'],
    };
    const richFreshPayload = {
      title: 'Balance+ Clarifying Serum',
      pdp_active_ingredients_raw: 'Salicylic Acid (BHA) targets blemishes.',
      active_ingredients: ['Salicylic acid'],
      pdp_how_to_use_raw: 'Use each component as directed.',
      pdp_details_sections: [{ heading: 'Details', content: 'A clarifying skincare routine.' }],
      seed_data: {
        external_seed_snapshot_contract: {
          authoritative: true,
          legacy_fields_quarantined: true,
        },
      },
    };

    const rows = [
      buildRowAudit(staleSeedRow, staleIdentity, staleFreshPayload),
      buildRowAudit(richSeedRow, richIdentity, richFreshPayload),
    ];
    const sigRows = applySigAudit(rows);

    expect(sigRows[0].sig_mixed_active_expectation).toBe(true);
    expect(sigRows[0].canonical_selection_gap).toBe(true);
    expect(sigRows[0].fresh_best_content_ref).toBe('external_seed:ext_rich');
    expect(rows[0].canonical_selection_gap).toBe(true);
    expect(rows[1].sync_candidate).toBe(true);
  });

  test('bundle formula-only mismatches stay out of automatic sync candidates', () => {
    const seedRow = {
      external_product_id: 'ext_duo',
      domain: 'kyliecosmetics.com',
      market: 'US',
      title: 'Power Plush Foundation & Brush Duo',
      canonical_url: 'https://kyliecosmetics.com/products/power-plush-foundation-brush-duo',
      updated_at: '2026-05-16T00:00:00.000Z',
    };
    const identity = {
      source_listing_ref: 'external_seed:ext_duo',
      source_tier: 'brand',
      live_read_enabled: true,
      identity_status: 'approved',
      review_required: false,
      identity_confidence: 0.94,
      sellable_item_group_id: 'sig_duo',
      product_line_id: 'pl_duo',
      updated_at: '2026-05-15T00:00:00.000Z',
      source_payload: {
        title: 'Power Plush Foundation & Brush Duo',
        pdp_active_ingredients_raw: 'See Power Plush Longwear Foundation for list of ingredients.',
        pdp_ingredients_raw: 'See Power Plush Longwear Foundation for list of ingredients.',
      },
    };
    const freshPayload = {
      title: 'Power Plush Foundation & Brush Duo',
      pdp_active_ingredients_raw: 'See Power Plush Longwear Foundation for list of ingredients.',
      pdp_ingredients_raw: 'See Power Plush Longwear Foundation for list of ingredients.',
      pdp_how_to_use_raw: 'Apply to the target area and build as needed.',
      seed_data: {
        external_seed_snapshot_contract: {
          authoritative: true,
          legacy_fields_quarantined: true,
        },
      },
    };

    const row = buildRowAudit(seedRow, identity, freshPayload);

    expect(row.audit_scope_mismatch).toBe(true);
    expect(row.identity_payload_stale).toBe(false);
    expect(row.sync_candidate).toBe(false);
    expect(row.pdp_shaping_gap).toBe(false);
  });

  test('hydrocolloid spot patches do not expect active ingredients without explicit active evidence', () => {
    expect(
      hasActiveIngredientExpectation({
        title: 'Tea-Trica Spot Cover Patch',
        product_kind: 'single_formula',
        pdp_description_raw:
          'Amazingly thin and skin-like pimple patches absorb excess sebum and impurities from acne.',
        pdp_ingredients_raw:
          'Polyisobutene, Cellulose gum, Hydrogenated Styrene/Methylstyrene/Indene copolymer, Pectin',
        pdp_field_quality_summary: {
          active_ingredients_raw: {
            source_origin: 'unknown',
            source_quality_status: 'low',
            reason_codes: ['missing_source_kind'],
          },
        },
      }),
    ).toBe(false);

    expect(
      hasActiveIngredientExpectation({
        title: 'Acne Patch with Salicylic Acid',
        pdp_active_ingredients_raw: 'Salicylic Acid',
        active_ingredients: ['Salicylic Acid'],
      }),
    ).toBe(true);
  });
});
