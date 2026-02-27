const { buildChatCardsResponse } = require('../src/auroraBff/chatCardsAssembler');

function makeEnvelope(overrides = {}) {
  return {
    request_id: 'req_chatcards_assembler_test',
    trace_id: 'trace_chatcards_assembler_test',
    assistant_message: { role: 'assistant', content: 'test' },
    cards: [],
    suggested_chips: [],
    session_patch: {},
    events: [],
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  return {
    request_id: 'req_chatcards_assembler_test',
    trace_id: 'trace_chatcards_assembler_test',
    lang: 'EN',
    ...overrides,
  };
}

describe('chatCardsAssembler safety mapping', () => {
  test('maps matched_rules BLOCK to safety.risk_level=high when block_level is missing', () => {
    const out = buildChatCardsResponse({
      envelope: makeEnvelope(),
      ctx: makeCtx(),
      safetyDecision: {
        matched_rules: [{ id: 'rule_block_1', level: 'BLOCK' }],
      },
    });

    expect(out.safety.risk_level).toBe('high');
    expect(out.safety.red_flags).toContain('rule_block_1');
  });

  test('infers safety risk from safety_gate_block event when safetyDecision is null', () => {
    const out = buildChatCardsResponse({
      envelope: makeEnvelope({
        events: [
          {
            event_name: 'safety_gate_block',
            data: { block_level: 'WARN' },
          },
        ],
      }),
      ctx: makeCtx(),
      safetyDecision: null,
    });

    expect(out.safety.risk_level).toBe('low');
  });
});
