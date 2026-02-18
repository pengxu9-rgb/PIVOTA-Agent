const { buildEnvelope } = require('../src/auroraBff/envelope');

describe('Aurora BFF product_analysis public payload guard', () => {
  test('does not expose internal reco fields to frontend payload', () => {
    const ctx = {
      request_id: 'req_test_public_payload',
      trace_id: 'trace_test_public_payload',
      aurora_uid: 'uid_test_public_payload',
      brief_id: 'brief_test_public_payload',
      lang: 'EN',
      trigger_source: 'chat',
      state: 'IDLE_CHAT',
    };

    const envelope = buildEnvelope(ctx, {
      assistant_message: null,
      suggested_chips: [],
      cards: [
        {
          card_id: 'card_test_product_analysis',
          type: 'product_analysis',
          payload: {
            competitors: { candidates: [] },
            related_products: { candidates: [] },
            dupes: { candidates: [] },
            confidence_by_block: {},
            provenance: {
              generated_at: new Date().toISOString(),
              contract_version: 'aurora.product_intel.contract.v2',
              pipeline: 'aurora_product_intel_main_path',
              source: 'test',
              validation_mode: 'soft_fail',
            },
            missing_info: ['analysis_limited'],
            missing_info_internal: ['reco_blocks_schema_invalid'],
            internal_debug_codes: ['reco_blocks_schema_invalid'],
          },
        },
      ],
      session_patch: {},
      events: [],
    });

    const card = Array.isArray(envelope.cards)
      ? envelope.cards.find((c) => c && c.type === 'product_analysis')
      : null;

    expect(card).toBeTruthy();
    expect(card.payload.missing_info_internal).toBeUndefined();
    expect(card.payload.internal_debug_codes).toBeUndefined();
    expect(card.payload.missing_info).toEqual(['analysis_limited']);
  });
});
