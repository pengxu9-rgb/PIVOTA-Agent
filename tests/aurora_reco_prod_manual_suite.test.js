const {
  CASES,
  buildBeautyRecoCase,
  buildCarriedSessionFromStepResponses,
  buildBeautyRecoChatBody,
  parseArgs,
  summarizeAnalysisEnvelope,
  summarizeCoverage,
  summarizeEnvelope,
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
    expect(coverage.by_scenario.profile_analysis_routine_context).toBe(3);
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

  test('context seeded cases write profile and analysis before chat without re-sending chat profile', () => {
    const contextCases = CASES.filter((spec) => Array.isArray(spec.tags) && spec.tags.includes('context'));

    expect(contextCases).toHaveLength(3);
    for (const spec of contextCases) {
      expect(spec.profilePatch).toBeTruthy();
      expect(spec.analysisSkinBody).toBeTruthy();
      expect(spec.analysisSkinBody.currentRoutine).toBeTruthy();
      expect(spec.chatBody.context.profile).toEqual({});
      expect(spec.carrySessionPatchToChat).toBe(true);
      expect(spec.contextExpectations.expected_role_ids_any.length).toBeGreaterThan(0);
    }
  });

  test('buildCarriedSessionFromStepResponses merges profile and analysis session patches for realistic chat continuity', () => {
    const carried = buildCarriedSessionFromStepResponses(
      { state: 'idle' },
      [
        {
          body: {
            cards: [{ type: 'profile' }],
            session_patch: {
              profile: { skinType: 'dry', sensitivity: 'high' },
            },
          },
        },
        {
          body: {
            cards: [{ type: 'analysis_story_v2' }],
            session_patch: {
              next_state: 'DIAG_ANALYSIS_SUMMARY',
              state: {
                latest_artifact_id: 'da_1',
                latest_reco_context: {
                  source_detail: 'analysis_handoff',
                  ranked_targets: [{ target_id: 'hydrating_barrier_moisturizer' }],
                },
              },
              meta: {
                analysis_context: { source_card_type: 'analysis_story_v2' },
              },
            },
          },
        },
      ],
    );

    expect(carried.session.profile.skinType).toBe('dry');
    expect(carried.session.state.latest_artifact_id).toBe('da_1');
    expect(carried.session.state.latest_reco_context.source_detail).toBe('analysis_handoff');
    expect(carried.session.meta.analysis_context.source_card_type).toBe('analysis_story_v2');
    expect(carried.applied).toHaveLength(2);
  });

  test('summarizeAnalysisEnvelope extracts analysis handoff reco context', () => {
    const summary = summarizeAnalysisEnvelope({
      request_id: 'req_1',
      trace_id: 'trace_1',
      cards: [{ type: 'analysis_story_v2' }],
      session_patch: {
        state: {
          latest_reco_context: {
            source_detail: 'analysis_handoff',
            trigger_source: 'analysis_handoff',
            context_origin: 'analysis_summary',
            resolved_target_step: 'sunscreen',
            resolved_target_step_confidence: 'high',
            resolved_target_step_source: 'explicit_target_step',
            ranked_targets: [
              {
                target_id: 'daily_sunscreen_finish_fit',
                target_role: 'primary',
                ingredient_query: 'Daily sunscreen with finish fit',
                verified_product_count: 2,
                product_candidates: [{ product_id: 'p1' }, { product_id: 'p2' }],
              },
            ],
          },
        },
      },
    });

    expect(summary.latest_reco_context.present).toBe(true);
    expect(summary.latest_reco_context.source_detail).toBe('analysis_handoff');
    expect(summary.latest_reco_context.resolved_target_step).toBe('sunscreen');
    expect(summary.latest_reco_context.ranked_target_ids).toEqual(['daily_sunscreen_finish_fit']);
    expect(summary.latest_reco_context.product_candidate_count).toBe(2);
  });

  test('summarizeEnvelope exposes context, planner, and search ledger markers', () => {
    const summary = summarizeEnvelope({
      assistant_message: { content: 'Use the lightweight sunscreen first.' },
      cards: [
        {
          type: 'recommendations',
          payload: {
            recommendations: [
              { product_id: 'p1', name: 'SPF', role_scope: 'daily_sunscreen_finish_fit', why_this_one: 'Lightweight finish.' },
            ],
            recommendation_meta: {
              source_mode: 'framework_mainline',
              mainline_status: 'grounded_success',
              query_source: 'beauty_mainline_local_handoff',
              semantic_owner: 'shopping_agent_beauty_mainline',
              primary_target_id: 'daily_sunscreen_finish_fit',
              selected_target_ids: ['daily_sunscreen_finish_fit'],
              analysis_context_usage: { analysis_context_available: true, context_source_mode: 'analysis_handoff' },
            },
            metadata: {
              search_stage_ledger: {
                final_selection: {
                  selection_owner: 'shopping_agent_beauty_mainline',
                  mainline_status: 'grounded_success',
                  selected_product_ids: ['p1'],
                },
                primary_search: {
                  planned_level_count: 1,
                  executed_level_count: 1,
                  executed_query_count: 1,
                  query_pack_attempts: [
                    {
                      query: 'lightweight sunscreen',
                      ladder_level: 'framework_stage_a_primary_internal',
                      role_id: 'daily_sunscreen_finish_fit',
                      source_scope: 'internal',
                      result_count: 1,
                    },
                  ],
                },
              },
            },
          },
        },
      ],
      session_patch: {
        state: {
          latest_reco_context: {
            source_detail: 'typed_reco',
            ranked_targets: [{ target_id: 'daily_sunscreen_finish_fit' }],
          },
        },
      },
    });

    expect(summary.mainline_status).toBe('grounded_success');
    expect(summary.query_source).toBe('beauty_mainline_local_handoff');
    expect(summary.selected_target_ids).toEqual(['daily_sunscreen_finish_fit']);
    expect(summary.analysis_context_usage.context_source_mode).toBe('analysis_handoff');
    expect(summary.latest_reco_context.ranked_target_ids).toEqual(['daily_sunscreen_finish_fit']);
    expect(summary.search_stage_ledger_summary.primary_search.query_attempts[0].query).toBe('lightweight sunscreen');
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
