const {
  CASES,
  buildBeautyRecoCase,
  buildBeautyRecoChatBody,
  parseArgs,
  summarizeCoverage,
  summarizeQuality,
  selectCases,
} = require('../scripts/aurora_reco_prod_manual_suite.cjs');

describe('aurora_reco_prod_manual_suite', () => {
  test('covers multiple skin profiles, intents, and scenarios', () => {
    const coverage = summarizeCoverage(CASES);

    expect(coverage.total_cases).toBeGreaterThanOrEqual(14);
    expect(coverage.by_skin_profile.oily).toBeGreaterThanOrEqual(3);
    expect(coverage.by_skin_profile.combination).toBeGreaterThanOrEqual(3);
    expect(coverage.by_skin_profile.dry).toBeGreaterThanOrEqual(2);
    expect(coverage.by_skin_profile.sensitive).toBeGreaterThanOrEqual(1);
    expect(coverage.by_user_intent.buy).toBeGreaterThanOrEqual(6);
    expect(coverage.by_user_intent.use_first).toBeGreaterThanOrEqual(2);
    expect(coverage.by_scenario.under_makeup).toBe(1);
    expect(coverage.by_scenario.hot_humid_weather).toBe(1);
    expect(coverage.by_constraint.budget).toBe(1);
    expect(coverage.by_constraint.low_irritation).toBeGreaterThanOrEqual(2);
  });

  test('selectCases filters by ids and respects limit without reordering the suite', () => {
    const selected = selectCases(CASES, {
      case: 'dry_barrier_use_first,oily_buy_basic',
      limit: '1',
    });

    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe('oily_buy_basic');
  });

  test('parseArgs supports value flags and bare boolean flags', () => {
    expect(
      parseArgs([
        'node',
        'script',
        '--case',
        'oily_buy_basic,dry_barrier_use_first',
        '--limit',
        '2',
        '--list',
      ]),
    ).toEqual({
      case: 'oily_buy_basic,dry_barrier_use_first',
      limit: '2',
      list: 'true',
    });
  });

  test('buildBeautyRecoCase applies default axes and chat envelope shape', () => {
    const spec = buildBeautyRecoCase({
      id: 'demo_case',
      title: 'Demo case',
      message: 'What product should I buy first?',
    });

    expect(spec.id).toBe('demo_case');
    expect(spec.axes).toEqual({
      skin_profile: 'unspecified',
      primary_concern: 'unspecified',
      user_intent: 'generic',
      scenario: 'baseline',
      constraint: 'none',
    });
    expect(spec.chatBody).toEqual(
      buildBeautyRecoChatBody('What product should I buy first?', null),
    );
  });

  test('summarizeQuality rolls up assistant and recommendation risk flags', () => {
    const quality = summarizeQuality([
      {
        summary: {
          assistant_quality_flags: [
            'assistant_missing',
            'underfilled_recommendations',
            'no_reviewed_insights',
          ],
        },
      },
      {
        summary: {
          assistant_quality_flags: [
            'templated_full_routine',
            'secondary_sunscreen_step',
            'no_reviewed_insights',
          ],
        },
      },
      {
        summary: {
          assistant_quality_flags: [
            'confidence_notice_only',
            'empty_recommendations',
          ],
        },
      },
    ]);

    expect(quality.total_cases).toBe(3);
    expect(quality.assistant_missing_cases).toBe(1);
    expect(quality.underfilled_recommendation_cases).toBe(1);
    expect(quality.empty_recommendation_cases).toBe(1);
    expect(quality.confidence_notice_only_cases).toBe(1);
    expect(quality.no_reviewed_insights_cases).toBe(2);
    expect(quality.templated_copy_cases).toBe(1);
    expect(quality.by_flag.assistant_missing).toBe(1);
    expect(quality.by_flag.no_reviewed_insights).toBe(2);
  });
});
