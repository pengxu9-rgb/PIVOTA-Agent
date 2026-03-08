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
    expect(out.telemetry.ui_language).toBe('EN');
    expect(out.telemetry.matching_language).toBe('EN');
    expect(out.telemetry.language_mismatch).toBe(false);
    expect(out.telemetry.language_resolution_source).toBe('text_detected');
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

  test('does not synthesize follow_up_questions from suggested_chips', () => {
    const out = buildChatCardsResponse({
      envelope: makeEnvelope({
        suggested_chips: [
          {
            chip_id: 'chip.intake.upload_photos',
            label: 'Upload a photo (more accurate)',
            kind: 'quick_reply',
            data: { reply_text: 'Upload a photo (more accurate)' },
          },
          {
            chip_id: 'chip.intake.skip_analysis',
            label: 'Skip photo (low confidence)',
            kind: 'quick_reply',
            data: { reply_text: 'Skip photo (low confidence)' },
          },
          {
            chip_id: 'chip.intake.upload_photos',
            label: 'Upload a photo (more accurate)',
            kind: 'quick_reply',
            data: { reply_text: 'Upload a photo (more accurate)' },
          },
        ],
      }),
      ctx: makeCtx(),
      intent: 'skin_diagnosis',
    });

    expect(Array.isArray(out.suggested_quick_replies)).toBe(true);
    expect(out.suggested_quick_replies.map((item) => item.id)).toEqual([
      'chip.intake.upload_photos',
      'chip.intake.skip_analysis',
    ]);
    expect(Array.isArray(out.follow_up_questions)).toBe(true);
    expect(out.follow_up_questions).toHaveLength(0);
  });

  test('anchor wait event upgrades compat telemetry gate_type to hard', () => {
    const out = buildChatCardsResponse({
      envelope: makeEnvelope({
        session_patch: {
          meta: {
            gate_type: 'soft',
            required_fields: ['anchor'],
          },
        },
        events: [
          {
            event_name: 'fitcheck_anchor_requested',
            data: { reason_codes: ['anchor_missing'] },
          },
          {
            event_name: 'anchor_collection_waiting_input',
            data: { intent: 'evaluate_product' },
          },
        ],
      }),
      ctx: makeCtx(),
      intent: 'evaluate_product',
    });

    expect(out.telemetry.gate_type).toBe('hard');
    expect(out.telemetry.required_fields).toEqual(['anchor']);
  });

  test('safety block event falls back to soft compat telemetry without explicit meta', () => {
    const out = buildChatCardsResponse({
      envelope: makeEnvelope({
        events: [
          {
            event_name: 'safety_gate_block',
            data: { block_level: 'BLOCK' },
          },
        ],
      }),
      ctx: makeCtx(),
      intent: 'ingredient_science',
    });

    expect(out.telemetry.gate_type).toBe('soft');
  });

  test('keeps pending clarification follow-up questions and enforces option bounds', () => {
    const out = buildChatCardsResponse({
      envelope: makeEnvelope({
        session_patch: {
          pending_clarification: {
            current: {
              id: 'skin_type',
              question: 'Which skin type fits you best?',
              options: [
                { id: 'oily', label: 'Oily', value: 'oily' },
                { id: 'dry', label: 'Dry', value: 'dry' },
                { id: 'combo', label: 'Combination', value: 'combination' },
              ],
            },
          },
        },
      }),
      ctx: makeCtx(),
      intent: 'skin_diagnosis',
    });

    expect(Array.isArray(out.follow_up_questions)).toBe(true);
    expect(out.follow_up_questions).toHaveLength(1);
    expect(out.follow_up_questions[0]).toMatchObject({
      id: 'skin_type',
      question: 'Which skin type fits you best?',
      required: true,
    });
    expect(Array.isArray(out.follow_up_questions[0].options)).toBe(true);
    expect(out.follow_up_questions[0].options).toHaveLength(2);
    expect(out.follow_up_questions[0].options.map((item) => item.id)).toEqual(['oily', 'dry']);
  });

  test('scoped fallback turns analysis follow-up empty cards into analysis_story_v2', () => {
    const out = buildChatCardsResponse({
      envelope: makeEnvelope({
        assistant_message: {
          role: 'assistant',
          content: 'From your latest analysis, your skin trends combination with high sensitivity.',
        },
        events: [
          {
            event_name: 'analysis_followup_action_routed',
            data: { action_id: 'chip.aurora.next_action.deep_dive_skin', fell_back_to_generic: false },
          },
        ],
      }),
      ctx: makeCtx(),
      intent: 'unknown',
    });

    expect(out.cards).toHaveLength(1);
    expect(out.cards[0].type).toBe('analysis_story_v2');
    expect(out.cards[0].title).toBe('Analysis story');
  });

  test('non-analysis empty successful responses keep existing nudge fallback', () => {
    const out = buildChatCardsResponse({
      envelope: makeEnvelope({
        assistant_message: {
          role: 'assistant',
          content: 'Here is a generic assistant-only reply.',
        },
        events: [
          {
            event_name: 'some_other_success_event',
            data: {},
          },
        ],
      }),
      ctx: makeCtx(),
      intent: 'unknown',
    });

    expect(out.cards).toHaveLength(1);
    expect(out.cards[0].type).toBe('nudge');
  });
});
