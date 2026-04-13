const {
  compareReports,
  parseArgs,
} = require('../../scripts/aurora_reco_prod_manual_drift_scoreboard.cjs');

function buildReport({ commit, rows }) {
  return {
    started_at: '2026-04-13T00:00:00.000Z',
    cases: rows.map((row) => ({
      case_id: row.case_id,
      title: row.title || row.case_id,
      summary: {
        x_service_commit: commit,
        assistant_quality_flags: row.assistant_quality_flags || [],
        products_with_reviewed_insights: row.products_with_reviewed_insights || 0,
      },
    })),
    raw: rows.map((row) => ({
      case_id: row.case_id,
      title: row.title || row.case_id,
      chat: {
        status: row.status,
        headers: {
          xServiceCommit: commit,
        },
        body: {
          assistant_message: row.assistant_text == null
            ? null
            : { role: 'assistant', content: row.assistant_text, format: 'text' },
          cards: row.cards || [],
        },
      },
    })),
  };
}

function buildRecoCard({
  recommendations = [],
  recommendationMeta = {},
} = {}) {
  return {
    type: 'recommendations',
    payload: {
      recommendations,
      recommendation_meta: recommendationMeta,
    },
  };
}

function buildConfidenceCard(reason) {
  return {
    type: 'confidence_notice',
    payload: { reason },
  };
}

describe('aurora_reco_prod_manual_drift_scoreboard', () => {
  test('parseArgs handles value flags and bare flags', () => {
    expect(
      parseArgs([
        'node',
        'script',
        '--before',
        'before.json',
        '--after',
        'after.json',
        '--pretty',
      ]),
    ).toEqual({
      before: 'before.json',
      after: 'after.json',
      pretty: 'true',
    });
  });

  test('compareReports classifies planner, selection, rewrite, recall, and runtime drift', () => {
    const before = buildReport({
      commit: 'aaa111',
      rows: [
        {
          case_id: 'planner_case',
          status: 200,
          assistant_text: 'Stable answer.',
          assistant_quality_flags: [],
          cards: [
            buildRecoCard({
              recommendations: [
                { product_id: 'prod_1', display_name: 'Product One', matched_role_id: 'daily_sunscreen' },
              ],
              recommendationMeta: {
                source_mode: 'framework_mainline',
                query_source: 'beauty_mainline_local_handoff',
                mainline_status: 'grounded_success',
                primary_target_id: 'daily_sunscreen',
                selected_target_ids: ['daily_sunscreen'],
                ranked_targets: [{ target_id: 'daily_sunscreen' }],
                selection_signature: 'sel_a',
                assistant_rewrite_llm_used: true,
              },
            }),
          ],
        },
        {
          case_id: 'rewrite_case',
          status: 200,
          assistant_text: 'Good shopper copy.',
          assistant_quality_flags: [],
          cards: [
            buildRecoCard({
              recommendations: [
                { product_id: 'prod_2', display_name: 'Product Two', matched_role_id: 'barrier_moisturizer' },
              ],
              recommendationMeta: {
                source_mode: 'framework_mainline',
                query_source: 'beauty_mainline_local_handoff',
                mainline_status: 'grounded_success',
                primary_target_id: 'barrier_moisturizer',
                selected_target_ids: ['barrier_moisturizer'],
                ranked_targets: [{ target_id: 'barrier_moisturizer' }],
                selection_signature: 'sel_b',
                assistant_rewrite_llm_used: true,
                assistant_rewrite_reason: null,
              },
            }),
          ],
        },
        {
          case_id: 'selection_case',
          status: 200,
          assistant_text: 'Comparison copy.',
          assistant_quality_flags: [],
          cards: [
            buildRecoCard({
              recommendations: [
                { product_id: 'prod_3', display_name: 'Product Three', matched_role_id: 'oil_control_treatment' },
                { product_id: 'prod_4', display_name: 'Product Four', matched_role_id: 'oil_control_treatment' },
              ],
              recommendationMeta: {
                source_mode: 'framework_mainline',
                query_source: 'beauty_mainline_local_handoff',
                mainline_status: 'grounded_success',
                primary_target_id: 'oil_control_treatment',
                selected_target_ids: ['oil_control_treatment'],
                ranked_targets: [{ target_id: 'oil_control_treatment' }],
                selection_signature: 'sel_c',
                llm_selector_used: false,
                selector_winner_source: 'deterministic',
              },
            }),
          ],
        },
        {
          case_id: 'runtime_case',
          status: 502,
          assistant_text: null,
          assistant_quality_flags: ['confidence_notice_only', 'empty_recommendations'],
          cards: [
            buildConfidenceCard('weak_viable_pool'),
          ],
        },
      ],
    });
    const after = buildReport({
      commit: 'bbb222',
      rows: [
        {
          case_id: 'planner_case',
          status: 200,
          assistant_text: 'Stable answer.',
          assistant_quality_flags: [],
          cards: [
            buildRecoCard({
              recommendations: [
                { product_id: 'prod_5', display_name: 'Product Five', matched_role_id: 'barrier_moisturizer' },
              ],
              recommendationMeta: {
                source_mode: 'framework_mainline',
                query_source: 'beauty_mainline_local_handoff',
                mainline_status: 'grounded_success',
                primary_target_id: 'barrier_moisturizer',
                selected_target_ids: ['barrier_moisturizer'],
                ranked_targets: [{ target_id: 'barrier_moisturizer' }],
                selection_signature: 'sel_d',
                assistant_rewrite_llm_used: true,
              },
            }),
          ],
        },
        {
          case_id: 'rewrite_case',
          status: 200,
          assistant_text: null,
          assistant_quality_flags: ['assistant_missing'],
          cards: [
            buildRecoCard({
              recommendations: [
                { product_id: 'prod_2', display_name: 'Product Two', matched_role_id: 'barrier_moisturizer' },
              ],
              recommendationMeta: {
                source_mode: 'framework_mainline',
                query_source: 'beauty_mainline_local_handoff',
                mainline_status: 'grounded_success',
                primary_target_id: 'barrier_moisturizer',
                selected_target_ids: ['barrier_moisturizer'],
                ranked_targets: [{ target_id: 'barrier_moisturizer' }],
                selection_signature: 'sel_b',
                assistant_rewrite_llm_used: false,
                assistant_rewrite_reason: 'GEMINI_JSON_TIMEOUT',
              },
            }),
          ],
        },
        {
          case_id: 'selection_case',
          status: 200,
          assistant_text: 'Comparison copy.',
          assistant_quality_flags: [],
          cards: [
            buildRecoCard({
              recommendations: [
                { product_id: 'prod_4', display_name: 'Product Four', matched_role_id: 'oil_control_treatment' },
                { product_id: 'prod_3', display_name: 'Product Three', matched_role_id: 'oil_control_treatment' },
              ],
              recommendationMeta: {
                source_mode: 'framework_mainline',
                query_source: 'beauty_mainline_local_handoff',
                mainline_status: 'grounded_success',
                primary_target_id: 'oil_control_treatment',
                selected_target_ids: ['oil_control_treatment'],
                ranked_targets: [{ target_id: 'oil_control_treatment' }],
                selection_signature: 'sel_e',
                llm_selector_used: true,
                selector_winner_source: 'llm_selector',
              },
            }),
          ],
        },
        {
          case_id: 'runtime_case',
          status: 200,
          assistant_text: 'I only found borderline matches right now, so I’m not forcing a product pick.',
          assistant_quality_flags: ['borderline_matches', 'confidence_notice_only', 'empty_recommendations'],
          cards: [
            buildConfidenceCard('weak_viable_pool'),
          ],
        },
      ],
    });

    const result = compareReports(before, after);
    const perCase = new Map(result.per_case.map((row) => [row.case_id, row]));

    expect(result.summary.environment_changed).toBe(true);
    expect(result.summary.changed_cases).toBe(4);
    expect(result.summary.by_drift_class.runtime).toBe(1);
    expect(result.summary.by_drift_class.planner).toBe(1);
    expect(result.summary.by_drift_class.selection).toBe(2);
    expect(result.summary.by_drift_class.rewrite).toBe(2);

    expect(perCase.get('planner_case').drift_classes).toEqual(
      expect.arrayContaining(['planner', 'selection']),
    );
    expect(perCase.get('planner_case').likely_root_cause).toBe('semantic_plan_shift');

    expect(perCase.get('rewrite_case').drift_classes).toEqual(
      expect.arrayContaining(['rewrite']),
    );
    expect(perCase.get('rewrite_case').likely_root_cause).toBe('rewrite_gemini_json_timeout');

    expect(perCase.get('selection_case').drift_classes).toEqual(
      expect.arrayContaining(['selection']),
    );
    expect(perCase.get('selection_case').likely_root_cause).toBe('selection_shift');

    expect(perCase.get('runtime_case').drift_classes).toEqual(
      expect.arrayContaining(['runtime', 'rewrite']),
    );
    expect(perCase.get('runtime_case').likely_root_cause).toBe('runtime_instability');
  });
});
