const DEFAULT_FALLBACK_QUERY_SOURCES = Object.freeze([
  'agent_products_error_fallback',
  'agent_products_resolver_fallback',
  'agent_products_resolver_ref_fallback',
]);

function normalizeFamily(input) {
  return String(input || '').trim();
}

function isSearchSource(testCase = {}) {
  return String(testCase?.source || '').trim() === 'search';
}

function buildStrictContractDefaults(testCase = {}, strictConstraintReason) {
  const searchSource = isSearchSource(testCase);
  return {
    ...(searchSource
      ? {
          allowed_contract_paths: ['shop_invoke_strict', 'agent_v1_search_beauty_mainline'],
        }
      : {
          expected_contract_path: 'shop_invoke_strict',
        }),
    must_equal_metadata: {
      ...(searchSource ? {} : { 'contract_bridge.resolved_contract': 'shop_invoke_strict' }),
      strict_constraint_query: true,
      strict_constraint_reason: strictConstraintReason,
    },
  };
}

function buildPrimaryReliabilityProdDefaults({ decisionAuthority = null } = {}) {
  return {
    must_have_metadata: [
      'route_health.fallback_triggered',
      'search_decision.decision_locked',
    ],
    must_equal_metadata: {
      'route_health.fallback_triggered': false,
      'search_decision.decision_locked': true,
      ...(decisionAuthority
        ? {
            'search_decision.decision_authority': decisionAuthority,
          }
        : {}),
    },
  };
}

function buildPrimaryReliabilityStagingDefaults({ decisionAuthority = null } = {}) {
  return {
    ownership: {
      must_equal_paths: {
        'metadata.route_health.fallback_triggered': false,
        'metadata.search_decision.decision_locked': true,
        ...(decisionAuthority
          ? {
              'metadata.search_decision.decision_authority': decisionAuthority,
            }
          : {}),
      },
    },
    observability: {
      must_have_paths: [
        'metadata.route_health.fallback_triggered',
        'metadata.search_decision.decision_locked',
        ...(decisionAuthority ? ['metadata.search_decision.decision_authority'] : []),
      ],
    },
  };
}

function buildProdGateFamilyDefaults(family, testCase = {}) {
  switch (normalizeFamily(family)) {
    case 'strict_ingredient':
      return {
        require_primary_path: true,
        allow_strict_empty: false,
        allow_zero_results: false,
        must_have_metadata: [
          'service_version.commit',
          'contract_bridge.resolved_contract',
          'strict_constraint_query',
          'strict_constraint_reason',
          'matched_ingredient_ids.0',
          ...buildPrimaryReliabilityProdDefaults({
            decisionAuthority: 'agent_products_ingredient_recall_direct',
          }).must_have_metadata,
        ],
        ...buildStrictContractDefaults(testCase, 'ingredient'),
        must_equal_metadata: {
          ...buildStrictContractDefaults(testCase, 'ingredient').must_equal_metadata,
          ...buildPrimaryReliabilityProdDefaults({
            decisionAuthority: 'agent_products_ingredient_recall_direct',
          }).must_equal_metadata,
        },
      };
    case 'strict_ingredient_budget':
      return {
        require_primary_path: true,
        allow_strict_empty: false,
        allow_zero_results: false,
        must_have_metadata: [
          'service_version.commit',
          'contract_bridge.resolved_contract',
          'strict_constraint_query',
          'strict_constraint_reason',
          'matched_ingredient_ids.0',
          ...buildPrimaryReliabilityProdDefaults({
            decisionAuthority: 'agent_products_ingredient_recall_direct',
          }).must_have_metadata,
        ],
        ...buildStrictContractDefaults(testCase, 'multi_constraint'),
        must_equal_metadata: {
          ...buildStrictContractDefaults(testCase, 'multi_constraint').must_equal_metadata,
          ...buildPrimaryReliabilityProdDefaults({
            decisionAuthority: 'agent_products_ingredient_recall_direct',
          }).must_equal_metadata,
        },
      };
    case 'merchant_query':
      return {
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['agent_products_search'],
        must_not_match_fallback_sources: [...DEFAULT_FALLBACK_QUERY_SOURCES],
        allow_zero_results: false,
        must_have_metadata: [
          'service_version.commit',
          'query_source',
          'search_trace.final_decision',
          ...buildPrimaryReliabilityProdDefaults({ decisionAuthority: 'agent_products_search' })
            .must_have_metadata,
        ],
        must_equal_metadata: {
          'search_trace.final_decision': 'products_returned',
          ...buildPrimaryReliabilityProdDefaults({ decisionAuthority: 'agent_products_search' })
            .must_equal_metadata,
        },
      };
    case 'exact_product_lookup':
      return {
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['agent_products_search'],
        must_not_match_fallback_sources: [...DEFAULT_FALLBACK_QUERY_SOURCES],
        allow_zero_results: false,
        must_have_metadata: [
          'service_version.commit',
          'query_source',
          'search_trace.query_class',
          'search_trace.final_decision',
          ...buildPrimaryReliabilityProdDefaults({ decisionAuthority: 'agent_products_search' })
            .must_have_metadata,
        ],
        must_equal_metadata: {
          'search_trace.query_class': 'lookup',
          'search_trace.final_decision': 'products_returned',
          ...buildPrimaryReliabilityProdDefaults({ decisionAuthority: 'agent_products_search' })
            .must_equal_metadata,
        },
      };
    case 'exactish_lookup':
      return {
        require_primary_path: true,
        allow_strict_empty: false,
        allow_zero_results: false,
        must_have_metadata: [
          'service_version.commit',
          'contract_bridge.resolved_contract',
          'strict_constraint_query',
          'strict_constraint_reason',
          'matched_ingredient_ids.0',
          'search_trace.final_decision',
          ...buildPrimaryReliabilityProdDefaults().must_have_metadata,
        ],
        must_equal_metadata: {
          'contract_bridge.resolved_contract': 'shop_invoke_strict',
          strict_constraint_query: true,
          strict_constraint_reason: 'ingredient',
          ...buildPrimaryReliabilityProdDefaults().must_equal_metadata,
        },
      };
    case 'scenario_clarify':
      return {
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['agent_products_search'],
        must_not_match_fallback_sources: [...DEFAULT_FALLBACK_QUERY_SOURCES],
        allow_zero_results: true,
        must_have_metadata: [
          'service_version.commit',
          'search_trace.final_decision',
          ...buildPrimaryReliabilityProdDefaults({ decisionAuthority: 'agent_products_search' })
            .must_have_metadata,
        ],
        must_equal_metadata: {
          'search_trace.final_decision': 'clarify',
          ...buildPrimaryReliabilityProdDefaults({ decisionAuthority: 'agent_products_search' })
            .must_equal_metadata,
        },
        must_have_clarification: true,
      };
    default:
      return null;
  }
}

function buildPromptLiveSmokeFamilyDefaults(family) {
  switch (normalizeFamily(family)) {
    case 'prompt_clarify':
      return {
        correctness: {
          expect_http_status: 200,
          min_assistant_message_length: 1,
        },
        observability: {
          must_have_paths: [
            'meta.prompt_intent',
            'meta.conversation_progress',
            'meta.early_decision',
            'meta.decision_owner',
          ],
          must_equal_paths: {
            'meta.prompt_intent': 'shopping_request',
            'meta.conversation_progress': 'new_request',
            'meta.early_decision': 'delegate_to_decisioning',
            'meta.decision_owner': 'aurora_orchestration',
          },
        },
      };
    case 'conversation_progress_resume':
      return {
        correctness: {
          expect_http_status: 200,
          min_assistant_message_length: 1,
        },
        observability: {
          must_have_paths: [
            'meta.prompt_intent',
            'meta.conversation_progress',
            'meta.early_decision',
            'meta.decision_owner',
          ],
          must_equal_paths: {
            'meta.early_decision': 'resume_prior_goal',
            'meta.decision_owner': 'aurora_orchestration',
          },
        },
      };
    case 'beauty_reco_grounded':
      return {
        correctness: {
          expect_http_status: 200,
          allow_null_assistant_message: true,
          required_card_types: ['recommendations'],
        },
        observability: {
          must_have_paths: [
            'cards.0.type',
            'cards.0.payload.mainline_status',
            'cards.0.payload.recommendations.0.product_id',
            'cards.0.payload.recommendation_meta.primary_target_id',
            'cards.0.payload.recommendation_meta.ranked_targets.0.target_id',
            'cards.0.payload.recommendation_meta.selected_target_ids.0',
          ],
          must_equal_paths: {
            'cards.0.type': 'recommendations',
            'cards.0.payload.mainline_status': 'grounded_success',
          },
        },
      };
    default:
      return null;
  }
}

function buildStagingSemanticFamilyDefaults(family) {
  switch (normalizeFamily(family)) {
    case 'strict_ingredient':
      return {
        blocking: true,
        rail_mode: 'authoritative_commerce',
        require_primary_path: true,
        allow_strict_empty: false,
        endpoint: '/agent/shop/v1/invoke',
        requires_auth: true,
        auth_profile: 'default',
        correctness: {
          mode: 'auto',
          expect_http_status: 200,
          allow_zero_results: false,
        },
        ownership: {
          must_equal_paths: {
            'metadata.contract_bridge.resolved_contract': 'shop_invoke_strict',
            'metadata.strict_constraint_query': true,
            'metadata.strict_constraint_reason': 'ingredient',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'agent_products_ingredient_recall_direct',
            }).ownership.must_equal_paths,
          },
          must_have_paths: ['metadata.matched_ingredient_ids.0'],
        },
        observability: {
          must_have_paths: [
            'metadata.service_version.commit',
            'metadata.search_trace.final_decision',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'agent_products_ingredient_recall_direct',
            }).observability.must_have_paths,
          ],
        },
        kind: 'semantic',
      };
    case 'strict_ingredient_budget':
      return {
        blocking: true,
        rail_mode: 'authoritative_commerce',
        require_primary_path: true,
        allow_strict_empty: false,
        endpoint: '/agent/shop/v1/invoke',
        requires_auth: true,
        auth_profile: 'default',
        correctness: {
          mode: 'auto',
          expect_http_status: 200,
          allow_zero_results: false,
        },
        ownership: {
          must_equal_paths: {
            'metadata.contract_bridge.resolved_contract': 'shop_invoke_strict',
            'metadata.strict_constraint_query': true,
            'metadata.strict_constraint_reason': 'multi_constraint',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'agent_products_ingredient_recall_direct',
            }).ownership.must_equal_paths,
          },
          must_have_paths: ['metadata.matched_ingredient_ids.0'],
        },
        observability: {
          must_have_paths: [
            'metadata.service_version.commit',
            'metadata.search_trace.final_decision',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'agent_products_ingredient_recall_direct',
            }).observability.must_have_paths,
          ],
        },
        kind: 'semantic',
      };
    case 'merchant_query':
      return {
        blocking: true,
        rail_mode: 'authoritative_commerce',
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['agent_products_search'],
        must_not_match_fallback_sources: [...DEFAULT_FALLBACK_QUERY_SOURCES],
        endpoint: '/agent/shop/v1/invoke',
        requires_auth: true,
        auth_profile: 'default',
        correctness: {
          mode: 'auto',
          expect_http_status: 200,
          allow_zero_results: false,
        },
        ownership: {
          must_equal_paths: {
            'metadata.search_trace.final_decision': 'products_returned',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'agent_products_search',
            }).ownership.must_equal_paths,
          },
          must_have_paths: ['metadata.query_source'],
        },
        observability: {
          must_have_paths: [
            'metadata.service_version.commit',
            'metadata.search_trace',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'agent_products_search',
            }).observability.must_have_paths,
          ],
        },
        kind: 'semantic',
      };
    case 'exact_product_lookup':
      return {
        blocking: true,
        rail_mode: 'authoritative_commerce',
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['agent_products_search'],
        must_not_match_fallback_sources: [...DEFAULT_FALLBACK_QUERY_SOURCES],
        endpoint: '/agent/shop/v1/invoke',
        requires_auth: true,
        auth_profile: 'default',
        correctness: {
          mode: 'auto',
          expect_http_status: 200,
          allow_zero_results: false,
        },
        ownership: {
          must_equal_paths: {
            'metadata.search_trace.query_class': 'lookup',
            'metadata.search_trace.final_decision': 'products_returned',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'agent_products_search',
            }).ownership.must_equal_paths,
          },
        },
        observability: {
          must_have_paths: [
            'metadata.service_version.commit',
            'metadata.query_source',
            'metadata.search_trace.query_class',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'agent_products_search',
            }).observability.must_have_paths,
          ],
        },
        kind: 'semantic',
      };
    case 'exactish_lookup':
      return {
        blocking: true,
        rail_mode: 'authoritative_commerce',
        require_primary_path: true,
        allow_strict_empty: false,
        endpoint: '/agent/shop/v1/invoke',
        requires_auth: true,
        auth_profile: 'default',
        correctness: {
          mode: 'auto',
          expect_http_status: 200,
          allow_zero_results: false,
        },
        ownership: {
          must_equal_paths: {
            'metadata.contract_bridge.resolved_contract': 'shop_invoke_strict',
            'metadata.strict_constraint_query': true,
            'metadata.strict_constraint_reason': 'ingredient',
            ...buildPrimaryReliabilityStagingDefaults().ownership.must_equal_paths,
          },
          must_have_paths: ['metadata.matched_ingredient_ids.0'],
        },
        observability: {
          must_have_paths: [
            'metadata.service_version.commit',
            'metadata.search_trace.final_decision',
            ...buildPrimaryReliabilityStagingDefaults().observability.must_have_paths,
          ],
        },
        kind: 'semantic',
      };
    case 'scenario_clarify':
      return {
        blocking: true,
        rail_mode: 'authoritative_commerce',
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['agent_products_search'],
        must_not_match_fallback_sources: [...DEFAULT_FALLBACK_QUERY_SOURCES],
        endpoint: '/agent/shop/v1/invoke',
        requires_auth: true,
        auth_profile: 'default',
        correctness: {
          mode: 'auto',
          expect_http_status: 200,
          must_have_clarification: true,
        },
        ownership: {
          must_equal_paths: {
            'metadata.search_trace.final_decision': 'clarify',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'agent_products_search',
            }).ownership.must_equal_paths,
          },
        },
        observability: {
          must_have_paths: [
            'metadata.service_version.commit',
            'metadata.search_trace.final_decision',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'agent_products_search',
            }).observability.must_have_paths,
          ],
        },
        kind: 'semantic',
      };
    default:
      return null;
  }
}

function buildAcceptanceTargetDefaults(target, testCase = {}) {
  const family = normalizeFamily(testCase.family);
  if (!family) return null;
  if (target === 'prod_gate') {
    return buildProdGateFamilyDefaults(family, testCase);
  }
  if (target === 'prompt_live_smoke') {
    return buildPromptLiveSmokeFamilyDefaults(family);
  }
  if (target === 'staging_matrix' && String(testCase.kind || '').trim() !== 'governance') {
    return buildStagingSemanticFamilyDefaults(family);
  }
  return null;
}

module.exports = {
  DEFAULT_FALLBACK_QUERY_SOURCES,
  buildAcceptanceTargetDefaults,
};
