const {
  buildPayloadDiff,
  classifyIdentityPayloadDrift,
  hasActiveIngredientEvidence,
  hasActiveIngredientExpectation,
} = require('../../src/services/pdpIdentityPayloadDrift');

describe('pdpIdentityPayloadDrift', () => {
  test('detects active evidence inside current seed snapshot contracts', () => {
    const payload = {
      title: 'Banana Bright Mineral Sunscreen SPF 30',
      seed_data: {
        snapshot: {
          pdp_active_ingredients_raw: 'Zinc Oxide 16.3%',
          pdp_ingredients_raw: 'Aqua, Zinc Oxide, Niacinamide.',
        },
      },
    };

    expect(hasActiveIngredientEvidence(payload, payload.title)).toBe(true);
  });

  test('separates active expectation from source-backed active evidence', () => {
    const skincarePayload = {
      title: 'BeamCream Smoothing Body Moisturizer',
      pdp_ingredients_raw: 'Water, glycerin, shea butter.',
    };
    const makeupPayload = {
      title: 'Banana Bright+ Vitamin CC Stick',
      pdp_ingredients_raw: 'Dimethicone, mica, iron oxides.',
    };

    expect(hasActiveIngredientEvidence(skincarePayload, skincarePayload.title)).toBe(false);
    expect(hasActiveIngredientExpectation(skincarePayload, skincarePayload.title)).toBe(true);
    expect(hasActiveIngredientExpectation(makeupPayload, makeupPayload.title)).toBe(false);
  });

  test('classifies stale identity payload when seed has source-backed PDP fields', () => {
    const identityPayload = {
      title: 'Balance+ Bundle',
      images: ['https://cdn.example.com/stale.jpg'],
    };
    const seedPayload = {
      title: 'Balance+ Bundle',
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

    const diff = buildPayloadDiff(identityPayload, seedPayload, 'Balance+ Bundle');
    const drift = classifyIdentityPayloadDrift({
      seedPayload,
      identityPayload,
      title: 'Balance+ Bundle',
      seedUpdatedAt: '2026-05-14T00:00:00.000Z',
      identityUpdatedAt: '2026-04-12T00:00:00.000Z',
    });

    expect(diff.gained_active_evidence).toBe(true);
    expect(diff.gained_how_to).toBe(true);
    expect(diff.gained_details).toBe(true);
    expect(drift.identity_payload_stale).toBe(true);
    expect(drift.seed_expects_active_ingredients).toBe(true);
    expect(drift.seed_updated_after_identity).toBe(true);
    expect(drift.audit_scope_mismatch).toBe(true);
  });

  test('classifies bundle formula-only drift as audit scope mismatch instead of stale sync work', () => {
    const identityPayload = {
      title: 'Power Plush Foundation & Brush Duo',
      pdp_active_ingredients_raw: 'See Power Plush Longwear Foundation for list of ingredients.',
      pdp_ingredients_raw: 'See Power Plush Longwear Foundation for list of ingredients.',
      images: ['https://cdn.example.com/duo.jpg'],
    };
    const seedPayload = {
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

    const drift = classifyIdentityPayloadDrift({
      seedPayload,
      identityPayload,
      title: 'Power Plush Foundation & Brush Duo',
      seedUpdatedAt: '2026-05-16T00:00:00.000Z',
      identityUpdatedAt: '2026-05-15T00:00:00.000Z',
    });

    expect(drift.audit_scope_mismatch).toBe(true);
    expect(drift.seed_has_active_evidence).toBe(true);
    expect(drift.identity_payload_stale).toBe(false);
  });
});
