const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('beauty canonical ownership recomputes final selection from surfaced recommendations', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const pollutedSelection = {
      selection_owner: 'shopping_agent_beauty_mainline',
      selected_product_ids: [
        '9886499864904',
        '9886500749640',
        '9859782246728',
        '9859793420616',
        '9859789455688',
      ],
      selected_titles: [
        'The Ordinary Niacinamide 10% + Zinc 1%',
        'Winona Soothing Repair Serum',
        'Small Foundation Brush',
        'Small Eyeshadow Brush',
        'Small Eyeshadow Brush 2',
      ],
      selection_signature: 'legacy_polluted_sig',
      mainline_status: 'grounded_success',
      source_tier_counts: { fresh_internal: 2, cache_fresh: 4 },
      top_candidate_provenance: { source_owner: 'cache_all_platforms' },
    };

    const envelope = {
      assistant_message: {
        role: 'assistant',
        content: 'Products actually selected this time: Small Foundation Brush, Small Eyeshadow Brush.',
      },
      cards: [
        {
          card_id: 'reco_test',
          type: 'recommendations',
          payload: {
            intent: 'reco_products',
            mainline_status: 'grounded_success',
            recommendations: [
              {
                product_id: '9886499864904',
                display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
                category: 'Serum',
                matched_role_id: 'oil_control_treatment',
              },
              {
                product_id: '9886500749640',
                display_name: 'Winona Soothing Repair Serum',
                category: 'Serum',
                matched_role_id: 'oil_control_treatment',
              },
            ],
            recommendation_meta: {
              mainline_status: 'needs_more_context',
              beauty_mainline_handoff_applied: true,
              beauty_mainline_handoff_owner: 'shopping_agent_beauty_mainline',
              final_selection: pollutedSelection,
            },
            metadata: {
              mainline_status: 'grounded_success',
              final_selection: pollutedSelection,
            },
          },
        },
      ],
    };

    const out = __internal.applyBeautyCanonicalOwnershipToEnvelope({
      envelope,
      route: 'reco',
      assistantText: envelope.assistant_message.content,
      profile: { skinType: 'oily', goals: ['oil control'] },
    });

    const recoCard = out.cards[0];
    const payload = recoCard.payload;
    const finalSelection = payload.metadata.final_selection;

    assert.deepEqual(
      finalSelection.selected_product_ids,
      ['9886499864904', '9886500749640'],
    );
    assert.deepEqual(
      payload.recommendation_meta.final_selection.selected_product_ids,
      ['9886499864904', '9886500749640'],
    );
    assert.equal(payload.metadata.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta.mainline_status, 'grounded_success');
    assert.equal(out.mainline_status, 'grounded_success');
    assert.equal(out.recommendation_meta.mainline_status, 'grounded_success');
    assert.equal(
      payload.recommendation_meta.assistant_text_selection_signature,
      finalSelection.selection_signature,
    );
    assert.match(String(out.assistant_message.content || ''), /Niacinamide|Winona/i);
    assert.doesNotMatch(String(out.assistant_message.content || ''), /Brush/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('canonical search result mirror keeps payload-bound assistant text ahead of framework summary text', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const payload = {
      recommendations: [
        {
          product_id: 'generic_plain_text_1',
          display_name: 'GoalSkin Oil Control Serum',
          category: 'Serum',
          matched_role_id: 'oil_control_treatment',
        },
      ],
      roles: [
        {
          role_id: 'oil_control_treatment',
          label: 'Oil-control treatment',
          rank: 1,
          why_this_role: 'Reduce excess sebum.',
        },
      ],
      framework_summary: {
        concern_text: 'oily skin',
        primary_role_id: 'oil_control_treatment',
      },
      recommendation_meta: {
        beauty_mainline_handoff_applied: true,
      },
      metadata: {},
    };
    const searchResult = {
      decision_owner: 'shopping_agent_beauty_mainline',
      semantic_owner: 'shopping_agent_beauty_mainline',
      query_source: 'agent_products_search',
      metadata: {
        contract_bridge: {
          attempted_contract: 'agent_v1_search_beauty_mainline',
          resolved_contract: 'agent_v1_search_beauty_mainline',
        },
        source_breakdown: {
          source_tier_counts: { fresh_internal: 1 },
          top_candidate_provenance: { source_owner: 'internal_search' },
        },
        search_stage_ledger: {
          primary_search: {
            query_pack_attempts: [
              { query: 'oil control treatment', adopted: true, result_count: 1 },
            ],
          },
          final_selection: {
            selection_owner: 'shopping_agent_beauty_mainline',
            selected_product_ids: ['generic_plain_text_1'],
            selected_titles: ['GoalSkin Oil Control Serum'],
            selection_signature: 'selection_sig_payload_bound',
            mainline_status: 'grounded_success',
            source_tier_counts: { fresh_internal: 1 },
            top_candidate_provenance: { source_owner: 'internal_search' },
          },
        },
      },
    };

    const mirrored = __internal.applyRecoCanonicalSearchResultToPayload(payload, searchResult, {
      selectionOwner: 'shopping_agent_beauty_mainline',
    });
    const assistantText = __internal.buildPayloadBoundRecoAssistantText({
      payload: mirrored,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
    });
    const routeAwareText = __internal.buildRouteAwareAssistantText({
      route: 'reco',
      payload: mirrored,
      language: 'EN',
      profile: { skinType: 'oily', goals: ['oil control'] },
    });

    assert.equal(mirrored.metadata?.contract_bridge?.resolved_contract, 'agent_v1_search_beauty_mainline');
    assert.deepEqual(mirrored.metadata?.search_stage_ledger?.final_selection?.selected_product_ids, ['generic_plain_text_1']);
    assert.equal(mirrored.recommendation_meta?.assistant_text_selection_signature, undefined);
    assert.match(String(assistantText || ''), /Products actually selected this time: GoalSkin Oil Control Serum\./i);
    assert.equal(routeAwareText, assistantText);
    assert.doesNotMatch(String(routeAwareText || ''), /Top pick for that first role|Priority order:|care framework/i);
  } finally {
    delete require.cache[moduleId];
  }
});
