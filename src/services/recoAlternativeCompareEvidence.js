function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function toList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function uniqueStrings(values, limit = 16) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = asString(raw).replace(/\s+/g, ' ');
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeEvidenceSourceType(value) {
  const text = asString(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!text) return 'unknown';
  if (['editorial', 'editorial_support', 'media', 'media_signal', 'press', 'publisher'].includes(text)) {
    return 'editorial_support';
  }
  if (['creator', 'creator_consensus', 'creator_social_consensus', 'social', 'social_consensus'].includes(text)) {
    return 'creator_social_consensus';
  }
  if (['review', 'reviews', 'verified_review', 'verified_reviews', 'user_review', 'user_reviews', 'community'].includes(text)) {
    return 'user_review_consensus';
  }
  if (['brand', 'brand_comparison', 'official_brand', 'official'].includes(text)) return 'brand_comparison';
  if (['retailer', 'marketplace', 'retailer_marketplace', 'merchant'].includes(text)) return 'retailer_marketplace';
  if (['search', 'web_search', 'web'].includes(text)) return 'web_search';
  return text.slice(0, 64);
}

function normalizeMentionType(value) {
  const text = asString(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!text) return 'alternative';
  if (['dupe', 'dupes', 'budget_dupe', 'budget_alternative', 'affordable_alternative'].includes(text)) {
    return text.includes('budget') || text.includes('affordable') ? 'budget_alternative' : 'dupe';
  }
  if (['compare', 'comparison', 'vs', 'versus', 'compared_with'].includes(text)) return 'comparison';
  if (['alternative', 'alternatives', 'similar', 'similar_product', 'substitute'].includes(text)) return 'alternative';
  if (['same_role', 'same_category', 'same_step'].includes(text)) return 'same_role';
  return text.slice(0, 64);
}

function normalizeEvidenceStrength(value) {
  const text = asString(value).toLowerCase();
  if (['strong', 'high'].includes(text)) return 'strong';
  if (['moderate', 'medium'].includes(text)) return 'moderate';
  if (['weak', 'low'].includes(text)) return 'weak';
  return '';
}

function normalizeRecoAlternativeCompareEvidence(raw, { maxItems = 4 } = {}) {
  const candidates = [
    ...toList(raw?.comparison_evidence),
    ...toList(raw?.compare_evidence),
    ...toList(raw?.external_compare_evidence),
    ...toList(raw?.external_comparison_evidence),
    ...toList(raw?.evidence?.comparison_evidence),
  ];
  const out = [];
  const seen = new Set();
  for (const itemRaw of candidates) {
    const item = asObject(itemRaw);
    if (!item) continue;
    const sourceType = normalizeEvidenceSourceType(item.source_type || item.sourceType || item.source);
    const mentionType = normalizeMentionType(item.mention_type || item.mentionType || item.type || item.kind);
    const summary = asString(item.summary || item.claim || item.claim_text || item.note || item.text).replace(/\s+/g, ' ');
    const sourceHint = asString(item.source_hint || item.sourceHint || item.source_label || item.label || item.url);
    if (!summary && sourceType === 'unknown' && mentionType === 'alternative') continue;
    const key = `${sourceType}|${mentionType}|${summary.toLowerCase()}|${sourceHint.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source_type: sourceType,
      mention_type: mentionType,
      ...(summary ? { summary: summary.slice(0, 180) } : {}),
      ...(sourceHint ? { source_hint: sourceHint.slice(0, 180) } : {}),
      ...(normalizeEvidenceStrength(item.evidence_strength || item.evidenceStrength || item.strength)
        ? { evidence_strength: normalizeEvidenceStrength(item.evidence_strength || item.evidenceStrength || item.strength) }
        : {}),
    });
    if (out.length >= Math.max(1, Math.min(Number(maxItems) || 4, 8))) break;
  }
  return out;
}

function scoreRecoAlternativeCompareEvidence(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  if (!list.length) return 0;
  const sourceTypes = new Set();
  const mentionTypes = new Set();
  let strengthScore = 0;
  for (const item of list) {
    const sourceType = normalizeEvidenceSourceType(item?.source_type);
    const mentionType = normalizeMentionType(item?.mention_type);
    if (sourceType && sourceType !== 'unknown') sourceTypes.add(sourceType);
    if (mentionType) mentionTypes.add(mentionType);
    const strength = normalizeEvidenceStrength(item?.evidence_strength);
    if (strength === 'strong') strengthScore += 0.016;
    else if (strength === 'moderate') strengthScore += 0.01;
    else if (strength === 'weak') strengthScore += 0.004;
  }
  const mentionBonus = Math.min(0.036, list.length * 0.012);
  const sourceBonus = Math.min(0.032, sourceTypes.size * 0.01);
  const dupeBonus = mentionTypes.has('dupe') || mentionTypes.has('budget_alternative') ? 0.012 : 0;
  return Number(Math.min(0.08, mentionBonus + sourceBonus + dupeBonus + Math.min(0.024, strengthScore)).toFixed(4));
}

function buildRecoAlternativeCompareEvidenceSearchQueries({
  anchorBrand = '',
  anchorName = '',
  candidateBrand = '',
  candidateName = '',
  role = '',
  limit = 8,
} = {}) {
  const anchor = uniqueStrings([[anchorBrand, anchorName].filter(Boolean).join(' ')], 1)[0] || '';
  const candidate = uniqueStrings([[candidateBrand, candidateName].filter(Boolean).join(' ')], 1)[0] || '';
  const roleText = asString(role).replace(/[_-]+/g, ' ');
  if (!anchor || !candidate) return [];
  return uniqueStrings(
    [
      `${anchor} ${candidate} comparison`,
      `${anchor} vs ${candidate}`,
      `${candidate} alternative to ${anchor}`,
      `${anchor} dupe ${candidate}`,
      `${candidate} dupe for ${anchor}`,
      roleText ? `${anchor} ${roleText} alternatives` : '',
      roleText ? `${candidate} ${roleText} reviews comparison` : '',
      `${anchor} affordable alternatives`,
    ],
    Math.max(1, Math.min(Number(limit) || 8, 12)),
  );
}

module.exports = {
  normalizeEvidenceSourceType,
  normalizeMentionType,
  normalizeRecoAlternativeCompareEvidence,
  scoreRecoAlternativeCompareEvidence,
  buildRecoAlternativeCompareEvidenceSearchQueries,
};
