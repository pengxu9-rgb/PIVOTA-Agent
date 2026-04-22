function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonSafe(value, fallback) {
  if (value == null) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function normalizeString(value) {
  const token = String(value || '').trim();
  return token || null;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeNextActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .map((action) => {
      if (!isPlainObject(action)) return null;
      const type = normalizeString(action.type || action.action_type || action.actionType);
      if (!type) return null;
      return {
        type,
        ...(normalizeString(action.label) ? { label: normalizeString(action.label) } : {}),
        ...(isPlainObject(action.payload) ? { payload: cloneJsonSafe(action.payload, {}) } : {}),
      };
    })
    .filter(Boolean);
}

function normalizeRecoRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!isPlainObject(row)) return null;
      const productId = normalizeString(row.product_id || row.id);
      const merchantId = normalizeString(row.merchant_id);
      const name = normalizeString(row.name || row.title);
      if (!productId && !name) return null;

      let price = null;
      let currency = null;
      if (isPlainObject(row.price)) {
        price = Number(row.price.amount ?? row.price.value ?? row.price.major);
        currency = normalizeString(row.price.currency);
      } else if (row.price != null && row.price !== '') {
        const parsed = Number(row.price);
        price = Number.isFinite(parsed) ? parsed : null;
      }
      if (!currency) currency = normalizeString(row.currency);

      return {
        ...(productId ? { product_id: productId } : {}),
        ...(merchantId ? { merchant_id: merchantId } : {}),
        ...(normalizeString(row.product_group_id) ? { product_group_id: normalizeString(row.product_group_id) } : {}),
        ...(normalizeString(row.product_ref) ? { product_ref: normalizeString(row.product_ref) } : {}),
        ...(normalizeString(row.canonical_product_ref) ? { canonical_product_ref: normalizeString(row.canonical_product_ref) } : {}),
        ...(name ? { name } : {}),
        ...(normalizeString(row.brand) ? { brand: normalizeString(row.brand) } : {}),
        ...(normalizeString(row.image_url) ? { image_url: normalizeString(row.image_url) } : {}),
        ...(price != null ? { price } : {}),
        ...(currency ? { currency } : {}),
        ...(normalizeString(row.price_label) ? { price_label: normalizeString(row.price_label) } : {}),
        ...(normalizeString(row.why_this_one || row.short_description || row.description)
          ? { why_this_one: normalizeString(row.why_this_one || row.short_description || row.description) }
          : {}),
        ...(normalizeString(row.role_scope) ? { role_scope: normalizeString(row.role_scope) } : {}),
        ...(normalizeString(row.selected_target_id) ? { selected_target_id: normalizeString(row.selected_target_id) } : {}),
        ...(normalizeString(row.authority_status || row.grounding_status)
          ? { authority_status: normalizeString(row.authority_status || row.grounding_status) }
          : {}),
        ...(row.pdp_open != null ? { pdp_open: cloneJsonSafe(row.pdp_open, null) } : {}),
      };
    })
    .filter(Boolean);
}

function normalizeBeautyRequestBlock(input = {}) {
  const next = isPlainObject(input) ? input : {};
  const normalized = {
    domain: normalizeString(next.domain) || 'beauty',
    user_goal: normalizeString(next.user_goal),
    skin_context: isPlainObject(next.skin_context) ? cloneJsonSafe(next.skin_context, {}) : {},
    routine_context: isPlainObject(next.routine_context) ? cloneJsonSafe(next.routine_context, {}) : {},
    product_context: isPlainObject(next.product_context) ? cloneJsonSafe(next.product_context, {}) : {},
    scenario_context: isPlainObject(next.scenario_context) ? cloneJsonSafe(next.scenario_context, {}) : {},
    constraints: isPlainObject(next.constraints) ? cloneJsonSafe(next.constraints, {}) : {},
    analysis_requested: next.analysis_requested === true,
  };
  return normalized;
}

function createBeautyExpertV1Response(input = {}) {
  const mode = normalizeString(input.mode) || 'guided_beauty_reco';
  const analysisSummary = isPlainObject(input.analysis_summary)
    ? cloneJsonSafe(input.analysis_summary, {})
    : {};
  const recommendationScope = isPlainObject(input.recommendation_scope)
    ? cloneJsonSafe(input.recommendation_scope, {})
    : {};
  const confidence = isPlainObject(input.confidence) ? cloneJsonSafe(input.confidence, {}) : {};
  const delegationTrace = isPlainObject(input.delegation_trace)
    ? cloneJsonSafe(input.delegation_trace, {})
    : {};
  const projections = isPlainObject(input.ui_projections)
    ? cloneJsonSafe(input.ui_projections, {})
    : {};

  return {
    contract_version: 'beauty_expert_v1',
    mode,
    beauty_intent: normalizeBeautyRequestBlock(input.beauty_intent || {}),
    analysis_summary: analysisSummary,
    recommendation_scope: recommendationScope,
    reco_bundle: {
      lead_picks: normalizeRecoRows(input.reco_bundle?.lead_picks),
      support_picks: normalizeRecoRows(input.reco_bundle?.support_picks),
      comparison_mode: normalizeString(input.reco_bundle?.comparison_mode),
      authority_status: normalizeString(input.reco_bundle?.authority_status),
    },
    compare_axes: Array.isArray(input.compare_axes)
      ? input.compare_axes
          .map((axis) =>
            isPlainObject(axis)
              ? {
                  ...(normalizeString(axis.id) ? { id: normalizeString(axis.id) } : {}),
                  ...(normalizeString(axis.label) ? { label: normalizeString(axis.label) } : {}),
                }
              : null,
          )
          .filter(Boolean)
      : [],
    confidence,
    next_actions: normalizeNextActions(input.next_actions),
    delegation_trace: delegationTrace,
    ui_projections: projections,
  };
}

module.exports = {
  createBeautyExpertV1Response,
  normalizeBeautyRequestBlock,
};
