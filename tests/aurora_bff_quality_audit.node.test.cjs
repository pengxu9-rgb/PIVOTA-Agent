const test = require('node:test');
const assert = require('node:assert/strict');

const {
  auditEnvelope,
  emitAudit,
} = require('../src/auroraBff/qualityAudit');

function makeEnvelope(overrides = {}) {
  return {
    assistant_message: { role: 'assistant', format: 'text', content: '先稳住屏障，再继续。' },
    suggested_chips: [],
    cards: [],
    session_patch: {},
    events: [],
    ...overrides,
  };
}

function getInvariant(report, id) {
  return (Array.isArray(report && report.invariants) ? report.invariants : []).find((row) => row && row.id === id);
}

test('quality audit: recommendations card outside RECO_* state triggers invariant', () => {
  const report = auditEnvelope(makeEnvelope({
    cards: [{ card_id: 'reco_1', type: 'recommendations', payload: { recommendations_count: 1 } }],
    session_patch: { next_state: 'IDLE_CHAT' },
  }));

  const invariant = getInvariant(report, 'recommendations_reco_state');
  assert.equal(Boolean(invariant && invariant.applicable), true);
  assert.equal(Boolean(invariant && invariant.passed), false);
  assert.equal(invariant.reason, 'recommendations_outside_reco_state');
});

test('quality audit: pending clarification enforces chips budget and <=1 question', () => {
  const report = auditEnvelope(makeEnvelope({
    assistant_message: { role: 'assistant', format: 'text', content: '你偏油还是偏干？你的目标是什么？' },
    suggested_chips: [
      { chip_id: 'c1', label: '偏油', kind: 'quick_reply', data: { norm_id: 'skinType', value: 'oily' } },
      { chip_id: 'c2', label: '偏干', kind: 'quick_reply', data: { norm_id: 'skinType', value: 'dry' } },
      { chip_id: 'c3', label: '混合', kind: 'quick_reply', data: { norm_id: 'skinType', value: 'combination' } },
    ],
    session_patch: {
      state: {
        pending_clarification: {
          current: { id: 'skin_type', norm_id: 'skinType' },
        },
      },
    },
  }));

  const invariant = getInvariant(report, 'pending_clarification_step_constraints');
  assert.equal(Boolean(invariant && invariant.applicable), true);
  assert.equal(Boolean(invariant && invariant.passed), false);
  assert.equal(invariant.reason, 'chips_below_min');
});

test('quality audit: null offers with buyable assertion triggers invariant', () => {
  const report = auditEnvelope(makeEnvelope({
    assistant_message: { role: 'assistant', format: 'text', content: '这款有货，可以立即购买。' },
    cards: [
      {
        card_id: 'offers_1',
        type: 'offers_resolved',
        payload: { items: [{ offer: null }] },
      },
    ],
  }));

  const invariant = getInvariant(report, 'offers_null_inventory_assertion_guard');
  assert.equal(Boolean(invariant && invariant.applicable), true);
  assert.equal(Boolean(invariant && invariant.passed), false);
  assert.equal(invariant.reason, 'asserted_in_stock_or_buy_now_with_null_offer');
});

test('quality audit: critical missing fields without field_missing reason triggers invariant', () => {
  const report = auditEnvelope(makeEnvelope({
    cards: [
      {
        card_id: 'parse_1',
        type: 'product_parse',
        payload: { product_name: 'Unknown Variant' },
      },
    ],
  }));

  const invariant = getInvariant(report, 'critical_missing_fields_require_field_missing_reason');
  assert.equal(Boolean(invariant && invariant.applicable), true);
  assert.equal(Boolean(invariant && invariant.passed), false);
  assert.equal(invariant.reason, 'missing_field_without_reason');
  assert.equal(Array.isArray(invariant.violations), true);
  assert.equal(invariant.violations.length > 0, true);
});

test('quality audit: emitAudit appends compact event without user PII payload', () => {
  const envelope = makeEnvelope({
    assistant_message: {
      role: 'assistant',
      format: 'text',
      content: 'Contact me at test.user@example.com, phone 18888888888, 有货可买。',
    },
    cards: [
      {
        card_id: 'offers_2',
        type: 'offers_resolved',
        payload: { items: [{ offer: null }] },
      },
    ],
    session_patch: { next_state: 'IDLE_CHAT', state: { _internal_next_state: 'S7_PRODUCT_RECO' } },
    events: [],
  });
  const ctx = {
    request_id: 'req_quality_audit',
    trace_id: 'trace_quality_audit',
    aurora_uid: 'sensitive@example.com',
    brief_id: 'brief-123456789',
    lang: 'CN',
    accept_language: 'zh-CN',
  };

  const { event } = emitAudit(envelope, ctx, { logger: null });
  assert.ok(event);
  assert.equal(event.event_name, 'quality_audit');
  assert.equal(Array.isArray(envelope.events), true);
  assert.equal(envelope.events.length, 1);

  const payloadStr = JSON.stringify(event.data || {});
  assert.equal(payloadStr.includes('test.user@example.com'), false);
  assert.equal(payloadStr.includes('18888888888'), false);
  assert.equal(payloadStr.includes('sensitive@example.com'), false);

  assert.equal(typeof event.data.total_score, 'number');
  assert.equal(Array.isArray(event.data.hard_fail_reasons), true);
  assert.equal(Array.isArray(event.data.invariants), true);
  assert.deepEqual(
    Object.keys(event.data.key_flags || {}).sort(),
    ['low_confidence', 'offers_null_count', 'used_photos'].sort(),
  );
});
