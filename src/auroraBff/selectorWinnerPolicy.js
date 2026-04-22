'use strict';

const {
  hasConcernSunscreenSignal,
  classifyConcernScopeCandidate,
  buildConcernCandidateText,
  buildConcernFrameworkCandidateText,
  isConcernFrameworkOutOfScopeArea,
} = require('./productScopeClassifier');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function pickFirstString(...values) {
  return pickFirstTrimmed(...values);
}

function asStringArray(value, max = 20) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const token = String(item || '').trim();
    if (!token) continue;
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

function uniqCaseInsensitiveStrings(items, max = 80) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function isConcernPrimaryRoleWinnerSafe(row, { semanticPlan = null } = {}) {
  const plan = isPlainObject(semanticPlan) ? semanticPlan : {};
  const primaryRole = Array.isArray(plan.core_roles) ? plan.core_roles[0] : null;
  const primaryRoleId = pickFirstTrimmed(primaryRole?.role_id);
  const matchedRoleId = pickFirstTrimmed(row?.matched_role_id, row?.matchedRoleId);
  if (!primaryRoleId || !matchedRoleId || matchedRoleId !== primaryRoleId) return false;
  const scopeClassification = classifyConcernScopeCandidate(row);
  if (scopeClassification.hard_reject) return false;
  const candidateText = uniqCaseInsensitiveStrings([
    buildConcernFrameworkCandidateText(row),
    buildConcernCandidateText(row),
  ], 3).join(' ');
  if (isConcernFrameworkOutOfScopeArea(row, candidateText)) return false;
  if (scopeClassification.classification === 'explicit_non_face_supportive') return false;
  const primaryStep = String(primaryRole?.preferred_step || '').trim().toLowerCase();
  if (primaryStep && primaryStep !== 'sunscreen' && hasConcernSunscreenSignal(row, candidateText)) return false;
  if (row?.support_only === true || row?.supportOnly === true) return false;
  return true;
}

function buildConcernSelectorCandidateEvidenceText(row = null) {
  const item = isPlainObject(row) ? row : {};
  return uniqCaseInsensitiveStrings([
    pickFirstTrimmed(item.display_name, item.displayName, item.name, item.title),
    pickFirstTrimmed(item.category, item.product_type, item.productType),
    pickFirstTrimmed(item.why_this_one, item.whyThisOne),
    pickFirstTrimmed(item.short_description, item.shortDescription, item.description),
    ...asStringArray(item.notes, 3),
    ...asStringArray(item.reasons, 3),
    ...asStringArray(item.compare_highlights, 3),
  ], 18).join(' ').toLowerCase();
}

function classifyConcernSelectorFinishFitTradeoffBucket(row = null) {
  const text = buildConcernSelectorCandidateEvidenceText(row);
  if (!text) return 'general';
  if (/\b(tinted|tone[-\s]?up|complexion coverage|coverage[-\s]?first|beige|ivory)\b/i.test(text)) {
    return 'tinted_makeup_base';
  }
  const richerCue = /\b(richer|more moisturizing|more moisture|hydrating|cream(?:ier)?|cream[-\s]?based|cream[-\s]?spf|hydrating daily cream|milk|cushion|colloidal oatmeal)\b/i.test(text);
  if (richerCue) return 'richer_moisturizing';
  const mineralCue = /\b(mineral|zinc oxide|zinc|titanium dioxide|sensitive skin|sensitive-skin|fragrance[-\s]?free|scentless)\b/i.test(text);
  if (mineralCue) return 'mineral_sensitive';
  const lighterCue = /\b(lighter|lightweight|weightless|sheer|invisible|fluid|watery|water[-\s]?fit|under makeup|under-makeup|smooth(?:er)?|soft[-\s]?focus|non[-\s]?greasy|no white cast|lower white[-\s]?cast)\b/i.test(text);
  if (lighterCue) return 'lighter_smoother';
  return 'general';
}

function shouldDiversifyConcernSelectorFinishFitComparison(selector = {}, recommendations = []) {
  const comparisonMode = String(
    pickFirstTrimmed(selector?.comparison_mode, selector?.comparisonMode) || '',
  ).trim().toLowerCase();
  const primaryRoleId = String(
    pickFirstTrimmed(selector?.primary_role_id, selector?.primaryRoleId) || '',
  ).trim().toLowerCase();
  return (
    (comparisonMode === 'same_role_comparison' || comparisonMode === 'same_role')
    && primaryRoleId === 'daily_sunscreen_finish_fit'
    && Array.isArray(recommendations)
    && recommendations.length > 2
  );
}

function diversifyConcernSelectorFinishFitOrdering(recommendations = [], selector = {}) {
  const ordered = Array.isArray(recommendations) ? recommendations.slice() : [];
  if (!shouldDiversifyConcernSelectorFinishFitComparison(selector, ordered)) return ordered;
  const topPickProductId = pickFirstTrimmed(selector?.top_pick_product_id, selector?.topPickProductId) || null;
  const lead = (topPickProductId
    ? ordered.find((row) => pickFirstString(row?.product_id, row?.productId) === topPickProductId)
    : null) || ordered[0] || null;
  if (!lead) return ordered;

  const usedProductIds = new Set();
  const diversified = [];
  const pushUnique = (row) => {
    const productId = pickFirstString(row?.product_id, row?.productId);
    if (!productId || usedProductIds.has(productId)) return false;
    usedProductIds.add(productId);
    diversified.push(row);
    return true;
  };
  pushUnique(lead);

  const leadBucket = classifyConcernSelectorFinishFitTradeoffBucket(lead);
  const desiredBuckets = ['lighter_smoother', 'mineral_sensitive', 'richer_moisturizing']
    .filter((bucket) => bucket !== leadBucket);
  for (const bucket of desiredBuckets) {
    const match = ordered.find((row) => {
      const productId = pickFirstString(row?.product_id, row?.productId);
      if (!productId || usedProductIds.has(productId)) return false;
      return classifyConcernSelectorFinishFitTradeoffBucket(row) === bucket;
    });
    if (match) pushUnique(match);
  }
  for (const row of ordered) pushUnique(row);
  return diversified;
}

function applyConcernSelectorRaceOrdering(recommendations, selectorRace) {
  const recos = Array.isArray(recommendations) ? recommendations.slice() : [];
  const selector = isPlainObject(selectorRace) ? selectorRace : {};
  if (!recos.length) {
    return {
      recommendations: [],
      primary_recommendation_id: null,
      support_roles_surfaced: [],
      winner_source: 'deterministic',
      selection_notes_by_product_id: {},
    };
  }
  const byId = new Map();
  for (const row of recos) {
    const productId = pickFirstString(row?.product_id, row?.productId);
    if (productId) byId.set(productId, row);
  }
  const orderedIds = uniqCaseInsensitiveStrings([
    ...asStringArray(selector.ordered_product_ids),
    ...Array.from(byId.keys()),
  ], recos.length || 8).filter((id) => byId.has(id));
  const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  const topPickProductId = pickFirstTrimmed(selector.top_pick_product_id) || null;
  if (topPickProductId && ordered.length > 1) {
    ordered.sort((left, right) => {
      const leftId = pickFirstString(left?.product_id, left?.productId);
      const rightId = pickFirstString(right?.product_id, right?.productId);
      if (leftId === topPickProductId) return -1;
      if (rightId === topPickProductId) return 1;
      return 0;
    });
  }
  const diversifiedOrdered = diversifyConcernSelectorFinishFitOrdering(ordered, selector);
  const selectionNotes = uniqCaseInsensitiveStrings(asStringArray(selector.selection_notes), 3);
  return {
    recommendations: diversifiedOrdered,
    primary_recommendation_id: topPickProductId,
    support_roles_surfaced: uniqCaseInsensitiveStrings(asStringArray(selector.support_roles_surfaced), 4),
    winner_source: topPickProductId ? 'llm_selector' : 'deterministic',
    selection_notes_by_product_id: topPickProductId && selectionNotes.length
      ? { [topPickProductId]: selectionNotes }
      : {},
  };
}

module.exports = {
  isConcernPrimaryRoleWinnerSafe,
  applyConcernSelectorRaceOrdering,
};
