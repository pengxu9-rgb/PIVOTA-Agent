const DISCOVERY_OPERATIONS = new Set([
  'find_products',
  'find_products_multi',
  'find_similar_products',
  'products.recommendations',
  'find_promotions',
]);

const EXACT_RESOLUTION_OPERATIONS = new Set([
  'resolve_product_candidates',
  'resolve_product_group',
  'offers.resolve',
  'get_product_detail',
  'get_pdp',
  'get_pdp_v2',
  'preview_quote',
]);

const FULL_PURCHASE_OPERATIONS = new Set([
  'create_order',
  'confirm_payment',
  'submit_payment',
  'get_order_status',
  'request_after_sales',
]);

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstNonEmptyString(...value);
      if (nested) return nested;
      continue;
    }
    const token = String(value || '').trim();
    if (token) return token;
  }
  return '';
}

function readHeader(headers = {}, key) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return '';
  return firstNonEmptyString(headers[key], headers[String(key || '').toLowerCase()]);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  const token = String(value || '').trim();
  return token ? [token] : [];
}

function normalizePartnerTier(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (normalized === 'flagship') return 'flagship';
  if (normalized === 'approved') return 'approved';
  return 'none';
}

function resolveInvokeTaskType(operation) {
  const normalizedOperation = String(operation || '').trim().toLowerCase();
  if (FULL_PURCHASE_OPERATIONS.has(normalizedOperation)) return 'full_purchase';
  if (EXACT_RESOLUTION_OPERATIONS.has(normalizedOperation)) return 'exact_product';
  return 'discovery';
}

function resolveInvokeRequestedLayer(operation, source) {
  const normalizedOperation = String(operation || '').trim().toLowerCase();
  if (FULL_PURCHASE_OPERATIONS.has(normalizedOperation)) return 'execution_facing';
  if (EXACT_RESOLUTION_OPERATIONS.has(normalizedOperation)) return 'execution_facing';
  if (DISCOVERY_OPERATIONS.has(normalizedOperation)) {
    const normalizedSource = String(source || '').trim().toLowerCase();
    if (normalizedSource === 'aurora-bff' || normalizedSource === 'aurora-chatbox') {
      return 'orchestration';
    }
    return 'decisioning';
  }
  return null;
}

function resolveAuthScheme(req = {}, routeContext = {}) {
  const authMode = firstNonEmptyString(
    routeContext.auth_mode,
    req?.invokeAuth?.auth_mode,
  ).toLowerCase();
  if (authMode === 'api_key') return 'api_key';
  if (authMode === 'checkout_token') return 'delegated';
  if (authMode === 'authorization_bearer') return 'oauth';
  return 'unknown';
}

function resolveAuthStrength(req = {}, routeContext = {}) {
  const authMode = firstNonEmptyString(
    routeContext.auth_mode,
    req?.invokeAuth?.auth_mode,
  ).toLowerCase();
  if (authMode === 'api_key') return 'strong';
  if (authMode === 'checkout_token') return 'medium';
  if (authMode === 'test_bypass') return 'medium';
  return 'unknown';
}

function resolveResponseMode(req = {}, metadata = {}) {
  const requested = firstNonEmptyString(
    metadata.response_mode,
    metadata.responseMode,
    metadata.delivery_mode,
    metadata.deliveryMode,
  ).toLowerCase();
  if (['sync', 'async', 'streaming'].includes(requested)) return requested;
  const accept = firstNonEmptyString(req?.headers?.accept, req?.headers?.Accept).toLowerCase();
  if (accept.includes('text/event-stream')) return 'streaming';
  return 'sync';
}

function resolveContinuationMode(payload = {}, metadata = {}) {
  if (payload && typeof payload === 'object') {
    if (payload.ap2_state && typeof payload.ap2_state === 'object') return 'session_token';
    if (payload.acp_state && typeof payload.acp_state === 'object') return 'session_token';
  }
  if (firstNonEmptyString(metadata.callback_url, metadata.callbackUrl)) return 'callback';
  if (firstNonEmptyString(metadata.cursor, metadata.next_cursor, metadata.nextCursor)) return 'cursor';
  if (firstNonEmptyString(metadata.continuation_token, metadata.continuationToken, metadata.session_token, metadata.sessionToken)) {
    return 'session_token';
  }
  return 'none';
}

function buildCallback(metadata = {}) {
  const url = firstNonEmptyString(metadata.callback_url, metadata.callbackUrl);
  const token = firstNonEmptyString(metadata.callback_token, metadata.callbackToken);
  const timeoutMs = parsePositiveInteger(
    metadata.callback_timeout_ms || metadata.callbackTimeoutMs,
    0,
  );
  if (!url && !token && !timeoutMs) return null;
  return {
    ...(url ? { url } : {}),
    ...(token ? { token } : {}),
    ...(timeoutMs ? { timeout_ms: timeoutMs } : {}),
  };
}

function buildContinuation(payload = {}, metadata = {}) {
  const token = firstNonEmptyString(
    metadata.continuation_token,
    metadata.continuationToken,
    metadata.session_token,
    metadata.sessionToken,
  );
  const cursor = firstNonEmptyString(
    metadata.cursor,
    metadata.next_cursor,
    metadata.nextCursor,
  );
  const resumable =
    token ||
    cursor ||
    (payload.ap2_state && typeof payload.ap2_state === 'object') ||
    (payload.acp_state && typeof payload.acp_state === 'object');
  if (!resumable) return null;
  return {
    ...(token ? { token } : {}),
    ...(cursor ? { cursor } : {}),
    resumable: true,
  };
}

function buildDeclaredCapabilities(payload = {}, metadata = {}) {
  const capabilities = [
    ...asStringArray(metadata.declared_capabilities),
    ...asStringArray(metadata.declaredCapabilities),
    ...asStringArray(metadata.capabilities),
    ...asStringArray(payload.capabilities),
  ];
  return Array.from(new Set(capabilities.map((item) => String(item || '').trim()).filter(Boolean)));
}

function buildMerchantFilters(payload = {}, metadata = {}) {
  const search =
    payload.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
      ? payload.search
      : {};
  return Array.from(
    new Set(
      [
        ...asStringArray(search.merchant_id),
        ...asStringArray(search.merchantId),
        ...asStringArray(search.merchant_ids),
        ...asStringArray(search.merchantIds),
        ...asStringArray(metadata.merchant_filters),
        ...asStringArray(metadata.merchantFilters),
      ].filter(Boolean),
    ),
  );
}

function buildCategoryFilters(payload = {}, metadata = {}) {
  const search =
    payload.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
      ? payload.search
      : {};
  return Array.from(
    new Set(
      [
        ...asStringArray(search.category),
        ...asStringArray(search.categories),
        ...asStringArray(metadata.category_filters),
        ...asStringArray(metadata.categoryFilters),
      ].filter(Boolean),
    ),
  );
}

function hasExplicitInvocationSurfaceDeclaration(req = {}, metadata = {}) {
  const declared = firstNonEmptyString(
    metadata.invocation_surface,
    metadata.invocationSurface,
    metadata.protocol_family,
    metadata.protocolFamily,
    readHeader(req?.headers, 'x-pivota-invocation-surface'),
    readHeader(req?.headers, 'x-invocation-surface'),
    readHeader(req?.headers, 'x-mcp-surface'),
  );
  return Boolean(declared);
}

function buildRawAuthClaims(req = {}, routeContext = {}, metadata = {}) {
  const partnerTier = normalizePartnerTier(
    firstNonEmptyString(
      metadata.partner_tier,
      metadata.partnerTier,
      readHeader(req?.headers, 'x-pivota-partner-tier'),
      readHeader(req?.headers, 'x-partner-tier'),
    ),
  );
  const agentId = firstNonEmptyString(
    routeContext.agent_id,
    req?.invokeAuth?.agent_id,
    metadata.agent_id,
    metadata.agentId,
  );
  const principalId = firstNonEmptyString(
    metadata.principal_id,
    metadata.principalId,
    agentId,
    req?.invokeAuth?.key_fingerprint ? `api_key:${req.invokeAuth.key_fingerprint}` : '',
  );
  const orgId = firstNonEmptyString(
    metadata.org_id,
    metadata.orgId,
    readHeader(req?.headers, 'x-pivota-org-id'),
    readHeader(req?.headers, 'x-org-id'),
  );
  const authSource = firstNonEmptyString(
    routeContext.auth_source,
    req?.invokeAuth?.auth_source,
  );
  const authMode = firstNonEmptyString(
    routeContext.auth_mode,
    req?.invokeAuth?.auth_mode,
  );
  return {
    ...(principalId ? { principal_id: principalId } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(orgId ? { org_id: orgId } : {}),
    ...(partnerTier !== 'none' ? { partner_tier: partnerTier } : {}),
    ...(authSource ? { auth_source: authSource } : {}),
    ...(authMode ? { auth_mode: authMode } : {}),
    ...(resolveAuthStrength(req, routeContext) ? { auth_strength: resolveAuthStrength(req, routeContext) } : {}),
    ...(req?.invokeAuth?.key_fingerprint ? { key_fingerprint: req.invokeAuth.key_fingerprint } : {}),
    ...(req?.invokeAuth?.introspect_auth_source
      ? { introspect_auth_source: req.invokeAuth.introspect_auth_source }
      : {}),
    ...(req?.invokeAuth?.auth_degraded === true ? { auth_degraded: true } : {}),
    ...(req?.invokeAuth?.auth_degraded_reason
      ? { auth_degraded_reason: req.invokeAuth.auth_degraded_reason }
      : {}),
    ...(hasExplicitInvocationSurfaceDeclaration(req, metadata)
      ? { invocation_surface_declared: true }
      : {}),
    environment:
      String(process.env.NODE_ENV || '').trim().toLowerCase() === 'test' ? 'staging' : 'prod',
  };
}

function buildInvokeIngressGatewayInput({
  req,
  routeContext = {},
  operation,
  payload = {},
  metadata = {},
  request_id,
} = {}) {
  const search =
    payload.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
      ? payload.search
      : {};
  const source = firstNonEmptyString(metadata.source, payload.source, 'shopping-agent-ui');
  const callback = buildCallback(metadata);
  const continuation = buildContinuation(payload, metadata);
  const declaredCapabilities = buildDeclaredCapabilities(payload, metadata);
  const responseMode = resolveResponseMode(req, metadata);
  const continuationMode = resolveContinuationMode(payload, metadata);
  const requestedResultDepth = firstNonEmptyString(
    metadata.requested_result_depth,
    metadata.requestedResultDepth,
    metadata.result_depth,
    metadata.resultDepth,
    search.result_depth,
    search.resultDepth,
  );
  const invocationSurface = firstNonEmptyString(
    metadata.invocation_surface,
    metadata.invocationSurface,
    metadata.protocol_family,
    metadata.protocolFamily,
    readHeader(req?.headers, 'x-pivota-invocation-surface'),
    readHeader(req?.headers, 'x-invocation-surface'),
    readHeader(req?.headers, 'x-mcp-surface'),
    payload.acp_state && typeof payload.acp_state === 'object' ? 'acp' : '',
    payload.ap2_state && typeof payload.ap2_state === 'object' ? 'ap2' : '',
    routeContext.invocation_surface,
    'direct_api',
  );

  return {
    request_id,
    source,
    operation,
    task_type: resolveInvokeTaskType(operation),
    requested_layer: resolveInvokeRequestedLayer(operation, source),
    invocation_surface: invocationSurface,
    protocol_family: firstNonEmptyString(
      metadata.protocol_family,
      metadata.protocolFamily,
      invocationSurface,
    ),
    protocol_version: firstNonEmptyString(
      metadata.protocol_version,
      metadata.protocolVersion,
      readHeader(req?.headers, 'x-pivota-protocol-version'),
    ),
    transport: 'http',
    auth_scheme: resolveAuthScheme(req, routeContext),
    continuation_mode: continuationMode,
    response_mode: responseMode,
    supports_callbacks: Boolean(callback),
    supports_capability_negotiation: declaredCapabilities.length > 0,
    declared_capabilities: declaredCapabilities,
    ...(callback ? { callback } : {}),
    ...(continuation ? { continuation } : {}),
    client_hints: {
      ...(routeContext.client_channel ? { client_channel: routeContext.client_channel } : {}),
      ...(routeContext.orchestrator_path ? { orchestrator_path: routeContext.orchestrator_path } : {}),
      ...(firstNonEmptyString(metadata.ui_surface, metadata.uiSurface, search.ui_surface, search.uiSurface)
        ? {
            ui_surface: firstNonEmptyString(
              metadata.ui_surface,
              metadata.uiSurface,
              search.ui_surface,
              search.uiSurface,
            ),
          }
        : {}),
    },
    raw_auth_claims: buildRawAuthClaims(req, routeContext, metadata),
    surface_metadata: {
      ...(req?.path ? { path: req.path } : {}),
      ...(req?.method ? { method: req.method } : {}),
      ...(routeContext.client_channel ? { client_channel: routeContext.client_channel } : {}),
      ...(routeContext.orchestrator_path ? { orchestrator_path: routeContext.orchestrator_path } : {}),
    },
    requested_result_depth: requestedResultDepth || undefined,
    governance_hints: {
      query_text: firstNonEmptyString(
        search.query,
        payload.query,
        metadata.query,
      ) || null,
      merchant_filters: buildMerchantFilters(payload, metadata),
      category_filters: buildCategoryFilters(payload, metadata),
      requested_page: parsePositiveInteger(
        search.page || search.page_number || metadata.requested_page || metadata.page,
        1,
      ),
      requested_result_depth: requestedResultDepth || undefined,
      requested_variant_expansions: parsePositiveInteger(
        search.variant_expansions ||
          search.variantExpansions ||
          metadata.requested_variant_expansions ||
          metadata.requestedVariantExpansions,
        parseBoolean(search.expand_variants, false) ? 1 : 0,
      ),
      request_checkout_handoff:
        FULL_PURCHASE_OPERATIONS.has(String(operation || '').trim().toLowerCase()) ||
        parseBoolean(metadata.request_checkout_handoff, false),
      near_exact_resolution:
        String(metadata.query_class || metadata.queryClass || '').trim().toLowerCase() ===
        'near_exact_resolution',
      repeated_merchant_queries: parsePositiveInteger(
        metadata.repeated_merchant_queries || metadata.repeatedMerchantQueries,
        0,
      ),
      repeated_category_queries: parsePositiveInteger(
        metadata.repeated_category_queries || metadata.repeatedCategoryQueries,
        0,
      ),
      repeated_page_turns: parsePositiveInteger(
        metadata.repeated_page_turns || metadata.repeatedPageTurns,
        0,
      ),
    },
  };
}

module.exports = {
  buildInvokeIngressGatewayInput,
  resolveInvokeTaskType,
  resolveInvokeRequestedLayer,
};
