const DEFAULT_FALLBACK_QUERY_SOURCES = Object.freeze([
  'agent_products_error_fallback',
  'agent_products_resolver_fallback',
  'agent_products_resolver_ref_fallback',
]);

function normalizeFamily(input) {
  return String(input || '').trim();
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

function buildProdGateFamilyDefaults(family) {
  switch (normalizeFamily(family)) {
    case 'strict_ingredient':
      return {
        require_primary_path: true,
        allow_strict_empty: false,
        expected_contract_path: 'shop_invoke_strict',
        allow_zero_results: false,
        must_have_metadata: [
          'service_version.commit',
          'contract_bridge.resolved_contract',
          'strict_constraint_query',
          'strict_constraint_reason',
          'matched_ingredient_ids.0',
          ...buildPrimaryReliabilityProdDefaults().must_have_metadata,
        ],
        must_equal_metadata: {
          'contract_bridge.resolved_contract': 'shop_invoke_strict',
          strict_constraint_query: true,
          strict_constraint_reason: 'ingredient',
          ...buildPrimaryReliabilityProdDefaults().must_equal_metadata,
        },
      };
    case 'merchant_query':
      return {
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['cache_cross_merchant_search'],
        must_not_match_fallback_sources: [...DEFAULT_FALLBACK_QUERY_SOURCES],
        allow_zero_results: false,
        must_have_metadata: [
          'service_version.commit',
          'query_source',
          'search_trace.final_decision',
          ...buildPrimaryReliabilityProdDefaults({ decisionAuthority: 'cache_cross_merchant_search' })
            .must_have_metadata,
        ],
        must_equal_metadata: {
          'search_trace.final_decision': 'cache_returned',
          ...buildPrimaryReliabilityProdDefaults({ decisionAuthority: 'cache_cross_merchant_search' })
            .must_equal_metadata,
        },
      };
    case 'exact_product_lookup':
      return {
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['cache_cross_merchant_search'],
        must_not_match_fallback_sources: [...DEFAULT_FALLBACK_QUERY_SOURCES],
        allow_zero_results: false,
        must_have_metadata: [
          'service_version.commit',
          'query_source',
          'search_trace.query_class',
          'search_trace.final_decision',
          ...buildPrimaryReliabilityProdDefaults({ decisionAuthority: 'cache_cross_merchant_search' })
            .must_have_metadata,
        ],
        must_equal_metadata: {
          'search_trace.query_class': 'lookup',
          'search_trace.final_decision': 'cache_returned',
          ...buildPrimaryReliabilityProdDefaults({ decisionAuthority: 'cache_cross_merchant_search' })
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
    case 'merchant_query':
      return {
        blocking: true,
        rail_mode: 'authoritative_commerce',
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['cache_cross_merchant_search'],
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
            'metadata.search_trace.final_decision': 'cache_returned',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'cache_cross_merchant_search',
            }).ownership.must_equal_paths,
          },
          must_have_paths: ['metadata.query_source'],
        },
        observability: {
          must_have_paths: [
            'metadata.service_version.commit',
            'metadata.search_trace',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'cache_cross_merchant_search',
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
        allowed_query_sources: ['cache_cross_merchant_search'],
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
            'metadata.search_trace.final_decision': 'cache_returned',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'cache_cross_merchant_search',
            }).ownership.must_equal_paths,
          },
        },
        observability: {
          must_have_paths: [
            'metadata.service_version.commit',
            'metadata.query_source',
            'metadata.search_trace.query_class',
            ...buildPrimaryReliabilityStagingDefaults({
              decisionAuthority: 'cache_cross_merchant_search',
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
    return buildProdGateFamilyDefaults(family);
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
