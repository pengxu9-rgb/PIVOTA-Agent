const { mapLegacyCardToSpecCards } = require('../src/auroraBff/chatCardFactory');
const { ChatCardSchema } = require('../src/auroraBff/chatCardsSchema');

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
});
