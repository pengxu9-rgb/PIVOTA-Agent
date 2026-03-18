const { mapLegacyCardToSpecCards } = require('../src/auroraBff/chatCardFactory');
const { ChatCardSchema, ChatCardsResponseSchema } = require('../src/auroraBff/chatCardsSchema');

describe('aurora chatCardFactory structured sections for adapter inputs', () => {
  test('product_verdict card includes product_verdict_structured section', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'product_analysis',
        card_id: 'legacy_product_analysis',
        payload: {
          assessment: {
            verdict: 'Good fit',
            suitability: 'good',
            match_score: 84,
            product_name: 'Barrier Serum',
            reasons: ['Supports barrier hydration.'],
            how_to_use: {
              timing: 'PM',
              notes: ['Start 3 nights per week.'],
            },
          },
          evidence: {
            science: {
              key_ingredients: ['Panthenol', 'Ceramide'],
              risk_notes: ['Potential tingling in very sensitive skin.'],
            },
          },
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards[0].type).toBe('product_verdict');
    const sections = Array.isArray(cards[0].sections) ? cards[0].sections : [];
    const structured = sections.find((section) => section && section.kind === 'product_verdict_structured');
    expect(structured).toBeTruthy();
  });

  test('skin_status card includes skin_status_structured section', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'skin_status',
        card_id: 'legacy_skin_status',
        payload: {
          profile: {
            skinType: 'oily',
            barrierStatus: 'impaired',
            goals: ['acne', 'dehydration'],
          },
          features: [{ observation: 'Shiny T-zone with dehydration signs.' }],
          strategy: 'Stabilize barrier first.',
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards[0].type).toBe('skin_status');
    const sections = Array.isArray(cards[0].sections) ? cards[0].sections : [];
    const structured = sections.find((section) => section && section.kind === 'skin_status_structured');
    expect(structured).toBeTruthy();
    expect(structured.diagnosis).toBeTruthy();
  });

  test('effect_review card includes effect_review_structured section', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'effect_review',
        card_id: 'legacy_effect_review',
        payload: {
          reasons: ['Response is slower than expected due to inconsistent usage.'],
          target_state: ['Reduce redness flare-ups.'],
          core_principles: ['Keep routine stable for 14 days.'],
          safety_notes: ['Pause strong acids if stinging persists.'],
          routine_bridge: {
            why_now: 'Routine consistency unlocks cleaner effect attribution.',
            cta_label: 'Refine AM/PM routine',
          },
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards[0].type).toBe('effect_review');
    const sections = Array.isArray(cards[0].sections) ? cards[0].sections : [];
    const structured = sections.find((section) => section && section.kind === 'effect_review_structured');
    expect(structured).toBeTruthy();
    expect(Array.isArray(structured.priority_findings)).toBe(true);
  });

  test('triage card includes triage_structured section', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'triage',
        card_id: 'legacy_triage',
        payload: {
          details: ['Pause exfoliating acids for 48 hours.'],
          actions: ['Use barrier moisturizer twice daily.'],
          red_flags: ['Persistent burning sensation'],
          risk_level: 'high',
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards[0].type).toBe('triage');
    const sections = Array.isArray(cards[0].sections) ? cards[0].sections : [];
    const structured = sections.find((section) => section && section.kind === 'triage_structured');
    expect(structured).toBeTruthy();
    expect(Array.isArray(structured.action_points)).toBe(true);
  });

  test('nudge card includes nudge_structured section', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'nudge',
        card_id: 'legacy_nudge',
        payload: {
          message: 'Keep your routine stable for one more week.',
          hints: ['Stability helps isolate what works.'],
          cadence_days: 7,
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards[0].type).toBe('nudge');
    const sections = Array.isArray(cards[0].sections) ? cards[0].sections : [];
    const structured = sections.find((section) => section && section.kind === 'nudge_structured');
    expect(structured).toBeTruthy();
    expect(typeof structured.message).toBe('string');
  });

  test('error card maps to type error (not nudge) and passes schema validation', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'error',
        card_id: 'err_test_123',
        payload: { error: 'CHAT_FAILED' },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards.length).toBe(1);
    expect(cards[0].type).toBe('error');
    expect(cards[0].type).not.toBe('nudge');
    expect(cards[0].title).toBe('Something went wrong');
    expect(cards[0].payload.error_code).toBe('CHAT_FAILED');
    expect(cards[0].actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'retry' })]),
    );
    expect(() => ChatCardSchema.parse(cards[0])).not.toThrow();
  });

  test('error card maps correctly for CN language', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'error',
        card_id: 'err_test_cn',
        payload: { error: 'UPSTREAM_TIMEOUT' },
      },
      { requestId: 'req_card_factory', language: 'CN', index: 0 },
    );

    expect(cards[0].type).toBe('error');
    expect(cards[0].title).toBe('出了点问题');
    expect(cards[0].tags).toEqual(['错误']);
    expect(cards[0].payload.error_code).toBe('UPSTREAM_TIMEOUT');
  });

  test('unknown card type still falls back to nudge (not error)', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'some_future_type',
        card_id: 'unknown_type_card',
        payload: { message: 'Future feature hint.' },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards.length).toBe(1);
    expect(cards[0].type).toBe('nudge');
    expect(cards[0].type).not.toBe('error');
  });

  test('product_parse card preserves type and remains schema-compatible', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'product_parse',
        card_id: 'legacy_product_parse',
        payload: {
          intent: 'availability',
          confidence: 0.92,
          product: { brand: 'Winona', name: '舒敏保湿特护霜' },
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('product_parse');
    expect(cards[0].title).toBe('Product parse');
    expect(cards[0].payload.intent).toBe('availability');
    expect(() => ChatCardSchema.parse(cards[0])).not.toThrow();
  });

  test('offers_resolved card preserves type and remains schema-compatible', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'offers_resolved',
        card_id: 'legacy_offers_resolved',
        payload: {
          market: 'CN',
          items: [{ product: { brand: 'Winona' }, offer: null }],
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('offers_resolved');
    expect(cards[0].title).toBe('Offers resolved');
    expect(cards[0].payload.market).toBe('CN');
    expect(() => ChatCardSchema.parse(cards[0])).not.toThrow();
  });

  test('error card preserves detail from payload.detail field', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'error',
        card_id: 'err_detail',
        payload: { error: 'ENRICHMENT_FAILED', detail: 'Catalog search returned non-200' },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards[0].type).toBe('error');
    const bulletSection = cards[0].sections.find((s) => s.kind === 'bullets');
    expect(bulletSection).toBeTruthy();
    expect(bulletSection.items[0]).toBe('Catalog search returned non-200');
  });

  test('routine_fit_summary card passes through with schema-compatible type', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'routine_fit_summary',
        card_id: 'legacy_routine_fit',
        title: 'Routine fit',
        payload: {
          overall_fit: 'partial_match',
          fit_score: 0.5,
          summary: 'Some strong matches, with a few gaps to adjust.',
          highlights: ['Barrier support is solid.'],
          concerns: ['AM protection could be stronger.'],
          dimension_scores: {
            ingredient_match: { score: 0.5, note: 'Mostly aligned' },
          },
          next_questions: ['What should I adjust first?'],
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards[0].type).toBe('routine_fit_summary');
    expect(cards[0].title).toBe('Routine fit');
    expect(cards[0].payload.summary).toBe('Some strong matches, with a few gaps to adjust.');
    expect(() => ChatCardSchema.parse(cards[0])).not.toThrow();
  });

  test('aurora_debug card stays visible in chatcards mode for live debug triage', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'aurora_debug',
        card_id: 'legacy_aurora_debug',
        payload: {
          contract_status: 'empty_structured',
          mainline_status: 'severe_parse_or_prompt_failure',
          primary_failure_reason: 'artifact_missing',
          telemetry_failure_reason: 'empty_structured',
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('aurora_debug');
    expect(cards[0].title).toBe('Aurora debug');
    expect(cards[0].payload.contract_status).toBe('empty_structured');
    expect(() => ChatCardSchema.parse(cards[0])).not.toThrow();
  });

  test('routine audit cards pass through with schema-compatible types', () => {
    const verdictCards = mapLegacyCardToSpecCards(
      {
        type: 'routine_verdict_v1',
        card_id: 'routine_verdict_card',
        payload: {
          overall_verdict: 'needs_simplification',
          top_issues: [{ text: 'Retinol and acid are stacked in the same PM window.' }],
          top_3_actions: [{ title: 'Split the actives across different nights' }],
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );
    const userFitCards = mapLegacyCardToSpecCards(
      {
        type: 'routine_user_fit_v1',
        card_id: 'routine_user_fit_card',
        payload: {
          overall_user_fit_score: 61,
          goal_coverage: [{ goal: 'acne', product: 'Retinol serum', state: 'neutral' }],
          risk_mismatches: [{ issue: 'Barrier is impaired while two strong actives are stacked.', state: 'hurts' }],
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 1 },
    );

    expect(() => ChatCardSchema.parse(verdictCards[0])).not.toThrow();
    expect(() => ChatCardSchema.parse(userFitCards[0])).not.toThrow();
    expect(verdictCards[0].type).toBe('routine_verdict_v1');
    expect(userFitCards[0].type).toBe('routine_user_fit_v1');
  });

  test('chatcards schema accepts four-card routine audit responses', () => {
    const response = {
      version: '1.0',
      request_id: 'req_routine_audit',
      trace_id: 'trace_routine_audit',
      assistant_text: 'Routine audit ready.',
      cards: [
        { id: 'c1', type: 'routine_verdict_v1', priority: 1, title: 'Routine verdict', sections: [], actions: [], tags: [] },
        { id: 'c2', type: 'routine_product_audit_v1', priority: 1, title: 'Product audit', sections: [], actions: [], tags: [] },
        { id: 'c3', type: 'routine_user_fit_v1', priority: 1, title: 'User fit', sections: [], actions: [], tags: [] },
        { id: 'c4', type: 'routine_adjustment_plan_v1', priority: 1, title: 'Adjustment plan', sections: [], actions: [], tags: [] },
      ],
      follow_up_questions: [],
      suggested_quick_replies: [],
      ops: {
        thread_ops: [],
        profile_patch: [],
        routine_patch: [],
        experiment_events: [],
      },
      safety: {
        risk_level: 'low',
        red_flags: [],
        disclaimer: 'none',
      },
      telemetry: {
        intent: 'routine_review',
        intent_confidence: 0.92,
        entities: [],
        ui_language: 'EN',
        matching_language: 'EN',
        language_mismatch: false,
        language_resolution_source: 'body',
      },
    };

    expect(() => ChatCardsResponseSchema.parse(response)).not.toThrow();
  });
});
