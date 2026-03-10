'use strict';

/**
 * Hard quality gate for dupe_suggest payloads.
 *
 * Returns { gated, payload, reason } where `gated=true` means the payload
 * was downgraded to an empty-state because it failed minimum quality checks.
 */

function isHollowItem(item) {
  if (!item || typeof item !== 'object') return true;
  const sim = Number(item.similarity);
  const hasSimilarity = Number.isFinite(sim) && sim > 0;
  const hasTradeoffs = Array.isArray(item.tradeoffs) && item.tradeoffs.length > 0;
  const conf = Number(item.confidence);
  const hasConfidence = Number.isFinite(conf) && conf > 0;
  return !hasSimilarity && !hasTradeoffs && !hasConfidence;
}

function applyDupeSuggestQualityGate(payload, { lang = 'EN' } = {}) {
  if (!payload || typeof payload !== 'object') return { gated: false, payload, reason: null };

  const dupes = Array.isArray(payload.dupes) ? payload.dupes : [];
  const comparables = Array.isArray(payload.comparables) ? payload.comparables : [];
  const allItems = [...dupes, ...comparables];

  const poolEmpty = payload.candidate_pool_meta
    && Number(payload.candidate_pool_meta.count) === 0;

  const allHollow = allItems.length > 0 && allItems.every(isHollowItem);

  const noResults = allItems.length === 0;

  if (!allHollow && !noResults) {
    return { gated: false, payload, reason: null };
  }

  const requestedEmptyReason = String(
    payload.empty_state_reason
      || (payload.meta && payload.meta.final_empty_reason)
      || '',
  ).trim();
  const fallbackReason = poolEmpty ? 'candidate_pool_empty' : 'no_meaningful_results';
  const reason = allHollow
      ? 'all_items_hollow'
      : requestedEmptyReason || fallbackReason;

  const actionHint = lang === 'CN'
    ? '当前数据不足以给出可靠的平替推荐。请提供产品链接或更完整的名称后重试。'
    : 'Insufficient data for a reliable dupe recommendation. Please provide a product link or a more complete name and try again.';

  const qualityIssues = Array.isArray(payload.quality?.quality_issues)
    ? [...payload.quality.quality_issues]
    : [];
  if (!qualityIssues.includes(reason)) qualityIssues.push(reason);

  const gatedPayload = {
    ...payload,
    dupes: allHollow ? [] : dupes.filter((it) => !isHollowItem(it)),
    comparables: allHollow ? [] : comparables.filter((it) => !isHollowItem(it)),
    verified: false,
    empty_state_reason: reason,
    action_hint: actionHint,
    quality: {
      ...(payload.quality || {}),
      quality_ok: false,
      quality_issues: qualityIssues,
    },
    meta: {
      ...(payload.meta || {}),
      quality_gate_enforced: true,
      quality_gate_reason: reason,
    },
  };

  return { gated: true, payload: gatedPayload, reason };
}

module.exports = { isHollowItem, applyDupeSuggestQualityGate };
