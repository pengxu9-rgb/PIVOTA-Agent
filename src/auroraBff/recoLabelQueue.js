function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function normalizeBool(value) {
  return value === true;
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function toScoreNearThreshold(scoreTotal) {
  const n = Number(scoreTotal);
  if (!Number.isFinite(n)) return false;
  return Math.abs(n - 0.5) <= 0.08;
}

function candidateFromSnapshot(snapshot = {}) {
  const obj = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  const candidate = obj.candidate && typeof obj.candidate === 'object' && !Array.isArray(obj.candidate) ? obj.candidate : {};
  return candidate;
}

function hasMissingCriticalFeature(item) {
  const block = normalizeText(item?.block);
  const candidate = candidateFromSnapshot(item?.snapshot);
  const category = candidate?.category_taxonomy || candidate?.category || '';
  const missingCategory = !String(category || '').trim();
  const missingPriceForDupe = block === 'dupes' && (
    candidate?.price == null ||
    !Number.isFinite(Number(candidate?.price?.amount ?? candidate?.price))
  );
  const flags = Array.isArray(item?.flags) ? item.flags : [];
  const hasMissingFlag = flags.some((raw) => {
    const token = normalizeText(raw);
    return token.includes('missing') || token.includes('needs_price_check') || token.includes('needs_category_check');
  });
  return missingCategory || missingPriceForDupe || hasMissingFlag;
}

function isExplorationSlot(item) {
  const snapshot = item?.snapshot && typeof item.snapshot === 'object' && !Array.isArray(item.snapshot) ? item.snapshot : {};
  if (snapshot.was_exploration_slot === true) return true;
  const flags = Array.isArray(item?.flags) ? item.flags : [];
  return flags.some((raw) => normalizeText(raw) === 'exploration_slot');
}

function isInvalidJsonFlag(item) {
  const flags = Array.isArray(item?.flags) ? item.flags : [];
  return flags.some((raw) => normalizeText(raw) === 'invalid_json');
}

function isNearThreshold(item) {
  const candidate = candidateFromSnapshot(item?.snapshot);
  const scoreTotal = Number(candidate?.score_breakdown?.score_total);
  if (toScoreNearThreshold(scoreTotal)) return true;
  const block = normalizeText(item?.block);
  const categoryMatch = Number(candidate?.score_breakdown?.category_use_case_match);
  const priceDistance = Number(candidate?.score_breakdown?.price_distance);
  const similarity = Number(candidate?.similarity_score ?? candidate?.sim_total);
  if (block === 'competitors' && Number.isFinite(categoryMatch)) {
    return Math.abs(categoryMatch - 0.55) <= 0.06;
  }
  if (block === 'dupes') {
    if (Number.isFinite(similarity) && Math.abs(similarity - 0.82) <= 0.06) return true;
    if (Number.isFinite(priceDistance) && Math.abs(priceDistance - 0.5) <= 0.1) return true;
  }
  return false;
}

function computePriority(item, weights = {}) {
  const w = {
    low_conf: Number.isFinite(Number(weights.w1)) ? Number(weights.w1) : 0.45,
    exploration: Number.isFinite(Number(weights.w2)) ? Number(weights.w2) : 0.2,
    near_threshold: Number.isFinite(Number(weights.w3)) ? Number(weights.w3) : 0.15,
    missing_critical: Number.isFinite(Number(weights.w4)) ? Number(weights.w4) : 0.15,
    invalid_json: Number.isFinite(Number(weights.w5)) ? Number(weights.w5) : 0.05,
  };
  const confidence = clamp01(item?.confidence);
  const score =
    w.low_conf * (1 - confidence) +
    w.exploration * (isExplorationSlot(item) ? 1 : 0) +
    w.near_threshold * (isNearThreshold(item) ? 1 : 0) +
    w.missing_critical * (hasMissingCriticalFeature(item) ? 1 : 0) +
    w.invalid_json * (isInvalidJsonFlag(item) ? 1 : 0);
  return Number(Math.max(0, Math.min(1, score)).toFixed(6));
}

function buildLabelQueue(items = [], options = {}) {
  const rows = Array.isArray(items) ? items : [];
  const filters = options.filters || {};
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 50));

  const filtered = rows.filter((row) => {
    if (filters.block && normalizeText(row?.block) !== normalizeText(filters.block)) return false;
    if (filters.anchor_product_id && normalizeText(row?.anchor_product_id) !== normalizeText(filters.anchor_product_id)) return false;
    if (normalizeBool(filters.low_confidence) && clamp01(row?.confidence) > 0.45) return false;
    if (normalizeBool(filters.wrong_block_only) && normalizeText(row?.suggested_label) !== 'wrong_block') return false;
    if (normalizeBool(filters.exploration_only) && !isExplorationSlot(row)) return false;
    if (normalizeBool(filters.missing_info_only) && !hasMissingCriticalFeature(row)) return false;
    return true;
  });

  const enriched = filtered.map((row) => ({
    ...row,
    priority_score: computePriority(row, options.weights),
    queue_hints: {
      exploration_slot: isExplorationSlot(row),
      near_threshold: isNearThreshold(row),
      missing_critical: hasMissingCriticalFeature(row),
      invalid_json: isInvalidJsonFlag(row),
    },
  }));

  enriched.sort((a, b) => {
    if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });
  return enriched.slice(0, limit);
}

module.exports = {
  computePriority,
  buildLabelQueue,
  __internal: {
    isNearThreshold,
    hasMissingCriticalFeature,
    isExplorationSlot,
    isInvalidJsonFlag,
  },
};
