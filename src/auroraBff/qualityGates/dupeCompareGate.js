'use strict';

/**
 * Hard quality gate for dupe_compare payloads.
 *
 * Ensures original/dupe are non-null, and limited-mode comparisons
 * always carry at least a minimal basic_compare array with action hints.
 */

function applyDupeCompareQualityGate(payload, { lang = 'EN' } = {}) {
  if (!payload || typeof payload !== 'object') return { gated: false, payload, reason: null };

  let mutated = false;
  let out = { ...payload };
  const reasons = [];

  const isStubOrNull = (obj) => !obj || (typeof obj === 'object' && obj._stub === true);

  if (isStubOrNull(out.original) && isStubOrNull(out.dupe)) {
    reasons.push('both_products_missing');
  }

  const isLimited = out.compare_quality === 'limited';
  const tradeoffsEmpty = !Array.isArray(out.tradeoffs) || out.tradeoffs.length === 0;
  const basicEmpty = !Array.isArray(out.basic_compare) || out.basic_compare.length === 0;

  if (isLimited && basicEmpty) {
    const fallbackBullets = [];
    if (lang === 'CN') {
      fallbackBullets.push('上游未能返回完整对比数据');
      fallbackBullets.push('建议提供产品完整链接后重新比较');
    } else {
      fallbackBullets.push('Upstream did not return full comparison data');
      fallbackBullets.push('Try again with the full product link for a better comparison');
    }
    out.basic_compare = fallbackBullets;
    mutated = true;
  }

  if (isLimited || tradeoffsEmpty) {
    const hint = lang === 'CN'
      ? '当前仅能提供有限对比。你可以提供两款产品的完整链接，重新触发详细比较。'
      : 'Only a limited comparison is available. Provide full product links to trigger a detailed comparison.';
    if (!out.limited_action_hint) {
      out.limited_action_hint = hint;
      mutated = true;
    }
  }

  if (reasons.length || mutated) {
    out.meta = {
      ...(out.meta || {}),
      quality_gate_enforced: true,
      ...(reasons.length ? { quality_gate_reasons: reasons } : {}),
    };
  }

  return {
    gated: reasons.length > 0 || mutated,
    payload: out,
    reason: reasons[0] || (mutated ? 'limited_enriched' : null),
  };
}

module.exports = { applyDupeCompareQualityGate };
