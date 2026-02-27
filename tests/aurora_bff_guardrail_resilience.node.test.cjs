const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');

test('safelyApplyProductIntelGuardrailsToEnvelope falls back when guardrail throws', async () => {
  const out = await __internal.safelyApplyProductIntelGuardrailsToEnvelope({
    envelope: {
      request_id: 'req_guardrail_fallback',
      trace_id: 'trace_guardrail_fallback',
      assistant_message: { role: 'assistant', content: 'test' },
      cards: [],
      events: [],
    },
    ctx: {
      request_id: 'req_guardrail_fallback',
      trace_id: 'trace_guardrail_fallback',
      aurora_uid: 'uid_guardrail_fallback',
      lang: 'EN',
      trigger_source: 'text',
      state: 'IDLE_CHAT',
      brief_id: 'brief_guardrail_fallback',
    },
    language: 'EN',
    applyFn: async () => {
      const err = new Error('boom');
      err.code = 'GUARDRAIL_TEST_THROW';
      throw err;
    },
  });

  assert.equal(out.failed, true);
  assert.equal(out.error_code, 'GUARDRAIL_TEST_THROW');
  assert.ok(out.envelope && Array.isArray(out.envelope.events));
  assert.ok(out.envelope.events.some((evt) => evt && evt.event_name === 'product_intel_guardrail_failed'));
});

test('safelyApplyProductIntelGuardrailsToEnvelope passes through guardrail result', async () => {
  const out = await __internal.safelyApplyProductIntelGuardrailsToEnvelope({
    envelope: {
      request_id: 'req_guardrail_ok',
      trace_id: 'trace_guardrail_ok',
      assistant_message: { role: 'assistant', content: 'test' },
      cards: [],
      events: [],
    },
    ctx: {
      request_id: 'req_guardrail_ok',
      trace_id: 'trace_guardrail_ok',
      aurora_uid: 'uid_guardrail_ok',
      lang: 'EN',
      trigger_source: 'text',
      state: 'IDLE_CHAT',
      brief_id: 'brief_guardrail_ok',
    },
    language: 'EN',
    applyFn: async ({ envelope }) => ({
      envelope: { ...envelope, cards: [{ card_id: 'c1', type: 'confidence_notice', payload: {} }] },
      dropped: 1,
      externalized: 0,
      rejected: [],
    }),
  });

  assert.equal(Boolean(out.failed), false);
  assert.equal(out.dropped, 1);
  assert.ok(Array.isArray(out.envelope.cards));
  assert.equal(out.envelope.cards.length, 1);
});
