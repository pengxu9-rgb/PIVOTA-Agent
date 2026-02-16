const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEnvelope } = require('../src/auroraBff/envelope');
const {
  resolveNextStateFromSessionPatch,
  applySessionPatchNextState,
} = require('../src/auroraBff/memoryStore');

function makeCtx() {
  return {
    request_id: 'req_test',
    trace_id: 'trace_test',
    aurora_uid: 'uid_test',
    brief_id: 'brief_test',
    lang: 'EN',
    trigger_source: 'text_explicit',
    state: 'idle',
  };
}

function makeChip(i) {
  return {
    chip_id: `chip.${i}`,
    label: `Chip ${i}`,
    kind: 'quick_reply',
    data: {},
  };
}

test('regression: recommendations card always normalizes ui next_state to RECO_RESULTS and preserves internal', () => {
  const envelope = buildEnvelope(makeCtx(), {
    assistant_message: null,
    suggested_chips: [],
    cards: [
      {
        card_id: 'card_reco',
        type: 'recommendations',
        payload: {
          recommendations_count: 1,
          recommendations: [{ offer: { affiliate_url: 'https://example.com/offer' } }],
        },
      },
    ],
    session_patch: { next_state: 'S7_PRODUCT_RECO' },
    events: [],
  });

  assert.equal(envelope.session_patch?.next_state, 'RECO_RESULTS');
  assert.equal(envelope.session_patch?.state?._internal_next_state, 'S7_PRODUCT_RECO');
});

test('regression: diagnosis_gate with wants=recommendation normalizes to RECO_GATE', () => {
  const envelope = buildEnvelope(makeCtx(), {
    assistant_message: null,
    suggested_chips: [],
    cards: [
      {
        card_id: 'card_gate',
        type: 'diagnosis_gate',
        payload: { wants: 'recommendation', missing_fields: ['skinType'] },
      },
    ],
    session_patch: { next_state: 'S2_DIAGNOSIS' },
    events: [],
  });

  assert.equal(envelope.session_patch?.next_state, 'RECO_GATE');
});

test('regression: analysis_summary normalizes to DIAG_ANALYSIS_SUMMARY', () => {
  const envelope = buildEnvelope(makeCtx(), {
    assistant_message: null,
    suggested_chips: [],
    cards: [
      {
        card_id: 'card_analysis',
        type: 'analysis_summary',
        payload: { summary: 'ok' },
      },
    ],
    session_patch: {},
    events: [],
  });

  assert.equal(envelope.session_patch?.next_state, 'DIAG_ANALYSIS_SUMMARY');
});

test('regression: offers_resolved item with offer=null must include field_missing reason', () => {
  const envelope = buildEnvelope(makeCtx(), {
    assistant_message: null,
    suggested_chips: [],
    cards: [
      {
        card_id: 'card_offers',
        type: 'offers_resolved',
        payload: {
          items: [{ product: { name: 'A' }, offer: null }],
          market: 'US',
        },
      },
    ],
    session_patch: {},
    events: [],
  });

  const card = Array.isArray(envelope.cards) ? envelope.cards[0] : null;
  const missing = Array.isArray(card?.field_missing) ? card.field_missing : [];
  assert.equal(
    missing.some((x) => x && x.field === 'items[0].offer' && x.reason === 'catalog_not_available'),
    true,
  );
});

test('regression: memoryStore patch apply prefers state._internal_next_state over ui next_state', () => {
  const patch = {
    state: { _internal_next_state: 'S7_PRODUCT_RECO' },
    next_state: 'RECO_RESULTS',
  };
  const persisted = applySessionPatchNextState({ next_state: 'IDLE_CHAT' }, patch);

  assert.equal(resolveNextStateFromSessionPatch(patch), 'S7_PRODUCT_RECO');
  assert.equal(persisted.next_state, 'S7_PRODUCT_RECO');
});

test('regression: suggested_chips are clamped to <= 10', () => {
  const chips = Array.from({ length: 17 }, (_, idx) => makeChip(idx + 1));
  const envelope = buildEnvelope(makeCtx(), {
    assistant_message: null,
    suggested_chips: chips,
    cards: [],
    session_patch: {},
    events: [],
  });

  assert.ok(Array.isArray(envelope.suggested_chips));
  assert.equal(envelope.suggested_chips.length, 10);
});
