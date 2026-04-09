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

  test('passes through root mainline_status and context_warning from envelope', () => {
    const out = buildChatCardsResponse({
      envelope: makeEnvelope({
        mainline_status: 'grounded_success',
        context_warning: {
          applied: true,
          reasons: ['clarify_preferred'],
        },
      }),
      ctx: makeCtx(),
      intent: 'reco_products',
    });

    expect(out.mainline_status).toBe('grounded_success');
    expect(out.context_warning).toEqual({
      applied: true,
      reasons: ['clarify_preferred'],
    });
  });

  test('availability commerce cards stay renderable in chatcards mode', () => {
    const out = buildChatCardsResponse({
      envelope: makeEnvelope({
        assistant_message: {
          role: 'assistant',
          content: 'I found Winona items for you.',
        },
        cards: [
          {
            type: 'product_parse',
            card_id: 'parse_req',
            payload: {
              product: {
                product_id: 'prod_winona_repair',
                merchant_id: 'mid_winona',
              },
            },
          },
          {
            type: 'offers_resolved',
            card_id: 'offers_req',
            payload: {
              items: [
                {
                  product: {
                    product_id: 'prod_winona_repair',
                    merchant_id: 'mid_winona',
                    brand: 'Winona',
                    display_name: 'Winona Soothing Repair Serum',
                  },
                  metadata: {
                    pdp_open_path: 'internal',
                  },
                  pdp_open: {
                    path: 'ref',
                    product_ref: {
                      product_id: 'prod_winona_repair',
                      merchant_id: 'mid_winona',
                    },
                  },
                },
              ],
            },
          },
        ],
      }),
      ctx: makeCtx(),
      intent: 'reco_products',
    });

    expect(out.cards).toHaveLength(1);
    expect(out.cards[0].type).toBe('recommendations');
    expect(out.cards[0].title).toBe('Items Found');
    const section = out.cards[0].sections.find((entry) => entry && entry.kind === 'product_cards');
    expect(section).toBeTruthy();
    expect(section.products[0]).toMatchObject({
      name: 'Winona Soothing Repair Serum',
      brand: 'Winona',
    });
  });

  test('beauty mainline reco card-only responses preserve null assistant text instead of generic filler', () => {
    const out = buildChatCardsResponse({
      envelope: makeEnvelope({
        assistant_message: null,
        cards: [
          {
            type: 'recommendations',
            card_id: 'reco_card_only_test',
            payload: {
              query_source: 'beauty_mainline_local_handoff',
              decision_owner: 'shopping_agent_beauty_mainline',
              semantic_owner: 'shopping_agent_beauty_mainline',
              recommendation_meta: {
                source_mode: 'framework_mainline',
                assistant_rewrite_llm_used: false,
                assistant_rewrite_reason: 'GEMINI_JSON_TIMEOUT',
              },
              recommendations: [
                {
                  product_id: '9886499864904',
                  display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
                },
              ],
            },
          },
        ],
      }),
      ctx: makeCtx(),
      intent: 'reco_products',
    });

    expect(out.assistant_text).toBe('');
    expect(out.assistant_message).toBeNull();
  });
});
